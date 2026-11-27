# postgrejs-typeorm

Running [TypeORM](https://typeorm.io) on [PostgreJS](https://github.com/panates/postgrejs)'s
wire-protocol client instead of `pg`.

**Read `docs/DRIVER-DESIGN.md` before changing `src/`.** It is why the facade is shaped the way it
is - which of `pg`'s behaviour is load-bearing, which of PostgreJS's defaults had to be overridden
and what each override costs - with the measurement behind every claim. Most of what looks arbitrary
in `src/` is answered there, and D1-D5 at its end record what was chosen and what it would cost to
choose otherwise.

## It is not a TypeORM driver - it is a `pg` facade

TypeORM's PostgreSQL options carry a `driver?: any` that "defaults to `require("pg")`", so the seam
is not "implement TypeORM's interface" but **be the `pg` module**. A custom TypeORM `Driver` class
cannot be registered at all. The surface is 18 members, all public; `docs/DRIVER-DESIGN.md` §2 is
the checklist.

Two things follow, and neither is to be reopened without new evidence:

- **This package ships as `typeorm-postgrejs`, and knex gets its own repository with its own copy
  of `src/`.** Not "extract a shared core". What keeps the duplication safe is the test design, so
  port that with the code: **`pg` is the live oracle in `test/B-live`**, not a table of expected
  values.
- **Prisma was rejected on evidence**, not taste. Do not argue the package's value on pg-promise
  or Sequelize either - the facade cannot reach them.

Why the seam is this one, what each target was worth, and why knex is a copy rather than a shared
core: [docs/decisions/pg-facade-not-a-driver.md](docs/decisions/pg-facade-not-a-driver.md).

## Where things are

- **PostgreJS**: `../postgrejs`. Its `CLAUDE.md` describes the internals. Peer is
  **`>=3.13.0 <4`**, and that floor is exact rather than cautious - `341f343` and `a11a9af` are
  what `src/` needs from it.

  **Build against the copy in `node_modules`, not against a release.** Do not add a branch, a
  fallback or a feature test for a published version, and do not run `git tag --contains` to
  justify keeping one.

  **The facade carries no post-decode fixups and nothing of `pg`'s.** No table that rewrites
  values after decoding, no `postgres-interval`, no `postgres-array`. A divergence from `pg` is
  measured against the `node_modules` build and then **fixed in PostgreJS** - written up in
  `../postgrejs/.claude/local/` - rather than patched around here.

  **Re-run the type matrix after every upstream bump**, not only the TypeORM suite. `money` is the
  worked example: a new decoder upstream is a new *divergence* here, and the suite is silent about
  it.

  What the floor is made of, the six-entry history behind the old `>=3.10.0`, and why there is no
  compatibility code left: [docs/decisions/postgrejs-peer-floor.md](docs/decisions/postgrejs-peer-floor.md).

- **TypeORM**: peer is **`>=0.3.0 <2`**. The lines that touch `pg` are unchanged from **0.2.39** -
  where `options.driver` was introduced, 2021-11-09 - to 1.1.1, apart from `defaults.parseInt8` added
  in the 0.3 line and `||` becoming `??` at 1.0.0. The same facade was run against 0.3.31 and 1.1.1
  with identical results. Note TypeORM reset its versioning - 1.x follows 0.3.x - so the major bump
  carried no seam change. Before 0.2.39 there is no `driver` option at all, which is the floor.
- **The Kysely dialect**: `../postgrejs-kysely` - finished.
- **The Drizzle driver**: `../postgrejs-drizzle` - finished, and its `docs/DRIVER-DESIGN.md` plus
  `CLAUDE.md` are the cheapest way to avoid paying twice for the same discoveries. Read both before
  starting. Copy the reasoning, not the layout - and not the constants: those are dialects, this is a
  facade, and the `fetchAsString` list does not carry over (see below).

## The package

`src/` is ten files, and the split is by decision rather than by layer - each file holds one thing
that was expensive to arrive at, with the reason next to it.

- `prepare-value.ts` - `pg`'s own parameter rendering, **ported, not imported**. A facade whose
  purpose is to replace `pg` cannot depend on `pg` at runtime. Held to the original by a test that
  calls both.
- `params.ts` - the policy, and **nothing is rendered on its default path**. A value PostgreJS
  would declare a type for is bound at OID 0 instead, where since `a11a9af` it writes exactly what
  `pg` writes - measured byte for byte over eight shapes, a caller's own `toPostgres()` class
  among them. Everything else is handed over untouched, because PostgreJS already sends it untyped
  for the same reasons `pg` does.

  **A number is the one deliberate divergence from `pg`.** It is declared, so
  `insert into t (q bigint) values ($1)` with `2.7` writes `3` - what plain SQL does with the
  literal - where `pg` sends text and the input parser refuses it. `select $1 * 2` works for the
  same reason. Pinned on both sides in `test/B-live/params.spec.ts` rather than skipped.

  `inferParameterTypes` is three-state: unset is the above, `true` hands everything over, `false`
  renders everything with `pg`'s own function and is `pg` byte for byte. `prepare-value.ts` exists
  for that third mode now, and is still held to `pg`'s function by a test that calls both.
- `typeorm-boolean.ts` - **a workaround, here on an explicit decision against the rule below.**
  TypeORM's own driver sends `1` for a `boolean` column, which only works because `pg` declares
  nothing for a parameter. It is sixty-seven of TypeORM's own tests and a broken insert in any
  application with a boolean column. Applied on import; `TYPEORM_POSTGREJS_NO_BOOLEAN_PATCH=1`
  skips it. **Remove it when TypeORM fixes it.**
- `constants.ts` - the `fetchAsString` OID list. **An array OID there behaves differently from a
  scalar one** - it makes the whole literal come back as one string - so it belongs there only where
  `pg` also returns a string. That is the geometric family except `point[]`.
  There is **no fixup table and no runtime dependency**. The facade hands every value through
  exactly as PostgreJS decoded it, and the 64-type matrix is 64/64 on values: what a caller reads -
  own keys, their values, `JSON.stringify` - agrees with `pg` everywhere. Three types come back as
  PostgreJS classes where `pg` gives a plain object, and `types.spec.ts` asserts that as the
  superset it is rather than dropping it: the class also answers `toPostgres()`, so a `point` read
  here goes back to the server as a parameter where `pg`'s own object fails 22P02.
- `result.ts` - `rows` and `rowCount` are **own properties**, because TypeORM reads them through
  `hasOwnProperty`. A class with accessors would make every query silently return nothing.
- `config.ts` - option translation. Two traps: `{ connectionString }` is not a PostgreJS option and
  is silently ignored, and its pool sizes (`max`/`min`/`idleTimeoutMillis`) are top-level rather
  than under a `pool` key - nesting them is accepted and does nothing.
- `client.ts`, `pool.ts` - the `pg` surface itself. `pool.on('acquire')` is emitted because
  TypeORM's own suite asserts it, though TypeORM itself listens only for `'error'`.
- `stream.ts` - `pg-query-stream`'s submittable is read for its SQL and thrown away; a PostgreJS
  `Cursor` does the work.
- `errors.ts` - the caret diagram and the numeric `position`, the only two divergences that reach a
  caller.

Tests come in three kinds and the split is the point:

- `test/A-common` - no server. Option translation, the parameter policy, the result reshape, the
  fixups, error normalisation. `prepare-value.spec.ts` is the one to keep honest: it compares
  against `pg`'s own function rather than a table someone wrote down.
- `test/B-live` - against a real server, with **`pg` as the control rather than an expected value**.
  A 64-type decoding matrix and a 32-case parameter matrix; a change on either side is reported
  instead of silently agreeing with a stale table.
- `test/C-differential` - 20 TypeORM programs run through `pg` and through this facade and
  deep-compared. This is what catches what nobody thought to assert: the `hasOwnProperty` rule, the
  `postgres-interval` major, and that TypeORM's own `columnsSql` has no `ORDER BY` so
  `getTable().columns` comes back in a plan-dependent order for *both* drivers.

`benchmark/` is the performance harness and is four files on purpose - `scenarios.mjs` is imported
by both the timing pass and the memory workers, so the two cannot describe different work;
`render-report.mjs` runs nothing, so `docs/BENCHMARKS.md` can be rewritten without re-measuring;
`heap-worker.mjs` is one child process per client, because a baseline taken with both alive has
their pools under it rather than in it. It is plain `.mjs` against `build/` for the same reason -
a TypeScript loader inside the baseline window gives the number away. `benchmark/results/latest.json`
is committed and is what the document is generated from.

Two things about it are easy to get wrong and are written up where they live: there is **no shape
where neither client wins**, so the control row is read on magnitude against the read rows rather
than on the sign test, and the control does not control for *allocation* at all, because a fixed
per-call cost has no term that scales with server time. `.claude/local/latency-is-half-the-benchmark.md`
is the handoff this was built from and is worth reading before changing any of it.

`scripts/run-typeorm-suite.sh` runs TypeORM's own functional suite against the facade. Read its
header before changing it; two things there are not obvious:

- It patches exactly one function, `getTypeOrmConfig()`, because `ormconfig.json` cannot carry a
  `driver` object. The patch fails loudly if that function's shape has changed.
- It runs **`pg` over the same files, on the same server, in the same invocation**, and per file in
  its own process with the database reset between. These tests leave schema behind and read it back:
  `create-table.test.js` scored 1/4 and then 5/0 across two runs with nothing changed. A pinned
  `EXPECTED_FAILURES` would be a lie; only a delta against the control is news.

## What PostgreJS gives you

Verified against a live server during the Kysely and Drizzle rounds, brought forward to 3.10, and
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
  **PostgreJS sends most of them unspecified itself now** - a string, a `Date`, an array - so the
  facade hands those over and binds only what PostgreJS would otherwise type. Nothing is rendered:
  since `a11a9af` an undeclared parameter is written the way `pg` writes one, measured byte for
  byte. A number is the one value left declared, deliberately. `docs/DRIVER-DESIGN.md` §5 is the
  whole of it, and the history - `prepareValue(v)` then OID 0 for everything scored 28/28 against
  23/28 and was the policy until 2026-10-06 - is §5.6.
- **`rowsAffected` is a number**, set for INSERT/UPDATE/DELETE/MERGE. `QueryResult` also carries
  `command`, `fields`, `rowType`, `rows`.
- **`rollbackOnError` defaults to true** - every statement inside a transaction runs under a
  savepoint of its own. PostgreSQL's own semantics are the opposite and `pg` has no such behaviour,
  so the facade will want `false`.
- **A pooled connection that dies** is reported on `Pool`'s `'destroy'` (second argument) and
  `'error'` as a `ConnectionLostError` - `code` `'08006'`, `processID`, the socket error as `cause`.
  The in-flight query rejects with the same object. `pg` does neither: it rejects the query with the
  server's own `57P01` and raises nothing on the pool.
- **Two PostgreJS defects this package found, both silently corrupting data, both since fixed
  upstream.** Written up in `docs/DRIVER-DESIGN.md` §5.8, and kept there because they are why the
  parameter policy was what it was for most of this package's history:
  - a `Date` did not round-trip through a `timestamptz` column - the instant shifted by the local
    offset, invisible whenever the session's `TimeZone` and the process's zone agreed, not merely at
    UTC. A `Date` now goes out untyped, carrying the process's own offset, which is what `pg` sends.
  - the binary array encoder wrote **lower bound 0**, so `arr[1]` returned the second element and
    `array_lower` reported 0.
- **Cursors read through a portal**, which lives only as long as the transaction that created it.
  Any other statement on the same connection destroys it. TypeORM streams through `pg-query-stream`,
  and **it maps**: `QueryStream.submit()` drives pg's private protocol object, but TypeORM only ever
  uses the returned value as a `ReadStream`, so the facade reads `text`/`values` off the submittable
  and returns its own `Readable` over a PostgreJS `Cursor`. The portal-lifetime rule does not bite
  because a QueryRunner holds one connection for its whole life.

## The decoding tension - measured, and narrower than it looked

The worry was that a `pg` facade would throw away everything PostgreJS decodes. It does not: over
64 scalar and array types the two agree on all but a short list, which `fetchAsString` accounts
for. That is 64/64 on values, with `interval`, `point` and `circle` coming back as classes that are
a superset of `pg`'s plain objects - not a fixup, and not to be converted.

- **`numeric` and `int8` are the two divergences people notice.** `pg` returns a string for both;
  PostgreJS returns a `number`, a `Numeric` or a `BigInt`. TypeORM hands a `numeric` straight to
  the user, so keeping PostgreJS's decoding there destroys precision.
- **Do not copy `postgrejs-drizzle`'s `fetchAsString` list.** Those are dialects, this is a facade;
  its list would create a divergence rather than remove one.
- Whether the facade is `pg`-faithful by default, PostgreJS-faithful by default, or configurable is
  **D1** in `docs/DRIVER-DESIGN.md`, and it is yours to make.

What was measured, and why each of those falls where it does:
[docs/decisions/decoding-divergences.md](docs/decisions/decoding-divergences.md).

## Release and tooling - rman 2.x

`.rmanrc.yml` extends `@panates/rman-preset`, and **the ground truth is `rman config --from-root`,
never the preset's source.** Single-package, so `group`, `version.cascade` and `changelog.groupBy`
are deliberately unset.

- **`build` and `prebuild` must not come back as npm scripts.** A `build` script silently wins over
  the config's `exec`; a `prebuild` runs the same three steps twice.
- **`lint`, `check` and `format` are scripts**, each one line delegating to the rman command of the
  same name. Measured: an rman command does not defer to a script that shares its name.
- `scripts/run-typeorm-suite.sh` calls `rman build` - plain `rman`, not `npx rman`.

The measurement, and what the preset owns:
[docs/decisions/rman-pipeline-and-scripts.md](docs/decisions/rman-pipeline-and-scripts.md).

## Working conventions

Inherited from `../postgrejs`; they apply from the first commit.

- **No fixups here. A gap in PostgreJS is reported, not worked around.** When something this
  adapter needs is missing, wrong or slower in `postgrejs`, do not patch around it in this package:
  no post-decode value rewriting, no shim, no vendored parser, no `pg`-compatibility table, no
  monkey-patching of the client, no "temporary" branch written to suit the behaviour as it is
  today. Stop there and write the finding up as a task file in `../postgrejs/.claude/local/<short-name>.md`
  - what was asked of the client, what it answered, what it should answer, and the smallest
  reproduction that shows the difference. That repo's own session picks it up and fixes it at the
  source. Otherwise every adapter ends up carrying its own copy of the same correction, and the
  client's behaviour gets defined by whichever adapter last worked around it. A workaround is
  allowed only when the user is asked for one and says yes; it then carries a comment naming the
  task file it waits on, so it can be removed when the fix lands.
- **Session notes live in `.claude/local/`, which git ignores; `.claude/local/handoff.md` is the
  handoff note between sessions.** `.claude/settings.json` is the shared one and is committed. The
  whole of `.claude/` used to be ignored, so a note added there was invisible and a path naming one
  was dead for everybody else - which is the trap `postgrejs` hit first.
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
