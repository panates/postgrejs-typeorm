import { DataTypeOIDs } from 'postgrejs';

/**
 * The OID `pg` declares for every parameter: unspecified, so PostgreSQL
 * resolves the type from where the placeholder appears rather than from the
 * value. Everything this facade sends is declared this way - see `params.ts`.
 */
export const UNSPECIFIED_OID = 0;

/**
 * Range and multirange OIDs. `DataTypeOIDs` does not name all of them and
 * `pg` hands every range back as a string, so they are listed here to be
 * asked for as text.
 */
const RANGE_OIDS: number[] = [
  // int4range  numrange  tsrange  tstzrange  daterange  int8range
  3904, 3906, 3908, 3910, 3912, 3926,
  // and their array forms
  3905, 3907, 3909, 3911, 3913, 3927,
  // the multirange family, scalar then array
  4451, 4532, 4533, 4534, 4535, 4536, 6150, 6151,
];

/**
 * OIDs asked for as text, because `pg`'s own value for them is a string and
 * PostgreJS decodes them into something else.
 *
 * Derived by measurement over 64 scalar and array types, not by reading the
 * catalog - see `doc/DRIVER-DESIGN.md` §6. Two things about the list are
 * easy to get wrong:
 *
 * - `interval` is **not** here either, though `pg`'s value for it is an
 *   object and PostgreJS's is an `Interval`. Asking for text would hand back
 *   a bare string, which is further from `pg` than the class is - the class
 *   carries the same seven fields under the same names. What is left between
 *   them is `toJSON` and `pg`'s sparseness, and that is a question for the
 *   decoder: `../postgrejs/.claude/pg-compatible-decoding.md`.
 * - `date`, `timestamp`, `timestamptz` and their array forms are **not**
 *   here. `pg` parses those into `Date` objects and PostgreJS returns the
 *   identical `Date`; asking for text would create a divergence rather than
 *   remove one. This is where `postgrejs-drizzle`'s list differs and must
 *   not be copied - its driver overrides pg's parsers to get raw strings.
 * - `_numeric` is the awkward one. `pg`'s array parser runs `parseFloat` per
 *   element even though scalar `numeric` stays a string - an inconsistency of
 *   `pg`'s, not a principle. Naming `numeric` here now reaches `numeric[]`
 *   too, which is the more defensible behaviour and the wrong one for a
 *   facade, so the elements are turned back into numbers afterwards.
 */
export const FETCH_AS_STRING_OIDS: number[] = [
  DataTypeOIDs.int8,
  DataTypeOIDs.numeric,
  DataTypeOIDs.time,
  // `pg-types` registers no parser for `money` at all, so `pg` hands back
  // the server's own text - symbol, grouping and the scale `lc_monetary`
  // decides: `$99,999,999,999,999.99`. PostgreJS gained a decoder for it
  // (upstream `285097e`) and returns a number, which drops all three. Asking
  // for text gets `pg`'s answer byte for byte.
  DataTypeOIDs.money,
  DataTypeOIDs.line,
  DataTypeOIDs.lseg,
  DataTypeOIDs.box,
  DataTypeOIDs.path,
  DataTypeOIDs.polygon,
  // An array OID here means the whole literal comes back as one string, not
  // as a JS array - so it belongs here only where `pg` also hands back a
  // string, which it does for these five and for `circle[]`. Measured: pg has
  // no array parser for the geometric family beyond `point[]`.
  DataTypeOIDs._line,
  DataTypeOIDs._lseg,
  DataTypeOIDs._box,
  DataTypeOIDs._path,
  DataTypeOIDs._polygon,
  DataTypeOIDs._circle,
  // Deliberately NOT here, though their scalar forms are: `pg` parses these
  // into real arrays, so asking for the literal would be a worse answer than
  // PostgreJS's own decoding.
  //   _money, _int8, _numeric, _interval, _point
  //
  // The first three need nothing at all now. Since upstream `313c71e`,
  // naming a **scalar** OID also asks for that type's array columns as an
  // array of the server's strings - which is exactly `pg`'s answer for
  // `money[]` and `int8[]`, and is why neither needs a fixup any more. The
  // array OIDs above still mean "the whole literal, verbatim", so the two
  // asks stay distinguishable by which OID is named.
  ...RANGE_OIDS,
].filter(oid => typeof oid === 'number');

/** What `pg`'s pool defaults to when `max` is not given. */
export const DEFAULT_POOL_MAX = 10;
