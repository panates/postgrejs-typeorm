# The decoding tension, measured

PostgreJS registers **125 built-in types** and decodes them into what they are: `Interval`,
`Range`, `Numeric`, a class per geometric type, `inet`/`macaddr`/`bit`/`tsvector` as the strings
the server prints. The worry was that a `pg` facade would have to throw all of that away.

**It does not**, and the gap is narrower than it looked. Measured over 64 scalar and array types
(`docs/DRIVER-DESIGN.md` §6): `pg` itself parses `date`, `timestamp`, `timestamptz`, `json`,
`jsonb`, `bool`, `bytea`, the integer and float families and every array of those - and PostgreJS
already returns the identical value for all of them. `unknownTypesAsString: true` on its own gets
43 of the 64.

What has to be suppressed is a short list: the types where `pg`'s own value is a string and
PostgreJS's is not - `int8`, `numeric`, `time`, `interval`, the geometric family and the range
family - through `fetchAsString`. That is 64/64 on values.

Three types are left where `pg` gives a plain object and PostgreJS a class instance: `interval`,
`point` and `circle`. They are **not** fixed up afterwards. `test/B-live/types.spec.ts` asserts
them as the superset they are, because the class also answers `toPostgres()` - so a `point` read
here goes back to the server as a parameter, where `pg`'s own object fails 22P02. An earlier
version of this note said four types and a post-decode fixup; both were out of date once
`value-shapes.ts` and its dependencies were removed.

## The two divergences people notice

- `numeric` - `pg` returns a string always, `19.99` included. PostgreJS returns a `number`, or a
  `Numeric` when a double cannot carry the value. Keeping PostgreJS's decoding here destroys
  precision, and TypeORM hands the result straight to the user: a `numeric` column has no
  hydration branch.
- `int8` - `pg` returns a string. PostgreJS returns a `number`, or a `BigInt` past 2^53.

## Why `postgrejs-drizzle`'s `fetchAsString` list does not carry over

Drizzle's own `node-postgres` driver overrides `pg`'s parsers for TIMESTAMP, TIMESTAMPTZ, DATE and
INTERVAL to get raw strings, so that list asks for strings where TypeORM wants the `Date` PostgreJS
already gives. Copying it would create a divergence rather than remove one. Those are dialects;
this is a facade.

## What is still open

Whether the facade is `pg`-faithful by default, PostgreJS-faithful by default, or configurable is
**D1** in `docs/DRIVER-DESIGN.md`, now with the cost of each option priced. It is the user's call.
