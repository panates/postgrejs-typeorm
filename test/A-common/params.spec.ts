import assert from 'node:assert';
import { BindParam } from 'postgrejs';
import { resolveFacadeOptions } from '../../src/config.js';
import { UNSPECIFIED_OID } from '../../src/constants.js';
import { toBindParams } from '../../src/params.js';

const pgFaithful = resolveFacadeOptions({});
const inferring = resolveFacadeOptions({
  postgrejs: { inferParameterTypes: true },
});

describe('toBindParams', () => {
  it('leaves an empty or absent list alone', () => {
    assert.strictEqual(toBindParams(undefined, pgFaithful), undefined);
    assert.deepStrictEqual(toBindParams([], pgFaithful), []);
  });

  /**
   * **The split, which is the whole policy.** `pg`'s renderer runs for the
   * four kinds PostgreJS would otherwise declare a type for; everything
   * else is handed over, because PostgreJS sends it unspecified exactly as
   * `pg` does and reaches the same wire bytes with less work.
   *
   * The live half of this is in `test/B-live/params.spec.ts`, where the
   * same eleven values are put through a server and compared by the result
   * column's OID. This half is about which branch each one takes.
   */
  it('renders only what PostgreJS would declare a type for', () => {
    const declared = toBindParams(
      [1, 1.5, true, [true, false], { a: 1 }],
      pgFaithful,
    )!;
    for (const p of declared) {
      assert.ok(p instanceof BindParam, 'should have been rendered');
      assert.strictEqual((p as any).oid, UNSPECIFIED_OID);
    }
  });

  it('hands over what PostgreJS already sends unspecified', () => {
    const date = new Date('2024-03-05T00:00:00Z');
    const numbers = [1, 2];
    const strings = ['a', 'b'];
    const out = toBindParams(['a', date, numbers, strings, null], pgFaithful)!;
    assert.strictEqual(out[0], 'a');
    assert.strictEqual(out[1], date);
    // By identity: the array is not copied, let alone rendered. This is the
    // one that pays - a 100 000-element int4[] is 0.97 MB a call through
    // PostgreJS's own writer against 27.2 through pg's concatenation.
    assert.strictEqual(out[2], numbers);
    assert.strictEqual(out[3], strings);
    assert.strictEqual(out[4], null);
    for (const p of out) assert.ok(!(p instanceof BindParam));
  });

  it('renders a plain object the way pg does', () => {
    const out = toBindParams([{ a: 1 }], pgFaithful)! as BindParam[];
    assert.strictEqual((out[0] as any).value, '{"a":1}');
  });

  it('hands an empty array and an all-null one over too', () => {
    // These used to be rendered here because `determine()` could not type
    // them and the server answered 22P02. Fixed upstream - both round-trip
    // on PostgreJS's own typing now - and neither holds a boolean, so both
    // take the handed-over branch.
    const empty: any[] = [];
    const nulls = [null];
    const out = toBindParams([empty, nulls], pgFaithful)!;
    assert.strictEqual(out[0], empty);
    assert.strictEqual(out[1], nulls);
  });

  /**
   * **Its bytes are kept and its type is still not declared**, which is
   * two things and used to be one.
   *
   * A Buffer was handed to PostgreJS untouched, on the reasoning that it
   * sends bytes either way. It does - and it also declares `bytea`, where
   * `pg` declares nothing and lets the server decide. `select $1` on raw
   * bytes is `22021` under `pg` and a Buffer back without this; both
   * answer `0102ff` for `$1::bytea`, which is why it survived until
   * `test/B-live/params.spec.ts` pinned the surface.
   */
  it('keeps a Buffer as bytes and still declares no type for it', () => {
    const buf = Buffer.from([1, 2, 255]);
    const out = toBindParams([buf], pgFaithful)! as BindParam[];
    assert.ok(out[0] instanceof BindParam);
    assert.strictEqual((out[0] as any).oid, UNSPECIFIED_OID);
    // the same bytes, not a rendering of them
    assert.strictEqual((out[0] as any).value, buf);
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
