# typeorm-postgrejs

**Bring [PostgreJS](https://github.com/panates/postgrejs) to [TypeORM](https://typeorm.io) - by
changing one line.**

TypeORM talks to PostgreSQL through [`pg`](https://node-postgres.com). This package is a
`pg`-compatible facade over PostgreJS, so TypeORM runs on PostgreJS's wire-protocol client instead -
without touching an entity, a query or a migration.

```ts
import { DataSource } from 'typeorm';
import * as pgjs from 'typeorm-postgrejs';

export const dataSource = new DataSource({
  type: 'postgres',
  host: '127.0.0.1',
  database: 'postgres',
  username: 'postgres',
  password: 'postgres',
  driver: pgjs, // <- the whole integration
  entities: [/* ... */],
});
```

That is the entire migration. `driver` is TypeORM's own option - its doc comment reads *"defaults
to `require("pg")`"* - and this package is a drop-in for that default: same members, same values
back, different client underneath.

> **Not released yet.** `src/` is written and tested; the decisions still open are at the end of
> [`doc/DRIVER-DESIGN.md`](doc/DRIVER-DESIGN.md).

## What you get

### Your reads get faster, and you change nothing to get it

`pg` asks PostgreSQL for **everything as text** and parses it in JavaScript. PostgreJS reads the
binary wire format, where an `int8` is eight bytes rather than a string to scan and a `timestamptz`
is an integer rather than a date to parse. That difference shows up as soon as rows have to be
decoded:

```
== through TypeORM                        pg      facade     delta

find 5000 entities                    18.998      15.820     -16.7%
find 100 entities                      0.987       0.826     -16.3%
findOneBy                              0.598       0.539      -9.8%
queryBuilder + where (500 rows)        2.892       2.494     -13.8%
save one entity                        1.809       1.876      +3.7%
```

Milliseconds, median. **Reads land 10-17% faster**; writes are inside the noise and swing either way
between runs, so read them as "unchanged". The gain scales with how much there is to decode - which
is the honest way to read the table, and the reason it includes a shape that must *not* move:

```
== raw pool.query()                       pg      facade     delta

select 100 rows                        0.705       0.584     -17.1%
count + filter (one row, after a scan) 1.537       1.557      +1.3%
```

`count` returns a single row after a scan the server dominates. Neither driver can win it, and it
comes out level - which is what makes the rest of the table worth believing.

Measure it yourself, on your own data and your own machine:

```bash
npx tsx scripts/bench.mts
```

The script alternates the two drivers **call by call inside one run** and reports medians, because
running all of A and then all of B measures the page cache and the JIT rather than the driver. The
numbers above are Node 24, PostgreSQL 18.4, `pg` 8.23.0, TypeORM 1.1.1, on an M1 Pro against a local
server. **Over a real network the share of time spent decoding is smaller, so expect less.**

### Your rows keep their `pg` values

Zero runtime dependencies, and **nothing is rewritten after decoding**. There is no fixup table
translating PostgreJS's values into `pg`'s behind your back: what the client decodes is what you
get, and where that is not yet `pg`'s answer it is fixed in the client rather than papered over
here. The short list of what is still open is below.

The facade's contract is that code written against `pg` sees what it expects. `numeric` and `int8`
stay strings, `interval` is a `PostgresInterval`, `point` is `{x, y}`, ranges are strings - `pg`'s
answers, not PostgreJS's richer ones. Nothing in your application has to learn a new type.

This is not a claim, it is the test suite: a **64-type decoding matrix** and a **32-case parameter
matrix** run against a live server with `pg` as the live oracle rather than a table of expected
values, so a change on *either* side is reported instead of quietly agreeing with something stale.

### Some rows come back *more* correct

This one came out of the testing rather than the design. Set a session's `DateStyle` to anything but ISO - a `German` or `SQL` locale
is an ordinary thing for a European deployment - and ask `pg` for a date:

```ts
await client.query(`set datestyle to 'German, DMY'`);
await client.query(`select '2024-03-05'::date as d, '2024-03-05 06:07'::timestamptz as ts`);

// pg      { d: null, ts: null }
// facade  { d: 2024-03-05, ts: 2024-03-05T06:07:00.000Z }
```

`pg` 8.23.0 hands back **`null`** for both, because it only parses PostgreSQL's ISO rendering and has
nowhere else to go. The binary format carries no formatting at all, so the facade is simply immune.
`test/B-live/date-style.spec.ts` holds this across every style and field order.

### And PostgreJS's own types are one option away

If you know the code reading your rows, take the richer values instead - `Interval`, `Range`,
`Numeric`, a class per geometric type:

```ts
new DataSource({
  // ...
  driver: pgjs,
  extra: { postgrejs: { decoding: 'native' } },
});
```

`extra` is TypeORM's passthrough to the pool config, which is where the facade reads its own options.
Behind PgBouncer in transaction pooling mode, the same place takes `{ postgrejs: { prepare: false } }`.
The full list is `PgjsFacadeOptions` in [`src/config.ts`](src/config.ts).

## What it costs you

Nothing hidden, so here is the whole list.

- **A less-travelled client.** `pg` is the most-downloaded package on npm and PostgreJS is a
  different implementation with a different bug surface. Everything below about differential
  testing exists because of that, not in spite of it - and most of what it has caught so far was in
  the facade rather than in PostgreJS.
- **A handful of values still serialise differently.** `interval`, `point` and `circle` come back
  with the same fields under the same names as `pg`'s - `v.x`, `{...v}` and `Object.keys(v)` all
  agree - but `JSON.stringify` gives the string PostgreSQL printed rather than the object, because
  PostgreJS's classes carry their own `toJSON`. An `interval` also carries its zero fields where
  `pg` omits them. Named value by value in `test/B-live/types.spec.ts` and being closed in
  PostgreJS, which is where the decoding belongs.
- **`pg-query-stream`**, but only if you call `QueryRunner.stream()`. TypeORM loads it itself.
- **Not a universal `pg` replacement.** The 18 members TypeORM uses are covered and so is knex's
  entry point; Sequelize wants a parser-function registry PostgreJS has no equivalent of, and
  pg-promise reaches into `pg`'s private protocol object. See `CLAUDE.md` for which is which.

## Why a facade rather than a driver

TypeORM does not take a dialect the way Kysely and Drizzle do, and a custom TypeORM `Driver` class
cannot be registered at all - `DriverFactory` is a closed `switch`. The only seam is `driver?: any`.
So the job is not "implement TypeORM's interface" but "be the `pg` module".

That surface turns out to be small and stable: **18 members**, all public, unchanged since TypeORM
0.2.39 (2021) through 1.1.1 today. It is counted in
[`doc/DRIVER-DESIGN.md`](doc/DRIVER-DESIGN.md) §2, which is also where every decision in `src/` is
argued with the measurement behind it.

## How far it is tested

- **806 of 806** on TypeORM's own functional suite, across 127 files - with a `pg` control run over
  the same files, on the same server, in the same invocation.
- **266 tests** of its own, at 98.9% coverage: unit tests, the live matrices above, and 20 TypeORM
  programs run through both drivers and deep-compared.

The differential tests are the ones that earn their keep. They found what nobody thought to assert:
that TypeORM reads `rows` and `rowCount` through `hasOwnProperty`, so a class with accessors would
make every query silently return nothing; that `postgres-interval`'s major version changes which
fields an interval carries; and that TypeORM's own catalog query has no `ORDER BY`, so
`getTable().columns` comes back in a plan-dependent order for *both* drivers.

```bash
npm test                      # unit, live and differential - needs a server on PGHOST
scripts/run-typeorm-suite.sh  # TypeORM's own suite, with a pg control
npx tsx scripts/bench.mts     # the numbers above
```

The suite script clones and compiles TypeORM at a pinned tag, patches the one function that stops an
`ormconfig.json` carrying a `driver` object, and runs every file twice on a freshly reset database.
It fails only on a test this facade loses that `pg` wins. There is no pinned expected-failure count
on purpose: these tests leave schema behind and read it back, so the same file scores differently
between runs, and only a control measured in the same invocation is worth comparing against.

## Requirements

- Node.js >= 22
- PostgreJS >= 3.7.0
- TypeORM >= 0.3.0 < 2 (optional peer - the facade does not import TypeORM)
- `pg-query-stream`, only for `QueryRunner.stream()`

## License

BSD-3-Clause
