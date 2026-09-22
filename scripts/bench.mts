/**
 * This facade against `pg`, on the same server, in the same process.
 *
 * Every number the README quotes comes from here, and the method is the
 * repository's rule rather than a choice: the two drivers **alternate inside
 * one run** and the result is a median, because anything else measures the
 * machine's mood. A benchmark that runs all of A and then all of B will
 * report whatever the page cache, the JIT and the server's plan cache were
 * doing at the time.
 *
 * Both halves are measured:
 *
 *   * raw `pool.query()`, where the difference is decoding and nothing else;
 *   * the same work through TypeORM's repositories, which is what a reader
 *     actually runs - entity hydration sits on top and dilutes any gain.
 *
 * The shapes are chosen so the result can be *disbelieved*: `count + filter`
 * returns a single row after a scan the server dominates, so it has to come
 * out level. If it does not, the run is noise and the rest of the table is
 * not worth reading.
 *
 * Usage: npx tsx scripts/bench.mts
 *   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE   (defaults: local postgres)
 */
import 'reflect-metadata';
import { Pool as PgPool } from 'pg';
import { DataSource, EntitySchema } from 'typeorm';
import * as facade from '../src/index.js';

const env = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
  database: process.env.PGDATABASE ?? 'postgres',
};
const ormEnv = { ...env, username: env.user };

const ROWS = 5000;

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

/** One row per shape, with both drivers alternating call by call. */
async function compare<T>(
  work: Record<string, (target: T) => Promise<unknown>>,
  reps: Record<string, number>,
  targets: [string, T][],
): Promise<void> {
  // Warm first: PostgreJS caches a prepared statement per connection from the
  // second use of the same SQL, and V8 needs a few hundred calls before it
  // has settled. Measuring either warm-up would be measuring start-up.
  for (const [, target] of targets)
    for (let i = 0; i < 40; i++)
      for (const w of Object.values(work)) await w(target);

  console.log(
    'shape'.padEnd(24),
    'pg'.padStart(9),
    'facade'.padStart(9),
    'delta'.padStart(9),
  );
  for (const [name, w] of Object.entries(work)) {
    const times: Record<string, number[]> = { pg: [], facade: [] };
    for (let i = 0; i < reps[name]; i++)
      for (const [label, target] of targets) {
        const t = process.hrtime.bigint();
        await w(target);
        times[label].push(Number(process.hrtime.bigint() - t) / 1e6);
      }
    const a = median(times.pg);
    const b = median(times.facade);
    console.log(
      name.padEnd(24),
      a.toFixed(3).padStart(9),
      b.toFixed(3).padStart(9),
      `${((b / a - 1) * 100).toFixed(1).padStart(8)}%`,
    );
  }
}

async function seedTable(): Promise<void> {
  const c = new PgPool(env);
  await c.query('drop table if exists bench_rows');
  await c.query(`create table bench_rows (
    id serial primary key, name text, amount numeric(12,2), qty int4,
    ratio float8, active bool, tags text[], meta jsonb,
    created timestamptz, day date, big int8)`);
  await c.query(
    `insert into bench_rows (name, amount, qty, ratio, active, tags, meta, created, day, big)
     select 'row ' || g, (g % 10000)::numeric / 100, g, g / 7.0, g % 2 = 0,
            array['a','b'], jsonb_build_object('g', g),
            now() - (g || ' minutes')::interval, current_date - (g % 365),
            g::int8 * 1000
     from generate_series(1, $1) g`,
    [ROWS * 4],
  );
  await c.end();
}

