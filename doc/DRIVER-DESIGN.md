# Running TypeORM on PostgreJS - what the seam is, and what it costs

Reconnaissance, before any `src/` exists. Eleven questions, then an estimate, a layout, the decisions
that need the user, and a recommendation.

Measured against `typeorm` 1.1.1 (npm `latest`, published 2026-09-20), `pg` 8.23.0,
`pg-query-stream` 4.17.0, PostgreJS 3.7.0 and PostgreSQL 18.4 on `127.0.0.1:5432`. Line references
are into the `typeorm` git tree at tag `1.1.1`, path prefix `src/`. Every table below came out of a
run against that server; nothing here is read out of documentation.

**The headline: the `driver` option is the whole seam, and it is smaller than anyone expected.**
TypeORM's PostgreSQL support touches exactly **three properties** on the `pg` module, **five** on a
`Pool`, **six** on a connection, **three** on a result and **zero** on an error. That surface has
been unchanged since TypeORM 0.2.39 (November 2021), the release that introduced `options.driver`.
A 180-line spike facade runs TypeORM's schema synchroniser, query builder, repositories,
transactions, savepoints, streaming and catalog introspection, and is **19/20 identical to `pg`** on
a differential harness - the one difference being cosmetic fields on the error object.

Three things to take upstream turned up on the way. Two are defects that silently corrupt data and
both affect `postgrejs-kysely` today (§5); the third is a missing `notice` relay (§2).

---

## 1. Is `driver` really the seam?

**Yes, and it is the only one.**

`PostgresDriver.loadDependencies()` is three lines of substance
(`src/driver/postgres/PostgresDriver.ts:1707-1721`):

```ts
const postgres = this.options.driver ?? PlatformTools.load("pg")
this.postgres = postgres
try {
    const pgNative = this.options.nativeDriver ?? PlatformTools.load("pg-native")
    if (pgNative && this.postgres.native) this.postgres = this.postgres.native
} catch (e) {}
```

`this.options.driver` wins outright; `PlatformTools.load("pg")` is only the fallback. The `??` was
`||` before 1.0.0 and nothing else about those lines has changed - see §11.

**`:1714` is a trap worth writing down.** If the user happens to have `pg-native` installed and the
facade exposes a truthy `native` property, TypeORM silently swaps the facade for `facade.native`. The
facade must therefore **not** define `native`, or must define it as `undefined`.

**A custom TypeORM `Driver` class cannot be registered.** `DriverFactory.create()` is a `switch` over
a closed set of 18 `type` strings with a `MissingDriverError` default
(`src/driver/DriverFactory.ts:32-92`), and `DataSource`'s constructor calls it unconditionally:
`this.driver = new DriverFactory().create(this)` (`src/data-source/DataSource.ts:142`). There is no
factory hook and no registry.

`DataSource.driver` is declared `driver: Driver` (`:76`) - **not** `readonly`, unlike the
`readonly migrations` / `readonly subscribers` beside it - so `ds.driver = new MyDriver(ds)` after
construction is technically possible. It is not a route worth taking, for two reasons:

- The `Driver` interface is **48 members** (`src/driver/Driver.ts`), and `createQueryRunner()` has to
  return a `QueryRunner`. Reimplementing what `PostgresDriver` (1,893 lines) and
  `PostgresQueryRunner` (5,269 lines) already do is 7,162 lines of transcription.
- **It does not remove the need for the facade.** `PostgresQueryRunner` talks to the `pg` connection
  object directly (`databaseConnection.query(...)`, `.on('error')`, `.removeListener(...)`), so a
  subclass route still has to hand it something `pg`-shaped. The only thing subclassing buys is a
  different way to inject the same object.

**Settled, not a decision:** the deliverable is a `pg`-compatible facade, injected through
`options.driver`. Everything below is about that object.

## 2. The `pg` surface TypeORM touches, counted

This is the specification for the facade. Found by grepping, not guessing; `escapeLiteral`,
`types.setTypeParser`, `pg.Client` and `pg.types` appear **nowhere** in TypeORM's source.

### On the module (3)

| # | member | site | note |
| --- | --- | --- | --- |
| 1 | `Pool` (constructor) | `PostgresDriver.ts:1774` | `new this.postgres.Pool(connectionOptions)` |
| 2 | `defaults.parseInt8` | `:1756-1770` | only when `options.parseInt8` is set; TypeORM checks `Object.getOwnPropertyDescriptor(defaults,'parseInt8')?.set` and **logs a warning and carries on** if there is no setter |
| 3 | `native` | `:1714-1715` | must be absent/falsy - see §1 |

`Client` is **never** used. That matters for §10.

### On a `Pool` (5)

| # | member | site |
| --- | --- | --- |
| 4 | `new Pool(opts)` where `opts` = `{connectionString, host, user, password, database, port, ssl, connectionTimeoutMillis, application_name, max, ...extra}` | `:1738-1754` |
| 5 | `pool.on("error", handler)` | `:1785` |
| 6 | `pool.connect((err, connection, release) => …)` - **callback form**, three arguments | `:1788`, `:1410`, `:1433` |
| 7 | `pool.end(cb)` | `:1823` |
| 8 | `pool.on("acquire", …)` | not TypeORM itself - **its own suite** asserts it (`test/functional/transaction/transaction-with-load-many/transaction-load-many.test.ts:36`) |

`pool.query()` is never called. Every statement goes through a connection checked out with
`pool.connect()`.

**Member 8 is the one this round's checklist missed and the suite caught** - see §9. Grepping
TypeORM's `src/` finds only `on("error")`, so it was not in the first count; the facade emitted no
`acquire` and one upstream test failed. The lesson is not about that one event but about the method:
`pg-pool`'s full event surface is `connect`, `acquire`, `release`, `remove`, `error`, and the facade
should emit all five rather than only what a grep of the consumer turns up.

### On a connection (6)

| # | member | site |
| --- | --- | --- |
| 9 | `connection.query(sql, params) → Promise` | `PostgresQueryRunner.ts:274` |
| 10 | `connection.query(sql, cb)` - callback form | `PostgresDriver.ts:1837` (`executeQuery`, used by the extension installer) |
| 11 | `connection.query(submittable) → stream` | `PostgresQueryRunner.ts:370` - see §3 |
| 12 | `connection.on("error", cb)` | `:107`, `:128` |
| 13 | `connection.removeListener("error", cb)` | `:101`, `:122` |
| 14 | `connection.on("notice", msg)` / `on("notification", msg)` | `PostgresDriver.ts:1792`, `:1797` - only when `logNotifications` is set; reads `msg.message`, `msg.channel`, `msg.payload`. **Half of this has no counterpart** - see below |

**`notification` maps; `notice` does not.** Measured on one connection each, with `LISTEN ch1` sent
as ordinary SQL and a `RAISE NOTICE` raised by a `DO` block:

| | `pg` | PostgreJS |
| --- | --- | --- |
| `notification` after a raw `LISTEN` | `{processId, channel, payload}` | **identical**, same field names |
| `notice` from `RAISE NOTICE` | `{message: 'hi'}` | **nothing emitted** |

So a TypeORM user with `logNotifications: true` gets the NOTIFY half and silently loses the NOTICE
half. PostgreJS does handle `NoticeResponse` on the wire (`connection/intl-connection.js:563` and
three sites in `prepared-statement.js`), so this is a small missing relay rather than a redesign -
the third upstream item this round turned up, and the only one that is a gap rather than a defect.

### The release callback (1)

| # | member | site |
| --- | --- | --- |
| 15 | `release()` / `release(err)` - the third argument of `pool.connect`'s callback | `PostgresQueryRunner.ts:104`, `:125` |

