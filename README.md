# typeorm-postgrejs

A [`pg`](https://node-postgres.com)-compatible facade over
[PostgreJS](https://github.com/panates/postgrejs), so [TypeORM](https://typeorm.io) runs on
PostgreJS's wire-protocol client instead of `pg`.

> **Not released yet.** `src/` is written and tested; the decisions still open are listed at the end
> of [`doc/DRIVER-DESIGN.md`](doc/DRIVER-DESIGN.md).

## Why a facade rather than a driver

TypeORM does not take a dialect the way Kysely and Drizzle do. Its PostgreSQL options carry a
`driver?: any` that defaults to `require("pg")`, and a custom TypeORM `Driver` class cannot be
registered at all - `DriverFactory` is a closed `switch`. So the seam is not "implement TypeORM's
interface" but "be the `pg` module".

That surface turns out to be small and stable: **18 members**, all public, unchanged since TypeORM
0.2.39 (2021). It is counted in `doc/DRIVER-DESIGN.md` §2.

```ts
import { DataSource } from 'typeorm';
import * as pgjs from 'typeorm-postgrejs';

export const dataSource = new DataSource({
  type: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  username: 'postgres',
  password: 'postgres',
  database: 'postgres',
  driver: pgjs, // <- the whole integration
  entities: [/* ... */],
});
```

## What you get, and what you give up

The facade's contract is that a consumer written against `pg` sees what it expects. So `numeric` and
`int8` come back as strings, `interval` as a `PostgresInterval`, `point` as `{x, y}`, ranges as
strings - `pg`'s answers, not PostgreJS's richer ones.

Most of PostgreJS's decoding survives that: `json`, `jsonb`, `bytea`, `bool`, the whole date and
time family and every array of them are already identical between the two. Only a short list has to
be suppressed, and it is in `src/constants.ts` with the measurement behind it.

If you know the code reading your rows, you can have PostgreJS's values instead:

```ts
new DataSource({
  // ...
  driver: pgjs,
  extra: { postgrejs: { decoding: 'native' } },
});
```

`extra` is TypeORM's passthrough to the pool config, which is where this facade reads its own
options. The full list is `PgjsFacadeOptions` in `src/config.ts`.

## Status

- **185 tests** of its own: unit tests, a 64-type decoding matrix and a 32-case parameter matrix
  against a live server with `pg` as the control, and 20 TypeORM programs run through both drivers
  and deep-compared.
- **601 of 601** against TypeORM's own functional suite across 111 files, with a `pg` control run in
  the same invocation.

## Running the tests

```bash
npm test                      # unit, live and differential - needs a server on PGHOST
scripts/run-typeorm-suite.sh  # TypeORM's own functional suite, with a pg control
```

The suite script clones and compiles TypeORM at a pinned tag, patches the one function that stops an
`ormconfig.json` carrying a `driver` object, and runs every file twice - once on `pg`, once on this
facade - on a freshly reset database each time. It fails only on a test this facade loses that `pg`
wins. There is no pinned expected-failure count on purpose: these tests leave schema behind and read
it back, so the same file scores differently between runs, and only a control measured in the same
invocation is worth comparing against.

Set `TZ` to something with a non-zero UTC offset when running either. A `Date` written into a
`timestamptz` column round-trips on a UTC machine whatever the driver does, so the assertions that
matter most pass vacuously there.

## Requirements

- Node.js >= 22
- PostgreJS >= 3.7.0
- TypeORM >= 0.3.0 < 2 (optional peer - the facade does not import TypeORM)
- `pg-query-stream`, only if you use `QueryRunner.stream()`. TypeORM loads it itself; the facade
  intercepts what it produces rather than implementing pg's private protocol object.

## License

BSD-3-Clause
