import type { PoolConfiguration } from 'postgrejs';
import { DEFAULT_POOL_MAX } from './constants.js';

/**
 * Options this facade understands, over and above the `pg` pool options it
 * has to accept.
 *
 * They arrive through whatever channel the consumer has for passing extra
 * pool config. From TypeORM that is `extra`, which `PostgresDriver.createPool()`
 * merges straight into the object handed to `new Pool(...)`:
 *
 * ```ts
 * new DataSource({ type: 'postgres', driver: pgjs, extra: { postgrejs: { decoding: 'native' } } })
 * ```
 */
export interface PgjsFacadeOptions {
  /**
   * What values come back as.
   *
   * - `'pg'` (the default) - what `pg` returns, type for type. `numeric` and
   *   `int8` are strings, `interval` is a `PostgresInterval`-shaped object,
   *   `point` is `{x, y}`, ranges are strings.
   * - `'native'` - PostgreJS's own decoding, which is richer and is the
   *   reason to use PostgreJS at all: a `Numeric` that keeps every digit, a
   *   `BigInt` past 2^53, typed geometric and `Range` classes.
   *
   * `'native'` is not safe with an ORM that was written against `pg`. TypeORM
   * has no hydration branch for a `numeric` column, so a `Numeric` instance
   * reaches the user where a string was expected. Opt in only if you know the
   * code reading these rows.
   */
  decoding?: 'pg' | 'native';

  /**
   * Let PostgreJS derive an OID per parameter from the JS value instead of
   * declaring every parameter unspecified the way `pg` does.
   *
   * Off by default, and it is not the same thing as being faster: see
   * `params.ts` for what it changes and `doc/DRIVER-DESIGN.md` §5 for the
   * measurement behind the default.
   */
  inferParameterTypes?: boolean;

  /**
   * Mirrors `pg`'s `defaults.parseInputDatesAsUTC`: render a `Date` parameter
   * from its UTC fields rather than its local ones.
   */
  parseInputDatesAsUTC?: boolean;

  /**
   * Additional OIDs to ask the server for as text, appended to the list the
   * `'pg'` decoding mode already uses. Ignored when `decoding` is `'native'`.
   */
  fetchAsString?: number[];

  /**
   * PostgreJS caches prepared statements per connection from the second use
   * of the same SQL. Set `false` for PgBouncer in transaction pooling mode
   * before 1.21, where a named statement does not survive to the next call.
   */
  prepare?: boolean;

  /**
   * Make the error a caller catches look like `pg`'s: strip the caret diagram
   * PostgreJS appends to `message`, and render `position` as a string.
   *
   * On by default. The structured fields (`code`, `severity`, `constraint`,
   * `detail`, `table`, ...) are identical either way - this is only about the
   * two that a caller migrating from `pg` would notice.
   */
  normalizeErrors?: boolean;

  /**
   * PostgreJS reports a dead pooled connection on the pool as well as
   * rejecting the in-flight query; `pg` only rejects the query. With this on
   * (the default) the pool event is suppressed when a query already carries
   * the same error, so a TypeORM user does not get a
   * `Postgres pool raised an error` warning that `pg` never produces.
   */
  suppressRedundantPoolError?: boolean;
}

/** The `pg` pool options TypeORM and knex actually pass. */
export interface PgCompatibleConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string | (() => string | Promise<string>);
  database?: string;
  ssl?: boolean | Record<string, any>;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  application_name?: string;
  max?: number;
  min?: number;
  /** This facade's own options. */
  postgrejs?: PgjsFacadeOptions;
  [key: string]: any;
}

export interface ResolvedFacadeOptions extends Required<
  Omit<PgjsFacadeOptions, 'fetchAsString' | 'prepare' | 'decoding'>
> {
  decoding: 'pg' | 'native';
  fetchAsString?: number[];
  prepare?: boolean;
}

export function resolveFacadeOptions(
  config: PgCompatibleConfig = {},
): ResolvedFacadeOptions {
  const o = config.postgrejs ?? {};
  return {
    decoding: o.decoding ?? 'pg',
    inferParameterTypes: o.inferParameterTypes ?? false,
    parseInputDatesAsUTC: o.parseInputDatesAsUTC ?? false,
    fetchAsString: o.fetchAsString,
    prepare: o.prepare,
    normalizeErrors: o.normalizeErrors ?? true,
    suppressRedundantPoolError: o.suppressRedundantPoolError ?? true,
  };
}

/**
 * `pg` pool options to a PostgreJS `PoolConfiguration`.
 *
 * The one that bites: PostgreJS takes a connection string as its **first
 * argument** or as `host`. `{ connectionString }` is not one of its options
 * and is silently ignored, landing you on localhost:5432/postgres - and
 * `connectionString` is exactly what TypeORM passes when the user gave a
 * `url` (`PostgresDriver.createPool()`), so it has to be translated here.
 */
export function toPoolConfiguration(
  config: PgCompatibleConfig = {},
): PoolConfiguration {
  // PostgreJS's PoolConfiguration extends lightning-pool's, so max/min/
  // idleTimeoutMillis sit at the top level rather than under a `pool` key.
  // Nesting them is accepted by JavaScript and silently ignored, which is how
  // you end up with a pool of the default size wondering why `max` did
  // nothing.
  const cfg: PoolConfiguration = {
    host: config.connectionString ?? config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    applicationName: config.application_name,
    max: config.max ?? DEFAULT_POOL_MAX,
    min: config.min ?? 0,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
  };
  // `pg` treats 0 and undefined alike here - no timeout - and PostgreJS
  // would take a 0 literally.
  if (config.connectionTimeoutMillis)
    cfg.connectTimeoutMs = config.connectionTimeoutMillis;
  if (config.ssl) cfg.ssl = config.ssl === true ? {} : config.ssl;
  return cfg;
}
