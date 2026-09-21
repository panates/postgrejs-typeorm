import assert from 'node:assert';
import { Pool as ControlPool } from 'pg';
import { PgClient, PgPool, type PgResult } from '../../src/index.js';
import { facadePool, liveConfig } from '../_support/live.js';

/**
 * What happens when something has already gone wrong: a connection that
 * cannot be opened, a statement that fails on both protocols, a backend
 * killed underneath a query.
 *
 * These are the branches a coverage report finds last, because nothing
 * reaches them on a good day - and they are the ones a caller meets on a
 * bad one.
 */
describe('B-live: error paths', () => {
  describe('connecting to somewhere that is not there', () => {
    const unreachable = () => ({
      ...liveConfig(),
      port: 1, // nothing listens here
      connectionTimeoutMillis: 2000,
    });

    it('rejects', async () => {
      const client = new PgClient(unreachable());
      await assert.rejects(() => client.connect());
    });

    it('calls back with the error rather than rejecting', async () => {
      const client = new PgClient(unreachable());
      const err = await new Promise<any>(ok => client.connect(e => ok(e)));
      assert.ok(err, 'the callback form has to receive the error');
    });
  });

  describe('a statement that fails on both protocols', () => {
    // 42601 is the SQLSTATE the multi-statement fallback keys on, and it is
    // also plain "syntax error" - so an ordinary typo takes the fallback,
    // fails again on the simple protocol, and has to surface as itself
    // rather than as whatever the retry said.
    it('surfaces the original error, not the retry', async () => {
      const pool = facadePool();
      try {
        await assert.rejects(
          () => pool.query('selec 1'),
          (e: any) => {
            assert.strictEqual(e.code, '42601');
            assert.match(e.message, /syntax error/);
            return true;
          },
        );
      } finally {
        await pool.end();
      }
    });

    it('reports the failing statement in a multi-statement string', async () => {
      const pool = facadePool();
      try {
        await assert.rejects(
          () => pool.query('select 1; select * from no_such_multi'),
          (e: any) => {
            assert.strictEqual(e.code, '42P01');
            return true;
          },
        );
      } finally {
        await pool.end();
      }
    });

    it('agrees with pg on both', async () => {
      const control = new ControlPool(liveConfig());
      const facade = facadePool();
      try {
        for (const sql of [
          'selec 1',
          'select 1; select * from no_such_multi',
        ]) {
          const codes = await Promise.all(
            [control, facade].map(p =>
              p.query(sql).then(
                () => 'no error',
                (e: any) => e.code,
              ),
            ),
          );
          assert.strictEqual(codes[1], codes[0], sql);
        }
      } finally {
        await control.end();
        await facade.end();
      }
    });
  });

  describe('pool.query() in callback form', () => {
    it('calls back with a result', async () => {
      const pool = facadePool();
      try {
        const r = await new Promise<PgResult>((ok, fail) => {
          pool.query('select 1 as n', undefined, (e: any, res: any) =>
            e ? fail(e) : ok(res),
          );
        });
        assert.strictEqual(r.rows[0].n, 1);
      } finally {
        await pool.end();
      }
    });

    it('calls back with an error, and still frees the connection', async () => {
      const pool = facadePool({ max: 1 });
      try {
        const err = await new Promise<any>(ok => {
          pool.query('select * from no_such_pool_cb', undefined, (e: any) =>
            ok(e),
          );
        });
        assert.strictEqual(err.code, '42P01');
        // A pool one connection wide: this only answers if the failed call
        // gave its connection back.
        assert.strictEqual((await pool.query('select 1 as n')).rows[0].n, 1);
      } finally {
        await pool.end();
      }
    });
  });

  describe('a backend killed underneath a query', () => {
    it('rejects the query and leaves the pool usable', async () => {
      const pool = facadePool({ max: 2 });
      const killer = new ControlPool(liveConfig());
      try {
        const client = (await pool.connect()) as PgClient;
        const pid = (
          (await client.query('select pg_backend_pid() as pid')) as PgResult
        ).rows[0].pid;

        const inflight = client.query('select pg_sleep(5)').then(
          () => 'resolved',
          (e: any) => e.code ?? 'rejected',
        );
        await new Promise(r => setTimeout(r, 300));
        await killer.query('select pg_terminate_backend($1)', [pid]);

        const outcome = await inflight;
        assert.notStrictEqual(
          outcome,
          'resolved',
          'the query must not resolve',
        );
        client.release!();

        // The pool has to keep working for the next caller - `pg` recovers
        // here and so must this.
        await new Promise(r => setTimeout(r, 300));
        assert.strictEqual((await pool.query('select 42 as n')).rows[0].n, 42);
      } finally {
        await killer.end();
        await pool.end();
      }
    });

    it('does not raise a pool error the query already carries', async () => {
      // PostgreJS reports a dead pooled connection on the pool as well as
      // rejecting the in-flight query; `pg` only rejects the query. Left
      // alone, a TypeORM user gets a "Postgres pool raised an error" warning
      // that `pg` never produces.
      const pool = facadePool({ max: 2 });
      const killer = new ControlPool(liveConfig());
      const poolErrors: any[] = [];
      pool.on('error', e => poolErrors.push(e));
      try {
        const client = (await pool.connect()) as PgClient;
        const pid = (
          (await client.query('select pg_backend_pid() as pid')) as PgResult
        ).rows[0].pid;
        const inflight = client
          .query('select pg_sleep(5)')
          .catch(() => undefined);
        await new Promise(r => setTimeout(r, 300));
        await killer.query('select pg_terminate_backend($1)', [pid]);
        await inflight;
        client.release!();
        await new Promise(r => setTimeout(r, 500));
        assert.deepStrictEqual(
          poolErrors.map(e => e.code ?? e.message),
          [],
          'the query already reported this one',
        );
      } finally {
        await killer.end();
        await pool.end();
      }
    });
  });

  describe('pool counters', () => {
    it('reports waitingCount, which pg has and PostgreJS does not', async () => {
      const pool = facadePool({ max: 1 });
      try {
        assert.strictEqual(pool.waitingCount, 0);
      } finally {
        await pool.end();
      }
    });

    it('can be ended twice without throwing', async () => {
      const pool = new PgPool(liveConfig());
      await pool.query('select 1');
      await pool.end();
      await pool.end();
      assert.strictEqual(pool.ending, true);
    });
  });
});
