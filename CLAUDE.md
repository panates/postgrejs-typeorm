# postgrejs-typeorm

Running [TypeORM](https://typeorm.io) on [PostgreJS](https://github.com/panates/postgrejs)'s
wire-protocol client instead of `pg`.

**Read `doc/DRIVER-DESIGN.md` before writing any `src/`.** The recon round asked for in
`.claude/typeorm-driver-recon.md` is done; that report is its answer, and it settles most of what the
section below left open. What is still open is listed there as D1-D5 and needs you.

## It is not a TypeORM driver - it is a `pg` facade

TypeORM does not take a dialect the way Kysely and Drizzle do. Its PostgreSQL options carry this,
read from `typeorm@1.1.1`'s own `driver/postgres/PostgresDataSourceOptions.d.ts:17-20`:

```ts
/**
 * The driver object
 * This defaults to `require("pg")`.
 */
readonly driver?: any;
```

So the seam is not "implement TypeORM's interface" but "be the `pg` module". **Confirmed**: a custom
TypeORM `Driver` class cannot be registered at all - `DriverFactory.create()` is a closed `switch`
over 18 `type` strings and `DataSource`'s constructor calls it unconditionally. The deliverable is a
**`pg`-compatible facade over PostgreJS**, and TypeORM is its first consumer rather than its purpose.
The surface is 18 members, all public; `doc/DRIVER-DESIGN.md` §2 is the checklist.

That changes the value of the work, which is the reason to do TypeORM at all rather than Prisma. The
recon round counted each library's slice instead of assuming it, and **the leverage is real for knex
and not real for pg-promise or Sequelize**:

| target | weekly downloads (2026-09-20) | how the facade gets in | reachable? |
| --- | --- | --- | --- |
| `pg` | 38.5M | what the facade replaces | - |
| typeorm | 3.6M | `driver?: any`, straight into `PostgresDriver.loadDependencies()` | **yes** - 18 public members |
| knex | 3.8M | **not** `client?: string \| typeof Client` - that injects a knex *dialect class*. The `pg` module is hard-wired in `Client_PG._driver()` (`lib/dialects/postgres/index.js:63-65`), so you subclass it and override `_driver()` | **yes**, with work - it wants `driver.Client` (which TypeORM never touches), query-config objects and `pg-query-stream` |
| sequelize | 2.0M | v6 wants `lib.types.getTypeParser` / `setTypeParser` / `types.arrayParser.create` (`lib/dialects/postgres/connection-manager.js:23`, `:53`, `:68`) | **no** - a parser-function registry, which PostgreJS has no equivalent of because it decodes at the wire level. v7 is still `7.0.0-alpha.48` |
| pg-promise | 0.50M | monkey-patches `pg.Client.prototype.connect` and reaches `this.connection.on('parameterStatus', …)` inside it (`lib/main.js:185-186`) | **no** - that is pg's private protocol object |
| objection | 0.17M | through knex | follows knex |

So the pitch is **"a `pg` facade that TypeORM and knex can both use"**, not "replace `pg`
everywhere". TypeORM alone still justifies it - but do not make the argument on pg-promise or
Sequelize.

Prisma was the other candidate and was rejected on evidence, not taste: its adapters must return
`SqlResultSet { columnTypes: ColumnType[], columnNames, rows }`, where `ColumnType` is Prisma's own
~30-value enum and the doc comment says the values are *"used within the Query Engine to convert
values from JS to Quaint values"* (`@prisma/driver-adapter-utils@7.10.0`). Every typed value
PostgreJS produces would be flattened for the Rust engine to re-convert, leaving socket throughput as
the only remaining advantage. Do not reopen that without new evidence.

## Where things are

- **PostgreJS**: `../postgrejs`. Its `CLAUDE.md` describes the internals. Peer is `^3.7.0`, which is
  published and contains everything below.
- **TypeORM**: peer is **`>=0.3.0 <2`**. The lines that touch `pg` are unchanged from **0.2.39** -
  where `options.driver` was introduced, 2021-11-09 - to 1.1.1, apart from `defaults.parseInt8` added
  in the 0.3 line and `||` becoming `??` at 1.0.0. The same facade was run against 0.3.31 and 1.1.1
  with identical results. Note TypeORM reset its versioning - 1.x follows 0.3.x - so the major bump
  carried no seam change. Before 0.2.39 there is no `driver` option at all, which is the floor.
- **The Kysely dialect**: `../postgrejs-kysely` - finished.
- **The Drizzle driver**: `../postgrejs-drizzle` - finished, and its `doc/DRIVER-DESIGN.md` plus
  `CLAUDE.md` are the cheapest way to avoid paying twice for the same discoveries. Read both before
  starting. Copy the reasoning, not the layout - and not the constants: those are dialects, this is a
  facade, and the `fetchAsString` list does not carry over (see below).

## What PostgreJS gives you

Verified against a live server during the Kysely and Drizzle rounds, brought forward to 3.7, and
re-checked in the TypeORM round wherever its expectations differ - the entries below say which.

- **`connection.query(sql, options)` returns every row.** `fetchCount` defaults to 0 - the protocol's
  "no limit" - and a result the server truncated carries `suspended: true`.
- **Rows are arrays by default**; `objectRows: true` for objects. `pg` gives objects, so the facade
  will want `objectRows` almost everywhere.
- **Parameters are `$1`-style** via `options.params`. Their **types** are the trap, and it has now
  cost three rounds: `Connection._query` derives an OID per parameter with `typeMap.determine(value)`,
  so a plain string arrives declared `varchar` and PostgreSQL stops inferring from context -
  inserting into a `json` column, `coalesce($1, 1)`, `$1 || x` and every overloaded function fail.
  `pg` sends OID 0 (unspecified). `new BindParam(0, value)` asks PostgreJS for the same.
  **OID 0 alone is not enough for a facade** - measured 23/28 against `pg`, because PostgreJS's typed
  encoders still run for `Date`, arrays and objects. What works is `pg`'s own `prepareValue(v)`
  *first*, then OID 0: 28/28. Render the value the way `pg` renders it rather than only asking for
  the same declared type. See `doc/DRIVER-DESIGN.md` §5.
- **`rowsAffected` is a number**, set for INSERT/UPDATE/DELETE/MERGE. `QueryResult` also carries
  `command`, `fields`, `rowType`, `rows`.
- **`rollbackOnError` defaults to true** - every statement inside a transaction runs under a
  savepoint of its own. PostgreSQL's own semantics are the opposite and `pg` has no such behaviour,
  so the facade will want `false`.
- **A pooled connection that dies** is reported on `Pool`'s `'destroy'` (second argument) and
  `'error'` as a `ConnectionLostError` - `code` `'08006'`, `processID`, the socket error as `cause`.
  The in-flight query rejects with the same object. `pg` does neither: it rejects the query with the
  server's own `57P01` and raises nothing on the pool.
- **Two PostgreJS defects, both silently corrupting data, both reaching `postgrejs-kysely` today.**
  Found in this round and written up in `doc/DRIVER-DESIGN.md` §5. Until they are fixed upstream, do
  not hand PostgreJS a `Date` or a JS array as a parameter:
  - a `Date` **does not round-trip through a `timestamptz` column** - the encoder writes its local
    wall-clock components as if they were UTC, so the instant shifts by the local offset. Invisible
    in a UTC deployment. `utcDates: true` fixes `timestamptz` and breaks `timestamp`.
  - the binary array encoder writes **lower bound 0** (`../postgrejs/src/util/encode-binaryarray.ts:31`),
    so `arr[1]` returns the second element and `array_lower` reports 0.
- **Cursors read through a portal**, which lives only as long as the transaction that created it.
  Any other statement on the same connection destroys it. TypeORM streams through `pg-query-stream`,
  and **it maps**: `QueryStream.submit()` drives pg's private protocol object, but TypeORM only ever
  uses the returned value as a `ReadStream`, so the facade reads `text`/`values` off the submittable
  and returns its own `Readable` over a PostgreJS `Cursor`. The portal-lifetime rule does not bite
  because a QueryRunner holds one connection for its whole life.

## The decoding tension - measured, and narrower than it looked

PostgreJS 3.7 registers **125 built-in types** and decodes them into what they are: `Interval`,
`Range`, `Numeric`, a class per geometric type, `inet`/`macaddr`/`bit`/`tsvector` as the strings the
server prints. The worry was that a `pg` facade would have to throw all of that away.

**It does not.** Measured over 64 scalar and array types (`doc/DRIVER-DESIGN.md` §6): `pg` itself
parses `date`, `timestamp`, `timestamptz`, `json`, `jsonb`, `bool`, `bytea`, the integer and float
families and every array of those - and PostgreJS already returns the identical value for all of
them. `unknownTypesAsString: true` on its own gets 43 of the 64.

What actually has to be suppressed is a short list - the types where `pg`'s own value is a string and
PostgreJS's is not: `int8`, `numeric`, `time`, `interval`, the geometric family and the range family,
through `fetchAsString`. Plus four types no wire option can reach, where `pg` produces a plain object
or an array of strings and PostgreJS a class instance: `point`, `circle`, `interval` and `int8[]`,
handled by a post-decode fixup. That is 64/64.

The two divergences this section has always called certain are confirmed, and they are the two
people notice:

- `numeric` - `pg` returns a string always, `19.99` included. PostgreJS returns a `number`, or a
  `Numeric` when a double cannot carry the value (3.7, breaking). Keeping PostgreJS's decoding here
  destroys precision and TypeORM hands the result straight to the user - a `numeric` column has no
  hydration branch.
- `int8` - `pg` returns a string. PostgreJS returns a `number`, or a `BigInt` past 2^53.

**Do not copy `postgrejs-drizzle`'s `fetchAsString` list.** Drizzle's own `node-postgres` driver
overrides `pg`'s parsers for TIMESTAMP, TIMESTAMPTZ, DATE and INTERVAL to get raw strings, so that
list asks for strings where TypeORM wants the `Date` PostgreJS already gives. It would create a
divergence rather than remove one.

Whether the facade is `pg`-faithful by default, PostgreJS-faithful by default, or configurable is
still **the** design decision - it is **D1** in `doc/DRIVER-DESIGN.md`, now with the cost of each
option priced, and it is yours to make.

## Working conventions

Inherited from `../postgrejs`; they apply from the first commit.

- **Do not sign commits or pull requests on the assistant's behalf** - no `Co-Authored-By: Claude`
  trailer, no "Generated with Claude Code" line.
- Run `git status` before staging. Commit only the files the change is about.
- Every change comes with a test.
- **Claims about how another library behaves get checked against that library's own source, not its
  documentation.**
- Do not publish a performance number that was not measured. Comparing two versions means alternating
  between them inside one run and taking medians.
- Code style follows `../postgrejs`'s `CLAUDE.md`: member order (properties, constructor, accessors,
  public, protected, private), `protected` over `private`.

## Local setup

PostgreSQL on `127.0.0.1:5432` (`postgres`/`postgres`, database `postgres`), from the docker compose
in the PostgreJS repo. TypeORM's own test suite needs more than that; see the recon round.
