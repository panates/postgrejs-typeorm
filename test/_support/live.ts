import type pg from 'pg';
import { Pool as ControlPool } from 'pg';
import { Connection } from 'postgrejs';
import { PgPool } from '../../src/index.js';

export const liveConfig = () => ({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

/** A `pg` pool, the control every live assertion is made against. */
export function pgPool(): pg.Pool {
  return new ControlPool(liveConfig());
}

/** This facade's pool, configured exactly as a consumer would get it. */
export function facadePool(extra?: Record<string, any>): PgPool {
  return new PgPool({ ...liveConfig(), ...extra });
}

/** A bare PostgreJS connection, for assertions about PostgreJS itself. */
export async function rawConnection(): Promise<Connection> {
  const c = new Connection(liveConfig());
  await c.connect();
  return c;
}

/**
 * A value rendered so two drivers' answers can be compared as strings.
 *
 * The **constructor name is deliberately not part of it**, and that is a
 * reversal worth the explanation. It used to be: `{x, y}` and a `Point`
 * carrying the same numbers were not the same answer, because the class
 * serialised to `'(1,2)'` where `pg`'s object serialised to `{"x":1,"y":2}`.
 * PostgreJS's classes no longer do that, and what is left of the difference
 * is the name alone - own keys, their values and `JSON.stringify` are all
 * identical now.
 *
 * Keeping the name in would demand the facade **degrade** the value to match:
 * `Point` answers `toPostgres()` and `pg`'s plain object does not, so a point
 * read here goes back to the server as a parameter and `pg`'s cannot -
 * `22P02`. A comparison that failed the better object would be measuring the
 * wrong thing. `types.spec.ts` asserts the superset property separately, so
 * the difference is stated rather than dropped.
 *
 * Everything that distinguishes one *kind* of value from another stays: a
 * Buffer, a Date, an array, a bigint and a primitive all render differently
 * from an object, so a type coming back as a string instead of a class is
 * still a failure.
 */
export function describeValue(v: any): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Buffer.isBuffer(v)) return `Buffer<${v.toString('hex')}>`;
  if (v instanceof Date) return `Date(${v.toISOString()})`;
  if (Array.isArray(v)) return `Array[${v.map(describeValue).join(',')}]`;
  const t = typeof v;
  if (t === 'object')
    return `object(${JSON.stringify(
      Object.keys(v)
        .sort()
        .map(k => [k, v[k]]),
    )}|${JSON.stringify(v)})`;
  if (t === 'bigint') return `bigint(${v})`;
  return `${t}(${String(v)})`;
}

/** Every value normalised so two results can be deep-compared. */
export function normalize(value: any): any {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return `bigint:${v}`;
      if (v instanceof Date) return `Date:${v.toISOString()}`;
      if (Buffer.isBuffer(v)) return `Buffer:${v.toString('hex')}`;
      return v;
    }),
  );
}
