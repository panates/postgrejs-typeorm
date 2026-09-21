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
    const r = toPgResult(
      { command: 'SELECT', rows: [{}, {}, {}] } as any,
      true,
    );
    assert.strictEqual(r.rowCount, 3);
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

  it('gives rows as an empty array when there are none at all', () => {
    const r = toPgResult({ command: 'CREATE TABLE' } as any, true);
    assert.deepStrictEqual(r.rows, []);
    assert.strictEqual(r.rowCount, 0);
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

  describe('value fixups', () => {
    const resultWith = (oid: number, value: any, apply = true) =>
      toPgResult(
        {
          command: 'SELECT',
          rowType: 'object',
          fields: [field('v', oid)],
          rows: [{ v: value }],
        } as any,
        apply,
      ).rows[0].v;

    it('turns a Point into a plain {x, y}', () => {
      const v = resultWith(DataTypeOIDs.point, { x: 1, y: 2 });
      assert.deepStrictEqual({ ...v }, { x: 1, y: 2 });
      assert.strictEqual(v.constructor, Object);
    });

    it("renames a Circle's r to radius", () => {
      assert.deepStrictEqual(
        { ...resultWith(DataTypeOIDs.circle, { x: 1, y: 2, r: 3 }) },
        { x: 1, y: 2, radius: 3 },
      );
    });

    it('stringifies int8 array elements, exactly past 2^53', () => {
      assert.deepStrictEqual(
        resultWith(DataTypeOIDs._int8, [1, 9007199254740993n]),
        ['1', '9007199254740993'],
      );
    });

    it('parses an interval into a PostgresInterval', () => {
      const v = resultWith(DataTypeOIDs.interval, '1 day 02:00:00');
      assert.strictEqual(v.constructor.name, 'PostgresInterval');
      assert.strictEqual(v.days, 1);
      assert.strictEqual(v.hours, 2);
      assert.strictEqual(typeof v.toISOString, 'function');
    });

    it('leaves nulls alone', () => {
      assert.strictEqual(resultWith(DataTypeOIDs.point, null), null);
    });

    it('does nothing at all in native decoding mode', () => {
      const v = resultWith(DataTypeOIDs.point, { x: 1, y: 2 }, false);
      assert.deepStrictEqual(v, { x: 1, y: 2 });
      assert.strictEqual(
        resultWith(DataTypeOIDs._int8, [1, 2], false)[0],
        1,
        'int8[] stays numeric',
      );
    });

    it('leaves a column that needs no fixup untouched', () => {
      assert.strictEqual(resultWith(DataTypeOIDs.int4, 5), 5);
    });
  });
});