### On a result (3)

| # | member | site |
| --- | --- | --- |
| 16 | `raw.rows` | `PostgresQueryRunner.ts:303` |
| 17 | `raw.rowCount` | `:307` |
| 18 | `raw.command` - switched on `"DELETE"` / `"UPDATE"` | `:311-318` |

**`rows` and `rowCount` are read through `raw.hasOwnProperty(...)`**, so they must be **own
properties**. A result class with `get rows()` on its prototype fails silently - `result.records`
stays undefined and every query returns nothing. This is the single easiest way to get the facade
subtly wrong.

### On an error (0)

**Nothing.** `QueryFailedError` spreads the driver error's own enumerable properties onto itself and
builds its message from `driverError.toString()` (`src/error/QueryFailedError.ts:14-31`). Searching
the whole tree for `err.code`, `23505`, `42P01`, `severity`, `detail`, `routine` and `sqlState` finds
exactly one hit, and it is CockroachDB's serialization-failure retry
(`src/driver/cockroachdb/CockroachQueryRunner.ts:369`). **TypeORM's PostgreSQL path never branches on
SQLSTATE.** Error fidelity matters for user code and for TypeORM's own suite, not for TypeORM itself.

**Eighteen members, all public, none of them `pg` internals.** That is the effort estimate for the
core of the facade, and it is small.

## 3. The sub-packages

**`pg-native` - optional and inert.** `PlatformTools.load("pg-native")` sits inside a `try/catch` that
swallows the failure (`PostgresDriver.ts:1712-1716`). Nothing to do beyond not exposing `native`.

**`pg-query-stream` - optional, lazily loaded, and the one deep part of the surface.**
`loadStreamDependency()` is only called from `QueryRunner.stream()` (`PostgresDriver.ts:1689-1698`),
so importing the facade never touches it. But when it is used:

```ts
const stream = databaseConnection.query(new QueryStream(query, parameters))
```

`QueryStream.submit(connection)` delegates to `pg-cursor`, which drives **pg's private protocol
object** - `con.parse()`, `con.bind()`, `con.describe()`, `con.execute()`, `con.flush()` - and gets
`handleRowDescription` / `handleDataRow` / `handleCommandComplete` called back on it
(`pg-cursor/index.js:43-70`). Reimplementing that means reimplementing pg's internals.

**It does not have to be reimplemented.** TypeORM only ever uses the returned object as a
`ReadStream` with `on('end')` and `on('error')` (`PostgresQueryRunner.ts:373-374`); it never touches
the pg protocol itself. So the facade can detect `typeof arg.submit === 'function'`, read
`arg.cursor.text` and `arg.cursor.values` off it, and return **its own** `Readable` driven by a
PostgreJS `Cursor`. The spike does exactly that in 25 lines and the differential harness's `stream`
case is byte-identical to `pg`.

One constraint from `PlatformTools.load`: it has a hard allowlist of module names
(`src/platform/PlatformTools.ts:41-77`), so the facade **cannot** substitute its own stream module -
the real `pg-query-stream` must be installed for `stream()` to work at all. It is small and is only
used as a carrier for `text`/`values`.

## 4. Result and error shape

### Result

| TypeORM reads | PostgreJS `QueryResult` | mapping |
| --- | --- | --- |
| `rows` | `rows` | direct, `[]` when absent; must be an **own** property |
| `rowCount` | `rowsAffected` | direct for INSERT/UPDATE/DELETE/MERGE. PostgreJS leaves it `undefined` for SELECT where `pg` sets the row count, so the facade falls back to `rows.length` |
| `command` | `command` | **first word only.** `pg` takes the first word of the command tag, so it collapses `CREATE TABLE`/`CREATE INDEX`/… into `CREATE`. PostgreJS keeps the full tag. TypeORM only compares against `"DELETE"` and `"UPDATE"`, which are single words either way - but `db.query()` results reach users, so the facade splits on the space and can keep the full tag on a `commandTag` extra, as `postgrejs-drizzle` does |
| (`fields`, user-facing) | `fields` | rename `fieldName`→`name`, `dataTypeId`→`dataTypeID`, `tableId`→`tableID`, `columnId`→`columnID`, `fixedSize`→`dataTypeSize`, `modifier`→`dataTypeModifier` |

### Error

Measured across seven error classes - undefined table, syntax, unique, not-null, foreign key, check,
division by zero. **Every structured field is identical on all seven**: `code`, `severity`,
`constraint`, `detail`, `table`, `column`, `schema`, `hint`, `where`, `dataType`, `internalQuery`,
`internalPosition`. What differs:

| field | `pg` | PostgreJS | consequence |
| --- | --- | --- | --- |
| `message` | the bare sentence | the sentence **plus a caret diagram** pointing into the SQL | reaches the user through `QueryFailedError`'s message |
| `position` | `"15"` - a string | `15` - a number | a caller doing `Number(e.position)` is fine; `e.position === "15"` is not |
| `line` | PostgreSQL's **C source line**, `"1466"` | **the SQL text of the line**, `"select * from nope_nope"` | same name, entirely different meaning, and nothing about reading it fails loudly |
| `lineNr`, `colNr` | absent | where in the statement | additive |
| `file`, `routine`, `length` | present | absent | `pg`-only |
| `batchResults`, `failedIndex` | absent | present | additive |
| `name` | `"error"` | `"Error"` | feeds `driverError.toString()`, which `QueryFailedError` strips with `/^error: /` and `/^Error: /` - both match, so the message comes out right either way |

All of it is cosmetic **to TypeORM** (§2: it reads nothing), and all of it is fixable in the facade
if `pg` fidelity is wanted for user code. That is decision **D3**.

## 5. Parameter types

TypeORM builds a positional `any[]` and passes it straight through
(`PostgresQueryRunner.ts:274`); `escapeQueryWithParameters` only rewrites `:name` into `$n`
(`PostgresDriver.ts:1012-1054`). Values reach the driver after `preparePersistentValue`
(`:756-864`), which stringifies `json`/`jsonb`, `hstore`, `simple-array`, `cube`, `ltree`, `point`
and `circle`, runs the timestamp family through `DateUtils.mixedDateToDate`, and - the one that
matters most here - turns a `boolean` into `1`/`0`. See §5.4.

### 5.1 What the policy is

**Nothing is rendered.** A value PostgreJS would otherwise declare a type for is bound at OID 0
instead; everything else is handed over untouched, because PostgreJS already sends it untyped for
the same reasons `pg` does.

```ts
out[i] = postgrejsWouldDeclare(v) ? new BindParam(0, v) : v;
```

`src/params.ts` is ten lines of code under that. The reasoning is the rest of this section.

### 5.2 The surface: which values PostgreJS declares a type for

Measured one `select $1 as x` per value, comparing the result column's OID against `pg`'s:

| value | `pg` | PostgreJS | what this package does |
| --- | --- | --- | --- |
| string | `text` | `text` | hand over |
| `Date` | `text` | `text` | hand over |
| array of numbers | `text` | `text` | hand over |
| array of strings | `text` | `text` | hand over |
| `null` | `text` | `text` | hand over |
| **number** | `text` | `int4` / `numeric` | **hand over - see §5.3** |
| boolean | `text` | `bool` | bind at OID 0 |
| array of booleans | `text` | `bool[]` | bind at OID 0 |
| plain object | `text` | `json` | bind at OID 0 |
| `Buffer` | `bytea` (OID 0, bytes) | `bytea` | bind at OID 0 |

`test/B-live/params.spec.ts` pins this against a live server. **The hazardous direction is PostgreJS
beginning to declare something it currently leaves untyped**: such a value would be handed over,
come back a different type than `pg` gives, and nothing else here would notice - the matrix runs
the shapes an ORM writes, where context decides the type and both clients agree.

