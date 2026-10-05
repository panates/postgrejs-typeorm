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
 * The one PostgreJS missed was an empty array, and an all-null array with it:
 * `determine()` picked an array's type from `value[0]`, which is `undefined`
 * for `[]` and `null` for `[null]`, so neither was typed and the server
 * answered `22P02 malformed array literal: ""`.
 *
 * **Both are fixed upstream** - re-measured against the `node_modules` build
 * on 2026-10-05, `[]`, `[null]` and `[null, 2]` all round-trip through
 * PostgreJS's own typing, with and without a cast, and agree with `pg`. So
 * the score is no longer what holds this policy in place.
 *
 * What holds it is the contract. The facade's job is to *be* the `pg`
 * module, so any divergence from what `pg` puts on the wire is a bug by
 * definition, however reasonable the other value looks. Reusing `pg`'s own
 * rendering (`prepare-value.ts`) means this cannot drift from it type by
 * type as either library gains encoders - a guarantee by construction
 * rather than by a matrix that has to be re-run.
 *
 * **It is paid for, and the bill is on arrays.** One parameter holding
 * 100 000 `int4`s, allocation per call: PostgreJS on its own 1.94 MB, `pg`
 * 27.19 MB, this policy 27.89 MB.
 *
 * Not because a binary encoding is given up - that was the first reading
 * here and it was wrong. PostgreJS's `isUnspecifiedParam` already sends an
 * array of numbers as unspecified **text**, for the same reason this file
 * does: `[1, 2]` is `int4[]`, `int8[]`, `numeric[]` or `float8[]` depending
 * on where it lands, and those have no implicit casts between them. Counted
 * on the socket for one such call, all three write the same order of bytes
 * - `pg` 1 300 124, PostgreJS 1 100 146, this facade 1 300 047.
 *
 * The fourteen times is in **how the literal is built**: PostgreJS writes it
 * into its own buffer, `prepareValue` concatenates it. Same wire contract,
 * same declared type, same bytes - fourteen times the garbage to produce
 * them. Which is also why lifting the policy for arrays is narrow: it does
 * not change what the server is told, only who assembles the text.
 *
 * Lifting it for arrays alone was tried and measured: 273 of 275 tests still
 * pass, the two failures are the unit tests in `test/A-common` that assert
 * this mechanism rather than any behaviour, and the live parameter matrix
 * and the differential suite - the two that compare against `pg` - are
 * untouched. `write a 100k int4[]` becomes 1.87 MB and 13.06 ms against
 * `pg`'s 27.21 and 17.54. It is not done here because it is **D1's
 * question, not this file's**: it trades a guarantee that holds by
 * construction for one that holds as long as someone re-runs the matrix.
 * See `doc/DRIVER-DESIGN.md` §5 and D1.
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
