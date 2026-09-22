import assert from 'node:assert';
import type pg from 'pg';
import type { PgPool } from '../../src/index.js';
import { describeValue, facadePool, pgPool } from '../_support/live.js';

/**
 * What every type decodes to, through `pg` and through the facade.
 *
 * `pg` is the oracle again rather than a written-down table: this is the
 * package's central claim - that a consumer written against `pg` sees what it
 * expects - and it is the thing most likely to move when either library gains
 * a decoder.
 */
const TYPES: [string, string][] = [
  ['int2', `'1'::int2`],
  ['int4', `'1'::int4`],
  ['int8', `'9007199254740993'::int8`],
  ['float4', `'1.5'::float4`],
  ['float8', `'1.5'::float8`],
  ['numeric', `'1234567890123456789.12'::numeric`],
  ['numeric, small', `'19.99'::numeric`],
  ['money', `'12.34'::money`],
  ['bool', `true`],
  ['text', `'x'::text`],
  ['varchar', `'x'::varchar`],
  ['char', `'x'::char(3)`],
  ['uuid', `'00000000-0000-0000-0000-000000000001'::uuid`],
  ['bytea', `'\\x0102'::bytea`],
  ['json', `'{"a":1}'::json`],
  ['jsonb', `'{"a":1}'::jsonb`],
  ['date', `'2024-03-05'::date`],
  ['time', `'06:07:08.9'::time`],
  ['timetz', `'06:07:08.9+02'::timetz`],
  ['timestamp', `'2024-03-05 06:07:08.9'::timestamp`],
  ['timestamptz', `'2024-03-05 06:07:08.9+00'::timestamptz`],
  ['interval', `'1 year 2 mons 3 days 04:05:06.7'::interval`],
  ['point', `'(1,2)'::point`],
  ['line', `'{1,2,3}'::line`],
  ['lseg', `'[(1,2),(3,4)]'::lseg`],
  ['box', `'((1,2),(3,4))'::box`],
  ['path', `'((1,2),(3,4))'::path`],
  ['polygon', `'((1,2),(3,4),(5,6))'::polygon`],
  ['circle', `'<(1,2),3>'::circle`],
  ['inet', `'192.168.0.1'::inet`],
  ['cidr', `'192.168.0.0/24'::cidr`],
  ['macaddr', `'08:00:2b:01:02:03'::macaddr`],
  ['macaddr8', `'08:00:2b:01:02:03:04:05'::macaddr8`],
  ['bit', `B'101'`],
  ['varbit', `'101'::varbit`],
  ['tsvector', `'a b'::tsvector`],
  ['tsquery', `'a & b'::tsquery`],
  ['int4range', `'[1,5)'::int4range`],
  ['int8range', `'[1,5)'::int8range`],
  ['numrange', `'[1.5,5.5)'::numrange`],
  ['daterange', `'[2024-01-01,2024-02-01)'::daterange`],
  ['tsrange', `'[2024-01-01,2024-02-01)'::tsrange`],
  ['tstzrange', `'[2024-01-01,2024-02-01)'::tstzrange`],
  ['xml', `'<a/>'::xml`],
  ['oid', `'1'::oid`],
  ['_int4', `'{1,2}'::int4[]`],
  ['_int8', `'{1,2}'::int8[]`],
  ['_text', `'{a,b}'::text[]`],
  ['_numeric', `'{1.5,2.5}'::numeric[]`],
  ['_date', `'{2024-03-05}'::date[]`],
  ['_timestamp', `'{"2024-03-05 06:07:08"}'::timestamp[]`],
  ['_timestamptz', `'{"2024-03-05 06:07:08+00"}'::timestamptz[]`],
  ['_interval', `'{"1 day"}'::interval[]`],
  // money[] was missing from this matrix until PostgreJS gained a `money`
  // decoder and only the scalar row caught it. The grouped value is the
  // interesting one: it is the element the literal has to quote.
  ['_money', `array['12.34'::money, '99999999999999.99'::money, null]`],
  ['_point', `'{"(1,2)"}'::point[]`],
  ['_inet', `'{192.168.0.1}'::inet[]`],
  ['_jsonb', `'{"{\\"a\\":1}"}'::jsonb[]`],
  ['_bool', `'{t,f}'::bool[]`],
  ['_uuid', `'{00000000-0000-0000-0000-000000000001}'::uuid[]`],
  ['_bytea', `'{"\\\\x0102"}'::bytea[]`],
  ['enum', `'happy'::live_mood`],
  ['_enum', `'{happy,sad}'::live_mood[]`],
  ['composite', `row(1,'x')::live_pair`],
  ['null', `null::int4`],
];

