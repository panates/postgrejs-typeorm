/**
 * What the in-process timing run and the per-client heap workers both
 * measure - one definition, so the two cannot drift apart. A workload
 * defined twice drifts the first time one of the copies is edited.
 *
 * Two levels, kept separate throughout: raw statements on a checked-out
 * connection, where the difference is the client and nothing else, and the
 * same work through TypeORM repositories, which is what a reader actually
 * runs. Entity hydration sits on top and dilutes any gain, so both answers
 * are worth having and neither substitutes for the other.
 *
 * ## What a scenario has to be
 *
 * Three rules, each of which was learnt by a row breaking it.
 *
 * 1. **The client has to dominate it.** A shape where PostgreSQL does the
 *    work measures PostgreSQL, and its ratio is set by how much scanning or
 *    writing the author asked for. A `count` over a scan was removed for
 *    this: swept across scan sizes its speedup read 1.04x, 0.95x, 1.00x and
 *    0.94x.
 * 2. **It has to be the path the consumer takes.** These ran through
 *    `pool.query()`, which TypeORM never calls - a `QueryRunner` checks a
 *    connection out once and keeps it - and each checkout was 7.6 KB a call
 *    that no TypeORM user pays.
 * 3. **It has to carry enough payload that the fixed cost is not the
 *    answer.** `concurrent reads` fetched one row per read, and measured,
 *    the same scenario reads +57%, +2% and -30% at one, twenty and a
 *    hundred rows each. None of those is a fact about concurrency; the row
 *    was reporting the cost of checking a connection out, twenty times.
 *
 * The three are the same rule from different sides: **a scenario has to put
 * the thing being compared in the majority of what it measures.** A row
 * that does not is not neutral - it answers a question nobody asked, under
 * a name that promises otherwise.
 */
import 'reflect-metadata';
import { Pool as PgPool } from 'pg';
import { DataSource, EntitySchema } from 'typeorm';
import * as facade from '../build/index.js';

export const CONTROL = 'pg';
export const DRIVER = 'typeorm-postgrejs';

export const SCHEMA = 'bench_typeorm';
export const SEED_ROWS = 5000;

/** Built once, so a write scenario times the send and not the making. */
export const BLOB_4MB = Buffer.alloc(4 * 1024 * 1024, 0x78);
export const ARRAY_100K = Array.from(
  { length: 100000 },
  (_, i) => 2147383646 + i,
);

export const CONN = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
  database: process.env.PGDATABASE ?? 'postgres',
};

/**
 * The `prepare` setting every figure here is taken under.
 *
 * Stated rather than left implicit because it is worth 1.2x on a repeated
 * parameterized query: a memory column taken under `prepare: false` and a
 * latency column taken under the default would be two different packages
 * in one table. This is the default, which is what the documentation
 * quotes.
 */
export const PREPARE = 'default (cached per connection)';

/**
 * The one PostgreJS default this harness turns off, and the only setting
 * here that is not both clients' own.
 *
 * PostgreJS captures a caller-preserving async stack on every call so a
 * failure points at the line that made it. `pg` offers nothing equivalent
 * and pays nothing for it, so leaving it on charges one client for a
 * feature the other does not have and the comparison does not cover -
 * PostgreJS's own documentation names turning it off as what makes a
 * benchmark against such a client fair, and `../postgrejs`'s own harness
 * has had it off since its adapter was written.
 *
 * Two things keep this honest rather than convenient.
 *
 * It is worth nothing to these numbers. Measured on the floor statement
 * with the setting definitely reaching the connection, three runs each:
 * 12.69 / 12.90 / 13.20 KB a call against 12.85 / 13.31 / 12.75 - 0.05 KB
 * apart on an estimator whose own spread is about 1 KB. The sampling
 * profiler next door resolves it at 0.49 KB; this one cannot see it. It is
 * turned off because it is not like-for-like, not because it moves a row.
 *
 * And it was unreachable until recently: `toPoolConfiguration()` is an
 * allowlist and the option was not on it, so nothing in here could have
 * turned it off even had it tried. `postgrejs.connection` is what carries
 * it now.
 */
export const ASYNC_ERROR_HANDLING = false;

/** What the facade is built with here, over and above `CONN`. */
const DRIVER_OPTS = {
  postgrejs: { connection: { asyncErrorHandling: ASYNC_ERROR_HANDLING } },
};

