import assert from 'node:assert';
import { normalizeError } from '../../src/errors.js';

describe('normalizeError', () => {
  it('strips the caret diagram PostgreJS appends', () => {
    const err: any = new Error(
      'relation "nope" does not exist\n' +
        '    at line 1 column 15\n' +
        '  1| select * from nope\n' +
        '    .--------------^',
    );
    normalizeError(err);
    assert.strictEqual(err.message, 'relation "nope" does not exist');
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
