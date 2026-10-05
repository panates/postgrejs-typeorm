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
    blob: { type: 'bytea', nullable: true },
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
      entities: [Row, Write, Payload],
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
    /* Comes out level, and that is the result rather than a dull row: the
     * socket counter reads 423 KB in on both sides, the identical bytes,
     * because this facade asks for the whole geometric family as text -
     * `pg` returns strings for it, so matching `pg` means giving up the
     * decoder. The row prices that entry in the `fetchAsString` list. A
     * dialect that lets PostgreJS decode `box` measures 1.87x on the same
     * shape. */
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
    /* The shape a web application under load actually has, and the only one
     * here where the pool is doing anything. This facade serialises
     * statements *per client* to match `pg` - see `src/client.ts` - so what
     * is compared is the pool handing out ten connections, not either
     * client's pipelining. */
    name: 'concurrent reads',
    group: 'Read',
    level: 'raw',
    note: '20 reads at once of 1 row each, pool of 10',
    iters: 4,
    pairs: 61,
    pooled: true,
    run: (db, i) =>
      Promise.all(
        Array.from({ length: 20 }, (_, k) =>
          q(db, `select * from ${SCHEMA}.rows where id = $1`, [
            ((i * 20 + k) % SEED_ROWS) + 1,
          ]),
        ),
      ),
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
    /* Nothing else here binds more than two parameters, and rendering them is
     * a thing this facade does itself: every value goes through `pg`'s own
     * `prepareValue` before it is bound. 2500 of them is where that shows. */
    name: 'insert 500 rows',
    group: 'Write',
    level: 'raw',
    note: '500 rows in 1 statement, 2500 parameters',
    iters: 5,
    pairs: 61,
    run: (db, i) => {
      const values = [];
      const params = [];
      for (let k = 0; k < 500; k++) {
        const n = k * 5;
        values.push(`($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5})`);
        params.push(
          `name-${i}-${k}`.padEnd(40, 'x'),
          `e${k}@example.com`,
          (k % 60) + 18,
          '12.345678',
          ['a', 'b'],
        );
      }
      return q(
        db,
        `insert into ${SCHEMA}.writes (name, email, age, balance, tags)
           values ${values.join(',')}`,
        params,
      );
    },
  },
  {
    /* Comes out level, and for the same kind of reason as `box` above: the
     * socket counter reads 1270 KB out on *both* sides, byte for byte. Every
     * parameter here goes through `pg`'s own `prepareValue` and then out
     * under OID 0 - the policy that makes a parameter behave exactly as
     * `pg`'s does, documented in CLAUDE.md and `src/params.ts` - so a JS
     * array becomes the same array literal `pg` would have sent. This row is
     * what that costs: a dialect that lets PostgreJS encode the array
     * measures 1.38x and 94% less allocated on the same shape. It is the
     * send-side counterpart of the `int4[]` read, which is 4x the other way
     * because *reading* is where this facade keeps the binary form. */
    name: 'write a 100k int4[]',
    group: 'Write',
    level: 'raw',
    note: '1 parameter holding 100 000 values, text on both sides',
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
    note: '20 rows, one statement each, inside one transaction',
    iters: 3,
    pairs: 61,
    run: async (db, i) => {
      const client = await db.connect();
      try {
        await client.query('begin');
        for (let k = 0; k < 20; k++)
          await client.query(
            `insert into ${SCHEMA}.writes (name) values ($1)`,
            [`t${i}-${k}`],
          );
        await client.query('commit');
      } finally {
        client.release();
      }
    },
  },
  {
    name: 'write a 4 MB bytea',
    group: 'Write',
    level: 'raw',
    /* **Read the allocation column, not the clock.** Both clients push 4 MB
     * through a socket and the server stores it; measured, the send path on
     * its own (`select length($1::bytea)`, where the server barely works) is
     * 1.03x and the insert 1.06x, so the clock here is the wire rather than
     * either client. What is a real client difference is what it costs to
     * get those bytes out: 3.3 MB allocated against 5.2. The row is kept for
     * that column. */
    note: '1 parameter of 4 MB - the clock is the socket, the allocation is not',
    iters: 3,
    pairs: 41,
    run: (db, i) =>
      q(db, `insert into ${SCHEMA}.writes (name, blob) values ($1, $2)`, [
        `b${i}`,
        BLOB_4MB,
      ]),
  },
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
    name: 'save one entity',
    group: 'Write',
    level: 'orm',
    note: '1 entity of 1 assigned column',
    iters: 50,
    pairs: 201,
    run: (ds, i) => ds.getRepository('BenchWrite').save({ name: `n${i}` }),
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
