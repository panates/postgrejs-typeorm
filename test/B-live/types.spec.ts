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

/**
 * What is still open upstream, named value by value.
 *
 * The facade rewrites nothing after decoding - no fixup table, no `pg`
 * dependency - so what PostgreJS decodes is what a caller gets. These six are
 * where that is not yet `pg`'s answer, and each is listed with the exact
 * difference so this file fails when one is closed. The tracking issue is
 * `../postgrejs/.claude/pg-compatible-decoding.md`; the two kinds are:
 *
 * - **`json`** - the value's own keys and their values match `pg` exactly and
 *   only `JSON.stringify` differs, because PostgreJS's classes carry a
 *   `toJSON` returning the literal the server printed. `{...v}`, `v.x` and
 *   `Object.keys(v)` all agree today.
 * - **`shape`** - a real difference in what is there.
 */
const PENDING_UPSTREAM: Record<string, string> = {
  // toJSON gives the literal where pg serialises the object.
  interval: 'json',
  point: 'json',
  circle: 'json',
  _point: 'json',
  // pg omits an interval's zero fields; PostgreJS carries all seven. Only
  // visible on a value that HAS a zero field, which is why the scalar
  // `interval` row above is a `json` and this one is not.
  _interval: 'shape',
  // Scalar `numeric` has to be text to keep its precision, and naming it
  // reaches `numeric[]` too, where `pg` runs parseFloat per element. Needs a
  // way to name a scalar without its array.
  _numeric: 'shape',
};

const describeGap = (actual: any, expected: any): string => {
  const same = (a: any, b: any): boolean =>
    Array.isArray(a) && Array.isArray(b)
      ? a.length === b.length && a.every((x, i) => same(x, b[i]))
      : a && b && typeof a === 'object' && typeof b === 'object'
        ? JSON.stringify({ ...a }) === JSON.stringify({ ...b })
        : Object.is(a, b);
  if (!same(actual, expected)) return 'shape';
  return JSON.stringify(actual) === JSON.stringify(expected) ? 'none' : 'json';
};

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
      const expected = (await control.query(sql)).rows[0].v;
      const actual = (await facade.query(sql)).rows[0].v;
      const pending = PENDING_UPSTREAM[label];
      if (!pending) {
        assert.strictEqual(
          describeValue(actual),
          describeValue(expected),
          `${label}: ${expr}`,
        );
        return;
      }
      // A known divergence, asserted as the divergence it is rather than
      // skipped - so it fails here the day upstream closes it and this entry
      // has to go, instead of passing quietly either way.
      assert.strictEqual(
        describeGap(actual, expected),
        pending,
        `${label}: ${expr} - see ../postgrejs/.claude/pg-compatible-decoding.md`,
      );
    });
  }

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
