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
 * Class identity matters here - `{x, y}` and a `Point` carrying the same
 * numbers are not the same answer - so the constructor name is part of it.
 */
export function describeValue(v: any): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Buffer.isBuffer(v)) return `Buffer<${v.toString('hex')}>`;
  if (v instanceof Date) return `Date(${v.toISOString()})`;
  if (Array.isArray(v)) return `Array[${v.map(describeValue).join(',')}]`;
  const t = typeof v;
  if (t === 'object')
    return `${v.constructor ? v.constructor.name : 'Object'}(${JSON.stringify(v)})`;
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
