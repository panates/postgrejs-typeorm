import { PgClient } from './client.js';
import { PgPool } from './pool.js';

export { PgClient } from './client.js';
export type {
  PgCompatibleConfig,
  PgjsFacadeOptions,
  ResolvedFacadeOptions,
} from './config.js';
export { FETCH_AS_STRING_OIDS, UNSPECIFIED_OID } from './constants.js';
export { PgPool } from './pool.js';
export { prepareValue } from './prepare-value.js';
export type { PgField, PgResult } from './result.js';

/**
 * `pg`'s `Pool` and `Client`, under the names the module exports them by, so
 * this package can be handed to anything that expects `require('pg')`.
 */
export { PgClient as Client, PgPool as Pool };

/**
 * `pg`'s module-level defaults. TypeORM only ever touches `parseInt8`, and it
 * checks for a setter before assigning (`PostgresDriver.createPool()`):
 *
 * ```ts
 * if (this.postgres.defaults && Object.getOwnPropertyDescriptor(this.postgres.defaults, 'parseInt8')?.set)
 *   this.postgres.defaults.parseInt8 = options.parseInt8
 * else logger.log('warn', '...will be ignored')
 * ```
 *
 * The property is defined with a real setter so that check passes, but the
 * value is deliberately inert: `pg` uses it to decide whether `int8` comes
 * back as a number, and this facade answers that per query through
 * `fetchAsString` rather than through a process-wide global. Two pools in one
 * process changing each other's decoding is a hazard worth not reproducing.
 *
 * Set `postgrejs: { decoding: 'native' }` in the pool config for `int8` as a
 * number (and a BigInt past 2^53, which `parseInt8` cannot give you).
 */
export const defaults: { parseInt8: boolean } = {} as any;
let _parseInt8 = false;
Object.defineProperty(defaults, 'parseInt8', {
  get(): boolean {
    return _parseInt8;
  },
  set(v: boolean) {
    _parseInt8 = v;
  },
  enumerable: true,
  configurable: true,
});

/**
 * `pg` exposes `native` as a lazily-loaded binding over libpq, and TypeORM
 * swaps the whole module for `module.native` when it is truthy *and*
 * `pg-native` happens to be installed (`PostgresDriver.loadDependencies()`).
 * There is no native build of this facade and there never will be - the point
 * of PostgreJS is that there are no native bindings - so this stays null and
 * that branch can never fire.
 */
export const native = null;

export default { Pool: PgPool, Client: PgClient, defaults, native };
