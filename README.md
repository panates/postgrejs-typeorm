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

## What you get

### Your reads get faster, and you change nothing to get it

`pg` asks PostgreSQL for **everything as text** and parses it in JavaScript. PostgreJS reads the
binary wire format, where an `int8` is eight bytes rather than a string to scan and a `timestamptz`
is an integer rather than a date to parse. That difference shows up as soon as rows have to be
decoded:

```
== through TypeORM                        pg      facade     delta

find 5000 entities                    16.611      13.868     -16.5%
find 100 entities                      0.864       0.739     -14.5%
findOneBy                              0.605       0.547      -9.6%
queryBuilder + where (500 rows)        2.472       2.152     -12.9%
save one entity                        0.937       0.977      +4.2%
```

Milliseconds, median. **Reads land 10-17% faster**; writes are inside the noise and swing either way
between runs, so read them as "unchanged". The gain scales with how much there is to decode - which
is the honest way to read the table, and the reason it includes a shape that must *not* move:

```
== raw pool.query()                       pg      facade     delta

select 100 rows                        0.665       0.567     -14.7%
count + filter (one row, after a scan) 1.450       1.490      +2.7%
```

`count` returns a single row after a scan the server dominates. Neither driver can win it, and it
comes out level - which is what makes the rest of the table worth believing.

Measure it yourself, on your own data and your own machine:

```bash
npx tsx scripts/bench.mts
```

The script alternates the two drivers **call by call inside one run** and reports medians, because
running all of A and then all of B measures the page cache and the JIT rather than the driver. The
numbers above are Node 24, PostgreSQL 18.4, `pg` 8.23.0, PostgreJS 3.10.0, TypeORM 1.1.1, on an M1
Pro against a local server. **Over a real network the share of time spent decoding is smaller, so expect less.**

### Your rows keep their `pg` values

Zero runtime dependencies, and **nothing is rewritten after decoding**. There is no fixup table
translating PostgreJS's values into `pg`'s behind your back: what the client decodes is what you
get, because where the two used to differ the client was changed rather than papered over here.

The contract is that code written against `pg` sees what it expects. `numeric` and `int8` stay
strings, `money` keeps the server's `$12.34`, ranges are strings, dates are `Date`s - `pg`'s
answers. Nothing in your application has to learn a new type.

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

### Your values can go back the way they came

`interval`, `point` and `circle` arrive as PostgreJS classes. They read exactly like `pg`'s objects -
same keys, same values, same `JSON.stringify` - and they can do one thing more:

```ts
const { rows } = await client.query(`select '(1,2)'::point as p`);
await client.query('insert into shapes (p) values ($1)', [rows[0].p]); // writes itself back
```

Through `pg` that second call fails with `22P02`: its plain object has no way to render itself into
a `point` again, so a value you just read is not a value you can pass on.

### One option, and it has not moved since 2021

`driver` is TypeORM's own option rather than a plugin API this package invented, and the surface
behind it is **18 members** - unchanged from TypeORM 0.2.39, November 2021, through 1.1.1 today. The
same facade was run against 0.3.31 and 1.1.1 with identical results. A seam that small and that
still is one you can upgrade TypeORM across without thinking about it.

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

## How far it is tested

- **806 of 806** on TypeORM's own functional suite, across 127 files - with a `pg` control run over
  the same files, on the same server, in the same invocation.
- **275 tests** of its own, at 99.9% coverage: unit tests, the live matrices above, and 20 TypeORM
  programs run through both drivers and deep-compared.

Running `pg` as a live control, rather than against a table of expected values, is what makes those
numbers mean something - and it is what found the things nobody thought to assert. That TypeORM
reads `rows` and `rowCount` through `hasOwnProperty`, so a class with accessors would make every
query silently return nothing. That `money` has no parser in `pg` at all, so the day PostgreJS
gained one the answers moved. That TypeORM's own catalog query has no `ORDER BY`, so
`getTable().columns` comes back in a plan-dependent order for *both* drivers.

Each of those became a fix in PostgreJS or in this package on the day it was measured, which is why
there is no compatibility code here to read around.

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
- PostgreJS >= 3.10.0
- TypeORM >= 0.3.0 < 2 (optional peer - the facade does not import TypeORM)
- `pg-query-stream`, only for `QueryRunner.stream()` - TypeORM loads it itself

Built for TypeORM, and knex's entry point is covered too: `driver.Client`, the query-config call
form and `pg-query-stream` all answer. `CLAUDE.md` has what the 18 members reach.

## License

BSD-3-Clause
