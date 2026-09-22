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
import { type PgResult, toPgResult, toPgResults } from './result.js';
import { isSubmittable, streamFromSubmittable } from './stream.js';

export type QueryCallback = (err: any, result?: PgResult | PgResult[]) => void;

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
 * - `rowDecoder: 'object'` because `pg` hands back objects. Not the
 *   deprecated `objectRows` boolean: PostgreJS resolves the two with
 *   `rowDecoder` winning, so setting `objectRows` next to it does nothing.
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
    rowDecoder: 'object',
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
  /**
   * Returns this client to the pool it came from. Assigned by `PgPool` when
   * it hands the client out, exactly as `pg-pool` assigns it - it is the same
   * function the connect callback receives as its third argument. Absent on a
   * standalone client, where `end()` is what closes the connection.
   */
  declare release?: (err?: any) => void;
  protected readonly _facadeOptions: ResolvedFacadeOptions;
  protected readonly _queryOptions: QueryOptions;
  protected readonly _connection: Connection;
  protected readonly _ownsConnection: boolean;
  protected _connected: boolean;
  /**
   * The tail of the per-client statement queue - see `_serialize`.
   */
  protected _tail: Promise<unknown>;
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
      this._tail = Promise.resolve();
      this._attach();
    } else {
      this._facadeOptions = resolveFacadeOptions(config);
      this._queryOptions = buildQueryOptions(this._facadeOptions);
      this._connection = new Connection(toPoolConfiguration(config));
      this._ownsConnection = true;
      this._connected = false;
      this._tail = Promise.resolve();
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

    const rowMode: string | undefined =
      typeof config === 'object' && config ? config.rowMode : undefined;
    const promise = this._query(text, params, rowMode);
    if (!cb) return promise;
    promise.then(
      r => cb(null, r),
      e => cb(e),
    );
    return undefined;
  }

  async end(callback?: (err?: any) => void): Promise<void> {
    try {
      if (this._ownsConnection) {
        this._detach();
        if (this._connected) {
          await this._connection.close();
          this._connected = false;
        }
      } else if (this.release) {
        // A pooled client: `release()` is the way back, and ending the
        // connection under the pool would strand it. Leaking is the worse
        // of the two divergences from `pg`, which would end the socket here
        // and let its pool notice afterwards.
        this.release();
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

  /**
   * Runs statements on this client one at a time, which is what `pg` does.
   *
   * `pg`'s `Client` pushes every `query()` onto an internal queue and starts
   * the next only when the previous has settled. A PostgreJS `Connection`
   * pipelines instead - concurrent calls all go out and overlap - and that is
   * a real feature: 500 queries on one connection take 12ms pipelined against
   * 120ms awaited, measured. It is also a behaviour difference a caller can
   * see, and the way they see it is a failure:
   *
   * ```js
   * await Promise.all([
   *   client.query('create temp table t(i int)'),
   *   client.query('insert into t values (1)'),   // 42P01 on the raw connection
   * ]);
   * ```
   *
   * Nobody migrating from `pg` loses the 10x by serialising, because `pg`
   * never offered it - it serialises, and deprecates concurrent `query()`
   * outright ("will be removed in pg@9.0"). Anyone who wants PostgreJS's
   * concurrency has `client.connection`, which is the real thing and is not
   * queued.
   *
   * Streams are deliberately not queued: a cursor is read lazily and holding
   * the queue open for its lifetime would deadlock every statement behind it.
   */
  protected _serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this._tail.then(run, run);
    // The chain has to survive a rejection, and must not retain the value.
    this._tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  protected _query(
    text: string,
    params: any[] | undefined,
    rowMode?: string,
  ): Promise<PgResult | PgResult[]> {
    return this._serialize(() => this._runQuery(text, params, rowMode));
  }

  protected async _runQuery(
    text: string,
    params: any[] | undefined,
    rowMode?: string,
  ): Promise<PgResult | PgResult[]> {
    const o = this._facadeOptions;
    const hasParams = !!params && params.length > 0;
    const opts = { ...this._queryOptions };
    // `pg` gives arrays of values for `rowMode: 'array'`, objects otherwise.
    // Through `rowDecoder`, not the deprecated `objectRows`: the two are
    // resolved with `rowDecoder` winning, and this object already carries
    // `rowDecoder: 'object'` - so assigning `objectRows` here is silently
    // ignored. It was, until a live test caught it.
    if (rowMode === 'array') opts.rowDecoder = 'array';

    // An empty statement has nothing to Parse, and PostgreJS's extended path
    // answers the server's EmptyQueryResponse with `Server returned
    // unexpected response message (I)`. `pg` resolves it as an empty result.
    if (!hasParams && !text?.trim()) return this._simple(text ?? '', opts);

    try {
      const r = await this._connection.query(text, {
        ...opts,
        params: toBindParams(params, o),
      });
      return toPgResult(r, o.decoding === 'pg');
    } catch (e: any) {
      // `pg` sends a parameterless statement over the SIMPLE protocol, which
      // allows several commands in one string and answers with one result per
      // command. PostgreJS's `query()` is always the extended protocol, where
      // the server refuses that outright.
      //
      // Falling back on the SQLSTATE rather than parsing the SQL is safe, and
      // measured: 42601 here is raised at Parse, before any command runs, so
      // the retry cannot double a side effect - verified by sending two
      // INSERTs and finding the table still empty afterwards. And `execute()`
      // takes no parameters, so this can only apply where `params` is empty,
      // which is the only case that could carry several commands anyway.
      // When the retry fails too, it is the retry's error that surfaces, not
      // this one. 42601 is also plain "syntax error", so a multi-statement
      // string whose second statement names a missing table arrives here as
      // 42601 and fails on the simple protocol as 42P01 - and 42P01 is what
      // went wrong, and what `pg` reports. Rethrowing the original would
      // answer a question nobody asked.
      if (e?.code === '42601' && !hasParams) return this._simple(text, opts);
      throw o.normalizeErrors ? normalizeError(e) : e;
    }
  }

  /** The simple protocol, via PostgreJS's `execute()`. */
  protected async _simple(
    text: string,
    opts: QueryOptions,
  ): Promise<PgResult | PgResult[]> {
    const o = this._facadeOptions;
    try {
      const r = await this._connection.execute(text, opts);
      const results = r.results ?? [];
      // An empty statement produces no result at all; `pg` still resolves to
      // one, with a null command and a null count.
      if (!results.length)
        return {
          // `null`, not `undefined` - that is what pg resolves an empty
          // statement to, and the two are not the same to a deep compare.
          command: null,
          rowCount: null,
          oid: undefined,
          rows: [],
          fields: [],
        };
      // One command in, one result out - `pg` unwraps that case and returns
      // an array only when there really were several.
      return results.length === 1
        ? toPgResult(results[0], o.decoding === 'pg')
        : toPgResults(results, o.decoding === 'pg');
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