async function rawQueries(): Promise<void> {
  const pools: [string, any][] = [
    ['pg', new PgPool({ ...env, max: 4 })],
    ['facade', new facade.Pool({ ...env, max: 4 })],
  ];
  const work = {
    'select 10k wide rows': (p: any) =>
      p.query('select * from bench_rows limit 10000'),
    'select 100 rows': (p: any) =>
      p.query('select * from bench_rows limit 100'),
    'point lookup by id': (p: any) =>
      p.query('select * from bench_rows where id = $1', [1234]),
    // The control shape: one row back after a scan, so the server dominates
    // and neither driver can win. If this one moves, nothing else here means
    // anything.
    'count + filter': (p: any) =>
      p.query(
        'select count(*) from bench_rows where qty > $1 and active',
        [5000],
      ),
    'insert one row': (p: any) =>
      p.query(
        `insert into bench_rows (name, amount, qty, ratio, active, tags, meta, created, day, big)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          'x',
          '1.23',
          1,
          1.5,
          true,
          ['a'],
          { a: 1 },
          new Date(),
          new Date(),
          '99',
        ],
      ),
  };
  console.log('\n== raw pool.query()\n');
  await compare(
    work,
    {
      'select 10k wide rows': 20,
      'select 100 rows': 200,
      'point lookup by id': 400,
      'count + filter': 60,
      'insert one row': 400,
    },
    pools,
  );
  for (const [, p] of pools) await p.end();
}

const Row = new EntitySchema<any>({
  name: 'Row',
  tableName: 'bench_entity',
  columns: {
    id: { type: 'int', primary: true, generated: 'increment' },
    name: { type: 'varchar', length: 60 },
    price: { type: 'numeric', precision: 12, scale: 2, nullable: true },
    qty: { type: 'int', nullable: true },
    ratio: { type: 'float8', nullable: true },
    active: { type: 'boolean', default: true },
    tags: { type: 'text', array: true, nullable: true },
    meta: { type: 'jsonb', nullable: true },
    at: { type: 'timestamptz', nullable: true },
    onDay: { type: 'date', nullable: true },
    big: { type: 'bigint', nullable: true },
  },
});

async function throughTypeORM(): Promise<void> {
  const make = (driver: any) =>
    new DataSource({
      type: 'postgres',
      ...ormEnv,
      driver,
      entities: [Row],
      synchronize: true,
      logging: false,
    } as any);
  const sources: [string, DataSource][] = [
    ['pg', make(undefined)],
    ['facade', make(facade)],
  ];
  for (const [, ds] of sources) await ds.initialize();

  const repo = sources[0][1].getRepository('Row');
  await repo.clear();
  const seed = Array.from({ length: ROWS }, (_, i) => ({
    name: `row ${i}`,
    price: String((i % 10000) / 100),
    qty: i,
    ratio: i / 7,
    active: i % 2 === 0,
    tags: ['a', 'b'],
    meta: { i },
    at: new Date(),
    onDay: '2024-03-05',
    big: String(i * 1000),
  }));
  for (let i = 0; i < seed.length; i += 500)
    await repo.insert(seed.slice(i, i + 500));

  const work = {
    [`find ${ROWS} entities`]: (ds: DataSource) =>
      ds.getRepository('Row').find(),
    'find 100 entities': (ds: DataSource) =>
      ds.getRepository('Row').find({ take: 100 }),
    findOneBy: (ds: DataSource) =>
      ds.getRepository('Row').findOneBy({ qty: 1234 }),
    'save one entity': (ds: DataSource) =>
      ds.getRepository('Row').save({
        name: 'x',
        price: '1.23',
        qty: 1,
        ratio: 1.5,
        active: true,
        tags: ['a'],
        meta: { a: 1 },
        at: new Date(),
        onDay: '2024-03-05',
        big: '99',
      }),
    'queryBuilder + where': (ds: DataSource) =>
      ds
        .getRepository('Row')
        .createQueryBuilder('r')
        .where('r.qty > :q', { q: 4000 })
        .orderBy('r.id')
        .take(500)
        .getMany(),
  };
  console.log('\n== through TypeORM\n');
  await compare(
    work,
    {
      [`find ${ROWS} entities`]: 15,
      'find 100 entities': 150,
      findOneBy: 200,
      'save one entity': 200,
      'queryBuilder + where': 80,
    },
    sources,
  );
  for (const [, ds] of sources) await ds.destroy();
}

await seedTable();
await rawQueries();
await throughTypeORM();
