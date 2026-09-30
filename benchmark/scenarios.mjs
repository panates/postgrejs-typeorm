/**
 * What the in-process timing run and the per-client heap workers both
 * measure - one definition, so the two cannot drift apart. A workload
 * defined twice drifts the first time one of the copies is edited.
 *
 * Two levels, kept separate throughout: raw `pool.query()`, where the
 * difference is the client and nothing else, and the same work through
 * TypeORM repositories, which is what a reader actually runs. Entity
 * hydration sits on top and dilutes any gain, so both answers are worth
 * having and neither substitutes for the other.
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

  // what the write scenarios fill. Unlogged: this measures the client, and
  // a WAL write is the same cost on both sides while being large enough to
  // hide what is not.
  `drop table if exists ${SCHEMA}.writes`,
  `create unlogged table ${SCHEMA}.writes (
     id serial primary key, name text, blob bytea
   )`,
];

/** The entity the ORM level runs over - one definition, both drivers. */
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

/**
 * One client per driver, at the same pool size, built the way a consumer
 * would get them. The ORM level gets a `DataSource` over the same entity.
 */
export function openDatabases(pooled = false, level = 'raw') {
  const max = pooled ? 10 : 1;
  if (level === 'raw') {
    const dbs = {
      [CONTROL]: new PgPool({ ...CONN, max }),
      [DRIVER]: new facade.Pool({ ...CONN, max }),
    };
    return {
      dbs,
      async close() {
        for (const db of Object.values(dbs)) await db.end();
      },
    };
  }
  const make = driver =>
    new DataSource({
      type: 'postgres',
      ...CONN,
      username: CONN.user,
      driver,
      entities: [Row],
      extra: { max },
      synchronize: false,
      logging: false,
    });
  const dbs = { [CONTROL]: make(undefined), [DRIVER]: make(facade) };
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
    name: 'insert one row',
    group: 'Write',
    level: 'raw',
    note: '1 row of 2 columns',
    iters: 50,
    pairs: 401,
    run: (db, i) =>
      q(db, `insert into ${SCHEMA}.writes (name) values ($1)`, [`n${i}`]),
  },
  {
    name: 'write a 4 MB bytea',
    group: 'Write',
    level: 'raw',
    note: '1 parameter of 4 MB - the one place both send binary',
    iters: 3,
    pairs: 41,
    run: (db, i) =>
      q(db, `insert into ${SCHEMA}.writes (name, blob) values ($1, $2)`, [
        `b${i}`,
        BLOB_4MB,
      ]),
  },
  {
    name: 'count over a filter',
    group: 'Read',
    level: 'raw',
    note: '1 row back after a scan of 5000',
    iters: 20,
    pairs: 101,
    run: (db, i) =>
      q(db, `select count(*) from ${SCHEMA}.rows where age > $1`, [
        20 + (i % 2),
      ]),
  },
  /**
   * The negative control, and the reason to believe any of the rest.
   *
   * One row back after a scan heavy enough that the server dominates, so
   * neither client can win it. If this moves, the instrument is measuring
   * itself and the run is noise.
   *
   * **Read it on magnitude, not on the sign test.** That is a correction
   * to how this row was used before, and it came out of trying to make it
   * hold. There is no shape where neither client wins: measured over the
   * same scan at 50 000, 500 000 and 1.5 million rows, the win rate stays
   * around 60% at every size and the sign test calls all three significant
   * - the driver is a hair faster on everything, and enough pairs will
   * always find a small fixed advantage. What does collapse is the
   * *size*: across four runs of this shape, -1.5%, -6.4%, -0.3% and -4.6%,
   * against -45% on a bulk read. So the check is the order of magnitude
   * between this row and the read rows, not a threshold on this row alone
   * - its own median is only worth a few percent at 9 ms. A run where the
   * server is doing 9 ms of work and this row still moves like a bulk read
   * is a run where the machine, not the client, was measured.
   *
   * `count over a filter` above was the control until postgrejs 3.12.1,
   * when it started coming out 2-7% ahead - at 0.8 ms the client's own
   * per-message work is a measurable fraction of the call, and 3.12.1 cut
   * it. It stayed on as the ordinary workload row it turned out to be.
   */
  {
    name: 'count, server-dominated',
    group: 'Control',
    level: 'raw',
    note: '1 row back after a scan of 500 000 - its magnitude has to stay small',
    iters: 3,
    pairs: 101,
    run: (db, i) =>
      q(
        db,
        `select count(*) from ${SCHEMA}.rows a, generate_series(1,100)
           where a.age > $1`,
        [20 + (i % 2)],
      ),
  },

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
    run: ds => ds.getRepository('BenchRow').find(),
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
    name: 'save one entity',
    group: 'Write',
    level: 'orm',
    note: '1 entity of 8 assigned columns',
    iters: 50,
    pairs: 201,
    run: (ds, i) =>
      ds.getRepository('BenchRow').save({
        name: `n${i}`,
        email: `e${i}@example.com`,
        age: 30,
        balance: '1.23',
        created: new Date(),
        tags: ['a'],
        meta: { i },
        active: true,
      }),
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
