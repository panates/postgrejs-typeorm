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
 * **What holds it is three values a caller reads.** `money` from a
 * non-integer used to be the last live case and it is closed upstream
 * (`341f343`: a finite non-integer is declared `numeric`, not `float8`, and
 * `numeric -> money` is an assignment cast where `float8 -> money` has no
 * `pg_cast` row at all). With that in, handing every parameter to PostgreJS
 * scores 42/42 on the matrix as it then stood - and the matrix was wrong.
 * It compared `String(v)`, under which `12` and `'12'` are one answer:
 *
 * ```
 *   select $1      12      pg '12' (string)    declared 12 (number)
 *   select $1      true    pg 'true' (string)  declared true (boolean)
 *   select $1 * 2  1.5     pg 22P02            declared '3.0'
 * ```
 *
 * All three are correct values and a facade still cannot ship them - a
 * caller moving off `pg` would find a string had become a number. They are
 * in `test/B-live/params.spec.ts` now, compared with their types on.
 *
 * So the policy stays, and what is left of the old argument stays with it:
 * reusing `pg`'s own rendering means this cannot drift from it type by type
 * as either library gains encoders - a guarantee by construction rather
 * than by a matrix that has to be re-run, which this round is the reason to
 * take seriously.
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
 * **Taking that back needs one thing from upstream, and not a change here.**
 * The shape that works is `isUnspecifiedParam(v) ? v : BindParam(0,
 * prepareValue(v))` - hand PostgreJS the value exactly where it would have
 * sent it unspecified anyway, so the wire contract is identical on both
 * branches and the fast lane is reached for the values that have one. That
 * predicate is internal: not on the root export, and `exports` carries only
 * `.` and `./package.json`.
 *
 * Writing our own copy of it is the one thing this package does not do.
 * `isUnspecifiedParam` has changed its mind three times in one round -
 * empty arrays, all-null arrays, non-integer scalars - and a stale copy
 * would silently begin declaring types where PostgreJS declares none, which
 * is a correctness bug reachable from a dependency bump with no test on
 * either side that would fail. Asked for in
 * `../postgrejs/.claude/export-isunspecifiedparam.md`.
 *
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
