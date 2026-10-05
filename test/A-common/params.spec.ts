import assert from 'node:assert';
import { BindParam } from 'postgrejs';
import { resolveFacadeOptions } from '../../src/config.js';
import { UNSPECIFIED_OID } from '../../src/constants.js';
import { toBindParams } from '../../src/params.js';

// Named for the path it exercises rather than for the default, which it
// stopped being: `inferParameterTypes` is on by default now, and these
// assertions are about `pg`'s own rendering - the opt-out.
const pgFaithful = resolveFacadeOptions({
  postgrejs: { inferParameterTypes: false },
});
const inferring = resolveFacadeOptions({
  postgrejs: { inferParameterTypes: true },
});

describe('toBindParams', () => {
  it('leaves an empty or absent list alone', () => {
    assert.strictEqual(toBindParams(undefined, pgFaithful), undefined);
    assert.deepStrictEqual(toBindParams([], pgFaithful), []);
  });

  it('declares every value unspecified, as pg does', () => {
    const out = toBindParams(['a', 1, true, null], pgFaithful)!;
    for (const p of out) {
      assert.ok(p instanceof BindParam);
      assert.strictEqual((p as any).oid, UNSPECIFIED_OID);
    }
  });

  it('renders values to text before binding them', () => {
    const out = toBindParams(
      [{ a: 1 }, [1, 2], new Date('2024-03-05T00:00:00Z')],
      pgFaithful,
    )! as BindParam[];
    assert.strictEqual((out[0] as any).value, '{"a":1}');
    // Every non-null array element goes out quoted - that is pg's own
    // arrayString(), which calls escapeElement() on each one, and the server
    // parses `{"1","2"}` and `{1,2}` identically.
    assert.strictEqual((out[1] as any).value, '{"1","2"}');
    assert.strictEqual(typeof (out[2] as any).value, 'string');
  });

  it('renders an empty array as {} and an all-null one as {NULL}', () => {
    // This used to be the case PostgreJS could not type: determine() picked
    // an array's type from value[0], undefined for [] and null for [null],
    // and the server answered 22P02. Fixed upstream - both round-trip on
    // its own typing now - so this asserts pg's rendering because that is
    // what this path is, not because it is the only thing that works.
    const out = toBindParams([[], [null]], pgFaithful)! as BindParam[];
    assert.strictEqual((out[0] as any).value, '{}');
    assert.strictEqual((out[1] as any).value, '{NULL}');
  });

  it('passes a Buffer through as bytes rather than binding it', () => {
    const buf = Buffer.from([1, 2, 255]);
    const out = toBindParams([buf], pgFaithful)!;
    assert.strictEqual(out[0], buf);
    assert.ok(!(out[0] instanceof BindParam));
  });

  it('hands values over untouched when inferParameterTypes is on', () => {
    const values = ['a', 1, new Date(), [1, 2]];
    const out = toBindParams(values, inferring)!;
    assert.deepStrictEqual(out, values);
    for (const p of out) assert.ok(!(p instanceof BindParam));
  });

  it('returns a new array rather than mutating the caller’s', () => {
    const values = ['a'];
    assert.notStrictEqual(toBindParams(values, pgFaithful), values);
    assert.notStrictEqual(toBindParams(values, inferring), values);
  });
});
