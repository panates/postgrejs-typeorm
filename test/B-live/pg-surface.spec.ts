import assert from 'node:assert';
import { defaults, PgClient, type PgResult } from '../../src/index.js';
import { facadePool, liveConfig } from '../_support/live.js';

/**
 * The members of `pg`'s surface that nothing else here reaches.
 *
 * `doc/DRIVER-DESIGN.md` §2 counts eighteen, and calls that count the
 * specification. Several of them had no test of their own until this file:
 * the callback form of `query()` (which TypeORM uses for the extension
 * installer), the standalone `Client` (which is knex's entry point rather
 * than TypeORM's), `defaults.parseInt8`, and `end()` on both kinds of client.
 *
 * Found by reading a coverage report rather than by anything failing, which
 * is the argument for looking at one: an untested member of a checklist that
 * is itself the specification.
 */
describe('B-live: the pg surface that nothing else exercises', () => {
  describe('query() in callback form', () => {
    // Member 10. `PostgresDriver.executeQuery()` uses this to install
    // extensions during afterConnect(), so it is on TypeORM's path - just
    // not on the path any other test here takes.
    it('calls back with a result', async () => {
      const pool = facadePool();
      const client = (await pool.connect()) as PgClient;
      try {
        const r = await new Promise<PgResult>((ok, fail) => {
          client.query('select 1 as n', (err: any, res?: any) =>
            err ? fail(err) : ok(res),
          );
        });
        assert.strictEqual(r.rows[0].n, 1);
      } finally {
        client.release!();
        await pool.end();
      }
    });

    it('calls back with parameters', async () => {
      const pool = facadePool();
      const client = (await pool.connect()) as PgClient;
      try {
        const r = await new Promise<PgResult>((ok, fail) => {
          client.query('select $1::int as n', [7], (err: any, res?: any) =>
            err ? fail(err) : ok(res),
          );
        });
        assert.strictEqual(r.rows[0].n, 7);
      } finally {
        client.release!();
        await pool.end();
      }
    });

    it('calls back with an error rather than rejecting', async () => {
      const pool = facadePool();
      const client = (await pool.connect()) as PgClient;
      try {
        const err = await new Promise<any>(ok => {
          client.query('select * from no_such_table_cb', (e: any) => ok(e));
        });
        assert.strictEqual(err.code, '42P01');
        // Normalised the same way the promise form is.
        assert.ok(!err.message.includes('^'), 'the caret diagram is stripped');
      } finally {
        client.release!();
        await pool.end();
      }
    });
  });

  describe('the standalone Client', () => {
    // knex constructs one of these directly - `new driver.Client(settings)`
    // then `client.connect()` - where TypeORM only ever takes them from a
    // pool. Both lifecycles have to work.
    it('connects, queries and ends', async () => {
      const client = new PgClient(liveConfig());
      await client.connect();
      const r = (await client.query('select 1 as n')) as PgResult;
      assert.strictEqual(r.rows[0].n, 1);
      await client.end();
    });

    it('supports the callback form of connect and end', async () => {
      const client = new PgClient(liveConfig());
      await new Promise<void>((ok, fail) =>
        client.connect(e => (e ? fail(e) : ok())),
      );
      const r = (await client.query('select 2 as n')) as PgResult;
      assert.strictEqual(r.rows[0].n, 2);
      await new Promise<void>((ok, fail) =>
        client.end(e => (e ? fail(e) : ok())),
      );
    });

    it('emits end', async () => {
      const client = new PgClient(liveConfig());
      await client.connect();
      let ended = 0;
      client.on('end', () => ended++);
      await client.end();
      assert.strictEqual(ended, 1);
    });

    it('is a no-op to connect twice', async () => {
      const client = new PgClient(liveConfig());
      await client.connect();
      await client.connect();
      assert.ok(((await client.query('select 1 as n')) as PgResult).rows[0].n);
      await client.end();
    });
  });

  describe('end() on a pooled client releases rather than closing', () => {
    it('gives the connection back to the pool', async () => {
      // Ending the socket under the pool would strand the connection. A pool
      // of one checked out twice is what shows it came back.
      const pool = facadePool({ max: 1 });
      try {
        const first = (await pool.connect()) as PgClient;
        await first.end();
        const second = (await pool.connect()) as PgClient;
        assert.ok(
          ((await second.query('select 1 as n')) as PgResult).rows[0].n,
        );
        second.release!();
      } finally {
        await pool.end();
      }
    });
  });

  describe('pool.query()', () => {
    // Not used by TypeORM, which always checks a connection out. knex reaches
    // for it when wrapping a native pool.
    it('runs a statement and gives the connection straight back', async () => {
      const pool = facadePool({ max: 1 });
      try {
        for (let i = 0; i < 3; i++) {
          const r = await pool.query('select $1::int as n', [i]);
          assert.strictEqual(r.rows[0].n, i);
        }
      } finally {
        await pool.end();
      }
    });

    it('releases the connection even when the statement fails', async () => {
      const pool = facadePool({ max: 1 });
      try {
        await assert.rejects(() => pool.query('select * from no_such_pq'));
        // The pool is one connection wide; this only works if the failed
        // call gave its connection back.
        assert.ok((await pool.query('select 1 as n')).rows[0].n);
      } finally {
        await pool.end();
      }
    });

    it('reports ending after end()', async () => {
      const pool = facadePool();
      assert.strictEqual(pool.ending, false);
      await pool.end();
      assert.strictEqual(pool.ending, true);
    });
  });

  describe('defaults.parseInt8', () => {
    // Module member 2. TypeORM assigns it only after checking that the
    // property has a setter:
    //   Object.getOwnPropertyDescriptor(this.postgres.defaults, 'parseInt8')?.set
    // and logs "this option will be ignored" when it does not. The setter
    // exists so that check passes; the value is inert because int8 is decided
    // per query here, not by a process-wide global.
    it('has a setter, which is what TypeORM checks for', () => {
      const d = Object.getOwnPropertyDescriptor(defaults, 'parseInt8');
      assert.strictEqual(typeof d?.set, 'function');
      assert.strictEqual(typeof d?.get, 'function');
      assert.strictEqual(d?.enumerable, true);
    });

    it('round-trips a value without changing what int8 decodes to', async () => {
      const before = defaults.parseInt8;
      defaults.parseInt8 = true;
      assert.strictEqual(defaults.parseInt8, true);
      const pool = facadePool();
      try {
        // Still a string: the facade answers int8 through fetchAsString per
        // query, so the global cannot reach it.
        const r = await pool.query(`select '9007199254740993'::int8 as n`);
        assert.strictEqual(typeof r.rows[0].n, 'string');
      } finally {
        defaults.parseInt8 = before;
        await pool.end();
      }
    });
  });
});