describe('B-live: decoded values match pg, type for type', () => {
  let control: pg.Pool;
  let facade: PgPool;

  before(async () => {
    control = pgPool();
    facade = facadePool();
    await control.query(`
      drop type if exists live_mood cascade;
      create type live_mood as enum ('happy','sad');
      drop type if exists live_pair cascade;
      create type live_pair as (n int, s text);`);
  });

  after(async () => {
    await control.query(
      'drop type if exists live_mood cascade; drop type if exists live_pair cascade',
    );
    await control.end();
    await facade.end();
  });

  for (const [label, expr] of TYPES) {
    it(label, async () => {
      const sql = `select ${expr} as v`;
      const expected = describeValue((await control.query(sql)).rows[0].v);
      const actual = describeValue((await facade.query(sql)).rows[0].v);
      assert.strictEqual(actual, expected, `${label}: ${expr}`);
    });
  }

  describe('where the class differs, it is a superset', () => {
    // `describeValue` compares values rather than constructor names, and
    // this is what keeps that from hiding anything. `interval`, `point` and
    // `circle` come back as PostgreJS classes where `pg` gives a plain
    // object or its own `PostgresInterval`. Everything a caller reads
    // agrees - own keys, their values, `JSON.stringify` - and the class adds
    // `toPostgres()`, which is what lets the value go back to the server.
    // `pg`'s own object cannot: it fails 22P02.
    const CASES: [string, string][] = [
      ['point', `'(1,2)'::point`],
      ['circle', `'<(1,2),3>'::circle`],
      ['interval', `'1 day 2 hours'::interval`],
    ];

    for (const [label, expr] of CASES) {
      it(`${label} reads the same and writes back, where pg's cannot`, async () => {
        const sql = `select ${expr} as v`;
        const theirs = (await control.query(sql)).rows[0].v;
        const ours = (await facade.query(sql)).rows[0].v;

        assert.deepStrictEqual(
          Object.keys(ours).sort(),
          Object.keys(theirs).sort(),
        );
        assert.deepStrictEqual({ ...ours }, { ...theirs });
        assert.strictEqual(JSON.stringify(ours), JSON.stringify(theirs));

        assert.strictEqual(
          typeof ours.toPostgres,
          'function',
          'the class has to be able to write itself back',
        );
        const back = await facade.query(`select $1::text as v`, [ours]);
        assert.strictEqual(typeof back.rows[0].v, 'string');
      });
    }

    it("pg's own point cannot be sent back, which is why the class is kept", async () => {
      // Not a facade assertion - a note about what the comparison above is
      // choosing between, pinned so it is not taken on trust.
      const theirs = (await control.query(`select '(1,2)'::point as v`)).rows[0]
        .v;
      await assert.rejects(
        () => control.query('select $1::point as v', [theirs]),
        (e: any) => e.code === '22P02',
      );
    });
  });

  it('keeps PostgreJS decoding when asked for it', async () => {
    // The escape hatch, and the reason it is not the default: what comes back
    // is better, and it is not what an ORM written against pg expects.
    const native = facadePool({ postgrejs: { decoding: 'native' } });
    try {
      const r = await native.query(
        `select '1234567890123456789.12'::numeric a, '9007199254740993'::int8 b`,
      );
      assert.notStrictEqual(typeof r.rows[0].a, 'string');
      assert.notStrictEqual(typeof r.rows[0].b, 'string');
    } finally {
      await native.end();
    }
  });
});
