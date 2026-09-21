import assert from 'node:assert';
import type pg from 'pg';
import type { PgPool } from '../../src/index.js';
import { facadePool, pgPool } from '../_support/live.js';

/**
 * Every parameter shape, sent through `pg` and through the facade, compared
 * on what the server ended up with. `pg` is the oracle - there is no table of
 * expected values to drift, and a change on either side is reported.
 */
const CASES: [string, string, any[]][] = [
  ['text', 'select $1::text::text v', ['hello']],
  ['text with quotes', 'select $1::text::text v', ['a"b\\c']],
  ['empty string', 'select $1::text::text v', ['']],
  ['int4', 'select $1::int4::text v', [42]],
  ['bool', 'select $1::bool::text v', [true]],
  ['bigint', 'select $1::int8::text v', [9007199254740993n]],
  ['numeric as string', 'select $1::numeric::text v', ['19.99']],
  [
    'numeric, full precision',
    'select $1::numeric::text v',
    ['123456789012345678901234567890.123456'],
  ],
  ['int8 from string', 'select $1::int8::text v', ['9007199254740993']],
  ['json object', 'select $1::json::text v', [{ a: 1 }]],
  ['jsonb string', 'select $1::jsonb::text v', ['{"a":1}']],
  [
    'jsonb containment',
    `select ('{"a":1}'::jsonb @> $1::jsonb)::text v`,
    ['{"a":1}'],
  ],
  [
    'timestamptz',
    'select $1::timestamptz::text v',
    [new Date('2024-03-05T06:07:08.900Z')],
  ],
  [
    'timestamp',
    'select $1::timestamp::text v',
    [new Date('2024-03-05T06:07:08.900Z')],
  ],
  ['date', 'select $1::date::text v', [new Date('2024-03-05T06:07:08.900Z')]],
  ['interval', 'select $1::interval::text v', ['1 day 2 hours']],
  ['int4 array', 'select $1::int4[]::text v', [[1, 2, 3]]],
  ['text array', 'select $1::text[]::text v', [['a', 'b']]],
  ['empty array', 'select $1::text[]::text v', [[]]],
  ['array with empty string', 'select $1::text[]::text v', [['', 'b']]],
  ['array with null', 'select $1::int4[]::text v', [[1, null, 3]]],
  [
    'nested array',
    'select $1::int4[][]::text v',
    [
      [
        [1, 2],
        [3, 4],
      ],
    ],
  ],
  ['bytea', `select encode($1::bytea, 'hex') v`, [Buffer.from([1, 2, 255])]],
  ['uuid', 'select $1::uuid::text v', ['00000000-0000-0000-0000-000000000001']],
  ['coalesce, untyped', 'select coalesce($1, 1)::text v', [7]],
  ['concatenation, untyped', `select ($1 || 'x')::text v`, ['a']],
  ['overloaded function', 'select length($1)::text v', ['abcd']],
  ['inet', 'select $1::inet::text v', ['192.168.0.1']],
  ['point', 'select $1::point::text v', ['(1,2)']],
  ['= any()', 'select ($1 = any(array[1,2,3]))::text v', [2]],
  ['null', 'select coalesce($1::text, x) v', [null]],
];

describe('B-live: parameters go on the wire the way pg puts them there', () => {
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
    p: { query: (t: string, v: any[]) => Promise<any> },
    sql: string,
    values: any[],
  ) => {
    try {
      const r = await p.query(sql, values);
      return `ok:${String(r.rows[0].v)}`;
    } catch (e: any) {
      return `err:${e.code ?? e.message}`;
    }
  };

  for (const [label, sql, values] of CASES) {
    it(label, async () => {
      const expected = await run(control as any, sql, values);
      const actual = await run(facade as any, sql, values);
      assert.strictEqual(actual, expected, `${label}: ${sql}`);
    });
  }

  it('sends an array PostgreSQL indexes from 1', async () => {
    // Not a pg comparison: an assertion about the value the server stored,
    // because an off-by-one lower bound is invisible to a round trip through
    // the same client.
    const r = await facade.query(
      'select ($1::int4[])[1] first, array_lower($1::int4[],1) lo',
      [[10, 20, 30]],
    );
    assert.strictEqual(r.rows[0].first, 10);
    assert.strictEqual(r.rows[0].lo, 1);
  });

  it('round-trips a Date through timestamptz without moving the instant', async () => {
    // This only means anything when the session's TimeZone differs from the
    // process's - with the two agreeing, the instant comes back unchanged
    // however the value was encoded, and the test would pass vacuously. So
    // the session is moved rather than the process, and a zone is picked that
    // cannot match whatever the runner happens to be set to.
    const offset = new Date().getTimezoneOffset();
    const sessionZone = offset === 0 ? 'Asia/Tokyo' : 'UTC';

    // One connection throughout: the table is temp and the zone is a session
    // setting.
    const client = (await facade.connect())!;
    try {
      await client.query(`set time zone '${sessionZone}'`);
      await client.query('create temp table rt(v timestamptz)');
      const d = new Date('2024-03-05T06:07:08.900Z');
      await client.query('insert into rt values($1)', [d]);
      const r = await client.query('select v from rt');
      assert.strictEqual(r.rows[0].v.getTime(), d.getTime());
    } finally {
      client.release!();
    }
  });

  it('agrees with pg on a Date in a session zone of its own', async () => {
    // The same thing against the oracle rather than against an invariant, and
    // over all three column kinds - which is where a single declared OID
    // cannot be right for both, and why the value goes out untyped.
    const offset = new Date().getTimezoneOffset();
    const sessionZone = offset === 0 ? 'Asia/Tokyo' : 'UTC';
    const d = new Date('2024-03-05T06:07:08.900Z');
    const sql =
      'select $1::timestamptz::text a, $2::timestamp::text b, $3::date::text c';

    const read = async (pool: { connect(): Promise<any> }) => {
      const client = await pool.connect();
      try {
        await client.query(`set time zone '${sessionZone}'`);
        return JSON.stringify((await client.query(sql, [d, d, d])).rows[0]);
      } finally {
        client.release();
      }
    };
    assert.strictEqual(await read(facade), await read(control));
  });
});
