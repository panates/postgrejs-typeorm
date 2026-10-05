# typeorm-postgrejs

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![CI Tests][ci-test-image]][ci-test-url]

A `pg`-compatible facade over [PostgreJS](https://github.com/panates/postgrejs) for
[TypeORM](https://typeorm.io). Put it where `pg` goes and everything above it stays the same - your
entities, your queries, your migrations.

<!-- bench:intro -->

It is faster where it counts and holds far less memory doing it. A 4 MB `bytea` comes back in
16.570 ms against 37.206 ms, and at 4.1 MB a call against 51.6 MB - `pg` reads that column as
hex text, twice the size, off the JS heap where a heap figure alone cannot see it. A
100 000-element `int4[]` runs 3.83x, at 2.2 MB against 22.7 MB. Ordinary queries gain less and gain it
repeatably: a point read is the faster of the two in 361 of 401 alternated pairs. All of it
measured through TypeORM against `pg` on the same server: [`doc/BENCHMARKS.md`](doc/BENCHMARKS.md).

<!-- /bench:intro -->

And the client underneath can do things TypeORM has no way to ask for.

## Install

```sh
npm install typeorm-postgrejs postgrejs
```

`postgrejs` (>=3.10.0 <4) is a peer dependency; `typeorm` (>=0.3.0 <2) is an optional one, because
this package never imports TypeORM. Node >=22. There are no runtime dependencies.

## Quick start

```ts
import { DataSource } from 'typeorm';
import * as pgjs from 'typeorm-postgrejs';

export const dataSource = new DataSource({
  type: 'postgres',
  url: 'postgres://localhost:5432/mydb',
  driver: pgjs, // <- the whole change
  entities: [
    /* ... */
  ],
});
```

That is the whole change. `driver` is TypeORM's own option - its doc comment reads *"The driver
object. This defaults to `require("pg")`."* - so this goes where that default was.

## Usage

### Connecting

Everything `pg` accepts, accepted the same way:

```ts
new DataSource({ type: 'postgres', driver: pgjs, url: 'postgres://user:secret@host/db' });
new DataSource({ type: 'postgres', driver: pgjs, host: 'localhost', database: 'mydb' });
new DataSource({ type: 'postgres', driver: pgjs, extra: { max: 20, idleTimeoutMillis: 30_000 } });
```

Migrations, the query builder, the schema tools and `QueryRunner.stream()` all work unchanged;
`pg-query-stream` is only needed if you call the last of those, and TypeORM loads it itself.

### Options

This package's own options go under `postgrejs` in TypeORM's `extra`, which
`PostgresDriver.createPool()` merges straight into the object the pool is constructed with:

```ts
new DataSource({
  // ...
  driver: pgjs,
  extra: { postgrejs: { decoding: 'native' } },
});
```

| option | default | what it does |
| --- | --- | --- |
| `decoding` | `'pg'` | `'native'` gives PostgreJS's own richer values instead of `pg`'s - a `Numeric` that keeps every digit, a `BigInt` past 2^53, typed geometric and `Range` classes. Opt in only if you know the code reading those rows: TypeORM has no hydration branch for a `numeric` column, so a `Numeric` reaches the user where a string was expected |
| `fetchAsString` | - | extra OIDs to ask the server for as text, on top of the list `'pg'` mode already uses. An entry is an OID or `{ oid, arrays: false }`, which asks for a scalar without its array columns |
| `prepare` | PostgreJS's default | `false` for PgBouncer in transaction pooling mode before 1.21, where a named statement does not survive to the next call. It turns off the one mechanism measured separately below |
| `normalizeErrors` | `true` | makes a caught error look like `pg`'s: the caret diagram out of `message`, `position` as a string. The structured fields are identical either way |
| `suppressRedundantPoolError` | `true` | PostgreJS reports a dead pooled connection on the pool *and* rejects the in-flight query; `pg` only rejects the query. This drops the duplicate |
| `parseInputDatesAsUTC` | `false` | mirrors `pg`'s `defaults.parseInputDatesAsUTC`: render a `Date` parameter from its UTC fields rather than its local ones |
| `inferParameterTypes` | `false` | lets PostgreJS declare an OID per parameter from the JS value, instead of sending every parameter unspecified the way `pg` does |

## Why

It is a drop-in swap for `pg`: the same `driver` option, the same entities, the same queries, the
same migrations. What you get for it:

<!-- bench:payload -->

- **Faster where the payload is large** - 2.25x on a 4 MB `bytea` and 3.83x on a
  100 000-element `int4[]`, on a fraction of the memory, because the values arrive in
  PostgreSQL's binary format rather than as text to be parsed.

<!-- /bench:payload -->

- **Slightly faster on ordinary round trips**, repeatably - statements are prepared and reused
  without anyone asking for it.
- **Correct dates on a server whose `DateStyle` is not `ISO`**, where `pg` hands back `null`.
- **A client that can do what TypeORM has no way to ask for** - cursors, `COPY`, `LISTEN`/`NOTIFY`,
  large objects and logical replication, on the same pool your queries use, through
  `client.connection`.
- **Checked against TypeORM's own functional suite** - 806 of its tests pass, with `pg` run over the
  same files on the same server in the same invocation as the control.

<!-- bench:headline -->

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| findOneBy - 1 entity of 9 columns | 0.343 ms<br>**64 KB/call** | **0.287 ms**<br>71 KB/call | **1.19x**<br>+10% |
| find 100 entities - 100 entities of 9 columns | 0.668 ms<br>427 KB/call | **0.561 ms**<br>**316 KB/call** | **1.19x**<br>**-26%** |
| find 5000 entities - 5000 entities of 9 columns | 9.548 ms<br>16.5 MB/call | **6.981 ms**<br>**11.1 MB/call** | **1.37x**<br>**-33%** |
| queryBuilder, 500 entities - 500 entities after a where and an order by | 1.339 ms<br>1.7 MB/call | **1.146 ms**<br>**1.1 MB/call** | **1.17x**<br>**-38%** |
| save one entity - 1 entity of 1 assigned column | 0.765 ms<br>**79 KB/call** | **0.704 ms**<br>103 KB/call | **1.09x**<br>+29% |
| point read - 1 row of 9 columns | 0.281 ms<br>**17 KB/call** | **0.238 ms**<br>20 KB/call | **1.18x**<br>+16% |
| page of 100 - 100 rows of 9 columns, mixed types | 0.551 ms<br>247 KB/call | **0.465 ms**<br>**157 KB/call** | **1.18x**<br>**-36%** |
| insert one row - 1 row of 2 columns | 0.270 ms<br>**9 KB/call** | **0.230 ms**<br>16 KB/call | **1.17x**<br>+80% |
| bytea of 4 MB - 1 row holding 4 MB | 37.206 ms<br>51.6 MB/call | **16.570 ms**<br>**4.1 MB/call** | **2.25x**<br>**-92%** |
| int4[] of 100k - 1 row holding 1 array of 100 000 values | 23.040 ms<br>22.7 MB/call | **6.017 ms**<br>**2.2 MB/call** | **3.83x**<br>**-90%** |

TypeORM 1.1.1, `pg` 8.23.0, PostgreJS 3.12.1, PostgreSQL 18.6, loopback, Node 24.15.0. Medians per call, and allocation per call. How that was measured and how far each row can be trusted are in [How the numbers were measured](#how-the-numbers-were-measured); the full set is in [`doc/BENCHMARKS.md`](doc/BENCHMARKS.md).

<!-- /bench:headline -->

**The gain follows the payload, not the query.** An ordinary read or write gains a little and gains
it consistently; a column that carries bulk - an array, a `bytea`, anything large - gains twice
over, in time and in memory. It allocates *more* on the smallest calls, where a fixed per-call cost
has nothing to amortise against. A schema of text, integers and timestamps will see the top of that
table and not the bottom.

## How the numbers were measured

Both clients run in one process and alternate on every pair, so neither gets a warmer machine. Each
figure is a median. Memory is a separate pass, one child process per client, because a baseline
taken with both alive has their pools and buffers under it rather than in it.

The medians alone would not be worth much - on a shared machine the absolute figures drift by more
than the differences do - so which of the two won each pair is counted separately:

<!-- bench:signtest -->

| workload | pairs | `typeorm-postgrejs` faster in | odds of that by luck |
| --- | --- | --- | --- |
| point read | 401 | 361 | < 1 in 10^18 |
| page of 100 | 201 | 177 | < 1 in 10^18 |
| all 5000 rows | 61 | 57 | < 1 in 10^12 |
| float8 spread over rows | 61 | 55 | < 1 in 10^10 |
| float8 packed in one row | 61 | 61 | < 1 in 10^18 |
| int4[] of 100k | 41 | 41 | < 1 in 10^12 |
| bytea of 4 MB | 41 | 41 | < 1 in 10^12 |
| uuid of 5k rows | 61 | 55 | < 1 in 10^10 |
| box of 5k rows | 61 | 48 | < 1 in 10^5 |
| insert one row | 401 | 373 | < 1 in 10^18 |
| insert 500 rows | 61 | 57 | < 1 in 10^12 |
| write a 100k int4[] | 41 | 19 | not significant |
| twenty inserts in a transaction | 61 | 60 | < 1 in 10^16 |
| concurrent reads | 61 | 43 | < 1 in 10^2 |
| findOneBy | 201 | 186 | < 1 in 10^18 |
| find 100 entities | 201 | 179 | < 1 in 10^18 |
| find 5000 entities | 61 | 59 | < 1 in 10^14 |
| queryBuilder, 500 entities | 101 | 86 | < 1 in 10^12 |
| findOne with a 4 MB bytea | 41 | 41 | < 1 in 10^12 |
| findOne with a 100k int4[] | 41 | 41 | < 1 in 10^12 |
| save one entity | 201 | 170 | < 1 in 10^18 |

<!-- /bench:signtest -->

That is a sign test: only which client won counts, and by how much is thrown away, which is what
makes it survive a noisy machine.

**Every scenario is one the client dominates**, and that is a selection rule rather than a
coincidence. A shape where PostgreSQL does most of the work measures PostgreSQL: its ratio is set
by how much scanning or writing was asked for, and a reader takes it for a property of the
workload. The one row here whose clock is not the client's is the 4 MB write, where both sides are
pushing bytes through a socket at the same speed - it is kept for its allocation column and says
so.

There was a deliberately server-dominated row as a control, on the theory that a shape neither
client can win is the cheapest check on a whole run. It was removed: swept across scan sizes its
speedup read 1.04x, 0.95x, 1.00x and 0.94x, twice significant in opposite directions, so it was not
doing that job either. The sign test is the guard instead, and it is the per-row version of the
same check.

```sh
npm run bench          # both passes, writes benchmark/results/latest.json
npm run bench:report   # regenerates this file's tables and doc/BENCHMARKS.md
```

The second measures nothing, which is the point: a measurement takes tens of minutes and the wording
gets rewritten a dozen times. [`doc/BENCHMARKS.md`](doc/BENCHMARKS.md) has every scenario, what each
client holds between calls, which mechanism earns which row, and why a per-call peak is not among
them.

## Tested against TypeORM's own suite

`scripts/run-typeorm-suite.sh` runs TypeORM's own functional suite - the one TypeORM ships and runs
its own driver through - against this facade, with `pg` over the same files, on the same server, in
the same invocation, as the control:

```
  pg (control)         806 / 806   (127 files)
  typeorm-postgrejs    806 / 806   (127 files)
```

Same tests, and both pass every one: **not a single test this facade loses that `pg` wins.** There
is no expected-failure list either, and that is deliberate rather than lazy - these tests leave
schema behind and read it back, so the same file scores differently between two runs of the *same*
driver. `create-table.test.js` scored 1/4 and then 5/0 with nothing changed. Only a control measured
in the same invocation is worth comparing against.

The script clones and compiles TypeORM at a pinned tag and patches one function - `getTypeOrmConfig()`,
because an `ormconfig.json` cannot carry a `driver` object - then runs every file twice, each in its
own process, on a freshly reset database. Without `PG_CONNECTION_STRING` it starts a container on a
free port and removes it afterwards.

On top of that, **275 tests** of this package's own at 99.9% coverage, and a differential suite among
them that runs 20 TypeORM programs through `pg` as well and deep-compares the two.

## What changes when you switch

Measured by a 64-type decoding matrix and a 32-case parameter matrix that run every case through
both. Everywhere not listed here the two agree exactly - `numeric` and `int8` are strings, `money`
keeps the server's `$12.34`, ranges are strings, dates are `Date`s.

### Values

| case | `pg` | `typeorm-postgrejs` |
| --- | --- | --- |
| any date type on a server whose `DateStyle` is not `ISO` | `null` | the stored value |
| `interval`, `point`, `circle` | a plain object | the same keys and values, plus `toPostgres()` |
| a connection lost mid-statement | rejects `57P01` | rejects `08006` |
| a pooled connection that dies while **idle** | nothing | `pool.on('error')` with `08006` |

### `DateStyle`, where this package is right and `pg` is not

A `German` or `SQL` locale is an ordinary thing for a European deployment, and `pg` cannot read what
the server then writes:

```ts
await client.query(`set datestyle to 'German, DMY'`);
await client.query(`select '2024-03-05'::date as d, '2024-03-05 06:07'::timestamptz as ts`);

// pg                  { d: null, ts: null }
// typeorm-postgrejs   { d: 2024-03-05, ts: 2024-03-05T06:07:00.000Z }
```

`pg` 8.23.0 parses only PostgreSQL's ISO rendering and has nowhere else to go. The binary format
carries no formatting at all. `test/B-live/date-style.spec.ts` holds this across four styles and
three field orders, on both wire formats.

### Values that can be written back

`interval`, `point` and `circle` arrive as PostgreJS classes. They read exactly like `pg`'s objects -
same keys, same values, same `JSON.stringify` - and they can do one thing more:

```ts
const { rows } = await client.query(`select '(1,2)'::point as p`);
await client.query('insert into shapes (p) values ($1)', [rows[0].p]); // writes itself back
```

Through `pg` that second call fails with `22P02`: its plain object has no way to render itself into
a `point` again, so a value you just read is not a value you can pass on.

### A lost connection

Both reject the in-flight query and both emit `'error'` on the client, so a handler written for `pg`
keeps working. The SQLSTATE differs - `pg` reports the server's own `57P01`, this reports `08006`
for the connection itself - and the error here carries `processID`.

The pool is the other half. `pg` raises nothing there; PostgreJS reports a lost pooled connection on
`pool.on('error')` as well. Where a caller already has the error the duplicate is dropped
(`suppressRedundantPoolError`); where the connection died **idle** and nobody would otherwise hear
about it, it is reported.

### Concurrent `query()` on one client

`pg` queues every `query()` per client and starts the next only when the previous has settled. This
facade does the same, which means it gives up PostgreJS's pipelining - worth about 10x on one
connection - on purpose: a `create temp table` and an `insert` into it, issued together, must not
race, and nothing written against `pg` can depend on the other behaviour. `client.connection` is the
real PostgreJS `Connection` and is not queued.

## Development

The unit tests need nothing; the live and differential ones need a PostgreSQL at `127.0.0.1:5432`
(`postgres`/`postgres`, database `postgres`), which `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and
`PGDATABASE` override.

```sh
npm test            # unit, live and differential tests
npm run citest      # the same, with coverage
npm run typecheck   # tsc --noEmit

rman build          # check, lint, clean, compile, stamp - the whole pipeline
rman lint           # eslint over the repository
rman check          # circular dependency check
rman format         # prettier

scripts/run-typeorm-suite.sh   # TypeORM's own suite, on a database of its own
npm run bench                  # the benchmarks, then `npm run bench:report`
```

`lint`, `check`, `format` and the build are commands `@panates/rman-preset` contributes rather than
scripts in `package.json`, so the flags behind them are pinned once for every repository that
extends it. `.rmanrc.yml` is one line; `rman config --from-root` prints what it resolves to.

The tests come in three kinds, and the split is deliberate:

- `test/A-common` - no server. Option translation, the parameter policy, the result reshape, error
  normalisation. `prepare-value.spec.ts` compares against `pg`'s own function rather than a table
  someone wrote down.
- `test/B-live` - against a real server, with **`pg` as the control rather than an expected value**,
  so a change on either side is reported instead of silently agreeing with a stale table.
- `test/C-differential` - the same TypeORM programs through this facade and through `pg`,
  deep-compared. It is what catches a difference nobody thought to assert.

[`doc/DRIVER-DESIGN.md`](doc/DRIVER-DESIGN.md) is why the facade is shaped the way it is, with the
measurement behind every claim.

## License

BSD-3-Clause

[npm-image]: https://img.shields.io/npm/v/typeorm-postgrejs
[npm-url]: https://npmjs.org/package/typeorm-postgrejs
[downloads-image]: https://img.shields.io/npm/dm/typeorm-postgrejs.svg
[downloads-url]: https://npmjs.org/package/typeorm-postgrejs
[ci-test-image]: https://github.com/panates/postgrejs-typeorm/actions/workflows/test.yml/badge.svg
[ci-test-url]: https://github.com/panates/postgrejs-typeorm/actions/workflows/test.yml