The `Buffer` row was wrong until it was pinned. It was handed over, on the reasoning that PostgreJS
sends bytes either way; it does, and it also declares `bytea` where `pg` declares nothing.
`select $1` on raw bytes is `22021` under `pg` and a `Buffer` back without the fix, while both
answer `0102ff` for `$1::bytea` - which is why it survived.

### 5.3 Why a number is allowed to be declared, and what it cost

A declared type does not only decide whether a parameter resolves. **It decides the type of any
result column derived from it**, and it decides which of PostgreSQL's two paths the value takes -
input parsing for text, assignment cast for a typed value:

```
  select $1 as x                with 7      pg  text / '7'    declared  int4 / 7
  select $1 * 2                 with 1.5    pg  22P02         declared  3.0
  insert into t (q bigint)      with 2.7    pg  22P02         declared  writes 3
```

The last one is the argument. `insert into t (q) values (2.7)` in plain SQL writes **3** - assigning
a numeric value to an integer column is an assignment cast and those round. `pg`'s `22P02` is what
PostgreSQL does with the *string* `'2.7'`, which is a consequence of the only technique `pg` has for
letting the server resolve a parameter from context, not a check it performs. Handed a JS number,
PostgreJS produces what the database produces for a number.

It is not free, and the price was measured rather than argued. Declaring numbers took TypeORM's own
functional suite from **806/806 to 739/806**. Bisected, those sixty-seven are `number` on its own:
handing numbers over reproduces all of them, and handing over booleans, boolean arrays and plain
objects costs none.

**And the cause was not the policy.** It was TypeORM sending `1` for a `boolean` column (§5.4). With
that corrected the suite is 806/806 with numbers declared, which is what made this the default.

Rendering a number to text loses nothing, which was the other thing worth checking: thirty shapes -
`0.1`, `0.30000000000000004`, `5e-324`, `1.7976931348623157e308`, `1e21`, `1e-7`,
`Number.MAX_SAFE_INTEGER`, `-0` among them - against `numeric`, `float8` and `int8`, **zero
differences from `pg`**. `String(n)` on a double is the shortest representation that round-trips.
So the cost of the old policy was never precision; it was the type.

### 5.4 `src/typeorm-boolean.ts`, which is a workaround

`PostgresDriver.preparePersistentValue` has, for every version in the peer range:

```ts
if (columnMetadata.type === Boolean) return value === true ? 1 : 0
```

PostgreSQL has a real `boolean`, so there is nothing to gain by it. It survives because `pg`
declares no type and sends it as text, and `'1'::boolean` is valid input - the integer never reaches
the column as an integer. Any client that declares a type gets
`42804 column "x" is of type boolean but expression is of type integer`.

This package patches it on import, **against the no-fixups rule in `CLAUDE.md` and on an explicit
decision**. Nothing is lost: TypeORM's suite is 806/806 with it, and the `pg` control in the same
invocation also ran patched and also stayed 806/806, since PostgreSQL accepts `'true'` and `'1'`
alike. It is global, because patching a prototype is, and benign for that same reason.
`TYPEORM_POSTGREJS_NO_BOOLEAN_PATCH=1` skips it. **Remove it when TypeORM fixes it.**

It patches the TypeORM it can resolve, which in an application is the one the application uses.
`scripts/run-typeorm-suite.sh` is not an application - it runs TypeORM's tests from a checkout with
no `node_modules/typeorm` in it - so it names the module with `TYPEORM_POSTGREJS_TYPEORM`. Without
that the patch silently did nothing for a whole run and the sixty-seven came back unchanged.

### 5.5 Why nothing is rendered any more

Binding at OID 0 used to mean `new BindParam(0, prepareValue(v))`. It had to: PostgreJS wrote an
undeclared parameter with `String(v)`, which produced `[object Object]` for a plain object, for an
object inside an array, and for any value whose class implements `toPostgres()` - `pg`'s own
extension point. Reported upstream and fixed in `a11a9af`, which writes an undeclared parameter the
way `pg` writes one, `toPostgres()` re-entering the same dispatch.

Re-measured against that build, every shape that still takes this branch - `true`, `false`, a
boolean array, a plain object, a nested object, a caller's `toPostgres()` class, a `Buffer`, an
object carrying a `Date` - is byte-identical to `pg` **with no rendering at all**. So there is none.

Two differences remain between an undeclared parameter here and under `pg`, both declined upstream
and both read identically by the server: a `Date` is written with a space where `pg` writes `T`, and
a number array as `{1,2,3}` where `pg` writes `{"1","2","3"}`. The second is why a 100 000-element
`int4[]` is 1 100 146 bytes here against `pg`'s 1 300 124.

### 5.6 The three policies, and what `prepare-value.ts` is for

`inferParameterTypes` selects between them:

| value | what it does |
| --- | --- |
| unset | §5.1 - the default |
| `true` | hand every value over, including numbers' neighbours; PostgreJS types all of it |
| `false` | render every value with `pg`'s own function and declare nothing: `pg` byte for byte |

`false` exists because this is a `pg` facade and code that depends on `pg`'s answers exactly -
including the ones where `pg` loses information - must have a way to keep them. It is the only
caller of `src/prepare-value.ts`, which is a port of `pg`'s own function held to it by a test that
calls both. `parseInputDatesAsUTC` has meaning only there, for the same reason.

The three were scored on 28 query shapes during the recon round, before any of the upstream fixes:
`raw` 23/28, `bind0` 23/28, `pgwire` 28/28. Both of the first two reached 27/28 once the defects in
§5.7 were fixed, and the remaining case - `[]` and `[null]`, which `determine()` could not type -
is closed too. **The score stopped being the argument some time ago**; what decides it now is which
answer is right for the value the caller passed, which is §5.3.

### 5.7 The pinned divergences

`pg` is the oracle for every parameter shape except two, and in both `pg` is the one losing
information. They are pinned on *both* sides in `test/B-live/params.spec.ts` - a change on either
fails - rather than skipped:

| | `pg` | here |
| --- | --- | --- |
| `select $1` with `12` | `'12'` (string) | `12` (number) |
| `select $1 * 2` with `1.5` | `22P02` | `'3.0'` |

A parameter with nothing around it to resolve from is the only place this shows. Everywhere else -
a column, a comparison, a function argument - the context decides and both land on the same value,
which is why the rest of the matrix and the differential suite are untouched by it.

### 5.8 The two PostgreJS defects this turned up - both since fixed

Both were in PostgreJS itself, both silently corrupted data, and **both affected `postgrejs-kysely`** - its `_params` (`src/postgrejs-connection.ts:229-244`) wraps only scalars and leaves `Date`
and arrays to PostgreJS's encoders, which is precisely the `bind0` policy in §5.6.
`postgrejs-drizzle` is shielded by accident: drizzle stringifies arrays and dates in its own column
encoders before the driver sees them.

**(a) A JS `Date` does not round-trip through a `timestamptz` column.** Isolated, no ORM involved:

```js
const d = new Date('2024-03-05T06:07:08.900Z')
await c.query('insert into rt values($1)', { params: [d] })
const r = await c.query('select v from rt', { objectRows: true })
r.rows[0].v.toISOString()   // 2024-03-05T09:07:08.900Z  - shifted by the local UTC offset
```

**The encoders are not at fault - the declared type is.** `TimestamptzType.encodeBinary` writes the
absolute instant and is correct; `BindParam(timestamptz, d)` round-trips exactly. The bug is that
`GlobalTypeMap.determine(new Date())` returns **1114, `timestamp`** - the zone-less type - so the
server reads that wall clock in the session `TimeZone` on the way into a `timestamptz` column. No
single declared OID is right for both column kinds, which is why `pg` sends OID 0 with an
offset-bearing text form and lets the server decide.

