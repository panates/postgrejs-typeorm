import assert from 'node:assert';
import type { PgClient } from '../../src/index.js';
import { facadePool } from '../_support/live.js';

describe('B-live: the pool behaves the way pg-pool does', () => {
  it('hands the same release function to the callback and to the client', async () => {
    // pg-pool assigns `client.release = this._releaseOnce(...)` and then calls
    // back with `(undefined, client, client.release)`. Both spellings are used
    // in the wild - TypeORM keeps the third argument, knex calls
    // `connection.release(shouldDestroy)`, and `await pool.connect()` leaves a
    // caller with nothing but the client - so they have to be the same thing.
    const pool = facadePool({ max: 2 });
    try {
      const [client, release] = await new Promise<[PgClient, any]>(
        (ok, fail) => {
          pool.connect((err, c, r) => (err ? fail(err) : ok([c!, r])));
        },
      );
      assert.strictEqual(typeof client.release, 'function');
      assert.strictEqual(client.release, release);
      release();
    } finally {
      await pool.end();
    }
  });

  it('lets a client taken with await be given back', async () => {
    // The promise form has no third argument, so without `client.release`
    // there is no way to return the connection at all - it would leak one per
    // call until the pool blocked.
    const pool = facadePool({ max: 1 });
    try {
      for (let i = 0; i < 3; i++) {
        const client = (await pool.connect()) as PgClient;
        const r = await client.query('select $1::int as n', [i]);
        assert.strictEqual(r.rows[0].n, i);
        client.release!();
      }
      // A fourth checkout on a pool of one proves the first three came back.
      const last = (await pool.connect()) as PgClient;
      last.release!();
    } finally {
      await pool.end();
    }
  });

  it('releases only once, however many times it is called', async () => {
    const pool = facadePool({ max: 1 });
    try {
      const client = (await pool.connect()) as PgClient;
      client.release!();
      client.release!();
      client.release!();
      // A double release would return the connection twice and corrupt the
      // pool's accounting; this checkout is what shows it did not.
      const again = (await pool.connect()) as PgClient;
      assert.ok(await again.query('select 1'));
      again.release!();
    } finally {
      await pool.end();
    }
  });

  it('emits acquire and release around a checkout', async () => {
    // TypeORM listens only for 'error', but its own suite asserts that
    // 'acquire' fires exactly once per checkout
    // (transaction-with-load-many/transaction-load-many.test.ts).
    const pool = facadePool({ max: 1 });
    let acquired = 0;
    let released = 0;
    pool.on('acquire', () => acquired++);
    pool.on('release', () => released++);
    try {
      const client = (await pool.connect()) as PgClient;
      assert.strictEqual(acquired, 1);
      assert.strictEqual(released, 0);
      client.release!();
      assert.strictEqual(released, 1);
    } finally {
      await pool.end();
    }
  });

  it('runs concurrent queries on one client one at a time, as pg does', async () => {
    // pg's Client queues them; a PostgreJS Connection pipelines, and the
    // difference is visible as a failure rather than as a reordering - the
    // insert reaches the server before the CREATE has taken effect and
    // raises 42P01. pg deprecates concurrent query() outright, so nobody
    // migrating loses the pipelining by having it serialised here; anyone
    // who wants it has `client.connection`, which is not queued.
    const pool = facadePool({ max: 1 });
    try {
      const client = (await pool.connect()) as PgClient;
      try {
        const results = await Promise.all([
          client.query('create temp table cc_order(i int)'),
          client.query('insert into cc_order values (1)'),
          client.query('select count(*)::int as n from cc_order'),
        ]);
        assert.strictEqual((results[2] as any).rows[0].n, 1);
      } finally {
        client.release!();
      }
    } finally {
      await pool.end();
    }
  });

  it('keeps each concurrent result matched to its own query', async () => {
    const pool = facadePool({ max: 1 });
    try {
      const client = (await pool.connect()) as PgClient;
      try {
        const rs = await Promise.all(
          [1, 2, 3, 4, 5].map(n => client.query('select $1::int as n', [n])),
        );
        assert.deepStrictEqual(
          rs.map((r: any) => r.rows[0].n),
          [1, 2, 3, 4, 5],
        );
      } finally {
        client.release!();
      }
    } finally {
      await pool.end();
    }
  });

  it('keeps serving after one statement in a concurrent burst fails', async () => {
    const pool = facadePool({ max: 1 });
    try {
      const client = (await pool.connect()) as PgClient;
      try {
        const rs = await Promise.allSettled([
          client.query('select 1 as a'),
          client.query('select * from no_such_table_at_all'),
          client.query('select 3 as c'),
        ]);
        assert.deepStrictEqual(
          rs.map(r =>
            r.status === 'fulfilled' ? 'ok' : ((r.reason as any).code ?? 'err'),
          ),
          ['ok', '42P01', 'ok'],
          'a rejection must not break the queue behind it',
        );
      } finally {
        client.release!();
      }
    } finally {
      await pool.end();
    }
  });

  it('reports the sizes pg reports', async () => {
    const pool = facadePool({ max: 3 });
    try {
      assert.strictEqual(pool.totalCount, 0);
      const client = (await pool.connect()) as PgClient;
      assert.strictEqual(pool.totalCount, 1);
      client.release!();
      assert.strictEqual(pool.idleCount, 1);
      assert.strictEqual(pool.ending, false);
    } finally {
      await pool.end();
    }
  });
});
