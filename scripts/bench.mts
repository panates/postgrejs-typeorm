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
import { Connection, DataFormat } from 'postgrejs';
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

/**
 * The odds of winning `wins` of `n` alternated iterations if the two were
 * equally fast - a two-sided sign test, computed exactly.
 *
 * The medians alone are worth less than they look on a shared machine: the
 * same `pg` baseline drifts between runs. What does not drift is *which* of
 * the two won each iteration, so that is counted separately. This says the
 * difference is real; it says nothing about its size, which is what the
 * median column is for.
 */
const signTest = (wins: number, n: number): string => {
  const k = Math.min(wins, n - wins);
  // Sum the tail with logs, so a binomial coefficient at n=400 does not
  // overflow a double.
  const logFactorial: number[] = [0];
  for (let i = 1; i <= n; i++)
    logFactorial[i] = logFactorial[i - 1] + Math.log(i);
  let tail = 0;
  for (let i = 0; i <= k; i++)
    tail += Math.exp(
      logFactorial[n] - logFactorial[i] - logFactorial[n - i] - n * Math.LN2,
    );
  const p = Math.min(1, 2 * tail);
  if (p > 0.05) return 'not significant';
  if (p < 1e-18) return '< 1 in 10^18';
  return `< 1 in 10^${Math.floor(-Math.log10(p))}`;
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
    'delta'.padStart(8),
    'won'.padStart(9),
    '  by luck',
  );
  for (const [name, w] of Object.entries(work)) {
    const n = reps[name];
    const times: Record<string, number[]> = { pg: [], facade: [] };
    let wins = 0;
    for (let i = 0; i < n; i++) {
      const one: Record<string, number> = {};
      for (const [label, target] of targets) {
        const t = process.hrtime.bigint();
        await w(target);
        one[label] = Number(process.hrtime.bigint() - t) / 1e6;
        times[label].push(one[label]);
      }
      if (one.facade < one.pg) wins++;
    }
    const a = median(times.pg);
    const b = median(times.facade);
    console.log(
      name.padEnd(24),
      a.toFixed(3).padStart(9),
      b.toFixed(3).padStart(9),
      `${((b / a - 1) * 100).toFixed(1).padStart(7)}%`,
      `${wins}/${n}`.padStart(9),
      '  ' + signTest(wins, n),
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
    'count + filter': (p: any) =>
      p.query(
        'select count(*) from bench_rows where qty > $1 and active',
        [5000],
      ),
    // The control shape: one row back after a scan heavy enough that the
    // server dominates, so neither driver can win it. If this one moves,
    // nothing else here means anything.
    //
    // It used to be `count + filter` above, and that stopped holding. On
    // postgrejs 3.12.1 the light count comes out 2-7% ahead across runs,
    // reaching significance in two of three, because at 0.8 ms the client's
    // own per-message work is a measurable fraction of the call and 3.12.1
    // cut it. Measured at the same iteration count, this shape and a
    // `pg_sleep(0.005)` both come out level - +0.3% and +2.3%, neither
    // significant - where the light count does not. So the premise moved to
    // a shape that still holds it, and the light count stayed on as the
    // ordinary workload row it turned out to be.
    'count, server-dominated': (p: any) =>
      p.query(
        'select count(*) from bench_rows a, generate_series(1,10) where a.qty > $1',
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
      // Odd counts, and high enough that the sign test can speak: a shape
      // run 15 times cannot reach significance however lopsided it is.
      'select 10k wide rows': 61,
      'select 100 rows': 201,
      'point lookup by id': 401,
      'count + filter': 101,
      'count, server-dominated': 101,
      'insert one row': 401,
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
      [`find ${ROWS} entities`]: 61,
      'find 100 entities': 201,
      findOneBy: 201,
      'save one entity': 201,
      'queryBuilder + where': 101,
    },
    sources,
  );
  for (const [, ds] of sources) await ds.destroy();
}

/**
 * Where the difference comes from, one mechanism at a time.
 *
 * The two sections above say how much; these say why, by turning a single
 * thing off and leaving everything else alone. Same alternation, same sign
 * test - a mechanism that cannot win its own A/B does not belong in the
 * explanation.
 */
async function mechanisms(): Promise<void> {
  console.log('\n== where it comes from\n');

  // 1. The wire format, isolated at the client rather than through the
  //    facade: same connection, same SQL, only the format code differs.
  const binary = new Connection(env);
  const text = new Connection(env);
  await binary.connect();
  await text.connect();
  const read = (c: Connection, fmt?: DataFormat) => () =>
    c.query('select * from bench_rows limit 2000', {
      objectRows: true,
      columnFormat: fmt,
    });
  await compare(
    { 'binary vs text, 2k rows': (f: () => Promise<unknown>) => f() },
    { 'binary vs text, 2k rows': 61 },
    [
      ['pg', read(text, DataFormat.text)],
      ['facade', read(binary, DataFormat.binary)],
    ],
  );
  await binary.close();
  await text.close();

  // 2. The per-connection statement cache, through the facade, which is
  //    where `prepare: false` is a supported option.
  const cached = new facade.Pool({ ...env, max: 4 });
  const uncached = new facade.Pool({
    ...env,
    max: 4,
    postgrejs: { prepare: false },
  } as any);
  await compare(
    {
      'prepared vs not': (p: any) =>
        p.query('select * from bench_rows where id = $1', [1234]),
    },
    { 'prepared vs not': 401 },
    [
      ['pg', uncached],
      ['facade', cached],
    ],
  );
  await cached.end();
  await uncached.end();
}

await seedTable();
await rawQueries();
await throughTypeORM();
await mechanisms();
