import { EventEmitter } from 'node:events';
import {
  type Connection,
  Pool as PgjsPool,
  type QueryOptions,
} from 'postgrejs';
import { buildQueryOptions, PgClient } from './client.js';
import {
  type PgCompatibleConfig,
  type ResolvedFacadeOptions,
  resolveFacadeOptions,
  toPoolConfiguration,
} from './config.js';
import { normalizeError } from './errors.js';
import type { PgResult } from './result.js';

export type ReleaseCallback = (err?: any) => void;
export type ConnectCallback = (
  err: any,
  client?: PgClient,
  release?: ReleaseCallback,
) => void;

/**
 * `pg`'s `Pool`, over a PostgreJS `Pool`.
 *
 * This is the object TypeORM builds its whole PostgreSQL support on: it sizes
 * the pool (`max`), attaches an error handler, checks one connection out per
 * QueryRunner through the callback form of `connect()`, and ends the pool on
 * `destroy()`. `pool.query()` is never called by TypeORM - every statement,
 * `START TRANSACTION` included, runs on a checked-out connection, which is
 * what keeps a transaction on one connection.
 */
export class PgPool extends EventEmitter {
  protected readonly _pool: PgjsPool;
  protected readonly _facadeOptions: ResolvedFacadeOptions;
  protected readonly _queryOptions: QueryOptions;
  /**
   * Connections whose in-flight query already rejected with the error the
   * pool is about to report, so the duplicate pool event can be suppressed -
   * see `suppressRedundantPoolError`.
   */
  protected readonly _reportedErrors: WeakSet<object>;
  protected _ended: boolean;

  constructor(config?: PgCompatibleConfig) {
    super();
    this._facadeOptions = resolveFacadeOptions(config);
    this._queryOptions = buildQueryOptions(this._facadeOptions);
    this._reportedErrors = new WeakSet();
    this._ended = false;
    this._pool = new PgjsPool(toPoolConfiguration(config));
    this._pool.on('error', (err: any, connection?: any) => {
      if (
        this._facadeOptions.suppressRedundantPoolError &&
        connection &&
        this._reportedErrors.has(connection)
      )
        return;
      this.emit(
        'error',
        this._facadeOptions.normalizeErrors ? normalizeError(err) : err,
      );
    });
  }

  get totalCount(): number {
    return this._pool.totalConnections;
  }

  get idleCount(): number {
    return this._pool.idleConnections;
  }

  get waitingCount(): number {
    return 0;
  }

  get ending(): boolean {
    return this._ended;
  }

  /**
   * Checks a connection out. Both forms of `pg`'s API are supported, and
   * TypeORM uses the callback one exclusively:
   * `pool.connect((err, connection, release) => ...)`.
   */
  connect(callback?: ConnectCallback): Promise<PgClient> | undefined {
    const promise = this._acquire();
    if (!callback) return promise.then(([client]) => client);
    promise.then(
      ([client, release]) => callback(null, client, release),
      e => callback(e),
    );
    return undefined;
  }

  /**
   * Not used by TypeORM, which always checks a connection out. Provided
   * because `pg` has it and knex reaches for it when wrapping a native pool.
   * Every call is free to pick a different connection, so a transaction
   * cannot be spread over it.
   */
  async query(text: any, values?: any, callback?: any): Promise<PgResult> {
    const [client, release] = await this._acquire();
    try {
      const r = await client.query(text, values);
      release();
      if (typeof callback === 'function') callback(null, r);
      return r;
    } catch (e) {
      release(e);
      if (typeof callback === 'function') {
        callback(e);
        return undefined as unknown as PgResult;
      }
      throw e;
    }
  }

  async end(callback?: (err?: any) => void): Promise<void> {
    try {
      this._ended = true;
      await this._pool.close(5000);
      callback?.();
    } catch (e) {
      if (!callback) throw e;
      callback(e);
    }
  }

  protected async _acquire(): Promise<[PgClient, ReleaseCallback]> {
    const connection: Connection = await this._pool.acquire();
    const client = PgClient.overConnection(
      connection,
      this._facadeOptions,
      this._queryOptions,
    );
    // `pg-pool` emits connect/acquire/release/remove/error. TypeORM listens
    // only for 'error', but its own suite asserts 'acquire' fires exactly
    // once per checkout, so all of them are emitted rather than only what a
    // grep of the consumer turns up.
    this.emit('acquire', client);

    // A query that dies with the connection rejects with the same error the
    // pool is about to raise; remember it so the pool event can be dropped.
    const onError = () => this._reportedErrors.add(connection as object);
    client.on('error', onError);

    let released = false;
    const release: ReleaseCallback = () => {
      if (released) return;
      released = true;
      client.removeListener('error', onError);
      client._release();
      this.emit('release', undefined, client);
      // `pg` takes a truthy argument here to mean "do not reuse this
      // connection". PostgreJS validates a connection on the way out of the
      // pool and destroys a dead one itself, so there is nothing to forward.
      this._pool.release(connection).catch(() => undefined);
    };
    return [client, release];
  }
}
