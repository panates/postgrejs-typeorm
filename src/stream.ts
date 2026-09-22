import { Readable } from 'node:stream';
import type { Connection, QueryOptions } from 'postgrejs';

/** What a `pg` "submittable" looks like from the outside. */
export interface Submittable {
  submit: (connection: any) => void;
  cursor?: { text: string; values?: any[] };
  text?: string;
  values?: any[];
  readableHighWaterMark?: number;
}

export function isSubmittable(value: any): value is Submittable {
  return !!value && typeof value.submit === 'function';
}

/**
 * `pg-query-stream` in terms of a PostgreJS `Cursor`.
 *
 * The submittable is the one part of `pg`'s surface that is genuinely
 * private: `QueryStream.submit(connection)` hands off to `pg-cursor`, which
 * drives `con.parse()`, `con.bind()`, `con.describe()`, `con.execute()` and
 * `con.flush()` on pg's internal protocol object and expects
 * `handleRowDescription` / `handleDataRow` / `handleCommandComplete` called
 * back on it. Reimplementing that means reimplementing pg's internals.
 *
 * It does not have to be. TypeORM only ever uses what `connection.query()`
 * returns here as a `ReadStream`, with `on('end')` and `on('error')`
 * (`PostgresQueryRunner.stream()`), and never touches the protocol itself.
 * So the submittable is read for the one thing it carries that we need - the
 * SQL and its parameters, already rendered by `pg-cursor` - and thrown away.
 *
 * `PlatformTools.load()` has a hard allowlist of module names, so the real
 * `pg-query-stream` still has to be installed for TypeORM to construct one;
 * it just never gets to run.
 */
export function streamFromSubmittable(
  connection: Connection,
  submittable: Submittable,
  queryOptions: QueryOptions,
): Readable {
  const source = submittable.cursor ?? submittable;
  const text = source.text as string;
  const batchSize = submittable.readableHighWaterMark || 100;

  let cursor: any;
  let opening: Promise<any> | undefined;

  // `queryOptions.params` is already what the caller wants bound - the
  // submittable's own `values` have been rendered by pg-cursor and then run
  // through this facade's parameter policy, so they are not read again here.
  const open = () => {
    if (!opening)
      opening = connection
        .query(text, {
          ...queryOptions,
          cursor: true,
          fetchCount: batchSize,
        })
        .then(r => {
          cursor = r.cursor;
          return cursor;
        });
    return opening;
  };

  return new Readable({
    objectMode: true,
    highWaterMark: batchSize,
    read() {
      open()
        .then(c => c.next())
        .then((row: any) => this.push(row === undefined ? null : row))
        .catch((e: Error) => this.destroy(e));
    },
    destroy(err, cb) {
      if (!cursor) return cb(err);
      cursor.close().then(
        () => cb(err),
        () => cb(err),
      );
    },
  });
}