/**
 * Every scenario reads what is already stored rather than asking the
 * server to build its values on each call, and every one binds at least
 * one parameter.
 *
 * The parameter is usually a `limit` that selects the whole result, and it
 * is there to make the comparison an even one rather than to filter
 * anything: `pg` sends a statement with no values over PostgreSQL's
 * *simple* protocol - `requiresPreparation()` in `pg/lib/query.js` is
 * false without a name, a row limit or values - and takes the extended one
 * as soon as a parameter appears, which is what PostgreJS always speaks.
 * Without it the two are not running the same protocol.
 *
 * Reading stored values rather than generating them is the same argument
 * one layer down: a shared cost large enough to matter compresses the
 * ratio towards 1, and `generate_series` and `repeat()` are exactly that.
 */
export const DDL = [
  `create schema if not exists ${SCHEMA}`,

  // the ordinary shapes: point read, page, insert - many rows, few values
  `drop table if exists ${SCHEMA}.rows cascade`,
  `create table ${SCHEMA}.rows (
     id serial primary key,
     name text not null,
     email text not null,
     age integer,
     balance numeric(14,2),
     created timestamptz not null default now(),
     tags text[],
     meta jsonb,
     active boolean not null default true
   )`,
  `insert into ${SCHEMA}.rows (name, email, age, balance, tags, meta)
     select 'name ' || i, 'user' || i || '@example.com', (i % 80) + 18,
            (i % 100000)::numeric / 100, array['a','b','c'],
            jsonb_build_object('i', i, 'nested', jsonb_build_object('k','v'))
     from generate_series(1, ${SEED_ROWS}) as i`,

  // The two-shape pair: the same 5000 float8s, once as 5000 rows of one
  // value and once as one row holding one array of 5000. Same bytes,
  // different shape - which is the whole question, because what the binary
  // wire format is worth scales with values per row rather than with
  // values. Every other shape in this file is the first kind.
  `drop table if exists ${SCHEMA}.floats`,
  `create table ${SCHEMA}.floats as
     select (random() * 1e9)::float8 as v from generate_series(1, 5000) i`,
  `drop table if exists ${SCHEMA}.float_array`,
  `create table ${SCHEMA}.float_array as
     select array_agg(v) as v from ${SCHEMA}.floats`,

  // Two scalar types that disagree about what binary is worth, 5000 rows
  // each. `uuid` is sixteen bytes against thirty-six characters, so binary
  // is shorter; `box` is four float8s against however many digits the
  // coordinates need. Which way that falls decides the row, and quoting only
  // one of them would be choosing the answer.
  //
  // `box` measures something different here than in a dialect that lets
  // PostgreJS decode it: this facade asks for the geometric family as text
  // (`pg` returns strings for it), so both sides parse text and what is
  // compared is the row machinery rather than a decoder.
  `drop table if exists ${SCHEMA}.uuids`,
  `create table ${SCHEMA}.uuids as
     select gen_random_uuid() as v from generate_series(1, 5000) i`,
  `drop table if exists ${SCHEMA}.boxes`,
  `create table ${SCHEMA}.boxes as
     select box(point(random() * 1e6, random() * 1e6),
                point(random() * 1e6, random() * 1e6)) as v
     from generate_series(1, 5000) i`,

  // A 100k int4[] in one row. `pg` reads it as text and has to materialise
  // the whole array literal as one string before it can parse it.
  `drop table if exists ${SCHEMA}.arrays`,
  `create table ${SCHEMA}.arrays as
     select array(select 2147383646 + i from generate_series(1, 100000) i) as v`,

  // One bytea, large. `pg` returns bytea as hex text - twice the size, and
  // off the JS heap, where a `heapUsed` figure alone cannot see it.
  `drop table if exists ${SCHEMA}.blobs`,
  `create table ${SCHEMA}.blobs (large bytea)`,
  `insert into ${SCHEMA}.blobs (large) values (repeat('x', 4194304)::bytea)`,

  // `external` on every payload column, then a rewrite to apply it:
  // `repeat('x', n)` and a sequential int4[] both compress to nearly
  // nothing, and what would be measured then is TOAST decompression rather
  // than the transfer.
  `alter table ${SCHEMA}.float_array alter column v set storage external`,
  `update ${SCHEMA}.float_array set v = v`,
  `alter table ${SCHEMA}.arrays alter column v set storage external`,
  `update ${SCHEMA}.arrays set v = v`,
  `alter table ${SCHEMA}.blobs alter column large set storage external`,
  `update ${SCHEMA}.blobs set large = large`,

  // The same two payloads again, as columns of one table, so the ORM level
  // can reach them through an entity. The raw scenarios read them from
  // tables of their own; this is the same bytes one layer up, which is
  // where a reader actually meets them.
  `drop table if exists ${SCHEMA}.payloads`,
  `create table ${SCHEMA}.payloads (
     id serial primary key,
     blob bytea,
     numbers integer[]
   )`,
  `insert into ${SCHEMA}.payloads (blob, numbers)
     values (repeat('x', 4194304)::bytea,
             array(select 2147383646 + i from generate_series(1, 100000) i))`,
  `alter table ${SCHEMA}.payloads alter column blob set storage external`,
  `alter table ${SCHEMA}.payloads alter column numbers set storage external`,
  `update ${SCHEMA}.payloads set blob = blob`,

  // what the write scenarios fill. Unlogged: this measures the client, and
  // a WAL write is the same cost on both sides while being large enough to
  // hide what is not.
  `drop table if exists ${SCHEMA}.writes`,
  `create unlogged table ${SCHEMA}.writes (
     id serial primary key,
     name text,
     email text,
     age integer,
     balance numeric(20,6),
     tags text[],
     created_at timestamptz,
     active boolean,
     meta jsonb,
     ref uuid,
     blob bytea,
     numbers integer[]
   )`,
];

