/**
 * **TypeORM sends `1` and `0` for a `boolean` column, and this corrects it.**
 *
 * `PostgresDriver.preparePersistentValue` has, for every version in the peer
 * range:
 *
 * ```ts
 * if (columnMetadata.type === Boolean) return value === true ? 1 : 0;
 * ```
 *
 * PostgreSQL has a real `boolean`, so there is nothing to gain by it. It
 * survives because `pg` declares no type for a parameter and sends it as
 * text, and `'1'::boolean` is valid input - so the integer never reaches the
 * column as an integer. Any client that declares a type instead gets
 * `42804 column "x" is of type boolean but expression is of type integer`,
 * which is sixty-seven failures in TypeORM's own suite and a broken insert in
 * any application with a boolean column.
 *
 * **This is a workaround and it is here on an explicit decision**, against
 * this package's own rule in `CLAUDE.md` that a gap is reported rather than
 * patched around. Two things were weighed and are recorded so the decision
 * can be revisited rather than rediscovered:
 *
 * - *Nothing is lost.* Returning the boolean is what the column wants.
 *   Measured: TypeORM's functional suite is 806/806 with this applied, and
 *   the `pg` control in the same invocation also ran patched and also stayed
 *   806/806 - PostgreSQL accepts `'true'` and `'1'` alike, so a `pg` user in
 *   the same process is unaffected.
 * - *It is global.* Patching a prototype reaches every `DataSource` in the
 *   process, including one running on `pg`. Benign for the reason above.
 *
 * **It must be removed when TypeORM fixes it** - see
 * `doc/TYPEORM-BOOLEAN.md` for the report. Set
 * `TYPEORM_POSTGREJS_NO_BOOLEAN_PATCH=1` to skip it.
 *
 * Idempotent, and silent if TypeORM is not installed: this package is a `pg`
 * facade and TypeORM is one of its consumers, not its purpose.
 */

import { createRequire } from 'node:module';

const MARK = Symbol.for('typeorm-postgrejs.booleanPatch');

// This package is ESM; TypeORM is resolved the way a consumer's own
// `require('typeorm')` would resolve it, from here.
const require = createRequire(import.meta.url);

export function patchTypeormBooleans(): boolean {
  if (process.env.TYPEORM_POSTGREJS_NO_BOOLEAN_PATCH) return false;
  let PostgresDriver: any;
  try {
    /**
     * **It patches the TypeORM it can resolve, which is the one a consumer
     * has.** An application installs TypeORM once and both it and this
     * package resolve the same copy, which is what makes an import-time
     * patch work at all.
     *
     * `TYPEORM_POSTGREJS_TYPEORM` names a `PostgresDriver` module
     * explicitly, for when that is not true. `scripts/run-typeorm-suite.sh`
     * sets it, and has to: it runs TypeORM's own tests from a checkout in a
     * temporary directory with no `node_modules/typeorm` in it, so nothing
     * resolves there and the patch would silently do nothing - which it did,
     * for one whole run, and the sixty-seven came back unchanged with no
     * sign of why.
     */
    const named = process.env.TYPEORM_POSTGREJS_TYPEORM;
    ({ PostgresDriver } = require(
      named ?? 'typeorm/driver/postgres/PostgresDriver.js',
    ));
  } catch {
    return false; // not a TypeORM consumer - knex, or the facade used directly
  }
  const proto = PostgresDriver?.prototype;
  if (!proto || typeof proto.preparePersistentValue !== 'function')
    return false;
  if ((proto as any)[MARK]) return true;

  const original = proto.preparePersistentValue;
  proto.preparePersistentValue = function (value: any, columnMetadata: any) {
    // Only the one conversion, and only when the value is already a boolean -
    // a transformer that produced something else keeps TypeORM's own path.
    if (
      columnMetadata?.type === Boolean &&
      (value === true || value === false) &&
      !columnMetadata.transformer
    )
      return value;
    return original.call(this, value, columnMetadata);
  };
  Object.defineProperty(proto, MARK, { value: true, enumerable: false });
  return true;
}