`utcDates: true` is not a workaround either: it fixes `timestamptz` and breaks `timestamp`, which
`pg` writes as local wall time - so neither setting reproduces `pg` for both, measured on one
connection:

| | `timestamptz` | `timestamp` |
| --- | --- | --- |
| `pg` | `06:07:08.9+00` | `09:07:08.9` |
| PostgreJS default | **`09:07:08.9+00`** | `09:07:08.9` |
| PostgreJS `utcDates: true` | `06:07:08.9+00` | **`06:07:08.9`** |

Invisible whenever the session's `TimeZone` and the Node process's zone **agree** - not merely at
UTC, which is how the first write-up of this put it. That is what let it survive, and it is also why
declaring `timestamptz` instead would not have helped: with the zones agreeing it changes nothing,
and with them differing it moves the damage from `timestamptz` to `timestamp`. Measured here with
the server at UTC and the process at UTC+03.

**(b) The binary array encoder writes lower bound 0.**
`../postgrejs/src/util/encode-binaryarray.ts:31` is `io.writeInt32BE(0); // LBound always 0.`
PostgreSQL's convention is 1, and the difference is observable:

```
pgjs param   -> { first: 20, lo: 0, lit: '[0:2]={10,20,30}' }
pgwire param -> { first: 10, lo: 1, lit: '{10,20,30}' }
```

`arr[1]` returns the **second** element. Every application that indexes an array it inserted is
wrong, and `array_lower` reports 0. A one-line fix, worth doing upstream regardless of this package.

## 6. Decoding - how much has to be turned off

This is where the round diverges hardest from `postgrejs-drizzle`, and the divergence is worth
stating plainly because it would otherwise be copied wholesale:

> **The drizzle round's `fetchAsString` list is wrong here.** `drizzle-orm/node-postgres` *overrides*
> `pg`'s parsers for TIMESTAMP, TIMESTAMPTZ, DATE and INTERVAL to get raw strings, so its driver has
> to ask PostgreJS for strings too. **TypeORM uses `pg`'s stock parsers**, which return `Date`
> objects - and PostgreJS already returns the identical `Date`. Asking for strings there *creates* a
> divergence instead of removing one.

Measured over 64 scalar and array types, `pg` versus PostgreJS, comparing the value a TypeORM user
would receive:

| mode | | score |
| --- | --- | --- |
| **A** | PostgreJS defaults | 35/56\* |
| **B** | `unknownTypesAsString: true` | **43/64** |
| **D** | B + the re-derived `fetchAsString` list | **58/64** |
| **E** | D + a post-decode fixup | **62/64**, and **64/64** with `postgres-interval` |

<sub>\*A was measured on the first, 56-case pass; B/D/E on the second, 64-case pass. B appears in both.</sub>

**`unknownTypesAsString: true` alone is worth 8 cases** and is not optional: without it an `enum`
column returns a raw `Buffer`, and so do composites and everything else PostgreJS has no decoder
for.

> `money` was in that list when this was measured and is not any more. PostgreJS gained a decoder
> for it (upstream `285097e`, `3ed2812`) which returns a **number**, where `pg` returns the server's
> own text - `$99,999,999,999,999.99`, symbol, grouping and all, because `pg-types` registers no
> parser for OID 790. So `money` moved into `fetchAsString`, and `money[]` needed both halves: `pg`
> *does* give a real array for it (`register(791, parseStringArray)`) whose elements are that same
> text, which no amount of formatting rebuilds from a number. The literal is fetched and split with
> `postgres-array`, the library `pg` splits it with.
>
> This is the shape of change to expect from here: the divergence list is not a property of the two
> libraries but of a moment in both. It was the **type matrix that caught it**, not the TypeORM
> suite - `money` appears nowhere in TypeORM's tests - which is the argument for keeping `pg` as the
> oracle rather than a table.

**The `fetchAsString` list, re-derived.** Only types where `pg`'s own value is a string and
PostgreJS's is not:

```
int8, numeric, time, interval, money,
line, lseg, box, path, polygon,
_line, _lseg, _box, _path, _polygon, _circle, _money,
+ the range family (int4range, int8range, numrange, daterange, tsrange, tstzrange,
  their multirange counterparts, and the array OIDs of each)
```

**An array OID in that list is a different thing from a scalar one**, and getting it wrong is easy:
it makes the whole array literal come back as **one string**, not as a JS array. So an array type
belongs there only where `pg` also hands back a string - which, measured, is the geometric family
**except `point[]`**, plus `money[]`, which is there for the opposite reason and is mapped back into
an array afterwards:

| | `pg` | PostgreJS, native |
| --- | --- | --- |
| `line[]`, `lseg[]`, `box[]`, `path[]`, `polygon[]`, `circle[]` | the literal, as a string | an array of typed classes |
| `interval[]`, `point[]` | a real array of `PostgresInterval` / `{x, y}` | an array of typed classes |
| `int8[]` | a real array of strings | an array of numbers |

The last three are therefore **not** in the list - they are decoded natively and mapped element by
element instead. `interval` and `interval[]` ending up on opposite sides of that line is the part
worth remembering.

`date`, `timestamp`, `timestamptz` and their array forms are **deliberately absent** - PostgreJS
already matches `pg` exactly on all six, verified. So is `_numeric`: `pg`'s array parser runs
`parseFloat` per element even though scalar `numeric` stays a string, and PostgreJS agrees.

**What no wire option can reach - the fixup, 4 types.** `fetchAsString` gives a string; PostgreJS's
decoder gives a class instance; `pg` gives a plain object or an array of strings. Neither end of the
wire produces `pg`'s shape, so the facade maps it after decoding:

| type | `pg` | PostgreJS | fixup |
| --- | --- | --- | --- |
| `point`, `point[]` | `{x,y}` plain object | `Point` instance | copy `x`, `y` |
| `circle` | `{x,y,radius}` | `Circle` instance with **`r`**, not `radius` | rename |
| `interval` | `PostgresInterval` instance | `Interval` instance - **identical seven fields**, different prototype and `toJSON` | `fetchAsString` + `postgresInterval(str)` |
| `interval[]` | array of `PostgresInterval` | array of `Interval` | native decode, then `postgresInterval(String(el))` per element |
| `int8[]` | `["1","2"]` | `[1, 2]` (numbers, BigInt past 2^53) | `.map(String)` - exact, because `String(bigint)` is exact |

**`postgres-interval` has to be pinned to the major `pg` itself resolves, and it is not the current
one.** `pg@8` depends on `pg-types@2`, which pins `postgres-interval@^1.1.0`; v1 assigns only the
fields the interval actually carries, while v3 assigns all seven. So `'1 day'` is `{days: 1}` under
v1 and `{years: 0, months: 0, days: 1, hours: 0, ...}` under v3, and only the first is what a `pg`
user sees. Caught by the differential harness on its first run against the real `src/`; the
dependency is `^1.2.0`.

### What `pg` fidelity costs, in both directions

Asked for by the task, and the honest answer is: **less than expected, because most of it is not
lost.** The 64-case matrix shows PostgreJS's richer decoding surviving untouched for `json`/`jsonb`
(parsed objects), `bytea` (Buffer), `bool`, the date/time family (real `Date`s), and every array of
those. What the facade gives up:

| type | PostgreJS native | as `pg` |
| --- | --- | --- |
| `numeric` | `number`, or a `Numeric` when a double cannot carry it | a string |
| `int8` | `number`, or `BigInt` past 2^53 | a string |
| `interval` | `Interval` with `totalMonths`, `totalMicroseconds` | `PostgresInterval` |
| `point`, `circle`, `line`, `lseg`, `box`, `path`, `polygon` | typed classes with `toString`/`toJSON` | plain objects and strings |
| ranges | `Range` objects | strings |
| `time` | a `Date` on 1970-01-01 | a string |

And what breaks if the decoding is **kept**: `numeric` loses precision
(`1234567890123456789.12` → `1234567890123456800`) and TypeORM hands that straight to the user,
because a `numeric` column has no hydration branch (`PostgresDriver.ts:872-1004`); `int8` reaches
user code as a number or BigInt where every TypeORM tutorial says string; a `Number`-typed column
runs `parseInt(value)` (`:993-995`), which truncates; and enums return `Buffer`s.

The decision is not "which is better" but "what is this package for", which is **D1**.

## 7. Transactions and savepoints

All plain SQL through `QueryRunner.query()`, so the facade sees ordinary statements
(`PostgresQueryRunner.ts:183-246`):

| depth | start | commit | rollback |
| --- | --- | --- | --- |
| 0 | `START TRANSACTION`, then `SET TRANSACTION ISOLATION LEVEL <x>` if asked | `COMMIT` | `ROLLBACK` |
| n>0 | `` SAVEPOINT typeorm_${depth} `` | `` RELEASE SAVEPOINT typeorm_${depth-1} `` | `` ROLLBACK TO SAVEPOINT typeorm_${depth-1} `` |

Savepoint names are generated from a counter and are **not user-controllable** - nothing to validate
or escape. `validateIsolationLevel` checks the level against `driver.supportedIsolationLevels` before
it is interpolated (`:178-182`).

**`rollbackOnError: false` is required, as in both sibling repos.** PostgreJS's default wraps every
statement in a savepoint of its own, so a failed statement leaves the transaction usable - the
opposite of PostgreSQL's semantics and of `pg`'s. Verified through TypeORM end to end: with
`rollbackOnError: false` the facade reproduces `pg` exactly - the second statement after a failure
raises `25P02 current transaction is aborted`, and the differential's `aborted transaction`,
`transaction rollback` and `nested transaction = savepoint` cases are identical.

One thing the facade must get right, and it follows from §2: `pool.connect()` checks out **one**
connection for the life of the QueryRunner, and every statement including `START TRANSACTION` runs on
it. The facade maps that onto `pool.acquire()` / `pool.release(con)`. `Pool.query()` must never be
used - it is free to pick a different connection per call, which would scatter a transaction.

## 8. Connection pooling

**The facade wraps PostgreJS's `Pool`.** TypeORM's pool *is* `pg.Pool`: it sizes it (`max`), attaches
its own error handler, checks connections out one per QueryRunner and ends it on `destroy()`. There
is no version of this where TypeORM pools single connections itself - `createPool` is the only path
to a connection (`PostgresDriver.ts:1729-1810`), and replication creates one pool per server.

The mapping is small: `connect(cb)` → `acquire()`, the third callback argument → `release(con)`,
`end(cb)` → `close()`. Option translation is mechanical, with one thing to get right: **PostgreJS
takes a connection string as its first argument or as `host`, and does not understand
`{ connectionString }`** - a config that silently lands you on `localhost:5432/postgres`. TypeORM
passes `connectionString: credentials.url` (`:1741`), so the facade must translate it.

**Dead connections diverge, measured.** A backend terminated mid-query:

| | `pg` | facade |
| --- | --- | --- |
| in-flight query rejects with | `57P01` *terminating connection due to administrator command* - the server's own notice | `ConnectionLostError` `08006` |
| `poolErrorHandler` | **not called** | **called** with the `ConnectionLostError` |
| next statement on that runner | `Connection terminated unexpectedly` | `Connection closed` |
| pool recovers for the next caller | yes | yes |

Both recover, and the failure is reported either way - but a TypeORM user on the facade gets a
`Postgres pool raised an error` warning in the log that `pg` never produces, and an `08006` where
`pg` reports the server's more specific `57P01`. Whether to suppress the duplicate pool event when
the in-flight query already carries the same error is decision **D4**.

## 9. A test oracle - yes, TypeORM's own suite, with one patch

`getTypeOrmConfig()` is `require(ormconfig.json)` (`test/utils/test-utils.ts:212-214`), and a JSON
file cannot carry a `driver` object. That is the only obstacle, and it is one function:

```ts
export function getTypeOrmConfig(): TestingConnectionOptions[] {
    const configs = require(getOrmFilepath())
    const injected = process.env.TYPEORM_PG_DRIVER
    if (injected)
        for (const c of configs)
            if (c.type === "postgres") (c as any).driver = require(injected)
    return configs
}
```

Everything downstream already works: `setupTestingConnections()` copies the config object through
(`:247-252`), and the suite compiles to 947 test files, 536 of them under
`test/functional`.

**It runs.** Checkout at tag `1.1.1`, `pnpm install --ignore-scripts`, `pnpm run compile`, an
`ormconfig.json` with only the postgres entry, that patch, and mocha pointed at a slice - **one
mocha process per test file**, with the database reset before each, because these tests leave schema
behind:

| slice | files | control | facade |
| --- | ---: | ---: | ---: |
| `functional/query-runner` | 30 | 63 pass, 0 fail | 63 pass, 0 fail |
| `functional/transaction` | 13 | 84 pass, 0 fail | 84 pass, 0 fail |
| `functional/query-builder` (first 25 files) | 25 | 167 pass, 0 fail | 167 pass, 0 fail |
| `functional/repository` (first 15 files) | 15 | 184 pass, 0 fail | 184 pass, 0 fail |
| `functional/persistence` (first 20 files) | 17 | 59 pass, 0 fail | 59 pass, 0 fail |
| `functional/database-schema/column-types/postgres*` | 3 | 29 pass, 0 fail | 29 pass, 0 fail |
| `functional/database-schema/*` | 8 | 15 pass, 0 fail | 15 pass, 0 fail |
| **total** | **111** | **601 pass, 0 fail** | **601 pass, 0 fail** |

Streaming, enums, enum arrays, jsonpath, isolation levels, nested transactions, `RETURNING`, date
parameters, SQL-injection guards and error stack traces are all in there and all at parity.

**It found a bug the differential harness did not.**
`transaction-with-load-many/transaction-load-many.test.ts:36` attaches `pool.on("acquire")` and
asserts it fires exactly once; the first facade emitted no such event and the test failed - the only
failure in the 601. Emitting `acquire` and `release` fixed it, and that is how member 8 got onto the
§2 checklist. Worth the whole exercise on its own: 20 hand-written differential cases and a
grep of TypeORM's `src/` both missed it, because the thing that reads the event lives in the suite
rather than in the library.


**Absolute pass counts are meaningless here and a pinned `EXPECTED_FAILURES` would be a lie.** The
same file scored 1 passing / 4 failing and then 5 passing / 0 failing across two consecutive runs -
these tests leave schema behind and read it back. So the harness resets the database and runs a
`pg` control **in the same invocation**, and only a delta against that control is news. That is the
same conclusion `scripts/run-drizzle-suite.sh` reached in the sibling repo, arrived at independently
and for a different reason.

Two guards the sibling script earned and this one needs from the start: a run that collects **zero**
tests is a failure, not a clean sweep (mocha reports `0 passing (0ms)` and exits 0 when a glob
misfires - it happened here); and the two runs must collect the **same number** of tests.

### The differential harness is worth building anyway