/**
 * The entity the ORM level reads - one definition, both clients.
 *
 * Writes go to `BenchWrite` below rather than here, and that is not
 * tidiness: `save one entity` used to write into this table, which
 * `find 5000 entities` then read without a bound. The memory pass runs one
 * client at a time in its own process, so the second one always read a
 * table the first had grown - a systematic bias, and large enough to
 * reverse the row. Caught by a number flipping sign between runs.
 */
export const Row = new EntitySchema({
  name: 'BenchRow',
  tableName: 'rows',
  schema: SCHEMA,
  columns: {
    id: { type: 'int', primary: true, generated: 'increment' },
    name: { type: 'text' },
    email: { type: 'text' },
    age: { type: 'int', nullable: true },
    balance: { type: 'numeric', precision: 14, scale: 2, nullable: true },
    created: { type: 'timestamptz' },
    tags: { type: 'text', array: true, nullable: true },
    meta: { type: 'jsonb', nullable: true },
    active: { type: 'boolean' },
  },
});

/** The payload columns, read through the ORM rather than through `query()`. */
export const Payload = new EntitySchema({
  name: 'BenchPayload',
  tableName: 'payloads',
  schema: SCHEMA,
  columns: {
    id: { type: 'int', primary: true, generated: 'increment' },
    blob: { type: 'bytea', nullable: true },
    numbers: { type: 'int', array: true, nullable: true },
  },
});

/** Where every ORM write goes, so no read scenario can see it grow. */
export const Write = new EntitySchema({
  name: 'BenchWrite',
  tableName: 'writes',
  schema: SCHEMA,
  columns: {
    id: { type: 'int', primary: true, generated: 'increment' },
    name: { type: 'text', nullable: true },
    email: { type: 'text', nullable: true },
    age: { type: 'int', nullable: true },
    balance: { type: 'numeric', precision: 20, scale: 6, nullable: true },
    tags: { type: 'text', array: true, nullable: true },
    created_at: { type: 'timestamptz', nullable: true },
    active: { type: 'boolean', nullable: true },
    meta: { type: 'jsonb', nullable: true },
    ref: { type: 'uuid', nullable: true },
    blob: { type: 'bytea', nullable: true },
  },
});

/**
 * One client per driver, at the same pool size, built the way a consumer
 * would get them. The ORM level gets a `DataSource` over the same entity.
 */
/**
 * @param only when given, build **only** that client.
 *
 * The memory workers pass it, and must: a child that constructs both has
 * them both alive in the one process, which is the thing a child per client
 * exists to prevent. It cost a measurement - `box of 5k rows` read 1.89
 * MB/call for `pg` with nothing else in the process and 2.37 with the other
 * client's connection merely open beside it, and the second figure is the
 * one the report carried. The latency pass needs both, because it alternates
 * between them in one process by design.
 */
