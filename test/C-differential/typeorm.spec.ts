import 'reflect-metadata';
import assert from 'node:assert';
import { DataSource, EntitySchema } from 'typeorm';
import * as facade from '../../src/index.js';
import { liveConfig, normalize } from '../_support/live.js';

/**
 * The same TypeORM program run through `pg` and through this facade, deep
 * compared.
 *
 * This is the instrument that catches what nobody thought to assert. Three
 * things were found this way rather than by reading TypeORM's source: that
 * `rows`/`rowCount` are read through `hasOwnProperty`, that a `Date` was not
 * round-tripping through `timestamptz`, and that TypeORM's own catalog query
 * has no `ORDER BY` - so `getTable().columns` comes back in a plan-dependent
 * order that differs between two runs of the *same* driver, and has to be
 * sorted before comparing.
 */
const Thing = new EntitySchema<any>({
  name: 'Thing',
  tableName: 'diff_thing',
  columns: {
    id: { type: 'int', primary: true, generated: 'increment' },
    name: { type: 'varchar', length: 60 },
    price: { type: 'numeric', precision: 14, scale: 4, nullable: true },
    big: { type: 'bigint', nullable: true },
    meta: { type: 'jsonb', nullable: true },
    tags: { type: 'text', array: true, nullable: true },
    at: { type: 'timestamptz', nullable: true },
    onDay: { type: 'date', nullable: true },
    span: { type: 'interval', nullable: true },
    active: { type: 'boolean', default: true },
  },
});

const Child = new EntitySchema<any>({
  name: 'Child',
  tableName: 'diff_child',
  columns: {
    id: { type: 'int', primary: true, generated: 'increment' },
    label: { type: 'varchar', length: 60 },
  },
  relations: {
    thing: {
      type: 'many-to-one',
      target: 'Thing',
      joinColumn: true,
      onDelete: 'CASCADE',
    },
  },
});

type Case = (ds: DataSource) => Promise<any>;