The same TypeORM program through `pg` and through the facade, deep-compared - 20 cases covering
insert/find, numeric precision, query builder parameters, `IN (...)`, update/delete counts,
`RETURNING`, relations, aggregates, raw query shapes, structured results, transactions, savepoints,
isolation levels, aborted transactions, unique violations, error fields, streaming, catalog
introspection and concurrent pool use:

**19/20 identical.** The one difference is the error object - `message` carrying the caret diagram,
`position` as a number, `routine` absent (§4).

It caught things the suite would not have named: `hasOwnProperty` on the result, the `timestamptz`
write shift, and - usefully - that TypeORM's own `columnsSql` has **no `ORDER BY`**
(`PostgresQueryRunner.ts:3667-3690`), so `getTable().columns` comes back in a plan-dependent order
that differs between two runs of the *same* driver. The harness sorts before comparing; a future
suite runner has to expect the same class of noise.

## 10. How far the facade carries - and it does not carry as far as hoped

This is the strategic argument for choosing TypeORM over Prisma, so it gets a straight answer:
**the leverage is real for knex and not real for pg-promise or Sequelize.** Checked against each
library's own source.

| | needs | verdict |
| --- | --- | --- |
| **TypeORM** 1.1.1 | `Pool` + 4 pool members + 6 connection members + 3 result fields | the 17 of §2, all public |
| **knex** 3.3.0 | `new driver.Client(settings)` + `client.connect()` (`lib/dialects/postgres/index.js:82`, `:92`), `connection.on('error'|'end')` (`:84`, `:88`), `connection.end(cb)` (`:120`), optional `connection.release(bool)` (`:144-147`), `connection.query(sql, cb)` **and** `query(queryConfig, cb)` (`:279`), `pg-query-stream` (`:250`), `resp.command` / `resp.rowCount` (`:293-307`) | **plausible.** It needs `Client` where TypeORM needs `Pool`, and query-config objects - a real but bounded addition, both wrapping the same PostgreJS `Connection` |
| **pg-promise** 12.7.1 | `pg.Client.prototype.connect` **monkey-patched** (`lib/main.js:185-186`), and inside the patch `this.connection.on('parameterStatus', …)` - **pg's private protocol object** - plus `pg.Pool` (`lib/database.js:126`) and `pg.native` (`lib/main.js:179`) | **hard.** Requires exposing a private surface, on a prototype a third party rewrites |
| **Sequelize** v6.37.8 | `lib.types.getTypeParser(oid)` / `setTypeParser` / `types.arrayParser.create()` (`lib/dialects/postgres/connection-manager.js:23`, `:53`, `:68`) plus `Client` (`:100`) | **hard, and different in kind.** It wants pg's *parser-function registry*; PostgreJS decodes at the wire level, so there is no function to hand back |

So the CLAUDE.md table needs amending. The honest pitch is **"a `pg` facade that TypeORM and knex can
both use"**, roughly 3.6M + 3.8M weekly downloads of addressable surface, not "replace `pg`
everywhere". That is still a much better payoff than a single dialect, and TypeORM alone already
justifies it - but the argument should not be made on pg-promise or Sequelize.

## 11. Peer range - and it is remarkable

The lines in `PostgresDriver.ts` and `PostgresQueryRunner.ts` that touch `pg` were extracted at each
tag and hashed, with quotes and trailing semicolons normalised so prettier's 0.3.0 reformat does not
register as a change:

| tag | lines | seam hash | change |
| --- | ---: | --- | --- |
| 0.2.38 | 23 | `593d2c4b4c` | **no `options.driver`** - `this.postgres = PlatformTools.load("pg")`, hard-wired. This is the floor |
| **0.2.39** | 24 | `e7f0c57959` | `options.driver` introduced (2021-11-09). The seam begins here |
| 0.2.45 | 24 | `333d06833c` | `hosts`-related line wrapping only |
| 0.3.0 | 25 | `889acef444` | prettier reformat; every `pg` call identical to 0.2.39 |
| 0.3.20 - 0.3.31 | 28 | `8c50c16b93` | **+ `defaults.parseInt8`** (3 lines) - the one semantic addition. Byte-identical across the whole 0.3 line |
| 1.0.0 - 1.1.1 | 28 | `71872c24a3` | `\|\|` → `??` in two places. Nothing else |

**Four years and two major versions, and the only semantic change is one optional property.**
`DriverFactory.ts` and `PostgresDataSourceOptions.ts` are byte-identical across 1.0.0, 1.1.0 and
1.1.1.

Two things do change below 0.2.39 and both rule it out as a target: `options.driver` does not exist,
and `QueryRunner` calls `databaseConnection.query(sql, params, cb)` in callback form rather than
awaiting it.

Confirmed by running: the **same unmodified spike facade** drives the smoke test identically on
`typeorm@0.3.31` and `typeorm@1.1.1` - same types, same affected counts, same transaction and
savepoint behaviour, in two separate installs.

**The honest peer range is `>=0.3.0 <2`**, tested at both ends, with the seam unchanged back to
0.2.39 by inspection - `>=0.2.39` would be defensible too, but nothing below 0.3.0 was run. Note
TypeORM reset its versioning - 1.x follows 0.3.x - so the major bump carried no seam change at all.

**And unlike the drizzle round, the target line is alive.** `typeorm@1.1.1` is `latest` and was
published 2026-09-20, with nightlies through `1.1.1-nightly.20260920`. There is no dead-branch risk
here; it is the single biggest way this round differs from the last one.

---

## Effort estimate

**Mechanical - 2 to 3 days.** The 17-member surface of §2, the `pgwire` parameter policy of §5, the
`fetchAsString` list and fixup of §6, the pool mapping of §8 and the stream interception of §3 are
all settled by measurement and all transcription from the spike. The spike is 180 lines and already
does every one of them; a real `src/` is that plus option validation, types, config plumbing and the
member-order conventions.

