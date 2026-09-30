# typeorm-postgrejs

A `pg`-compatible facade over [PostgreJS](https://github.com/panates/postgrejs), so
[TypeORM](https://typeorm.io) runs on PostgreJS's wire-protocol client instead of
[`pg`](https://node-postgres.com).

## Install

```sh
npm install typeorm-postgrejs postgrejs
```

`postgrejs` (>=3.10.0 <4) is a peer dependency; `typeorm` (>=0.3.0 <2) is an optional one, because
this package never imports TypeORM. Node >=22. There are no runtime dependencies.

## Usage

`driver` is TypeORM's own option - its doc comment reads *"The driver object. This defaults to
`require("pg")`."* - so this package goes where that default was:

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
  entities: [
    /* ... */
  ],
});
```

That is the entire migration: no entity, query or migration changes. A connection string and the
pool options work exactly as they do with `pg`:

```ts
new DataSource({ type: 'postgres', driver: pgjs, url: 'postgres://user:secret@localhost/mydb' });
new DataSource({ type: 'postgres', driver: pgjs, extra: { max: 20, idleTimeoutMillis: 30_000 } });
```

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
| `prepare` | PostgreJS's default | `false` for PgBouncer in transaction pooling mode before 1.21, where a named statement does not survive to the next call. It turns off the largest single speedup this package has - see [Where the speed comes from](#where-the-speed-comes-from) |
| `normalizeErrors` | `true` | makes a caught error look like `pg`'s: the caret diagram out of `message`, `position` as a string. The structured fields are identical either way |
| `suppressRedundantPoolError` | `true` | PostgreJS reports a dead pooled connection on the pool *and* rejects the in-flight query; `pg` only rejects the query. This drops the duplicate, so you do not get a `Postgres pool raised an error` warning `pg` never produces |
| `parseInputDatesAsUTC` | `false` | mirrors `pg`'s `defaults.parseInputDatesAsUTC`: render a `Date` parameter from its UTC fields rather than its local ones |
| `inferParameterTypes` | `false` | lets PostgreJS declare an OID per parameter from the JS value, instead of sending every parameter unspecified the way `pg` does |

## Why

It is a drop-in swap for `pg`: the same `driver` option, the same entities, the same queries. What
you get for it:

- **Faster queries**, measured end to end through a real `DataSource` - reads most of all, writes by
  a smaller but real margin.
- **Correct dates on a server whose `DateStyle` is not `ISO`**, where `pg` hands back `null`.
  Details under [How it differs](#how-it-differs-from-pg).
- **Checked against TypeORM's own functional suite** - 806 of 806, with `pg` run over the same
  files on the same server in the same invocation as the control.

| workload | `pg` | `typeorm-postgrejs` | speedup | allocated |
| --- | --- | --- | --- | --- |
| `findOneBy` | 0.343 ms | 0.296 ms | **1.19x** | +6% |
| `find`, 100 entities | 0.672 ms | 0.582 ms | **1.17x** | **-24%** |
| `find`, 5000 entities | 8.335 ms | 5.904 ms | **1.42x** | **-29%** |
| query builder, 500 entities | 1.192 ms | 0.994 ms | **1.20x** | **-38%** |
| raw: 100 rows | 0.550 ms | 0.477 ms | **1.15x** | **-30%** |
| raw: primary-key lookup | 0.281 ms | 0.247 ms | **1.14x** | +42% |
| raw: one insert | 0.267 ms | 0.227 ms | **1.19x** | +89% |
| raw: `bytea` of 4 MB | 36.412 ms | 16.199 ms | **2.25x** | **-92%** |
| raw: `int4[]` of 100 000 | 23.210 ms | 6.302 ms | **3.68x** | **-91%** |

TypeORM 1.1.1, `pg` 8.23.0, PostgreJS 3.12.1, PostgreSQL 18.6, loopback, Node 24, M1 Pro. Medians
per call; allocation is per call too. The full set, the method and how far each row can be trusted
are in [`doc/BENCHMARKS.md`](doc/BENCHMARKS.md), which is generated from a committed results file
rather than written by hand.

**The gain grows with how much comes back in one row.** An entity read gains 1.2x; five thousand of
them 1.4x; a single row holding a large array or a `bytea` between 2.2x and 3.7x, and there the
allocation falls by an order of magnitude - 4.1 MB a call against 51.8 MB on a 4 MB `bytea`.
It allocates *more* on the smallest calls, where a fixed per-call cost has nothing to amortise
against. Over a real network the share of time spent on the client is smaller, so expect less than a
loopback figure.

## How the numbers were measured

Both clients run in one process and alternate on every pair, so neither gets a warmer machine, and
each figure is a median. Memory is a separate pass, one child process per client, because a baseline
taken with both alive has their pools and buffers under it rather than in it.

The medians alone would not be worth much - on a shared machine the absolute figures drift by more
than the differences do - so which of the two won each pair is counted separately and reported as
the odds of that split by luck. A sign test survives a noisy machine because it throws away *by how
much*.

There is a control row: one result after a scan the server dominates, whose job is to stay small
while the read rows do not. A run where those two move by the same amount measured the machine.

```sh
node benchmark/bench.mjs          # both passes, writes benchmark/results/latest.json
node benchmark/render-report.mjs  # regenerates doc/BENCHMARKS.md, measures nothing
```

[`doc/BENCHMARKS.md`](doc/BENCHMARKS.md) has the rest: every scenario, the allocation column, what
each client holds between calls, and why a per-call peak is not among them.

## Where the speed comes from

Each of these is isolated by turning one thing off and leaving everything else alone, with the same
alternation and the same sign test. They do not add up to the totals above and are not meant to:
what is left is the client's own decoding path, which cannot be switched off to measure.

### It keeps prepared statements

PostgreJS names and caches a statement per connection from the second use of the same SQL, so the
server parses and plans each distinct SQL once instead of on every call. `pg` has no equivalent -
it sends an unnamed statement unless you name one yourself, so every call is parsed again.

Isolated on a repeated parameterized read, against the same facade with `prepare: false`: **1.14x**
(0.622 ms to 0.545 ms, faster in 304 of 401 pairs). That is what `prepare: false` costs behind
PgBouncer.

### The wire format, and what it is worth

PostgreJS reads PostgreSQL's binary format where `pg` asks for everything as text. This section used
to say the difference could not be credited to that, because measured on a bulk read it came out 4%
faster in one run and 7% slower in another and neither reached significance. That was the right
report of the wrong experiment.

What the format is worth scales with **values per row**, not with values, and a shape of many rows
holding few values each hides it. The pair that settles it holds the same 5000 `float8`s twice, as
5000 rows of one value and as one row holding an array of 5000 - same bytes, different shape:

| | clock | allocated per call |
| --- | --- | --- |
| spread over 5000 rows | 1.66x | -13% |
| packed into one row | **3.69x** | **-92%**, 220 KB against 2.7 MB |

`pg` gets worse rather than this client getting better: one row of 5000 values is one long array
literal with a substring cut per element.

### What it gives up: pipelining

A PostgreJS `Connection` can put several statements on one connection at a time, and that is worth
about 10x on one connection - 500 queries in 12 ms pipelined against 120 ms awaited. **This package
does not use it.** `pg` puts every `query()` on a per-client queue and starts the next only when the
previous has settled, and pg@9.0 is removing the last public view of that queue
(`Client.activeQuery`, `Client.queryQueue`) rather than the queue itself. So nothing written against
`pg` can depend on the other behaviour, and a `create temp table` with an `insert` into it, issued
together, must not race.

If you want it, `client.connection` is the real PostgreJS `Connection` and is not queued.

## TypeORM's own test suite

`scripts/run-typeorm-suite.sh` runs TypeORM's own functional suite against this facade, with `pg`
over the same files, on the same server, in the same invocation as the control. Tag 1.1.1,
PostgreSQL 18.4, 127 suite files:

| | `pg` | `typeorm-postgrejs` |
| --- | --- | --- |
| passed | 806 | 806 |

There is no expected-failure list, and that is deliberate rather than lazy: these tests leave schema
behind and read it back, so the same file scores differently between two runs of the *same* driver -
`create-table.test.js` scored 1/4 and then 5/0 with nothing changed. Only a control measured in the
same invocation is worth comparing against, and the only thing that fails the comparison is a test
this facade loses that `pg` wins.

The script clones and compiles TypeORM at a pinned tag and patches one function - `getTypeOrmConfig()`,
because an `ormconfig.json` cannot carry a `driver` object - then runs every file twice, each in its
own process, on a freshly reset database.

Alongside it, **275 tests** of its own at 99.9% coverage: unit tests; a 64-type decoding matrix and a
32-case parameter matrix against a live server with **`pg` as the oracle** rather than a written-down
table; and 20 TypeORM programs run through both drivers and deep-compared.

```sh
npm test                      # unit, live and differential - needs a server on PGHOST
scripts/run-typeorm-suite.sh  # TypeORM's own suite, with a pg control
```

Running `pg` live rather than against expected values is what found the things nobody thought to
assert: that TypeORM reads `rows` and `rowCount` through `hasOwnProperty`, so a class with accessors
would make every query silently return nothing; that `money` has no parser in `pg` at all, so the
day PostgreJS gained one the answers moved; and that TypeORM's own catalog query has no `ORDER BY`,
so `getTable().columns` comes back in a plan-dependent order for *both* drivers.

## How it differs from `pg`

Measured by a 64-type decoding matrix and a 32-case parameter matrix that run every case through
both. Everywhere not listed here, the two agree exactly - `numeric` and `int8` are strings, `money`
keeps the server's `$12.34`, ranges are strings, dates are `Date`s.

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
`pool.on('error')` as well. Where a caller already has the error, the duplicate is dropped
(`suppressRedundantPoolError`); where the connection died **idle** and nobody would otherwise hear
about it, it is reported.

## Requirements

- Node.js >= 22
- `postgrejs` >= 3.10.0 < 4. The facade is built on six things that release carries: `fetchAsString`
  naming an array column by its element type and its `{ oid, arrays: false }` selector, the value
  classes serialising as their fields, `toPostgres()` on them, `Circle` naming its radius `radius`,
  and a lost connection reported on `'error'`. All six exist because this package's tests measured
  them and reported them upstream.
- `typeorm` >= 0.3.0 < 2, an optional peer - this package does not import TypeORM
- `pg-query-stream`, only for `QueryRunner.stream()` - TypeORM loads it itself

Built for TypeORM, and knex's entry point is covered too: `driver.Client`, the query-config call
form and `pg-query-stream` all answer.

## License

BSD-3-Clause
