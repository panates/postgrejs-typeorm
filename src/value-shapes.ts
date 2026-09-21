import { DataTypeOIDs } from 'postgrejs';
import postgresInterval from 'postgres-interval';

/**
 * The four shapes no wire option can produce.
 *
 * `fetchAsString` gets the server's own text and PostgreJS's decoders give a
 * class instance, but for these four `pg` gives a plain object or an array of
 * strings - a third shape that is neither end of the wire. So they are mapped
 * after decoding. Measured, this is what takes the type matrix from 58/64 to
 * 64/64 (`doc/DRIVER-DESIGN.md` §6).
 *
 * `postgres-interval` is a dependency for exactly one of them, and it is the
 * one that cannot be approximated: `pg` returns a `PostgresInterval`
 * instance, whose seven fields PostgreJS's own `Interval` already matches
 * value for value - but whose `toPostgres()`, `toISOString()` and prototype
 * it does not. The package is what `pg` itself uses (through `pg-types`), is
 * a single file with no dependencies of its own, and is already in the tree
 * of anyone who has `pg` installed. Reimplementing its parser here would be
 * an approximation of a thing that has to be exact.
 */
type Fixup = (value: any) => any;

const FIXUPS = new Map<number, Fixup>(
  (
    [
      // `interval` is asked for as text (see constants.ts), so what arrives
      // here is the server's own rendering and postgresInterval() parses it
      // the same way `pg` does.
      [DataTypeOIDs.interval, (v: string) => postgresInterval(v)],
      // `interval[]` is NOT asked for as text - `pg` parses it into an array
      // of intervals, so PostgreJS's own array decoding is the closer start
      // and each element is converted from its text form.
      [
        DataTypeOIDs._interval,
        (v: any[]) => v.map(i => (i == null ? i : postgresInterval(String(i)))),
      ],
      // PostgreJS decodes these into classes of its own; `pg` gives plain
      // objects. Same fields, except that Circle names its radius `r`.
      // `circle[]` is absent on purpose: `pg` has no array parser for it and
      // hands back the literal, so it is asked for as text instead.
      [DataTypeOIDs.point, (v: any) => ({ x: v.x, y: v.y })],
      [
        DataTypeOIDs._point,
        (v: any[]) => v.map(p => (p == null ? p : { x: p.x, y: p.y })),
      ],
      [DataTypeOIDs.circle, (v: any) => ({ x: v.x, y: v.y, radius: v.r })],
      // `pg` leaves int8 array elements as strings. PostgreJS decodes them
      // into numbers, and into BigInt past 2^53 - and String(bigint) is
      // exact, so this loses nothing.
      [
        DataTypeOIDs._int8,
        (v: any[]) => v.map(n => (n == null ? n : String(n))),
      ],
    ] as [number, Fixup][]
  ).filter(([oid]) => typeof oid === 'number'),
);

/** The fixup for a column's type, or undefined when it needs none. */
export function fixupFor(dataTypeId: number | undefined): Fixup | undefined {
  return dataTypeId === undefined ? undefined : FIXUPS.get(dataTypeId);
}