export function openDatabases(pooled = false, level = 'raw', only) {
  const max = pooled ? 10 : 1;
  const wanted = name => !only || name === only;
  if (level === 'raw') {
    const pools = {};
    if (wanted(CONTROL)) pools[CONTROL] = new PgPool({ ...CONN, max });
    if (wanted(DRIVER))
      pools[DRIVER] = new facade.Pool({ ...CONN, ...DRIVER_OPTS, max });

    /**
     * A **checked-out connection**, not the pool, unless the scenario is
     * about the pool.
     *
     * This is what TypeORM does: a `QueryRunner` calls `pool.connect()` once
     * and runs every statement of its life on that one connection -
     * `pool.query()` is never called anywhere in its PostgreSQL driver. The
     * raw scenarios used the pool anyway, and it cost this package 7.6 KB a
     * call that no TypeORM user pays: measured, the same `point read` is
     * 25.0 KB/call through `pool.query()` and 17.4 on a checked-out client,
     * because each checkout builds a `PgClient` wrapper, a release closure
     * and two emits. Against `pg`'s 16.0 that is the difference between
     * reading +56% and +9%.
     *
     * `pooled: true` keeps the pool, and there it is the faithful shape
     * rather than a shortcut: twenty concurrent reads in TypeORM are twenty
     * QueryRunners, which is twenty checkouts.
     */
    if (pooled)
      return {
        dbs: pools,
        async close() {
          for (const db of Object.values(pools)) await db.end();
        },
      };

    const dbs = {};
    return {
      dbs,
      async ready() {
        for (const [name, pool] of Object.entries(pools))
          dbs[name] = await pool.connect();
      },
      async close() {
        for (const db of Object.values(dbs)) db.release();
        for (const pool of Object.values(pools)) await pool.end();
      },
    };
  }
  const make = driver =>
    new DataSource({
      type: 'postgres',
      ...CONN,
      username: CONN.user,
      driver,
      entities: [Row, Write, Payload],
      // `extra` is what TypeORM merges into the object it hands `new
      // Pool(...)`, so it is the same channel a consumer would use. Only
      // the facade gets it - `pg` has no such setting to turn off.
      extra: { max, ...(driver ? DRIVER_OPTS : {}) },
      synchronize: false,
      logging: false,
    });
  const dbs = {};
  if (wanted(CONTROL)) dbs[CONTROL] = make(undefined);
  if (wanted(DRIVER)) dbs[DRIVER] = make(facade);
  return {
    dbs,
    async ready() {
      for (const db of Object.values(dbs)) await db.initialize();
    },
    async close() {
      for (const db of Object.values(dbs)) await db.destroy();
    },
  };
}

const q = (db, sql, params) => db.query(sql, params);

/**
 * **What a row is, in one place, because three scenarios need the same
 * answer and a benchmark cannot have three of them.**
 *
 * Mixed on purpose. A write row of nothing but short text measures a
 * client's call overhead and calls it an insert: both clients render text
 * the same way, so the only thing left in the figure is what each pays per
 * statement. The types below are the ones an application actually stores
 * and the ones the two clients treat differently - a `numeric` that `pg`
 * sends and reads as a string, an array, a `jsonb`, a `uuid`, a `boolean`,
 * and a `Date`.
 *
 * The `Date` is deliberate twice over. It is what a row carries, and until
 * it was here **no scenario in this file bound one** - so an upstream
 * change that binds a reused `Date` as binary against the type the server
 * resolved (`11cfb77`) moved nothing here and could not be seen at all.
 */
export const WRITE_COLUMNS =
  'name, email, age, balance, tags, created_at, active, meta, ref';

const WRITE_EPOCH = Date.UTC(2026, 0, 1);

export const writeRow = i => [
  `Customer account ${i} - northern region, renewed`,
  `accounts.payable.${i}@long-company-domain-name.example.com`,
  (i % 60) + 18,
  `${1000 + (i % 500)}.459900`,
  ['priority', 'renewed', 'northern', `cohort-${i % 12}`],
  new Date(WRITE_EPOCH + i * 86400000),
  i % 2 === 0,
  { region: 'north', tier: i % 5, flags: ['renewed', 'priority'] },
  `6ba7b810-9dad-11d1-80b4-${String(100000000000 + (i % 899999999999)).slice(0, 12)}`,
];

/**
 * Each one is a single call, the way a caller would write it.
 *
 * `note` states the shape - `5000 rows of 1 value` against `1 row holding
 * 1 array of 5000` - because workloads with different row counts cannot be
 * compared across rows without it.
 */
