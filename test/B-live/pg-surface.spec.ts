import assert from 'node:assert';
import { Pool as ControlPool } from 'pg';
import { DataTypeOIDs } from 'postgrejs';
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

  describe('the query-config object', () => {
    // `pg` takes `{text, values}` as well as `(text, values)`, and TypeORM
    // uses the positional form everywhere - so this is knex's path, and the
    // one a coverage report finds because nothing else here takes it.
    it('reads values off the config object', async () => {
      const pool = facadePool();
      try {
        const r = await pool.query({
          text: 'select $1::int as n',
          values: [7],
        } as any);
        assert.strictEqual(r.rows[0].n, 7);
      } finally {
        await pool.end();
      }
    });
  });

  describe('several results from one string', () => {
    // `pg` returns a bare **array** of results for a multi-statement string
    // and a single result otherwise. Both arms matter: unwrapping the
    // one-result case is what a caller reading `r.rows` depends on.
    it('gives an array, one entry per command', async () => {
      const pool = facadePool();
      const client = (await pool.connect()) as PgClient;
      try {
        const r = (await client.query(
          'select 1 as a; select 2 as b',
        )) as unknown as PgResult[];
        assert.ok(
          Array.isArray(r),
          'a multi-statement string answers with an array',
        );
        assert.strictEqual(r.length, 2);
        assert.deepStrictEqual(
          r.map(x => x.rows),
          [[{ a: 1 }], [{ b: 2 }]],
        );
      } finally {
        client.release!();
        await pool.end();
      }
    });

    it('unwraps the single-command case', async () => {
      const pool = facadePool();
      const client = (await pool.connect()) as PgClient;
      try {
        const r = (await client.query('select 1 as a;')) as PgResult;
        assert.ok(!Array.isArray(r));
        assert.deepStrictEqual(r.rows, [{ a: 1 }]);
      } finally {
        client.release!();
        await pool.end();
      }
    });

    it('unwraps it on the simple protocol too', async () => {
      // A leading semicolon is an empty statement, which the extended
      // protocol refuses with 42601 - so this takes the fallback and comes
      // out of it with exactly one result. Same arm, different route, and
      // the only way to reach that one.
      const pool = facadePool();
      const client = (await pool.connect()) as PgClient;
      try {
        const r = (await client.query(';select 1 as a')) as PgResult;
        assert.ok(!Array.isArray(r));
        assert.deepStrictEqual(r.rows, [{ a: 1 }]);
        assert.strictEqual(r.command, 'SELECT');
      } finally {
        client.release!();
        await pool.end();
      }
    });
  });

  describe('the two ways out of the facade', () => {
    // Both are documented escape hatches and neither is on TypeORM's path,
    // so nothing else here reaches them.
    it('exposes the backend pid under pg spelling', async () => {
      const pool = facadePool();
      const client = (await pool.connect()) as PgClient;
      try {
        const reported = client.processID;
        const asked = (
          (await client.query('select pg_backend_pid() as pid')) as PgResult
        ).rows[0].pid;
        assert.strictEqual(reported, asked, 'and it has to be the real one');
      } finally {
        client.release!();
        await pool.end();
      }
    });

    it('hands out the PostgreJS connection underneath', async () => {
      const pool = facadePool();
      const client = (await pool.connect()) as PgClient;
      try {
        const r = await client.connection.query('select 1 as n', {
          objectRows: true,
        });
        assert.strictEqual(r.rows![0].n, 1);
      } finally {
        client.release!();
        await pool.end();
      }
    });
  });

  describe('extra fetchAsString OIDs from the caller', () => {
    it('appends them to the list the pg mode already uses', async () => {
      // `float8` is not in the built-in list - `pg` parses it to a number and
      // so does PostgreJS - so asking for it is visibly the caller's doing,
      // and the built-ins have to survive alongside.
      const pool = facadePool({
        postgrejs: { fetchAsString: [DataTypeOIDs.float8] },
      });
      try {
        const r = await pool.query(
          `select '1.5'::float8 as f, '9007199254740993'::int8 as i`,
        );
        assert.strictEqual(r.rows[0].f, '1.5', "the caller's OID");
        assert.strictEqual(
          r.rows[0].i,
          '9007199254740993',
          'and the built-in list is still there',
        );
      } finally {
        await pool.end();
      }
    });
  });

  describe("the events pg's Client emits", () => {
    // Relayed from the PostgreJS connection, and none of them is on TypeORM's
    // path - it listens for 'error' on the pool and nothing on the client. A
    // consumer doing LISTEN/NOTIFY, or logging server notices, needs all
    // three, so they are tested here rather than left to a first user.
    it("relays a server NOTICE to 'notice'", async () => {
      const pool = facadePool();
      const client = (await pool.connect()) as PgClient;
      const notices: any[] = [];
      client.on('notice', m => notices.push(m));
      try {
        await client.query(
          `do $$ begin raise notice 'hello from plpgsql'; end $$;`,
        );
        await new Promise(r => setTimeout(r, 200));
        assert.strictEqual(notices.length, 1, 'exactly one notice');
        assert.match(
          String(notices[0].message ?? notices[0]),
          /hello from plpgsql/,
        );
      } finally {
        client.release!();
        await pool.end();
      }
    });

    it("relays LISTEN/NOTIFY to 'notification'", async () => {
      const pool = facadePool({ max: 2 });
      const listener = (await pool.connect()) as PgClient;
      const notifications: any[] = [];
      listener.on('notification', m => notifications.push(m));
      try {
        await listener.query('listen facade_channel');
        const sender = (await pool.connect()) as PgClient;
        await sender.query(`notify facade_channel, 'payload here'`);
        sender.release!();
        await new Promise(r => setTimeout(r, 300));
        assert.strictEqual(notifications.length, 1);
        assert.strictEqual(notifications[0].channel, 'facade_channel');
        assert.strictEqual(notifications[0].payload, 'payload here');
      } finally {
        listener.release!();
        await pool.end();
      }
    });

    it("does NOT relay a dying connection to 'error' - pg does", async () => {
      // A divergence, recorded rather than worked around. `pg`'s Client
      // rejects the in-flight query with 57P01 *and* emits 'error' on the
      // client; PostgreJS's Connection rejects with 08006 and emits 'close',
      // with no 'error' at all - so the facade's relay has nothing to relay.
      // It matters because `pg`'s own docs tell a caller to attach
      // `client.on('error')` precisely for this, and here it never fires.
      //
      // The relay stays: it is right for any 'error' the connection does
      // emit, and it starts working the day this is closed - at which point
      // this test fails and has to be rewritten. Reported in
      // `../postgrejs/.claude/connection-error-event.md`.
      const pool = facadePool({ max: 2 });
      const killer = new ControlPool(liveConfig());
      const client = (await pool.connect()) as PgClient;
      const errors: any[] = [];
      const closes: any[] = [];
      client.on('error', e => errors.push(e));
      client.connection.on('close', () => closes.push('close'));
      try {
        const pid = (
          (await client.query('select pg_backend_pid() as pid')) as PgResult
        ).rows[0].pid;
        const inflight = client.query('select pg_sleep(5)').then(
          () => 'resolved',
          (e: any) => e.code,
        );
        await new Promise(r => setTimeout(r, 300));
        await killer.query('select pg_terminate_backend($1)', [pid]);
        assert.strictEqual(
          await inflight,
          '08006',
          'the query still reports it',
        );
        await new Promise(r => setTimeout(r, 500));
        assert.deepStrictEqual(
          errors,
          [],
          "nothing reaches client.on('error')",
        );
        assert.deepStrictEqual(
          closes,
          ['close'],
          "'close' is what arrives instead",
        );
      } finally {
        client.release!();
        await killer.end();
        await pool.end();
      }
    });
  });

  describe('normalizeErrors: false', () => {
    // On by default, and the off arm is a documented option nothing else
    // here takes - so `pg`'s two cosmetic divergences come back.
    it('leaves the caret diagram and the numeric position alone', async () => {
      const pool = facadePool({ postgrejs: { normalizeErrors: false } });
      try {
        await assert.rejects(
          () => pool.query('select * from no_such_raw_error'),
          (e: any) => {
            assert.strictEqual(e.code, '42P01');
            assert.notStrictEqual(
              typeof e.position,
              'string',
              'pg renders position as a string; raw leaves it as it came',
            );
            return true;
          },
        );
      } finally {
        await pool.end();
      }
    });

    it('passes a pool error through unnormalised too', async () => {
      const pool = facadePool({
        max: 2,
        postgrejs: {
          normalizeErrors: false,
          suppressRedundantPoolError: false,
        },
      });
      const killer = new ControlPool(liveConfig());
      const errors: any[] = [];
      pool.on('error', e => errors.push(e));
      try {
        const client = (await pool.connect()) as PgClient;
        const pid = (
          (await client.query('select pg_backend_pid() as pid')) as PgResult
        ).rows[0].pid;
        client.release!();
        await killer.query('select pg_terminate_backend($1)', [pid]);
        await new Promise(r => setTimeout(r, 1500));
        assert.deepStrictEqual(
          errors.map(e => e.code),
          ['08006'],
        );
      } finally {
        await killer.end();
        await pool.end();
      }
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
