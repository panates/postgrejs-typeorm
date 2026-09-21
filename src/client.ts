import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { Connection, type QueryOptions } from 'postgrejs';
import {
  type PgCompatibleConfig,
  type ResolvedFacadeOptions,
  resolveFacadeOptions,
  toPoolConfiguration,
} from './config.js';
import { FETCH_AS_STRING_OIDS } from './constants.js';
import { normalizeError } from './errors.js';
import { toBindParams } from './params.js';
import { type PgResult, toPgResult } from './result.js';
import { isSubmittable, streamFromSubmittable } from './stream.js';

export type QueryCallback = (err: any, result?: PgResult) => void;

/** A `pg` query config object, as knex and `pg` itself pass one. */
export interface PgQueryConfig {
  text: string;
  values?: any[];
  name?: string;
  rowMode?: string;
}

/**
 * The per-query options every statement goes out with.
 *
 * - `objectRows` because `pg` hands back objects.
 * - `rollbackOnError: false` because PostgreJS otherwise wraps every
 *   statement inside a transaction in a savepoint of its own, so a failed
 *   statement leaves the transaction usable. That is neither PostgreSQL's
 *   semantics nor `pg`'s: verified through TypeORM, the statement after a
 *   failure has to raise `25P02 current transaction is aborted`.
 * - `fetchCount: 0` - the protocol's "no limit". `pg` has no notion of a
 *   partial result and there is nowhere to report one.
 * - `unknownTypesAsString` because without it a column of a type PostgreJS
 *   has no decoder for - an enum, a composite, an extension type - arrives
 *   as a raw `Buffer` where `pg` gives the string the server printed.
 */
export function buildQueryOptions(o: ResolvedFacadeOptions): QueryOptions {
  const opts: QueryOptions = {
    objectRows: true,
    rollbackOnError: false,
    fetchCount: 0,
  };
  if (o.decoding === 'pg') {
    opts.unknownTypesAsString = true;
    opts.fetchAsString = o.fetchAsString
      ? [...FETCH_AS_STRING_OIDS, ...o.fetchAsString]
      : FETCH_AS_STRING_OIDS;
  }
  if (o.prepare !== undefined) opts.prepare = o.prepare;
  return opts;
}

/**
 * `pg`'s `Client`, over a PostgreJS `Connection`.
 *
 * TypeORM never constructs one - it only ever takes connections out of a
 * `Pool` - but knex does (`new this.driver.Client(settings)` followed by
 * `client.connect()`), and `Pool` hands one of these out per checkout either
 * way, so the two consumers share it.
 */
export class PgClient extends EventEmitter {
  protected readonly _facadeOptions: ResolvedFacadeOptions;
  protected readonly _queryOptions: QueryOptions;
  protected readonly _connection: Connection;
  protected readonly _ownsConnection: boolean;
  protected _connected: boolean;
  protected _onConnectionError?: (err: any) => void;
  protected _onNotice?: (msg: any) => void;
  protected _onNotification?: (msg: any) => void;

  /**
   * Wraps a connection the pool already owns. Not part of the `pg` surface -
   * `Pool.connect()` is how a consumer gets one of these.
   *
   * @internal
   */
  static overConnection(
    connection: Connection,
    options: ResolvedFacadeOptions,
    queryOptions: QueryOptions,
  ): PgClient {
    return new PgClient(undefined, { connection, options, queryOptions });
  }

  constructor(
    config?: PgCompatibleConfig,
    /** @internal */
    borrowed?: {
      connection: Connection;
      options: ResolvedFacadeOptions;
      queryOptions: QueryOptions;
    },
  ) {
    super();
    if (borrowed) {
      this._connection = borrowed.connection;
      this._facadeOptions = borrowed.options;
      this._queryOptions = borrowed.queryOptions;
      this._ownsConnection = false;
      this._connected = true;
      this._attach();
    } else {
      this._facadeOptions = resolveFacadeOptions(config);
      this._queryOptions = buildQueryOptions(this._facadeOptions);
      this._connection = new Connection(toPoolConfiguration(config));
      this._ownsConnection = true;
      this._connected = false;
    }
  }

  /** The backend pid, which `pg` exposes under this name. */
  get processID(): number | undefined {
    return this._connection.processID;
  }

  /** The underlying PostgreJS connection, for anything this facade does not cover. */
  get connection(): Connection {
    return this._connection;
  }

  async connect(callback?: (err?: any) => void): Promise<void> {
    try {
      if (this._ownsConnection && !this._connected) {
        await this._connection.connect();
        this._connected = true;
        this._attach();
      }
      callback?.();
    } catch (e) {
      if (!callback) throw e;
      callback(e);
    }
  }

  query(config: any, values?: any, callback?: any): any {
    // pg-query-stream and anything else submittable: a Cursor is driven
    // instead - see stream.ts.
    if (isSubmittable(config)) return this._stream(config);

    const text: string = typeof config === 'string' ? config : config?.text;
    const params: any[] | undefined = Array.isArray(values)
      ? values
      : Array.isArray(config?.values)
        ? config.values
        : undefined;
    const cb: QueryCallback | undefined =
      typeof values === 'function'
        ? values
        : typeof callback === 'function'
          ? callback
          : undefined;

    const promise = this._query(text, params);
    if (!cb) return promise;
    promise.then(
      r => cb(null, r),
      e => cb(e),
    );
    return undefined;
  }

  async end(callback?: (err?: any) => void): Promise<void> {
    try {
      this._detach();
      if (this._ownsConnection && this._connected) {
        await this._connection.close();
        this._connected = false;
      }
      this.emit('end');
      callback?.();
    } catch (e) {
      if (!callback) throw e;
      callback(e);
    }
  }

  /** @internal - the pool calls this when the client goes back. */
  _release(): void {
    this._detach();
  }

  protected _attach(): void {
    if (this._onConnectionError) return;
    const con = this._connection;
    this._onConnectionError = (err: any) => this.emit('error', err);
    this._onNotice = (msg: any) => this.emit('notice', msg);
    this._onNotification = (msg: any) => this.emit('notification', msg);
    con.on('error', this._onConnectionError);
    con.on('notice', this._onNotice);
    con.on('notification', this._onNotification);
  }

  protected _detach(): void {
    const con = this._connection;
    if (this._onConnectionError)
      con.removeListener('error', this._onConnectionError);
    if (this._onNotice) con.removeListener('notice', this._onNotice);
    if (this._onNotification)
      con.removeListener('notification', this._onNotification);
    this._onConnectionError = undefined;
    this._onNotice = undefined;
    this._onNotification = undefined;
  }

  protected async _query(
    text: string,
    params: any[] | undefined,
  ): Promise<PgResult> {
    const o = this._facadeOptions;
    try {
      const r = await this._connection.query(text, {
        ...this._queryOptions,
        params: toBindParams(params, o),
      });
      return toPgResult(r, o.decoding === 'pg');
    } catch (e) {
      throw o.normalizeErrors ? normalizeError(e) : e;
    }
  }

  protected _stream(submittable: any): Readable {
    const source = submittable.cursor ?? submittable;
    return streamFromSubmittable(this._connection, submittable, {
      ...this._queryOptions,
      params: toBindParams(source.values, this._facadeOptions),
    });
  }
}
