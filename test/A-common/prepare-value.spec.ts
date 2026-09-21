import assert from 'node:assert';
// `pg` is a devDependency for exactly this: prepare-value.ts is a port of its
// own rendering, so the port is held to the original rather than to a table
// of expectations someone wrote down once.
import pgUtils from 'pg/lib/utils.js';
import { prepareValue } from '../../src/prepare-value.js';

const pgPrepare = (pgUtils as any).prepareValue as (v: any) => any;

describe('prepareValue', () => {
  const cases: [string, any][] = [
    ['null', null],
    ['undefined', undefined],
    ['string', 'hello'],
    ['string with quotes', 'a"b\\c'],
    ['empty string', ''],
    ['number', 42],
    ['negative number', -1.5],
    ['zero', 0],
    ['bigint', 9007199254740993n],
    ['true', true],
    ['false', false],
    ['Buffer', Buffer.from([1, 2, 255])],
    ['Uint8Array', new Uint8Array([1, 2, 255])],
    ['plain object', { a: 1, b: [1, 2] }],
    ['nested object', { a: { b: { c: null } } }],
    ['empty array', []],
    ['number array', [1, 2, 3]],
    ['string array', ['a', 'b']],
    ['array with null', [1, null, 3]],
    ['array with empty string', ['', 'b']],
    ['array with quotes', ['a"b', 'c\\d']],
    ['nested array', [[1, 2], [3]]],
    ['array of buffers', [Buffer.from([1])]],
    ['array of objects', [{ a: 1 }]],
    ['object with toPostgres', { toPostgres: () => 'custom' }],
  ];

  for (const [label, value] of cases) {
    it(`renders ${label} exactly as pg does`, () => {
      const ours = prepareValue(value);
      const theirs = pgPrepare(value);
      if (Buffer.isBuffer(theirs)) {
        assert.ok(Buffer.isBuffer(ours), `${label}: expected a Buffer`);
        assert.deepStrictEqual(ours, theirs);
      } else {
        assert.strictEqual(ours, theirs);
      }
    });
  }

  // Dates are their own block: pg reads a module-level default for these and
  // the port takes it as an argument instead, so they cannot go through the
  // loop above without mutating pg's global.
  describe('Date', () => {
    const dates = [
      ['ordinary', new Date('2024-03-05T06:07:08.900Z')],
      ['DST side', new Date('2024-06-15T23:30:00.000Z')],
      ['pre-epoch', new Date('1969-12-31T23:59:59.999Z')],
      ['year 1', new Date(Date.UTC(1, 0, 1))],
    ] as const;

    for (const [label, d] of dates) {
      it(`renders a ${label} Date exactly as pg does`, () => {
        assert.strictEqual(prepareValue(d), pgPrepare(d));
      });
    }

    it('renders from UTC fields when asked, as pg does with parseInputDatesAsUTC', () => {
      const d = new Date('2024-03-05T06:07:08.900Z');
      assert.strictEqual(
        prepareValue(d, undefined, true),
        '2024-03-05T06:07:08.900+00:00',
      );
    });
  });

  it('detects a circular toPostgres, as pg does', () => {
    const a: any = {};
    a.toPostgres = () => a;
    assert.throws(() => prepareValue(a), /circular reference/);
    assert.throws(() => pgPrepare(a), /circular reference/);
  });
});
