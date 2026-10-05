import { BindParam } from 'postgrejs';
import type { ResolvedFacadeOptions } from './config.js';
import { UNSPECIFIED_OID } from './constants.js';
import { prepareValue } from './prepare-value.js';

/**
 * Parameters: PostgreJS types each value from the JS value it is given, and
 * `pg`'s own rendering - `prepareValue()` then OID 0 for everything - is the
 * opt-out behind `inferParameterTypes: false`.
 *
 * **It was the other way round until 2026-10-06, and the reason it changed
 * is that the reason for it went away.** The policy existed because a
 * declared type forecloses the server's own resolution: PostgreSQL resolves
 * an unspecified parameter from wherever its placeholder appears, and
 * naming a type stops it. That cost three rounds across the sibling
 * packages - a plain string arriving `varchar` broke `json` columns,
 * `coalesce($1, 1)`, `$1 || x` and every overloaded function.
 *
 * PostgreJS now sends exactly those unspecified itself (`isUnspecifiedParam`:
 * strings, `Date`s, and arrays of numbers, each for the same reason this
 * file had). What was left was `money` from a non-integer, which `pg` got
 * right by saying nothing and this client got wrong by declaring `float8` -
 * and `float8 -> money` has no `pg_cast` row. Closed upstream in `341f343`
 * by declaring `numeric`, which is an assignment cast `::money` accepts.
 *
 * ## What it costs, stated because it is a real divergence
 *
 * Three shapes, and `pg` is the one losing information in all three. They
 * are pinned on both sides in `test/B-live/params.spec.ts` rather than
 * excused:
 *
 * ```
 *   select $1      12      pg '12' (string)    here 12 (number)
 *   select $1      true    pg 'true' (string)  here true (boolean)
 *   select $1 * 2  1.5     pg 22P02            here '3.0'
 * ```
 *
 * A parameter with no context at all is the only place this shows, because
 * everywhere else the column or the operator decides and both clients land
 * on the same value. TypeORM generates no such SQL - every parameter it
 * sends has a column or a comparison around it - which is why the matrix
 * and the differential suite are untouched by the change. Code that holds a
 * raw `select $1` and depends on the string is why the opt-out exists.
 *
 * ## What it is worth
 *
 * One parameter holding 100 000 `int4`s, allocation per call: **27.89 MB
 * through `pg`'s renderer, 1.94 MB through PostgreJS's**. Not because a
 * binary encoding was being given up - both send unspecified text, and all
 * three clients write the same order of bytes on the socket (`pg` 1 300 124,
 * PostgreJS 1 100 146, the old path here 1 300 047). The fourteen times is
 * in **how the literal is built**: PostgreJS writes digits into its own
 * buffer, `prepareValue` concatenates. Same wire contract, same declared
 * type, same bytes, a fourteenth of the garbage.
 *
 * `pg`'s renderer stays in the tree and stays tested against `pg`'s own
 * function, because it is what `inferParameterTypes: false` runs. It is not
 * dead code with an opinion; it is the other half of a documented choice.
 *
 * **`parseInputDatesAsUTC` belongs to that half only.** It is an option of
 * `pg`'s renderer. On this path a `Date` goes out untyped carrying the
 * process's own offset, which is what `pg` sends anyway.
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
    // The default: hand the values over untouched. PostgreJS declares what
    // it can name and sends the rest unspecified, which is the same question
    // this file used to answer for every value at once.
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
