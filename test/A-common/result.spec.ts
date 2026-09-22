import assert from 'node:assert';
import { DataTypeOIDs } from 'postgrejs';
import { toPgResult } from '../../src/result.js';

const field = (name: string, dataTypeId: number) => ({
  fieldName: name,
  dataTypeId,
  dataTypeName: '',
  jsType: '',
  tableId: 16384,
  columnId: 1,
  fixedSize: -1,
  modifier: -1,
});

describe('toPgResult', () => {
  it('puts rows and rowCount on the object ITSELF, not on a prototype', () => {
    // Load-bearing. TypeORM reads these through raw.hasOwnProperty('rows')
    // and raw.hasOwnProperty('rowCount') in PostgresQueryRunner.query(), so a
    // class with accessors would make every query silently return nothing.
    const r = toPgResult({ command: 'SELECT', rows: [{ a: 1 }] } as any, true);
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'rows'));
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'rowCount'));
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'command'));
  });

  it('counts rows for a SELECT, which PostgreJS leaves undefined', () => {
    // `fields` is what says the statement returned rows at all - PostgreJS
    // sends it for every row-returning statement and omits it otherwise.
    const r = toPgResult(
      { command: 'SELECT', rows: [{}, {}, {}], fields: [] } as any,
      true,
    );
    assert.strictEqual(r.rowCount, 3);
  });

  it('reports 0 for a SELECT that matched nothing', () => {
    const r = toPgResult(
      { command: 'SELECT', rows: [], fields: [] } as any,
      true,
    );
    assert.strictEqual(r.rowCount, 0);
  });

  it('reports rowsAffected for a write', () => {
    const r = toPgResult(
      { command: 'UPDATE', rows: [], rowsAffected: 7 } as any,
      true,
    );
    assert.strictEqual(r.rowCount, 7);
  });

  it('reports 0 affected rather than falling back to the row count', () => {
    const r = toPgResult(
      { command: 'DELETE', rows: [], rowsAffected: 0 } as any,
      true,
    );
    assert.strictEqual(r.rowCount, 0);
  });

  it('reports null, not 0, when the command tag carried no count', () => {
    // DDL and utility statements. `pg` takes rowCount straight off the tag,
    // so CREATE/DROP/TRUNCATE/SET/BEGIN/COMMIT are null there - measured
    // across 11 statement kinds. Reporting 0 would claim the statement
    // affected nothing, which is a different thing from not saying.
    const r = toPgResult({ command: 'CREATE TABLE' } as any, true);
    assert.deepStrictEqual(r.rows, []);
    assert.strictEqual(r.rowCount, null);
  });

  it("keeps only the command tag's first word, as pg does", () => {
    // pg collapses CREATE TABLE / CREATE INDEX / CREATE VIEW into `CREATE`.
    for (const tag of ['CREATE TABLE', 'CREATE INDEX', 'DROP VIEW']) {
      const r = toPgResult({ command: tag } as any, true);
      assert.strictEqual(r.command, tag.split(' ')[0]);
      assert.strictEqual(r.commandTag, tag, 'the full tag is kept alongside');
    }
  });

  it('renames the field metadata to pg spelling', () => {
    const r = toPgResult(
      {
        command: 'SELECT',
        rows: [],
        fields: [field('a', DataTypeOIDs.int4)],
      } as any,
      true,
    );
    assert.deepStrictEqual(r.fields, [
      {
        name: 'a',
        tableID: 16384,
        columnID: 1,
        dataTypeID: DataTypeOIDs.int4,
        dataTypeSize: -1,
        dataTypeModifier: -1,
        format: 'text',
      },
    ]);
  });

  it('hands every value through exactly as PostgreJS decoded it', () => {
    // There is no fixup table any more, and this is what says so: a value
    // that used to be rewritten here - a `point` - now arrives untouched,
    // class and all. Whatever `pg` answers that PostgreJS does not is fixed
    // in the decoder, not undone afterwards. See
    // `../postgrejs/.claude/pg-compatible-decoding.md`, and
    // `test/B-live/types.spec.ts` for which types are still open.
    class Point {
      constructor(
        readonly x: number,
        readonly y: number,
      ) {}
      toJSON() {
        return `(${this.x},${this.y})`;
      }
    }
    const given = new Point(1, 2);
    const got = toPgResult({
      command: 'SELECT',
      rowType: 'object',
      fields: [field('v', DataTypeOIDs.point)],
      rows: [{ v: given }],
    } as any).rows[0].v;
    assert.strictEqual(got, given, 'the very same object, not a copy');
  });
});