export const SCENARIOS = [
  // ---- raw pool.query(), where the difference is the client -----------
  {
    name: 'point read',
    group: 'Read',
    level: 'raw',
    note: '1 row of 9 columns',
    iters: 50,
    pairs: 401,
    run: (db, i) =>
      q(db, `select * from ${SCHEMA}.rows where id = $1`, [
        (i % SEED_ROWS) + 1,
      ]),
  },
  {
    name: 'page of 100',
    group: 'Read',
    level: 'raw',
    note: '100 rows of 9 columns, mixed types',
    iters: 20,
    pairs: 201,
    run: (db, i) =>
      q(db, `select * from ${SCHEMA}.rows order by id offset $1 limit 100`, [
        (i % 40) * 100,
      ]),
  },
  {
    name: 'all 5000 rows',
    group: 'Read',
    level: 'raw',
    note: '5000 rows of 9 columns',
    iters: 3,
    pairs: 61,
    run: (db, i) =>
      q(db, `select * from ${SCHEMA}.rows limit $1`, [SEED_ROWS - (i % 2)]),
  },
  // The pair. Same 5000 float8s, same bytes, different shape - this is
  // what turns "the wire format is not claimed" from an absence into a
  // finding, because the two disagree by more than either differs from pg.
  {
    name: 'float8 spread over rows',
    group: 'Read',
    level: 'raw',
    note: '5000 rows of 1 value',
    iters: 5,
    pairs: 61,
    run: (db, i) =>
      q(db, `select v from ${SCHEMA}.floats limit $1`, [5000 - (i % 2)]),
  },
  {
    name: 'float8 packed in one row',
    group: 'Read',
    level: 'raw',
    note: '1 row holding 1 array of 5000 values',
    iters: 5,
    pairs: 61,
    run: (db, i) =>
      q(db, `select v from ${SCHEMA}.float_array limit $1`, [1 + (i % 1)]),
  },
  {
    name: 'int4[] of 100k',
    group: 'Read',
    level: 'raw',
    note: '1 row holding 1 array of 100 000 values',
    iters: 3,
    pairs: 41,
    run: (db, i) =>
      q(db, `select v from ${SCHEMA}.arrays limit $1`, [1 + (i % 1)]),
  },
  {
    name: 'bytea of 4 MB',
    group: 'Read',
    level: 'raw',
    note: '1 row holding 4 MB',
    iters: 3,
    pairs: 41,
    run: (db, i) =>
      q(db, `select large from ${SCHEMA}.blobs limit $1`, [1 + (i % 1)]),
  },
  {
    name: 'uuid of 5k rows',
    group: 'Read',
    level: 'raw',
    note: '5000 rows of 1 value, sixteen bytes against thirty-six characters',
    iters: 5,
    pairs: 61,
    run: (db, i) =>
      q(db, `select v from ${SCHEMA}.uuids limit $1`, [5000 - (i % 2)]),
  },
  {
    /* The socket counter reads 423 KB in on **both** sides, the identical
     * bytes: this facade asks for the whole geometric family as text,
     * because `pg` returns strings for it and matching `pg` means giving up
     * the decoder. So nothing this row shows can be credited to the wire,
     * which is what makes it worth having - it is the one shape here where
     * the two are handed byte for byte the same thing. On it the facade is
     * 1.09x on the clock and allocates 4% more.
     *
     * It read -16% for one round, and chasing that down found a defect in
     * the harness rather than anything about either client: the memory
     * worker built *both* clients in the child, so each measurement had the
     * other's connection open beside it. Measured, that is worth 1.89 MB
     * against 2.37 for `pg` on this row - a fifth of the figure - and it
     * flattered the facade on every mid-sized row. The worker builds only
     * the client it measures now. A dialect that lets PostgreJS decode
     * `box` measures 1.87x on the same shape. */
    name: 'box of 5k rows',
    group: 'Read',
    level: 'raw',
    note: '5000 rows of 1 value, asked for as text on both sides',
    iters: 5,
    pairs: 61,
    run: (db, i) =>
      q(db, `select v from ${SCHEMA}.boxes limit $1`, [5000 - (i % 2)]),
  },
  {
    /**
     * The shape a web application under load has: several requests at once,
     * each fetching a page. In TypeORM that is one `QueryRunner` per
     * request, so twenty of them are twenty checkouts - which is why this is
     * the one scenario that keeps the pool rather than a held connection.
     *
     * **Each read returns a page, and that is the whole design of the row.**
     * It fetched a single row until it was measured, and at that size the
     * answer is not about either client's decoding: per call, 290 KB against
     * 456 at one row each, 906 against 920 at twenty, and 4134 against 2906
     * at a hundred. The ratio runs from +57% to -30% without concurrency
     * changing at all, because at one row the fixed cost of checking a
     * connection out is most of what is being counted and at a hundred the
     * decoding is. A single row per request is not what a request does, and
     * the number it produced was a measurement of pool bookkeeping wearing
     * the word "concurrent".
     *
     * What it says now, against `page of 100` at -33%: twenty of them at
     * once land in the same place. Concurrency does not change the answer
     * here - it multiplies it.
     */
    name: 'concurrent reads',
    group: 'Read',
    level: 'raw',
    note: '20 reads at once of 100 rows each, pool of 10',
    iters: 2,
    pairs: 61,
    pooled: true,
    run: (db, i) =>
      Promise.all(
        Array.from({ length: 20 }, (_, k) =>
          q(
            db,
            `select * from ${SCHEMA}.rows order by id offset $1 limit 100`,
            [((i * 20 + k) % 40) * 100],
          ),
        ),
      ),
  },
  {
    /**
     * **The floor, and that is its job.** One row, one parameter, nothing
     * returned: the smallest statement anyone would send, so the per-call
     * cost is most of what it counts. Every other row here is partly about
     * payload; this one is about what a statement costs before the payload.
     *
     * Which is why its percentage must not be read as a fact about writing.
     * Swept on PostgreJS 3.12.2, per call, `pg` against this facade:
     *
     * ```
     *                                 pg     here     gap
     *   1 parameter                  8.2     13.8     5.6     +68%
     *   1 parameter, returning id   10.3     14.1     3.8     +37%
     *   5 parameters                 9.0     15.4     6.5     +72%
     *   5 parameters, returning *   17.0     18.4     1.4      +8%
     *   10 rows of 5                23.2     31.3     8.1     +35%
     * ```
     *
     * The gap moves between about 4 and 8 KB; the percentage moves by a
     * factor of nine. Nothing about either client changes across those
     * five - the denominator does, and this scenario picked nearly the
     * smallest denominator available.
     *
     * (A no-parameter variant reads +150%, and is left out of that table
     * on purpose: with no parameter `pg` sends a simple Query while
     * PostgreJS still runs Parse/Bind/Describe/Execute/Sync, so the two are
     * not on the same protocol and the figure means nothing.)
     *
     * **And the gap is mostly not this facade's.** The same statement with
     * one parameter, one client per process, medians of three: `pg` 8.4 KB
     * a call, PostgreJS with nothing on it 12.9, this facade 14.2. So about
     * 4.5 KB is the client underneath and 1.4 KB is what the facade adds.
     * Reported upstream as
     * `../postgrejs/.claude/a-fixed-cost-per-statement.md` rather than
     * hidden behind a larger denominator, and `flexy-buffer@1.1.2` in
     * PostgreJS 3.12.2 is the first part of it coming back - two
     * `setTimeout`s a query out of the send buffer.
     *
     * It keeps no RETURNING, unlike `save one entity`, which TypeORM sends
     * as `INSERT ... RETURNING "id"`. That is deliberate here: adding one
     * would move this row from +68% to +37% by giving the decoder something
     * to do, and a floor that has been softened is not a floor. The ORM
     * level is where the consumer's actual insert is measured.
     */
    name: 'insert one row',
    group: 'Write',
    level: 'raw',
    note: '1 row, 1 parameter, nothing returned',
    iters: 50,
    pairs: 401,
    run: (db, i) =>
      q(db, `insert into ${SCHEMA}.writes (name) values ($1)`, [`n${i}`]),
  },
  {
    /* Nothing else here binds more than two parameters, and rendering them is
     * a thing this facade does itself: every value goes through `pg`'s own
     * `prepareValue` before it is bound. 2500 of them is where that shows. */
    name: 'insert 500 rows',
    group: 'Write',
    level: 'raw',
    note: '500 rows of 9 mixed columns in 1 statement, 4500 parameters',
    iters: 5,
    pairs: 61,
    run: (db, i) => {
      const values = [];
      const params = [];
      for (let k = 0; k < 500; k++) {
        const n = k * 9;
        values.push(
          `(${Array.from({ length: 9 }, (_, c) => `$${n + c + 1}`).join(',')})`,
        );
        params.push(...writeRow(i * 500 + k));
      }
      return q(
        db,
        `insert into ${SCHEMA}.writes (${WRITE_COLUMNS})
           values ${values.join(',')}`,
        params,
      );
    },
  },
  {
    /**
     * **The send-side counterpart of the `int4[]` read**, and it came level
     * for two years' worth of this file's history. The note is kept because
     * what changed is instructive.
     *
     * Both clients still put *text* on the wire - the socket counter reads
     * about 1.1-1.3 MB out on either side, and neither sends the binary
     * array format. PostgreSQL's binary array carries a mandatory 4-byte
     * length per element whatever the element is, so for `int4` it is 8
     * bytes an element against `digits + 1` as text; text is the cheaper
     * encoding below 7-8 digits and this array is below it.
     *
     * What changed is **who builds that text**. Every parameter used to go
     * through `pg`'s own `prepareValue` first, which concatenates the
     * literal; now an array is handed to PostgreJS, which writes the digits
     * straight into its own buffer. Same bytes, same declared type (none),
     * a fraction of the garbage - 27.2 MB a call becomes under 1 MB.
     *
     * So this row no longer measures the cost of a policy. It measures the
     * difference between two ways of producing the same bytes.
     */
    name: 'write a 100k int4[]',
    group: 'Write',
    level: 'raw',
    note: '1 parameter holding 100 000 values, text on both sides, built by each client',
    iters: 3,
    pairs: 41,
    run: (db, i) =>
      q(db, `insert into ${SCHEMA}.writes (name, numbers) values ($1, $2)`, [
        `a${i}`,
        ARRAY_100K,
      ]),
  },
  {
    /* Twenty round trips under one BEGIN. Nothing else here measures what a
     * transaction costs, and it is most of what an ORM does. */
    name: 'twenty inserts in a transaction',
    group: 'Write',
    level: 'raw',
    note: '20 rows of 9 mixed columns, one statement each, returning the key, in one transaction',
    iters: 3,
    pairs: 61,
    /**
     * On the connection the scenario already holds, which is where a
     * TypeORM transaction runs: `QueryRunner.startTransaction()` sends BEGIN
     * on the connection it checked out, not a fresh one.
     *
     * **Each insert writes a row and reads the key back**, because both
     * halves of that are what TypeORM sends. Captured off the wire, saving
     * an entity is `INSERT INTO ... VALUES ($1, DEFAULT) RETURNING "id"` -
     * so a scenario that writes one short column and returns nothing is
     * neither the shape of a row nor the statement the consumer issues.
     *
     * It is not a detail. The same insert, allocation per call, `pg`
     * against this facade:
     *
     * ```
     *   1 token column, no returning     8.58  ->  13.43   +57%
     *   5 token columns                  9.52  ->  14.92   +57%
     *   5 columns of real content       10.63  ->  15.42   +45%
     *   the same, returning the row     19.22  ->  19.42    +1%
     * ```
     *
     * Payload helps a little; returning anything at all is what moves it,
     * because until the statement gives the decoder work the comparison
     * excludes the only thing this package is faster at. A write row with
     * no result is a measurement of call overhead wearing the word
     * "insert".
     */
    run: async (db, i) => {
      await db.query('begin');
      for (let k = 0; k < 20; k++)
        await db.query(
          `insert into ${SCHEMA}.writes (${WRITE_COLUMNS})
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          writeRow(i * 20 + k),
        );
      await db.query('commit');
    },
  },
  /**
   * **There is no 4 MB *write* here, and it was removed rather than never
   * written.** Two measurements took it out, one per column.
   *
   * Its clock: running the same insert with the payload generated
   * server-side, so the send costs nothing, reads 13.25 ms against the
   * 19.47 the full call takes - two thirds of the row is PostgreSQL writing
   * 4 MB. The remaining third is both clients pushing bytes through a socket
   * at the same speed, isolated as `select length($1::bytea)` at 1.03x.
   *
   * Its allocation: it read 5.5 MB against 3.6 while memory was one
   * measurement per client, and that was the reason to keep the row. Paired
   * seven ways it is 2.91 MB against 3.24, won 1 of 7, with the two spreads
   * overlapping - level, and slightly the wrong way. The figure that
   * justified the row was a single-sample artefact, which is what pairing
   * the memory pass was for.
   *
   * So neither column says anything about either client, and `bytea of 4 MB`
   * on the read side - 2.25x and 92% less allocated - keeps the type covered
   * where the client is the one doing the work.
   */

  /**
   * There is no control row here, and removing the one there was is the
   * point rather than an omission.
   *
   * It was a `count` over a scan heavy enough that the server dominated, so
   * that neither client could win it and a run where it moved could be
   * thrown away. Two things killed it. Swept across scan sizes its speedup
   * read 1.04x, 0.95x, 1.00x and 0.94x - wandering around 1.0, twice
   * "significant" in opposite directions - so it did not do the job either.
   * And a scenario the server dominates measures PostgreSQL, which is not
   * what any of this is about: every row here has to be mostly the client's
   * own CPU or allocation, or its number misleads whoever reads it.
   *
   * The sign test is the guard instead, and it is the per-row version of the
   * same check: a run too noisy to trust says so on every row at once.
   */

  // ---- the same work through TypeORM ---------------------------------
  {
    name: 'findOneBy',
    group: 'Read',
    level: 'orm',
    note: '1 entity of 9 columns',
    iters: 50,
    pairs: 201,
    run: (ds, i) =>
      ds.getRepository('BenchRow').findOneBy({ id: (i % SEED_ROWS) + 1 }),
  },
  {
    name: 'find 100 entities',
    group: 'Read',
    level: 'orm',
    note: '100 entities of 9 columns',
    iters: 20,
    pairs: 201,
    run: (ds, i) =>
      ds
        .getRepository('BenchRow')
        .find({ take: 100, skip: (i % 40) * 100, order: { id: 'ASC' } }),
  },
  {
    name: 'find 5000 entities',
    group: 'Read',
    level: 'orm',
    note: '5000 entities of 9 columns',
    iters: 3,
    pairs: 61,
    // Bounded on purpose. Unbounded it read whatever the table had grown
    // to, which made it a different workload for whichever client ran
    // second.
    run: ds => ds.getRepository('BenchRow').find({ take: SEED_ROWS }),
  },
  {
    name: 'queryBuilder, 500 entities',
    group: 'Read',
    level: 'orm',
    note: '500 entities after a where and an order by',
    iters: 10,
    pairs: 101,
    run: (ds, i) =>
      ds
        .getRepository('BenchRow')
        .createQueryBuilder('r')
        .where('r.age > :a', { a: 20 + (i % 2) })
        .orderBy('r.id')
        .take(500)
        .getMany(),
  },
  {
    name: 'findOne with a 4 MB bytea',
    group: 'Read',
    level: 'orm',
    note: '1 entity holding 4 MB',
    iters: 3,
    pairs: 41,
    run: (ds, i) =>
      ds.getRepository('BenchPayload').findOne({
        where: { id: 1 + (i % 1) },
        select: { id: true, blob: true },
      }),
  },
  {
    name: 'findOne with a 100k int4[]',
    group: 'Read',
    level: 'orm',
    note: '1 entity holding 1 array of 100 000 values',
    iters: 3,
    pairs: 41,
    run: (ds, i) =>
      ds.getRepository('BenchPayload').findOne({
        where: { id: 1 + (i % 1) },
        select: { id: true, numbers: true },
      }),
  },
  {
    /**
     * **An entity with something in it.** It assigned one short column
     * until 2026-10-06, which made it a measurement of what a `save` costs
     * before it has anything to save - see `twenty inserts in a
     * transaction` for the sweep that settled this, where the same insert
     * runs +57% at one token column and +1% at five real ones returning
     * the row.
     *
     * TypeORM already returns the key here whatever the columns are, so
     * this row only needed the other half: a row carrying what a row
     * carries.
     */
    name: 'save one entity',
    group: 'Write',
    level: 'orm',
    note: '1 entity of 9 assigned columns, mixed types',
    iters: 50,
    pairs: 201,
    run: (ds, i) => {
      const [name, email, age, balance, tags, created_at, active, meta, ref] =
        writeRow(i);
      return ds.getRepository('BenchWrite').save({
        name,
        email,
        age,
        balance,
        tags,
        created_at,
        active,
        meta,
        ref,
      });
    },
  },
];

export const scenariosMatching = (which, level) =>
  SCENARIOS.filter(
    s =>
      (which === 'all' || s.group.toLowerCase() === which) &&
      (!level || s.level === level),
  );

/** Creates the schema and the data every scenario reads. */
export async function seed() {
  const pool = new PgPool(CONN);
  for (const statement of DDL) await pool.query(statement);
  await pool.end();
}
