import type { FieldInfo, QueryResult } from 'postgrejs';

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
  /** `null` for an empty statement, which is what `pg` resolves one to. */
  command?: string | null;
  /** `null` for a statement whose command tag carries no count - see below. */
  rowCount: number | null;
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
 * - **`rowCount` is `null` for a statement whose command tag carries no
 *   count**, not 0 - see the comment on it below.
 *
 * Nothing is rewritten here. This reshapes the result object and hands the
 * values through exactly as PostgreJS decoded them: whatever `pg` answers
 * that PostgreJS does not is a question for the decoder, and is fixed there.
 * `../postgrejs/.claude/pg-compatible-decoding.md` is what is still open.
 */
export function toPgResult<R = any>(r: QueryResult): PgResult<R> {
  const fields = r.fields ?? [];
  const rows = (r.rows ?? []) as R[];

  return {
    command: r.command ? r.command.split(' ')[0] : undefined,
    // `pg` takes this from the command tag: a count when the tag carries one,
    // and **null** when it does not. So DDL and utility statements - CREATE,
    // DROP, TRUNCATE, SET, BEGIN, COMMIT - are `null`, not 0. Measured across
    // 11 statement kinds. PostgreJS says the same thing differently: it sets
    // `rowsAffected` for the write commands and sends `fields` only for a
    // statement that returns rows, so the absence of both is the tag having
    // carried no count.
    rowCount:
      r.rowsAffected !== undefined
        ? r.rowsAffected
        : r.fields !== undefined
          ? rows.length
          : null,
    oid: undefined,
    rows,
    fields: toPgFields(fields),
    commandTag: r.command,
  };
}

/**
 * A multi-statement result, which `pg` returns as a **bare array** of results
 * rather than as one object - see `PgClient` for why this path exists at all.
 */
export function toPgResults(results: readonly QueryResult[]): PgResult[] {
  const l = results.length;
  const out = new Array<PgResult>(l);
  let i: number;
  for (i = 0; i < l; i++) out[i] = toPgResult(results[i]);
  return out;
}
