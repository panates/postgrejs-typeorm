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
 * - `date`, `timestamp`, `timestamptz` and their array forms are **not**
 *   here. `pg` parses those into `Date` objects and PostgreJS returns the
 *   identical `Date`; asking for text would create a divergence rather than
 *   remove one. This is where `postgrejs-drizzle`'s list differs and must
 *   not be copied - its driver overrides pg's parsers to get raw strings.
 * - `_numeric` is not here either: `pg`'s array parser runs `parseFloat` per
 *   element even though scalar `numeric` stays a string, and PostgreJS agrees.
 */
export const FETCH_AS_STRING_OIDS: number[] = [
  DataTypeOIDs.int8,
  DataTypeOIDs.numeric,
  DataTypeOIDs.time,
  DataTypeOIDs.interval,
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
  // `money[]` is here for a different reason than the geometric arrays: `pg`
  // *does* give a real array for it (`register(791, parseStringArray)`), but
  // its elements are the server's text, which cannot be rebuilt from the
  // numbers PostgreJS decodes. So the literal is fetched and split with the
  // same library `pg` splits it with - see value-shapes.ts.
  DataTypeOIDs._money,
  // Deliberately NOT here, though their scalar forms are: `pg` parses these
  // into real arrays, so asking for the literal would be a worse answer than
  // PostgreJS's own decoding. They are mapped element by element instead -
  // see value-shapes.ts.
  //   _interval, _point, _int8
  ...RANGE_OIDS,
].filter(oid => typeof oid === 'number');

/** What `pg`'s pool defaults to when `max` is not given. */
export const DEFAULT_POOL_MAX = 10;
