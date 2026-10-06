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
  // `money` has a binary encoder upstream now, so the outbound direction is
  // worth pinning too and not only what comes back: a number and the
  // server's own rendering both have to land on the same value `pg` lands on.
  ['money from a number', 'select $1::money::text v', [12.34]],
  ['money as rendered', 'select $1::money::text v', ['$12.34']],
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

  /**
   * A parameter with no context at all. These are the shapes where
   * declaring a type and leaving it unspecified give different answers, so
   * they are the ones that say whether the policy in `src/params.ts` is
   * still doing anything. They came from the `postgrejs` session, which
   * offered `select $1` with `1.5` as a case its own change improved - and
   * the integer and boolean forms of it turned out to be live divergences
   * this file was not asking about.
   */
  ['bare parameter, integer', 'select $1 v', [12]],
  ['bare parameter, non-integer', 'select $1 v', [1.5]],
  ['bare parameter, boolean', 'select $1 v', [true]],
  ['bare parameter, string', 'select $1 v', ['abc']],
  ['bare parameter, null', 'select $1 v', [null]],
  ['arithmetic on an undeclared parameter', 'select $1 * 2 v', [1.5]],
  ['arithmetic on an undeclared integer', 'select $1 + 1 v', [12]],
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

  /**
   * **The type is half the answer, and this used to throw it away.**
   *
   * The comparison was `String(v)`, under which `12` and `'12'` are the
   * same string and so are `true` and `'true'`. A parameter policy that
   * declares a type instead of leaving it unspecified changes exactly that
   * and nothing else on these shapes - `select $1` with `12` gives `pg`'s
   * string and PostgreJS's number - so the one property this matrix exists
   * to hold was the one it could not see. It read 42/42 over three live
   * divergences.
   */
  const show = (v: any): string => {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'bigint') return `bigint:${v}`;
    if (Buffer.isBuffer(v)) return `buffer:${v.toString('hex')}`;
    if (Array.isArray(v)) return `array:[${v.map(show).join(',')}]`;
    if (v instanceof Date) return `date:${v.toISOString()}`;
    if (typeof v === 'object')
      return `${v.constructor?.name}:${JSON.stringify(v)}`;
    return `${typeof v}:${String(v)}`;
  };

  const run = async (
    p: { query: (t: string, v: any[]) => Promise<any> },
    sql: string,
    values: any[],
  ) => {
    try {
      const r = await p.query(sql, values);
      return `ok:${show(r.rows[0].v)}`;
    } catch (e: any) {
      return `err:${e.code ?? e.message}`;
    }
  };

  /**
   * **The shapes this package deliberately answers differently, and both
   * halves of each.**
   *
   * `pg` is the oracle everywhere else in this file and that is the point of
   * it. These are where it stopped being one: a number is PostgreJS's to
   * type (`src/params.ts`), so the database answers for the value the caller
   * passed rather than for the text `pg` would have sent instead.
   *
   * `pg` declares no type for any parameter, which is the only way it has of
   * letting the server resolve one from context. A parameter with no context
   * is where that technique runs out: it gets its own text back, and it
   * cannot multiply at all.
   *
   * Both sides are pinned rather than the case skipped - a change on either
   * one fails here, so this records a decision instead of excusing a
   * difference.
   */
  const INTENDED: Record<string, { pg: string; ours: string }> = {
    'bare parameter, integer': { pg: 'ok:string:12', ours: 'ok:number:12' },
    'arithmetic on an undeclared parameter': {
      pg: 'err:22P02',
      ours: 'ok:string:3.0',
    },
  };

  for (const [label, sql, values] of CASES) {
    it(label, async () => {
      const expected = await run(control as any, sql, values);
      const actual = await run(facade as any, sql, values);
      const intended = INTENDED[label];
      if (intended) {
        assert.strictEqual(expected, intended.pg, `${label}: pg moved`);
        assert.strictEqual(actual, intended.ours, `${label}: we moved`);
        return;
      }
      assert.strictEqual(actual, expected, `${label}: ${sql}`);
    });
  }

  it('diverges from pg on exactly the shapes it says it does', () => {
    // So a divergence cannot be added by editing one map: every key has to
    // be a case this file runs, and the count is stated.
    const labels = new Set(CASES.map(([l]) => l));
    for (const key of Object.keys(INTENDED))
      assert.ok(labels.has(key), `INTENDED names a case not run: ${key}`);
    assert.strictEqual(Object.keys(INTENDED).length, 2);
  });

  /**
   * **Why `inferParameterTypes` is off by default, as an executable fact
   * rather than a paragraph.**
   *
   * Letting PostgreJS type each parameter was tried on 2026-10-06, after
   * `341f343` closed the last value it got wrong where `pg` got it right.
   * The live matrix agreed with `pg` on everything but three shapes, the
   * differential suite was untouched - and TypeORM's own functional suite
   * went from 806/806 to **739/806**. The same checkout with this default
   * restored is 806/806, so the sixty-seven are the policy and nothing
   * else.
   *
   * The mechanism is below and it is not what the three shapes suggested.
   * A declared parameter does not only change what comes back for
   * `select $1`; it changes **the type of any result column derived from a
   * parameter**, because the server now knows what the expression is. `pg`
   * declares nothing, so such a column is `text` and arrives as a string.
   * TypeORM selects parameters constantly - subqueries, the distinct query
   * behind skip/take, insert-from-select - and hydrates what comes back.
   *
   * So the reach of the divergence is not "a bare parameter", which is what
   * the matrix above was measuring. Anything that is not asserted here is
   * not known, and that is the lesson this test exists to carry.
   */
  it('a declared parameter changes the type of a column derived from it', async () => {
    const pgFaithful = facadePool({
      postgrejs: { inferParameterTypes: false },
    });
    try {
      const sql = 'select $1 as x';
      const byPg = await control.query(sql, [7]);
      const byDefault = await facade.query(sql, [7]);
      const rendered = await pgFaithful.query(sql, [7]);

      // `pg` declares nothing and gets its own text back.
      assert.strictEqual(byPg.fields[0].dataTypeID, 25);
      assert.strictEqual(byPg.rows[0].x, '7');

      // The default declares `int4`, so the column derived from it is int4.
      // This is the whole of the divergence and it is deliberate: the
      // database answers for the value the caller passed.
      assert.strictEqual(byDefault.fields[0].dataTypeID, 23);
      assert.strictEqual(byDefault.rows[0].x, 7);

      // And the opt-out is still exactly `pg`.
      assert.strictEqual(rendered.fields[0].dataTypeID, 25);
      assert.strictEqual(rendered.rows[0].x, '7');
    } finally {
      await pgFaithful.end();
    }
  });

  /**
   * **The surface `src/params.ts` is built on, pinned against a live
   * server.**
   *
   * The policy renders exactly the values PostgreJS would declare a type
   * for and hands over the rest. That list is a fact about PostgreJS, not
   * a preference, so it is asserted rather than described: each value goes
   * through `select $1 as x` and the result column's OID says whether the
   * parameter was declared.
   *
   * **The hazardous direction is PostgreJS beginning to declare something
   * it currently leaves untyped.** A value would then be handed over, come
   * back a different type than `pg` gives, and nothing else here would
   * notice - the matrix above runs the shapes an ORM writes, where context
   * decides the type and both clients agree. This test is what fails
   * first.
   *
   * The other direction - one of the four becoming unspecified upstream -
   * fails here too, and costs nothing until it is acted on: a value that
   * is still rendered is still exactly what `pg` sends.
   */
  it('pins which values PostgreJS declares a type for', async () => {
    const native = facadePool({ postgrejs: { inferParameterTypes: true } });
    try {
      // 25 is text: no type declared, which is what `pg` always sends.
      const HANDED_OVER = {
        string: ['abc', 25],
        Date: [new Date('2026-03-04T05:06:07Z'), 25],
        'array of numbers': [[1, 2, 3], 25],
        'array of strings': [['a', 'b'], 25],
        null: [null, 25],
      } as const;
      const DECLARED = {
        // Declared by PostgreJS and left to it - see src/params.ts.
        'number, integer': [7, 23],
        'number, non-integer': [1.5, 1700],
        // Declared by PostgreJS and rendered by us, because pg's own value
        // is what a caller migrating from it expects.
        boolean: [true, 16],
        'array of booleans': [[true, false], 1000],
        'plain object': [{ a: 1 }, 114],
        // The one that was already diverging and nothing was asking:
        // handed over, PostgreJS declares `bytea` where `pg` declares
        // nothing, so `select $1` differs. Bound at OID 0 now.
        Buffer: [Buffer.from([1, 2, 3]), 17],
      } as const;

      for (const [label, [value, oid]] of Object.entries(HANDED_OVER)) {
        const r = await native.query('select $1 as x', [value as any]);
        assert.strictEqual(
          r.fields[0].dataTypeID,
          oid,
          `${label}: PostgreJS no longer leaves this untyped - src/params.ts hands it over`,
        );
      }
      for (const [label, [value, oid]] of Object.entries(DECLARED)) {
        const r = await native.query('select $1 as x', [value as any]);
        assert.strictEqual(
          r.fields[0].dataTypeID,
          oid,
          `${label}: PostgreJS declares this differently now`,
        );
      }

      // And the default path answers pg's own type for everything it still
      // renders. A number is the exception and is asserted above instead:
      // it is handed over on purpose.
      for (const [label, [value]] of Object.entries({
        ...HANDED_OVER,
        ...DECLARED,
      })) {
        if (label.startsWith('number')) continue;
        const ours = await facade.query('select $1 as x', [value as any]);
        const theirs = await control.query('select $1 as x', [value as any]);
        assert.strictEqual(
          ours.fields[0].dataTypeID,
          theirs.fields[0].dataTypeID,
          `${label}: the default path stopped matching pg`,
        );
      }
    } finally {
      await native.end();
    }
  });

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
