# typeorm-postgrejs

A [`pg`](https://node-postgres.com)-compatible facade over
[PostgreJS](https://github.com/panates/postgrejs), so [TypeORM](https://typeorm.io) runs on
PostgreJS's wire-protocol client instead of `pg`.

> **Not released yet.** The reconnaissance round is finished and its findings are in
> [`doc/DRIVER-DESIGN.md`](doc/DRIVER-DESIGN.md); `src/` is not written. Everything below describes
> what the package is going to be, and the design decisions it still needs are §"Decisions that need
> you" in that document.

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

## Status

A spike of the facade is **19/20 identical to `pg`** on a differential harness and scores
**601 of 601** against TypeORM's own functional suite across 111 files, with a `pg` control run in
the same invocation. The measurements, and what they cost, are in `doc/DRIVER-DESIGN.md`.

## Requirements

- Node.js >= 22
- PostgreJS >= 3.7.0
- TypeORM >= 0.3.0 < 2 (optional peer - the facade does not import TypeORM)
- `pg-query-stream`, only if you use `QueryRunner.stream()`. TypeORM loads it itself; the facade
  intercepts what it produces rather than implementing pg's private protocol object.

## License

BSD-3-Clause
