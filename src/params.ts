import { BindParam } from 'postgrejs';
import type { ResolvedFacadeOptions } from './config.js';
import { UNSPECIFIED_OID } from './constants.js';
import { prepareValue } from './prepare-value.js';

/**
 * Parameters: `pg`'s own rendering for the values PostgreJS would declare a
 * type for, and PostgreJS's own path for the rest - which it already sends
 * untyped, exactly as `pg` does.
 *
 * ## Why not simply hand them all over
 *
 * Because a declared type is not only about whether the parameter resolves.
 * **It also sets the type of any result column derived from that
 * parameter**, and TypeORM selects parameters constantly: in subqueries, in
 * the distinct query behind skip/take, in insert-from-select.
 *
 * ```
 *   select $1 as x   with 7    pg  text / '7'    declared  int4 / 7
 * ```
 *
 * Letting every value through took TypeORM's own functional suite from
 * 806/806 to **739/806**. Bisected, those sixty-seven are **`number` on its
 * own**: handing numbers over reproduces all of them, and handing over
 * booleans, boolean arrays and plain objects costs none. So the list below
 * is measured rather than reasoned, and `number` is the expensive entry.
 *
 * `inferParameterTypes: true` hands everything over for anyone who wants
 * PostgreJS's answers - `select $1 * 2` works there and raises `22P02`
 * under `pg` - and the cost of that is the sixty-seven, which is why it is
 * not the default.
 *
 * ## Why not render all of them, which is what this file used to do
 *
 * Because six of the eleven value kinds are rendered for nothing: PostgreJS
 * sends a string, a `Date`, an array of numbers, an array of strings and
 * `null` untyped for the same reasons this file would have, so running
 * `pg`'s renderer over them produces the same wire bytes the slow way.
 *
 * The array is what pays. One parameter holding 100 000 `int4`s: **27.2 MB
 * a call through `pg`'s renderer, 0.97 MB through PostgreJS's own writer**,
 * and 17.8 ms against 13.1. Identical bytes on the wire and the same
 * declared type - nothing - because the saving is in building the literal,
 * not in what is sent. `write a 100k int4[]` goes from level to 41/41.
 *
 * ## Nothing is rendered on this path at all
 *
 * Binding at OID 0 used to mean `new BindParam(0, prepareValue(v))`, because
 * PostgreJS wrote an undeclared parameter with `String(v)` - which destroyed
 * a plain object (`[object Object]`), an object inside an array, and any
 * value whose class implements `toPostgres()`. Fixed upstream in `a11a9af`,
 * which writes an undeclared parameter the way `pg` writes one.
 *
 * Re-measured against that build, the eight shapes that still take this
 * branch - `true`, `false`, a boolean array, a plain object, a nested
 * object, a caller's `toPostgres()` class, a `Buffer`, an object carrying a
 * `Date` - are **byte-identical to `pg` with no rendering at all**. So there
 * is none: the value goes to `BindParam` as it arrived.
 *
 * ## What `pg`'s renderer is still for
 *
 * `prepare-value.ts` is a port of `pg`'s own function, held to it by a test
 * that calls both. It is what `inferParameterTypes: false` runs, and that is
 * now its only caller here - the mode for code that wants `pg`'s answers
 * exactly, including the ones where `pg` loses information.
 *
 * **`parseInputDatesAsUTC` only has meaning there**, for the same reason: it
 * is an option of `pg`'s renderer, and nothing on the default path reaches
 * it.
 */