**Known work, sized - 3 to 5 days.** `scripts/run-typeorm-suite.sh`: a pinned checkout, `pnpm` via
`COREPACK_INTEGRITY_KEYS=0` (corepack's signature check fails on Node 24 here, the same way it failed
for Kysely - see the sibling script's `npx --yes pnpm@…` workaround, which does **not** work here
because TypeORM's `devEngines` block rejects npm), the `getTypeOrmConfig` patch, a database reset per
file, the `pg` control in the same invocation, and the zero-tests and equal-count guards. Plus the
`test/A-common` fakes and promoting the differential harness out of the scratch directory.

**Unknowns - two, both small.** How much of the 947-file suite is green for `pg` in the first place
on a given server (the slice measured here is at parity, but the whole thing has not been run); and
whether any TypeORM feature outside the differential's 20 cases reaches a `pg` member §2 missed -
`LISTEN`/`NOTIFY` through `logNotifications` is the most likely candidate, since it is the one path
the spike stubs rather than implements.

**Biggest risk.** Not technical. It is that the facade's value proposition is *also* its liability:
being `pg` means suppressing the decoding that is PostgreJS's headline advantage, so the package has
to be sold on wire throughput and on not needing `pg` at all, not on richer values. §6 quantifies
exactly what is suppressed, and the answer is smaller than feared - `json`, `bytea`, the date family
and every array of them keep PostgreJS's decoding - but `numeric` and `int8` become strings, and
those are the two people notice.

The second risk is the one §10 names: if the strategic case rests on four ecosystems and only two are
reachable, the scope should be set accordingly now rather than discovered later.

## Proposed layout

Following the sibling repos' split and `../postgrejs`'s member-order and `protected`-over-`private`
conventions.

```
src/
  index.ts          exports the module object (Pool, Client, defaults), the config type
  pool.ts           PgPool facade: connect(cb)/end(cb)/on('error'), option translation
                    NB: PostgreJS takes a connection string as its FIRST ARGUMENT or as
                    `host`. `{ connectionString }` is not one of its options and is
                    silently ignored, landing you on localhost:5432/postgres - and
                    TypeORM passes exactly that (PostgresDriver.ts:1741).
  client.ts         PgClient facade: the three query() overloads, notice/notification
                    relay, error listener bookkeeping
  params.ts         the pgwire policy of §5 - pg's own prepareValue, then OID 0
  result.ts         QueryResult -> pg result. rows/rowCount as OWN properties (§2),
                    command's first word, field renames, the §6 fixup
  types.ts          the fetchAsString OID list of §6 + the range family
  stream.ts         the pg-query-stream submittable interception of §3
  errors.ts         the §4 normalisations, behind config (D3)
  config.ts         PgjsTypeormConfig
  constants.ts

test/
  _support/
    fakes.ts        a fake PostgreJS Connection/Pool recording every call
    differential.ts the pg-vs-facade runner
  A-common/         against the fakes: option translation, the three query overloads,
                    hasOwnProperty on the result, param policy, the fixup table,
                    release(err) bookkeeping, native must stay undefined
  B-live/           against 127.0.0.1:5432: the §6 type matrix and the §5 param matrix
                    as explicit regression tables, the dead-connection case of §8
  C-differential/   the 20 TypeORM programs of §9 through pg and through us, deep-compared

scripts/
  run-typeorm-suite.sh   pinned typeorm checkout, compile, getTypeOrmConfig patch,
                         per-file database reset, pg control in the same invocation,
                         fails only on a delta
```

## Decisions that need you

Everything settled by evidence is settled above and not repeated. These four are not.

**D1 - `pg`-faithful by default, PostgreJS-faithful by default, or configurable?**
This is the one the CLAUDE.md flagged, and §6 has now priced it.
**(A)** `pg`-faithful always. The package *is* `pg`; anything else is a bug. `numeric` and `int8`
come back as strings.
**(B)** `pg`-faithful by default, with one option (say `decoding: 'pg' | 'native'`) that turns the
suppression off for someone who wants `numeric` as a `Numeric` and knows their code handles it.
**(C)** PostgreJS-faithful by default.
My recommendation is **(B)**. (C) is untenable - it silently corrupts `numeric` through an ORM that
documents strings. (A) is right for the default and (B) costs one branch, because the suppression is
already expressed as two query options and one lookup table; the escape hatch is the same code with
the list empty. But the default is the product decision and it is yours.

**D2 - Take `postgres-interval` as a dependency?**
Yes / no. It buys the last 2 of 64 type cases: a real `PostgresInterval` instance with `toISOString()`
and `toPostgres()`, rather than a plain object with the same seven fields. One file, no dependencies
of its own, already in the tree of anyone who has `pg`. I would take it - but it is a dependency on a
package the whole point of this project is to stop depending on, which is a reasonable thing to mind.

**D3 - Normalise the error object to `pg`'s shape?**
Independently, three of them: **(a)** strip the caret diagram from `message`; **(b)** `String()` the
`position`; **(c)** drop or rename `line`, whose meaning differs (§4). TypeORM itself reads none of
them, so this is entirely about user code and about TypeORM's own suite. I would do (a) and (b) and
leave (c) as a documented difference, since faking `file`/`routine` would mean inventing values.

**D4 - Suppress the duplicate pool error event?**
When a pooled connection dies, PostgreJS reports it on the pool *and* rejects the in-flight query,
where `pg` only rejects the query (§8). The facade can swallow the pool event when a query already
carries the same error. Yes / no. I lean yes: TypeORM's default `poolErrorHandler` logs a warning, so
the difference is a log line users will ask about.

**D5 - Scope: TypeORM only, or TypeORM + knex from the start?**
**(A)** TypeORM only; add `Client` later if knex is ever wanted.
**(B)** Build `Pool` and `Client` together now, since §10 shows knex needs the same wrapper with a
different entry point, and retrofitting `Client` afterwards means reworking `client.ts`'s lifecycle.
I lean **(B)** - the extra work is small and the strategic argument in CLAUDE.md is the reason this
target was chosen over Prisma. But it doubles the conformance surface, so it is a real choice.

## Recommendation: proceed

Every one of the ways this could have been not worth doing was checked, and none of them holds.

The seam is **public, tiny and five years stable** - 17 members, one optional property added since
2021, and the same facade runs unmodified on 0.3.31 and 1.1.1. The suppression the CLAUDE.md worried
about is **smaller than feared**: `json`, `jsonb`, `bytea`, `bool`, the whole date/time family and
every array of them keep PostgreJS's decoding untouched, and what has to be given up is `numeric`,
`int8`, the geometric classes and ranges - real, but not "nothing left worth choosing it for". There
is a **real conformance oracle** in TypeORM's own suite, reachable with a one-function patch, and a
differential harness that is already **19/20 identical**. And the target line is **alive**, which the
drizzle round's was not.

What I would do next, in this order:

1. **Fix the two PostgreJS defects first** (§5). Both corrupt data, both are one-line-ish, and both
   affect `postgrejs-kysely` right now - the `timestamptz` write shift especially, because it is
   invisible in a UTC deployment and wrong everywhere else. Doing them first also means the facade
   never has to work around them, and `postgrejs-kysely` should be re-run against the fixed build.
   The third upstream item, the missing `notice` relay (§2), is a feature rather than a defect and
   can follow.
2. **Stand up `scripts/run-typeorm-suite.sh` with the control run**, before `src/`. §9 shows the
   suite's own score moving between runs of the same driver; without the control in the same
   invocation, every later measurement is noise.
3. **Then write the facade**, which is two to three days because §§2-8 have already decided
   everything it has to decide.

The one thing I would not do is start `src/` first. Not because it is hard - on this evidence it is
the cheapest part - but because step 2 is what keeps it honest.

---

## What actually happened

Step 1 was done first, as recommended, and all three items were fixed upstream. Every measurement in
§5 and §6 above was re-taken against that build; two moved, and both are marked in place - a bare
`Date` now matches `pg` on all three column kinds, which takes the two rejected parameter policies
from 23/28 to 27/28.

**Steps 2 and 3 were taken in the opposite order**, which is worth recording rather than quietly
tidying away. `src/` was written against a throwaway copy of the suite runner, and
`scripts/run-typeorm-suite.sh` was only then promoted into the repository. It did not cost anything
here - the throwaway ran the same per-file control comparison from the start, and it is what caught
the missing `pool.on('acquire')` - but the argument for step 2 first still stands, because nothing
about the throwaway was reviewable and a second person could not have re-run it.

Four things were found after `src/` compiled that reading either library had not turned up:

- **`postgres-interval` has to be pinned to `^1.2.0`**, the major `pg-types@2` resolves. v3 assigns
  all seven interval fields where v1 assigns only the ones the value carries, so `'1 day'` is
  `{days: 1}` to a `pg` user and `{years: 0, months: 0, days: 1, ...}` under v3. Caught by the
  differential harness.
- **An array OID in `fetchAsString` returns the whole literal as one string**, so it belongs there
  only where `pg` also returns a string. Caught by the live type matrix.
- **PostgreJS's pool sizes are top-level**, not under a `pool` key; nesting them is accepted by
  JavaScript and silently does nothing. Caught by the compiler, having survived the spike.
- **The facade must not be copied into the suite's `node_modules`**, which is what the sibling
  drizzle script does. That one has to share a single copy of `drizzle-orm` between the suite and
  the driver; this one shares nothing with TypeORM, and copying it in put `postgrejs` somewhere its
  own dependencies could not be resolved from - every test died in a before-hook with
  `Cannot find package 'flexy-buffer'`. Caught by the script's own equal-count guard, on its first
  real run, which is the guard earning its place.

None of the first three was reachable by reading either library. They are the case for the
differential harness, which is the only thing that would have caught them.

### And four more, found by probing `pg` rather than by running TypeORM

The 806-test suite run was green before any of these were noticed, which is the useful part: TypeORM
issues its DDL one statement at a time and reads `rowCount` only for writes, so none of them is on a
path it takes. They were found by asking `pg` what it does with statement shapes the facade had not
been shown, and comparing.

| | `pg` | the facade, before |
| --- | --- | --- |
| `select 1; select 2` | a **bare array** of two results | `42601 cannot insert multiple commands into a prepared statement` |
| `query('')` | `{command: null, rowCount: null, rows: [], fields: []}` | `Server returned unexpected response message (I)` |
| `create table …` | `rowCount: **null**` | `rowCount: 0` |
| `{text, rowMode: 'array'}` | `[[1, 2]]` | `[{a: 1, b: 2}]` |

`rowCount` is the subtle one. `pg` takes it straight off the command tag, so a tag carrying no count
- CREATE, DROP, TRUNCATE, SET, BEGIN, COMMIT - gives `null`, not 0. Measured across 11 statement
kinds. "Affected nothing" and "did not say" are different answers and a caller can tell.

**Multi-statement needs the simple protocol**, which is a property of the two libraries rather than a
defect: `pg` sends any parameterless statement over the simple protocol, where several commands are
allowed and each answers with its own result; PostgreJS's `query()` is always the extended protocol,
where the server refuses. `execute()` is the simple protocol here, so the facade retries on `42601`
when there are no parameters.

That retry is only safe because **`42601` is raised at Parse, before any command in the string
runs** - otherwise it would double every write in a multi-statement INSERT. Verified rather than
reasoned: two INSERTs, the call fails, the table is still empty; after the retry it has two rows, not
four. `test/B-live/statement-kinds.spec.ts` pins it.

Two of the four are PostgreJS's rather than the facade's, and are filed upstream in
`../postgrejs/.claude/query-edge-cases.md`: the empty statement, and `determine()` typing an array
from `value[0]` alone - so `['a', null]` can be sent and `[null, 'a']` cannot, which makes it depend
on element order.

### Re-measured against PostgreJS 3.8 (2026-09-21)

Both of those, and the three defects from §5, are fixed upstream. **Which release they are in decides
what `src/` keeps carrying**, and the answer is not "all of them": the working copy runs ahead of
npm.

| in published **3.8.0** | still unreleased |
| --- | --- |
| binary array lower bound | `query('')` answers instead of raising |
| a `Date` parameter goes out unspecified | an array is typed from its first non-null value |
| a string parameter goes out unspecified | `err.serverMessage` |
| server notices reach the connection | pooled-connection pipelining, opt-in |

So the empty-statement fallback and the caret-stripping fallback in `src/errors.ts` are not dead code
on 3.8.0 - they are what someone installing from npm today still needs. `git tag --contains <sha>`
before deleting a workaround.

> **Superseded.** Read the 3.10.0 section at the end before acting on that paragraph: the peer floor
> is 3.10.0 now, both fallbacks are gone, and the rule is the opposite one.

**`err.serverMessage` replaces a regex.** 3.8 keeps PostgreSQL's own undecorated text on the error,
which is exactly what `pg` puts in `message`, so `normalizeError` copies a field where it used to
take the decorated text apart. The regex stays as the 3.7 path. The field was added upstream for the
same reason it is wanted here: parsing the decorated message is what callers do, and the decoration
breaks anchored patterns.

**One new divergence, and it is the largest behavioural one found so far.** `pg`'s `Client` queues
concurrent `query()` calls and runs them one at a time; a PostgreJS `Connection` pipelines. The
difference surfaces as a failure rather than a reordering:

```js
await Promise.all([
  client.query('create temp table t(i int)'),
  client.query('insert into t values (1)'),   // 42P01 on a raw connection
]);
```

Measured against `pg`: `1` there, `42P01` here. Result-to-query correlation and error isolation were
already identical; it is only statements that depend on what a previous one left behind.

**The facade now serialises per client**, which is what `pg` does. Pipelining is worth **10x** on one
connection - 500 queries in 12ms against 120ms awaited, and `pg` itself takes 142ms awaited - so this
is giving up something real. It is still right: `pg` has never offered that path - every `query()`
goes on a per-client queue and the next starts only when the previous has settled - so no consumer
written against `pg` can be relying on it. (What pg@9.0 deprecates is the public view of that queue,
`Client.activeQuery` and `Client.queryQueue`, not the queueing.) Anyone who wants PostgreJS's concurrency has `client.connection`, which is the
real `Connection` and is not queued. Streams are deliberately left out of the queue - a cursor is
read lazily, and holding the queue for its lifetime would deadlock everything behind it.

## Re-measured against PostgreJS 3.10.0 (2026-09-22)

The sections above are a record of how this was arrived at, and two of their instructions no longer
hold. **The peer floor is `>=3.10.0 <4`**, and `src/` carries nothing for an older one - no
fallback, no feature test, no `git tag --contains` before deleting a workaround. The reason is not
that old versions stopped mattering but that PostgreJS is maintained in the next directory and
released before this package ships, so an unreleased fix is a scheduling detail rather than a
constraint. A branch written for a version that will not exist by release is dead code someone has
to find later.

**Every divergence this package found was closed in the client, not worked around here.** That is
the whole shape of the last few rounds, and it is what the floor buys:

| what `src/` needs | upstream |
| --- | --- |
| `fetchAsString` naming an array column by its element type | `313c71e` |
| `fetchAsString`'s `{ oid, arrays: false }` - `numeric` as text without `numeric[]` | `423977d` |
| the value classes serialising as their fields rather than the literal | `ac5ba39` |
| `toPostgres()` on them, so a value read can be written back | `3d84fb5` |
| `Circle` naming its radius `radius` | `8d30acc` |
| a lost connection reported on `'error'`, not only `'close'` | `93b07c3` |
| a text date read in the server's own `DateStyle` | `4c1154b` |

**So the fixup table is gone, and with it every runtime dependency.** §6's answer was "64/64, with a
`fetchAsString` list, a post-decode fixup table and `postgres-interval`". It is now **64/64 with the
list alone**: `toPgResult` reshapes the result object and hands the values through exactly as
PostgreJS decoded them. `value-shapes.ts` does not exist; `postgres-interval` and `postgres-array`
are not dependencies; `package.json` has no `dependencies` key at all.

Three types still come back as a PostgreJS class where `pg` gives a plain object - `interval`,
`point`, `circle`. That is **not** a divergence in the value: same own keys, same values, same
`JSON.stringify`. It is a superset, and `test/B-live/types.spec.ts` asserts it as one, because the
class answers `toPostgres()` and `pg`'s object does not - a `point` read here goes back to the
server as a parameter, and `pg`'s own fails `22P02` doing the same. Converting it would have been
the facade choosing the worse object to match a name.

**Two things `decimalAsString` (`605e91e`) does not replace**, measured, because it looks like it
should. For `money` it gives the exact decimal without a currency symbol, where `pg` gives the
server's own `$12.34` - so `fetchAsString` stays. For `numeric` it reaches `numeric[]` as well,
turning `[1.5, 2.5]` into `['1.5', '2.5']` where `pg` runs `parseFloat` per element - so the
`{ arrays: false }` selector stays too.

The caret-stripping regex in `errors.ts` is gone and deliberately not replaced. An error carrying a
caret diagram but no `serverMessage` did not come from this client, and guessing at its shape is
what that field was added to stop.
