/**
 * `pg`'s own parameter rendering, reimplemented.
 *
 * Ported from `pg@8.23.0`'s `lib/utils.js` - `prepareValue`, `arrayString`,
 * `escapeElement`, `prepareObject`, `dateToString` and `dateToStringUTC` -
 * rather than imported from it. A facade whose purpose is to replace `pg`
 * cannot depend on `pg` at runtime, and this is the one piece of it the
 * facade genuinely needs: what `pg` puts on the wire for a JS value is the
 * behaviour being emulated, so it has to be reproduced rather than
 * approximated.
 *
 * Keep it a faithful port. If it ever has to diverge, say why here.
 */

function escapeElement(elementRepresentation: string): string {
  const escaped = elementRepresentation
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return '"' + escaped + '"';
}

/**
 * A JS array as a PostgreSQL array literal. Comma-separated, so it is wrong
 * for types whose array separator is not a comma (`box`) - which is `pg`'s
 * own documented limitation and is reproduced here deliberately.
 */
function arrayString(val: readonly any[]): string {
  const l = val.length;
  let result = '{';
  let i: number;
  for (i = 0; i < l; i++) {
    if (i > 0) result += ',';
    let item = val[i];
    if (item == null) {
      result += 'NULL';
    } else if (Array.isArray(item)) {
      result += arrayString(item);
    } else if (ArrayBuffer.isView(item)) {
      if (!Buffer.isBuffer(item))
        item = Buffer.from(item.buffer, item.byteOffset, item.byteLength);
      result += '\\\\x' + (item as Buffer).toString('hex');
    } else {
      result += escapeElement(prepareValue(item) as string);
    }
  }
  return result + '}';
}

function dateToString(date: Date): string {
  let offset = -date.getTimezoneOffset();
  let year = date.getFullYear();
  const isBCYear = year < 1;
  // A negative year is one off its BC representation.
  if (isBCYear) year = Math.abs(year) + 1;

  let ret =
    String(year).padStart(4, '0') +
    '-' +
    String(date.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(date.getDate()).padStart(2, '0') +
    'T' +
    String(date.getHours()).padStart(2, '0') +
    ':' +
    String(date.getMinutes()).padStart(2, '0') +
    ':' +
    String(date.getSeconds()).padStart(2, '0') +
    '.' +
    String(date.getMilliseconds()).padStart(3, '0');

  if (offset < 0) {
    ret += '-';
    offset *= -1;
  } else {
    ret += '+';
  }
  ret +=
    String(Math.floor(offset / 60)).padStart(2, '0') +
    ':' +
    String(offset % 60).padStart(2, '0');
  if (isBCYear) ret += ' BC';
  return ret;
}

function dateToStringUTC(date: Date): string {
  let year = date.getUTCFullYear();
  const isBCYear = year < 1;
  if (isBCYear) year = Math.abs(year) + 1;

  let ret =
    String(year).padStart(4, '0') +
    '-' +
    String(date.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(date.getUTCDate()).padStart(2, '0') +
    'T' +
    String(date.getUTCHours()).padStart(2, '0') +
    ':' +
    String(date.getUTCMinutes()).padStart(2, '0') +
    ':' +
    String(date.getUTCSeconds()).padStart(2, '0') +
    '.' +
    String(date.getUTCMilliseconds()).padStart(3, '0');

  ret += '+00:00';
  if (isBCYear) ret += ' BC';
  return ret;
}

function prepareObject(val: any, seen?: any[]): string {
  if (val && typeof val.toPostgres === 'function') {
    seen = seen || [];
    if (seen.indexOf(val) !== -1)
      throw new Error(
        'circular reference detected while preparing "' + val + '" for query',
      );
    seen.push(val);
    return prepareValue(val.toPostgres(prepareValue), seen) as string;
  }
  return JSON.stringify(val);
}

/**
 * The value `pg` would put on the wire: a string, a `Buffer`, or null.
 *
 * `parseInputDatesAsUTC` mirrors `pg`'s `defaults.parseInputDatesAsUTC`. It
 * is passed in rather than read from a module-level singleton, so two pools
 * in one process cannot change each other's behaviour - which is a real
 * hazard with `pg`'s own global defaults and not worth reproducing.
 */
export function prepareValue(
  val: any,
  seen?: any[],
  parseInputDatesAsUTC = false,
): string | Buffer | null {
  // null and undefined are both NULL to PostgreSQL.
  if (val == null) return null;
  if (typeof val === 'object') {
    if (Buffer.isBuffer(val)) return val;
    if (ArrayBuffer.isView(val))
      return Buffer.from(val.buffer, val.byteOffset, val.byteLength);
    if (val instanceof Date)
      return parseInputDatesAsUTC ? dateToStringUTC(val) : dateToString(val);
    if (Array.isArray(val)) return arrayString(val);
    return prepareObject(val, seen);
  }
  return val.toString();
}
