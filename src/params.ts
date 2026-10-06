import { BindParam } from 'postgrejs';
import type { ResolvedFacadeOptions } from './config.js';
import { UNSPECIFIED_OID } from './constants.js';
import { prepareValue } from './prepare-value.js';

/*
 * Parameters. Nothing is rendered: a value PostgreJS would otherwise declare
 * a type for is bound at OID 0, where it writes what `pg` writes, and
 * everything else is handed over - PostgreJS already sends it untyped.
 *
 * `inferParameterTypes` picks a different policy: `true` hands every value
 * over, `false` renders every value with `pg`'s own function and declares
 * nothing, which is `pg` byte for byte.
 *
 * **Why those three and what each costs is `doc/DRIVER-DESIGN.md` §5**, with
 * the measurements. The short version is that a declared type does not only
 * decide whether a parameter resolves - it also decides the type of a result
 * column derived from it - and that a number is the one value this package
 * lets PostgreJS declare.
 */

/*
 * Would PostgreJS declare a type for this value, where `pg` declares none?
 * Those are bound at OID 0; the rest are handed over.
 *
 * The list is measured rather than reasoned - `doc/DRIVER-DESIGN.md` §5.2 has
 * the table and how it was arrived at - and
 * `test/B-live/params.spec.ts` pins it against a live server, because a
 * value moving between the two groups upstream is a correctness change here
 * and nothing else would notice.
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
