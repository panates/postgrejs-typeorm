import assert from 'node:assert';
import type pg from 'pg';
import type { PgClient, PgPool } from '../../src/index.js';
import { facadePool, pgPool } from '../_support/live.js';

/**
 * Whole-statement behaviour that a single `select` never exercises: how many
 * results come back, what `rowCount` is when the command tag carries no
 * count, and the two protocols `pg` silently switches between.
 *
 * All of it found by probing `pg` rather than by reading TypeORM, and none of
 * it caught by the 806-test suite run - TypeORM issues its DDL one statement
 * at a time and reads `rowCount` only for writes.
 */
const CASES: [string, string][] = [
  ['multi-statement select', 'select 1 as x; select 2 as y'],
  [
    'multi-statement DDL and write',
    'create temp table mz(i int); insert into mz values (1),(2)',
  ],
  ['empty statement', ''],
  ['whitespace-only statement', '   '],
  ['create', 'create temp table rc2(i int)'],
  ['truncate', 'create temp table rc3(i int); truncate rc3'],
  ['set', 'set search_path to public'],
  ['begin', 'begin'],
  ['commit', 'commit'],
  ['select with rows', 'select 1 as x'],
  ['select with no rows', 'select 1 where false'],
  ['insert', 'create temp table rc4(i int); insert into rc4 values (1),(2)'],
];

const shape = (r: any): string =>
  Array.isArray(r)
    ? `array[${r.map(x => `${x.command}/${x.rowCount}`).join(' ')}]`
    : `{command:${r.command},rowCount:${r.rowCount},rows:${JSON.stringify(r.rows)}}`;

describe('B-live: statement kinds, protocols and result counts', () => {
  let control: pg.Pool;
  let facade: PgPool;

  before(() => {
    control = pgPool();
    facade = facadePool();
  });
  after(async () => {
    await control.end();
    await facade.end();
  });

  const run = async (
    pool: { connect(): Promise<any> },
    sql: string,
  ): Promise<string> => {
    // One connection per case: several of these make temp tables, and a
    // multi-statement string cannot be split across connections.
    const client = await pool.connect();
    try {
      return shape(await client.query(sql));
    } catch (e: any) {
      return `ERR:${e.code ?? e.message}`;
    } finally {
      client.release();
    }
  };

  for (const [label, sql] of CASES) {
    it(label, async () => {
      assert.strictEqual(await run(facade, sql), await run(control, sql), sql);
    });
  }

  it('gives arrays of values for rowMode: array', async () => {
    const q = { text: 'select 1 as a, 2 as b', rowMode: 'array' };
    const expected = (await control.query(q as any)).rows;
    const client = (await facade.connect()) as PgClient;
    try {
      assert.deepStrictEqual((await client.query(q)).rows, expected);
      assert.deepStrictEqual(expected, [[1, 2]], 'sanity: pg really does this');
    } finally {
      client.release!();
    }
  });

  it('does not run a multi-statement string twice when it falls back', async () => {
    // The fallback is triggered by SQLSTATE 42601 from the extended protocol
    // and retries over the simple one. That is only safe because 42601 is
    // raised at Parse, before any command runs - if it were raised later,
    // the retry would double every write in the string. This is the test
    // that says so.
    const client = (await facade.connect()) as PgClient;
    try {
      await client.query('create temp table dbl(i int)');
      await client.query(
        'insert into dbl values (1); insert into dbl values (2)',
      );
      const r = await client.query('select count(*)::int as n from dbl');
      assert.strictEqual(r.rows[0].n, 2, 'a doubled retry would give 4');
    } finally {
      client.release!();
    }
  });
});
