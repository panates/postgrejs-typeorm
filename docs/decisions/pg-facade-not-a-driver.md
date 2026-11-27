# Why this is a `pg` facade and not a TypeORM driver

TypeORM does not take a dialect the way Kysely and Drizzle do. Its PostgreSQL options carry this,
read from `typeorm@1.1.1`'s own `driver/postgres/PostgresDataSourceOptions.d.ts:17-20`:

```ts
/**
 * The driver object
 * This defaults to `require("pg")`.
 */
readonly driver?: any;
```

So the seam is not "implement TypeORM's interface" but "be the `pg` module". A custom TypeORM
`Driver` class cannot be registered at all - `DriverFactory.create()` is a closed `switch` over 18
`type` strings and `DataSource`'s constructor calls it unconditionally. The deliverable is a
`pg`-compatible facade over PostgreJS, and TypeORM is its first consumer rather than its purpose.

## What that is worth, counted rather than assumed

Being the `pg` module rather than one library's driver is the reason to do TypeORM at all rather
than Prisma. The recon round counted each library's slice instead of assuming it, and the leverage
is real for knex and not real for pg-promise or Sequelize:

| target | weekly downloads (2026-09-20) | how the facade gets in | reachable? |
| --- | --- | --- | --- |
| `pg` | 38.5M | what the facade replaces | - |
| typeorm | 3.6M | `driver?: any`, straight into `PostgresDriver.loadDependencies()` | **yes** - 18 public members |
| knex | 3.8M | **not** `client?: string \| typeof Client` - that injects a knex *dialect class*. The `pg` module is hard-wired in `Client_PG._driver()` (`lib/dialects/postgres/index.js:63-65`), so you subclass it and override `_driver()` | **yes**, with work - it wants `driver.Client` (which TypeORM never touches), query-config objects and `pg-query-stream` |
| sequelize | 2.0M | v6 wants `lib.types.getTypeParser` / `setTypeParser` / `types.arrayParser.create` (`lib/dialects/postgres/connection-manager.js:23`, `:53`, `:68`) | **no** - a parser-function registry, which PostgreJS has no equivalent of because it decodes at the wire level. v7 is still `7.0.0-alpha.48` |
| pg-promise | 0.50M | monkey-patches `pg.Client.prototype.connect` and reaches `this.connection.on('parameterStatus', …)` inside it (`lib/main.js:185-186`) | **no** - that is pg's private protocol object |
| objection | 0.17M | through knex | follows knex |

So the pitch is "a `pg` facade that TypeORM and knex can both use", not "replace `pg` everywhere".
TypeORM alone still justifies it - but the argument must not be made on pg-promise or Sequelize.

## Why knex gets its own repository instead of a shared core

This package ships as `typeorm-postgrejs`, and knex gets its own repository with its own copy of
`src/`. The cost was accepted rather than overlooked: the two copies can drift. A name people
search for is worth more than a deduplicated tree, and a knex user reading `typeorm-postgrejs` in
their lockfile is the same loss of confidence moved somewhere it cannot be explained away.

What makes the duplication survivable is the test design, which has to be copied with the code:
`pg` is the live oracle in `test/B-live`, not a table of expected values. Two copies held to the
same third party cannot silently disagree with each other without one of them first disagreeing
with `pg`, so neither repository ever needs to compare itself to the other.

The two consumers also overlap less than the shared code suggests, which is why the copy is thin
work rather than a second project. Measured against `knex@3.3.0` and `typeorm@1.1.1`: TypeORM
enters through `new postgres.Pool(...)` and never constructs a `Client`; knex enters through
`new driver.Client(...)`, pools with `tarn`, and never touches `pg`'s `Pool`. knex also cannot be
handed the module - `require('pg')` is hard-wired in `Client_PG._driver()` - so the knex side is a
subclass overriding that one method, plus the callback and query-config call forms it uses
throughout. Everything underneath is the same facade.

## Why Prisma was rejected

On evidence, not taste. Prisma's adapters must return
`SqlResultSet { columnTypes: ColumnType[], columnNames, rows }`, where `ColumnType` is Prisma's own
~30-value enum and the doc comment says the values are *"used within the Query Engine to convert
values from JS to Quaint values"* (`@prisma/driver-adapter-utils@7.10.0`). Every typed value
PostgreJS produces would be flattened for the Rust engine to re-convert, leaving socket throughput
as the only remaining advantage.

Do not reopen this without new evidence.
