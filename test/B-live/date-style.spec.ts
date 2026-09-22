import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { PgClient, PgResult } from '../../src/index.js';
import { facadePool } from '../_support/live.js';

/**
 * A session whose `DateStyle` is not ISO, read over the text wire format.
 *
 * This is not a type-matrix row because `pg` is no oracle for it: `pg` is
 * all-text always and under a non-ISO style it answers `null` for `date` and
 * `timestamptz` and `{}` for `interval` - so agreeing with `pg` here would
 * mean agreeing with data loss. The oracle is the **binary path**, which
 * carries no formatting and has always been right. Text has to reach the same
 * value or decline; it must never reach a different one.
 *
 * Reached through this facade's own documented escape hatch rather than
 * through a contrived option: `postgrejs: { prepare: false }` is what a
 * PgBouncer user is told to set, and it asks for the whole row as text. That
 * is why it is worth a test - the corruption was one supported configuration
 * away, not behind a flag nobody sets. Fixed upstream in `4c1154b`; the
 * write-up that prompted it is `../postgrejs/.claude/text-timestamp-fallback.md`.
 */
const STYLES = [
  'ISO, MDY',
  'ISO, DMY',
  'German, DMY',
  'SQL, DMY',
  'SQL, MDY',
  'Postgres, DMY',
];

// A day of 5 and a day of 25 in the same month, deliberately: only the first
// can be silently swapped with its month, and the second is the one anyone
// would have noticed.
const DAYS = ['2024-03-05', '2024-11-02', '2024-03-25'];

/**
 * Whether the installed PostgreJS reads the server's `DateStyle`.
 *
 * The peer range starts at 3.7.0 and published 3.8.0 does not carry the fix,
 * so this cannot be asserted unconditionally without claiming a requirement
 * the facade does not have - nothing in `src/` depends on it. The version
 * string is no help either: the working copy still reads 3.8.0. What the fix
 * did ship is a module of its own, so its presence is the signal. It is only
 * ever used to decide whether to run.
 */
const readsDateStyle = (() => {
  const require = createRequire(import.meta.url);
  try {
    const pkg = require.resolve('postgrejs/package.json');
    return existsSync(join(dirname(pkg), 'util', 'date-style.js'));
  } catch {
    return false;
  }
})();

const localDate = (v: any): string => {
  if (!(v instanceof Date)) return String(v);
  if (Number.isNaN(v.getTime())) return 'Invalid Date';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
};

describe('B-live: a session whose DateStyle is not ISO', () => {
  for (const [label, extra] of [
    ['binary, the default', {}],
    ['text, through prepare:false', { postgrejs: { prepare: false } }],
  ] as [string, Record<string, any>][]) {
    describe(label, function () {
      before(function () {
        if (extra.postgrejs && !readsDateStyle) this.skip(); // PostgreJS predates 4c1154b
      });

      for (const style of STYLES) {
        it(`reads back what was stored under '${style}'`, async () => {
          const pool = facadePool(extra);
          const client = (await pool.connect()) as PgClient;
          try {
            await client.query(`set datestyle to '${style}'`);
            for (const day of DAYS) {
              const r = (await client.query(
                `select $1::date as d, $1::timestamp as ts,
                        $1::timestamptz as tstz, array[$1::date] as arr`,
                [day],
              )) as PgResult;
              const row = r.rows[0];
              for (const [column, value] of [
                ['date', row.d],
                ['timestamp', row.ts],
                ['timestamptz', row.tstz],
                ['date[]', row.arr[0]],
              ] as [string, any][])
                assert.strictEqual(
                  localDate(value),
                  day,
                  `${style} ${column} ${day}`,
                );
            }
          } finally {
            client.release!();
            await pool.end();
          }
        });
      }
    });
  }
});