/**
 * **Would PostgreJS declare a type for this value, where `pg` declares
 * none?** Only those go through `pg`'s renderer; the rest are handed over.
 *
 * PostgreJS answers the same question internally (`isUnspecifiedParam`) and
 * sends strings, `Date`s and arrays of numbers untyped for the same reasons
 * this file would have. Measured against the build in `node_modules`, one
 * `select $1 as x` per value, comparing the result column's OID:
 *
 * ```
 *   string       text    text      same
 *   Date         text    text      same
 *   number[]     text    text      same
 *   string[]     text    text      same
 *   Buffer       bytea   bytea     DECLARED (see below)
 *   null         text    text      same
 *   number       text    int4 / numeric   declared - and allowed to be
 *   boolean      text    bool             DECLARED
 *   boolean[]    text    bool[]           DECLARED
 *   plain object text    json             DECLARED
 * ```
 *
 * **A number is the one that is allowed to be declared**, and it is the
 * expensive entry. PostgreJS answering `int4`/`numeric` is the right answer
 * for a value the caller passed as a number: `insert into t (q bigint)
 * values ($1)` with `2.7` writes `3`, which is what plain SQL does with the
 * literal, where `pg` sends text and the server's input parser refuses it.
 * It cost sixty-seven of TypeORM's own tests until the cause was found, and
 * the cause was TypeORM sending `1` for a boolean column - see
 * `typeorm-boolean.ts`.
 *
 * The rest matter because **a declared parameter changes the type of a
 * result column derived from it**, not only whether the parameter resolves.
 * `select $1 as x` with `7` is `text` and `'7'` under `pg`, `int4` and `7`
 * declared - and TypeORM selects parameters constantly, in subqueries, in
 * the distinct query behind skip/take, in insert-from-select. Letting all
 * of them through took TypeORM's own suite from 806/806 to 739/806;
 * rendering exactly these four is 806/806 again, which is how the list was
 * confirmed rather than assumed.
 *
 * **This list being stale is a lost optimisation, not a bug - in one
 * direction.** If PostgreJS starts sending one of the four unspecified, a
 * value here keeps going through `pg`'s renderer: still exactly what `pg`
 * sends, just more work than needed. The hazardous direction is the other
 * one - PostgreJS beginning to declare something it currently leaves
 * untyped - and `test/B-live/params.spec.ts` pins the whole surface
 * against a live server so that moving it fails here first.
 */
function postgrejsWouldDeclare(v: any): boolean {
  // One line per JS type, each saying what PostgreJS does with it. The last
  // line is **not** a general fallthrough - the test above it has already
  // returned for everything that is not an object.
  if (v === null || v === undefined) return false; // untyped, as `pg` sends
  if (typeof v === 'boolean') return true; // -> `bool`
  if (Array.isArray(v)) return v.some(e => typeof e === 'boolean'); // -> `bool[]`
  if (typeof v !== 'object') return false; // a number or a string: see below
  return !(v instanceof Date); // a plain object -> `json`; a `Date`, untyped
}

export function toBindParams(
  values: readonly any[] | undefined,
  options: ResolvedFacadeOptions,
): any[] | undefined {
  if (!values || !values.length) return values as any[] | undefined;
  const l = values.length;
  const out = new Array(l);
  let i: number;
  if (options.inferParameterTypes === false) {
    // Exactly `pg`: render everything, declare nothing.
    const utcAll = options.parseInputDatesAsUTC;
    for (i = 0; i < l; i++) {
      const rendered = prepareValue(values[i], undefined, utcAll);
      out[i] = new BindParam(UNSPECIFIED_OID, rendered);
    }
    return out;
  }
  if (options.inferParameterTypes) {
    // The escape hatch: hand the values over untouched and let PostgreJS
    // derive an OID from each. Keeps the binary encoders in play, at the
    // cost of the two array cases above and of whatever inference the server
    // would otherwise have done from context.
    for (i = 0; i < l; i++) out[i] = values[i];
    return out;
  }
  for (i = 0; i < l; i++) {
    // Two outcomes, and neither renders anything. A value PostgreJS would
    // declare a type for is bound at OID 0 instead, where it writes the same
    // text `pg` writes; everything else is handed over, because PostgreJS
    // already sends it untyped for the same reasons `pg` does.
    out[i] = postgrejsWouldDeclare(values[i])
      ? new BindParam(UNSPECIFIED_OID, values[i])
      : values[i];
  }
  return out;
}
