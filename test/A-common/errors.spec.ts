import assert from 'node:assert';
import { normalizeError } from '../../src/errors.js';

describe('normalizeError', () => {
  it("takes the server's own text from serverMessage", () => {
    // PostgreJS added `serverMessage` because parsing the decorated `message`
    // is what callers were reduced to, and it breaks anchored patterns.
    // Copying the field beats reproducing it.
    const err: any = Object.assign(
      new Error(
        'column "x" does not exist\n    at line 1 column 8\n  1| select x\n    .------^',
      ),
      { serverMessage: 'column "x" does not exist' },
    );
    normalizeError(err);
    assert.strictEqual(err.message, 'column "x" does not exist');
  });

  it('leaves a decorated message alone when there is no serverMessage', () => {
    // There used to be a regex here, stripping the diagram for a PostgreJS
    // that had no `serverMessage`. It is gone, and deliberately not replaced:
    // an error carrying a diagram but no `serverMessage` did not come from
    // this client, and guessing at its shape is how anchored patterns break.
    const decorated =
      'relation "nope" does not exist\n' +
      '    at line 1 column 15\n' +
      '  1| select * from nope\n' +
      '    .--------------^';
    const err: any = new Error(decorated);
    normalizeError(err);
    assert.strictEqual(err.message, decorated);
  });

  it('leaves a message that has no diagram exactly as it was', () => {
    const err: any = new Error(
      'duplicate key value violates unique constraint "uq"',
    );
    const before = err.message;
    normalizeError(err);
    assert.strictEqual(err.message, before);
  });

  it('renders position as a string, which is how pg reads it off the wire', () => {
    const err: any = Object.assign(new Error('x'), { position: 15 });
    normalizeError(err);
    assert.strictEqual(err.position, '15');
  });

  it('leaves an absent position absent rather than inventing one', () => {
    const err: any = new Error('x');
    normalizeError(err);
    assert.strictEqual(err.position, undefined);
    assert.ok(!('position' in err));
  });

  it('keeps every structured field untouched', () => {
    // These are identical between the two drivers already - verified across
    // seven error classes - so normalisation must not touch them.
    const err: any = Object.assign(new Error('x'), {
      code: '23505',
      severity: 'ERROR',
      detail: 'Key (a)=(1) already exists.',
      constraint: 'uq',
      table: 't',
      schema: 'public',
      column: 'a',
      hint: undefined,
    });
    normalizeError(err);
    assert.strictEqual(err.code, '23505');
    assert.strictEqual(err.severity, 'ERROR');
    assert.strictEqual(err.detail, 'Key (a)=(1) already exists.');
    assert.strictEqual(err.constraint, 'uq');
    assert.strictEqual(err.table, 't');
    assert.strictEqual(err.schema, 'public');
    assert.strictEqual(err.column, 'a');
  });

  it('passes a non-error through', () => {
    assert.strictEqual(normalizeError(null), null);
    assert.strictEqual(normalizeError('boom'), 'boom');
  });
});
