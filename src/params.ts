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
 * ## What `pg`'s renderer is still for
 *
 * `prepare-value.ts` is a port of `pg`'s own function, held to it by a test
 * that calls both. It stays, and `inferParameterTypes: false` runs it over
 * everything for code that wants the old behaviour exactly.
 *
 * **`parseInputDatesAsUTC` only has meaning there.** It is an option of
 * `pg`'s renderer, and a `Date` no longer reaches it on the default path -
 * PostgreJS sends one untyped, carrying the process's own offset, which is
 * what `pg` sends anyway.
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
 *   number       text    int4 / numeric   DECLARED
 *   boolean      text    bool             DECLARED
 *   boolean[]    text    bool[]           DECLARED
 *   plain object text    json             DECLARED
 * ```
 *
 * The four matter because **a declared parameter changes the type of a
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
  if (v === null || v === undefined) return false;
  const t = typeof v;
  if (t === 'number' || t === 'boolean') return true;
  if (Array.isArray(v)) return v.some(e => typeof e === 'boolean');
  if (t !== 'object') return false;
  return !(v instanceof Date);
}

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
    if (!postgrejsWouldDeclare(values[i])) {
      // PostgreJS sends this one unspecified too, so its own path is `pg`'s
      // answer reached more cheaply. See `postgrejsWouldDeclare`.
      out[i] = values[i];
      continue;
    }
    v = prepareValue(values[i], undefined, utc);
    // A Buffer keeps its bytes - `prepareValue` returns it unchanged - but
    // it is still bound at OID 0, which is the correction. Handed to
    // PostgreJS directly it declares `bytea`, where `pg` declares nothing
    // and lets the server decide: `select $1` on raw bytes is 22021 under
    // `pg` and a Buffer back without this. Both answer `0102ff` for
    // `$1::bytea`, which is why it went unnoticed until the surface was
    // pinned.
    out[i] = new BindParam(UNSPECIFIED_OID, v);
  }
  return out;
}
