import { BindParam } from 'postgrejs';
import type { ResolvedFacadeOptions } from './config.js';
import { UNSPECIFIED_OID } from './constants.js';
import { prepareValue } from './prepare-value.js';

/**
 * Parameters, the way `pg` sends them: every value rendered to text (or left
 * a `Buffer`) and declared OID 0, so PostgreSQL resolves each one from where
 * its placeholder appears.
 *
 * This is the whole policy, and it is deliberately not "wrap scalars in
 * `BindParam(0, v)` and leave the rest to PostgreJS's typed encoders", which
 * is what `postgrejs-kysely` and `postgrejs-drizzle` do. Measured over 28
 * query shapes against `pg` (`doc/DRIVER-DESIGN.md` §5):
 *
 * | policy | score |
 * | --- | --- |
 * | leave everything to PostgreJS | 27/28 |
 * | `BindParam(0, v)` for scalars only | 27/28 |
 * | **this one** | **28/28** |
 *
 * The one PostgreJS misses is an empty array, and an all-null array with it:
 * `determine()` picks an array's type from `value[0]`, which is `undefined`
 * for `[]` and `null` for `[null]`, so neither is typed and the server
 * answers `22P02 malformed array literal: ""`. Rendering to `{}` / `{NULL}`
 * and letting the server resolve it sidesteps that.
 *
 * But the score is not really the argument. The facade's contract is to *be*
 * the `pg` module, so any divergence from what `pg` puts on the wire is a
 * bug by definition, however reasonable the other value looks. Reusing `pg`'s
 * own rendering (`prepare-value.ts`) means this cannot drift from it type by
 * type as either library gains decoders.
 */
export function toBindParams(
  values: readonly any[] | undefined,
  options: ResolvedFacadeOptions,
): any[] | undefined {
  if (!values || !values.length) return values as any[] | undefined;
  const l = values.length;
  const out = new Array(l);
  let i: number;
  if (options.inferParameterTypes) {
    // The escape hatch: hand the values over untouched and let PostgreJS
    // derive an OID from each. Keeps the binary encoders in play, at the
    // cost of the two array cases above and of whatever inference the server
    // would otherwise have done from context.
    for (i = 0; i < l; i++) out[i] = values[i];
    return out;
  }
  const utc = options.parseInputDatesAsUTC;
  let v: string | Buffer | null;
  for (i = 0; i < l; i++) {
    v = prepareValue(values[i], undefined, utc);
    // A Buffer goes as bytes. `pg` sends it as a binary parameter and
    // PostgreJS does the same when it is handed one directly, so there is
    // nothing to declare.
    out[i] = Buffer.isBuffer(v) ? v : new BindParam(UNSPECIFIED_OID, v);
  }
  return out;
}
