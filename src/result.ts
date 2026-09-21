import type { FieldInfo, QueryResult } from 'postgrejs';
import { fixupFor } from './value-shapes.js';

/** A `pg` result field. */
export interface PgField {
  name: string;
  tableID?: number;
  columnID?: number;
  dataTypeID: number;
  dataTypeSize?: number;
  dataTypeModifier?: number;
  format: string;
}

/** What `pg` resolves a query to. */
export interface PgResult<R = any> {
  command?: string;
  rowCount: number;
  oid?: number;
  rows: R[];
  fields: PgField[];
  /**
   * PostgreJS's full command tag, which `pg` does not have. `pg` takes only
   * the first word, so it collapses `CREATE TABLE`/`CREATE INDEX`/`CREATE
   * VIEW`/`CREATE SEQUENCE` into one word - `command` keeps that behaviour
   * for compatibility and this keeps what the server actually said.
   */
  commandTag?: string;
}

function toPgFields(fields: readonly FieldInfo[]): PgField[] {
  const l = fields.length;
  const out = new Array<PgField>(l);
  let i: number;
  let f: FieldInfo;
  for (i = 0; i < l; i++) {
    f = fields[i];
    out[i] = {
      name: f.fieldName,
      tableID: f.tableId,
      columnID: f.columnId,
      dataTypeID: f.dataTypeId,
      dataTypeSize: f.fixedSize,
      dataTypeModifier: f.modifier,
      format: 'text',
    };
  }
  return out;
}

/**
 * PostgreJS's `QueryResult` as the object `pg` would have returned.
 *
 * Two things here are load-bearing and neither is obvious:
 *
 * - **`rows` and `rowCount` must be own properties.** TypeORM reads them
 *   through `raw.hasOwnProperty('rows')` (`PostgresQueryRunner.query()`), so
 *   a class with accessors on its prototype would make every query return
 *   nothing, silently. That is why this builds a plain object literal rather
 *   than an instance of anything.
 * - **`rowCount` falls back to `rows.length`.** PostgreJS sets `rowsAffected`
 *   only for INSERT/UPDATE/DELETE/MERGE and leaves it undefined for SELECT,
 *   where `pg` reports the number of rows returned.
 */
export function toPgResult<R = any>(
  r: QueryResult,
  applyFixups: boolean,
): PgResult<R> {
  const fields = r.fields ?? [];
  const rows = (r.rows ?? []) as R[];

  if (applyFixups && rows.length && r.rowType === 'object') {
    const l = fields.length;
    let i: number;
    // Built once for the whole result rather than per row: a query with no
    // column needing one pays a single pass over `fields`.
    let fixers: (ReturnType<typeof fixupFor> | undefined)[] | undefined;
    for (i = 0; i < l; i++) {
      const fn = fixupFor(fields[i].dataTypeId);
      if (!fn) continue;
      if (!fixers) fixers = new Array(l);
      fixers[i] = fn;
    }
    if (fixers) {
      const rowCount = rows.length;
      let j: number;
      let name: string;
      let row: any;
      for (i = 0; i < l; i++) {
        const fn = fixers[i];
        if (!fn) continue;
        name = fields[i].fieldName;
        for (j = 0; j < rowCount; j++) {
          row = rows[j];
          if (row[name] != null) row[name] = fn(row[name]);
        }
      }
    }
  }

  return {
    command: r.command ? r.command.split(' ')[0] : undefined,
    rowCount: r.rowsAffected !== undefined ? r.rowsAffected : rows.length,
    oid: undefined,
    rows,
    fields: toPgFields(fields),
    commandTag: r.command,
  };
}