const CASES: Record<string, Case> = {
  async 'insert and find'(ds) {
    const r = ds.getRepository('Thing');
    const saved = await r.save({
      name: 'a',
      price: '19.9900',
      big: '9007199254740993',
      meta: { k: [1, 2, { z: null }] },
      tags: ['p', 'q', ''],
      at: new Date('2024-03-05T06:07:08.900Z'),
      onDay: '2024-03-05',
      span: '1 day 2 hours',
    });
    const found: any = await r.findOneBy({ id: saved.id });
    return { saved, found, atISO: found.at?.toISOString() };
  },

  async 'numeric keeps its precision'(ds) {
    await ds.query('insert into diff_thing (name, price) values ($1,$2)', [
      'np',
      '12345678.9012',
    ]);
    return ds.query('select price from diff_thing where name = $1', ['np']);
  },

  async 'query builder with parameters'(ds) {
    const r = ds.getRepository('Thing');
    await r.save([
      { name: 'qb1', price: '1.0000' },
      { name: 'qb2', price: '2.0000' },
    ]);
    return r
      .createQueryBuilder('t')
      .where('t.name like :p', { p: 'qb%' })
      .andWhere('t.price > :min', { min: 0.5 })
      .orderBy('t.name', 'ASC')
      .getMany();
  },

  async 'in clause'(ds) {
    const r = ds.getRepository('Thing');
    await r.save([{ name: 'i1' }, { name: 'i2' }, { name: 'i3' }]);
    return r
      .createQueryBuilder('t')
      .where('t.name in (:...ns)', { ns: ['i1', 'i3'] })
      .orderBy('t.name')
      .getMany();
  },

  async 'affected counts'(ds) {
    const r = ds.getRepository('Thing');
    await r.save([{ name: 'u1' }, { name: 'u2' }]);
    return {
      updated: (await r.update({ name: 'u1' }, { name: 'u1x' })).affected,
      deleted: (await r.delete({ name: 'u2' })).affected,
      deletedNone: (await r.delete({ name: 'nobody' })).affected,
    };
  },

  async returning(ds) {
    const res = await ds
      .createQueryBuilder()
      .insert()
      .into('Thing')
      .values([{ name: 'r1', price: '3.5000' }])
      .returning(['id', 'name', 'price'])
      .execute();
    return {
      raw: res.raw,
      identifiers: res.identifiers,
      generatedMaps: res.generatedMaps,
    };
  },

  async relations(ds) {
    const t = await ds.getRepository('Thing').save({ name: 'parent' });
    await ds.getRepository('Child').save([
      { label: 'c1', thing: t },
      { label: 'c2', thing: t },
    ]);
    return ds
      .getRepository('Child')
      .find({ relations: { thing: true }, order: { label: 'ASC' } });
  },

  async aggregates(ds) {
    const r = ds.getRepository('Thing');
    await r.save([
      { name: 'g1', price: '1.0000' },
      { name: 'g2', price: '2.0000' },
    ]);
    const raw = await r
      .createQueryBuilder('t')
      .select('count(*)', 'cnt')
      .addSelect('sum(t.price)', 'total')
      .addSelect('avg(t.price)', 'mean')
      .where(`t.name like 'g%'`)
      .getRawOne();
    const count = await r.count();
    return { raw, count, countType: typeof count };
  },

  async 'raw query shapes'(ds) {
    return {
      select: await ds.query('select 1 as a, $1::text as b', ['z']),
      noRows: await ds.query('select 1 where false'),
      insert: await ds.query(
        `insert into diff_thing (name) values ('raw') returning id`,
      ),
      update: await ds.query(
        `update diff_thing set name='raw2' where name='raw'`,
      ),
    };
  },

  async 'structured results'(ds) {
    const qr = ds.createQueryRunner();
    await qr.connect();
    const out: Record<string, any> = {};
    const statements: [string, string][] = [
      ['select', 'select 1 as a'],
      ['insert', `insert into diff_thing (name) values ('sr')`],
      ['update', `update diff_thing set name='sr2' where name='sr'`],
      ['delete', `delete from diff_thing where name='sr2'`],
    ];
    for (const [k, sql] of statements) {
      const r = await qr.query(sql, undefined, true);
      out[k] = { records: r.records, affected: r.affected, raw: r.raw };
    }
    await qr.release();
    return out;
  },

  async 'transaction commits'(ds) {
    await ds.transaction(async m => {
      await m.save(Thing, { name: 'tx-ok' });
    });
    return ds.getRepository('Thing').countBy({ name: 'tx-ok' });
  },

  async 'transaction rolls back'(ds) {
    await ds
      .transaction(async m => {
        await m.save(Thing, { name: 'tx-bad' });
        throw new Error('x');
      })
      .catch(() => undefined);
    return ds.getRepository('Thing').countBy({ name: 'tx-bad' });
  },

  async 'a nested transaction is a savepoint'(ds) {
    await ds.transaction(async m => {
      await m.save(Thing, { name: 'outer' });
      await m
        .transaction(async m2 => {
          await m2.save(Thing, { name: 'inner' });
          throw new Error('x');
        })
        .catch(() => undefined);
    });
    const r = ds.getRepository('Thing');
    return {
      outer: await r.countBy({ name: 'outer' }),
      inner: await r.countBy({ name: 'inner' }),
    };
  },

  async 'isolation level'(ds) {
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction('SERIALIZABLE');
    const lvl = await qr.query('show transaction_isolation');
    await qr.commitTransaction();
    await qr.release();
    return lvl;
  },

  async 'a failed statement aborts the transaction'(ds) {
    // PostgreSQL's own semantics, which PostgreJS's rollbackOnError would
    // otherwise hide by wrapping every statement in its own savepoint.
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    let first: string | undefined;
    let second: string;
    try {
      await qr.query('select * from no_such_table_here');
    } catch (e: any) {
      first = e.driverError.code;
    }
    try {
      await qr.query('select 1');
      second = 'continued';
    } catch (e: any) {
      second = e.driverError.code;
    }
    await qr.rollbackTransaction().catch(() => undefined);
    await qr.release();
    return { first, second };
  },

  async 'unique violation'(ds) {
    await ds.query(
      `create unique index if not exists diff_uq on diff_thing (name) where name = 'uq'`,
    );
    await ds.query(`insert into diff_thing (name) values ('uq')`);
    try {
      await ds.query(`insert into diff_thing (name) values ('uq')`);
      return 'no error';
    } catch (e: any) {
      const d = e.driverError;
      return {
        name: e.name,
        code: d.code,
        constraint: d.constraint,
        severity: d.severity,
        table: d.table,
        detail: d.detail,
      };
    }
  },

  async 'error fields'(ds) {
    try {
      await ds.query('select * from nope_nope');
    } catch (e: any) {
      const d = e.driverError;
      return {
        name: e.name,
        message: e.message,
        code: d.code,
        severity: d.severity,
        position: d.position,
        positionType: typeof d.position,
        schema: d.schema,
        table: d.table,
      };
    }
    return 'no error';
  },

  async streaming(ds) {
    const r = ds.getRepository('Thing');
    await r.save([{ name: 's1' }, { name: 's2' }, { name: 's3' }]);
    const qr = ds.createQueryRunner();
    await qr.connect();
    const stream = await qr.stream(
      `select name from diff_thing where name like 's%' order by name`,
    );
    const rows: any[] = [];
    await new Promise<void>((ok, fail) => {
      stream.on('data', (row: any) => rows.push(row));
      stream.on('end', () => ok());
      stream.on('error', fail);
    });
    await qr.release();
    return rows;
  },

  async 'catalog introspection'(ds) {
    const qr = ds.createQueryRunner();
    await qr.connect();
    const t = await qr.getTable('diff_thing');
    await qr.release();
    // TypeORM's own columnsSql has no ORDER BY, so the row order is
    // plan-dependent for both drivers - sort before comparing.
    return t!.columns
      .map(c => ({
        name: c.name,
        type: c.type,
        isNullable: c.isNullable,
        precision: c.precision,
        scale: c.scale,
        isArray: c.isArray,
        default: c.default,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  async 'concurrent pool use'(ds) {
    const out = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        ds.query('select $1::int as n', [i]),
      ),
    );
    return out.map(r => r[0].n);
  },
};

async function runAll(driver: any): Promise<Record<string, any>> {
  const cfg = liveConfig();
  const ds = new DataSource({
    type: 'postgres',
    host: cfg.host,
    port: cfg.port,
    username: cfg.user,
    password: cfg.password,
    database: cfg.database,
    driver,
    entities: [Thing, Child],
    synchronize: true,
    dropSchema: true,
    logging: false,
  });
  await ds.initialize();
  const results: Record<string, any> = {};
  for (const [name, fn] of Object.entries(CASES)) {
    await ds
      .query('truncate diff_child, diff_thing restart identity cascade')
      .catch(() => undefined);
    try {
      results[name] = { ok: true, value: await fn(ds) };
    } catch (e: any) {
      results[name] = { ok: false, error: `${e.name}: ${e.message}` };
    }
  }
  await ds.destroy();
  return results;
}

describe('C-differential: the same TypeORM program through pg and through us', function () {
  this.timeout(180000);
  let control: Record<string, any>;
  let actual: Record<string, any>;

  before(async () => {
    // Sequential, not parallel: both run dropSchema against the same database.

    control = await runAll((await import('pg')).default);
    actual = await runAll(facade);
  });

  for (const name of Object.keys(CASES)) {
    it(name, () => {
      assert.deepStrictEqual(normalize(actual[name]), normalize(control[name]));
    });
  }
});
