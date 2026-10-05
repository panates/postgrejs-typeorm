import assert from 'node:assert';
import { resolveFacadeOptions, toPoolConfiguration } from '../../src/config.js';

describe('toPoolConfiguration', () => {
  it('translates connectionString, which PostgreJS does not understand', () => {
    // The one that bites: PostgreJS takes a connection string as its first
    // argument or as `host`. `{ connectionString }` is silently ignored and
    // you land on localhost:5432/postgres - and connectionString is exactly
    // what TypeORM passes when the user configured a `url`.
    const cfg = toPoolConfiguration({
      connectionString: 'postgres://u:p@db.example.com:5433/app',
    });
    assert.strictEqual(cfg.host, 'postgres://u:p@db.example.com:5433/app');
  });

  it('prefers connectionString over host, as pg does', () => {
    const cfg = toPoolConfiguration({
      connectionString: 'postgres://db/app',
      host: 'ignored',
    });
    assert.strictEqual(cfg.host, 'postgres://db/app');
  });

  it('puts the pool sizes at the top level, not under a `pool` key', () => {
    // lightning-pool's options are merged into PostgreJS's PoolConfiguration,
    // so nesting them is accepted by JavaScript and silently does nothing.
    const cfg = toPoolConfiguration({ max: 25, min: 2 }) as any;
    assert.strictEqual(cfg.max, 25);
    assert.strictEqual(cfg.min, 2);
    assert.strictEqual(cfg.pool, undefined);
  });

  it("defaults max to pg's 10", () => {
    assert.strictEqual((toPoolConfiguration({}) as any).max, 10);
  });

  it('renames application_name and the connect timeout', () => {
    const cfg = toPoolConfiguration({
      application_name: 'svc',
      connectionTimeoutMillis: 1500,
    });
    assert.strictEqual(cfg.applicationName, 'svc');
    assert.strictEqual(cfg.connectTimeoutMs, 1500);
  });

  it('treats a 0 connect timeout as no timeout, as pg does', () => {
    assert.strictEqual(
      toPoolConfiguration({ connectionTimeoutMillis: 0 }).connectTimeoutMs,
      undefined,
    );
  });

  it('turns ssl: true into an empty options object', () => {
    assert.deepStrictEqual(toPoolConfiguration({ ssl: true }).ssl, {});
    const opts = { rejectUnauthorized: false };
    assert.strictEqual(toPoolConfiguration({ ssl: opts }).ssl, opts);
  });
});

describe('resolveFacadeOptions', () => {
  it('defaults to pg fidelity on every axis', () => {
    const o = resolveFacadeOptions({});
    assert.strictEqual(o.decoding, 'pg');
    assert.strictEqual(o.inferParameterTypes, false);
    assert.strictEqual(o.parseInputDatesAsUTC, false);
    assert.strictEqual(o.normalizeErrors, true);
    assert.strictEqual(o.suppressRedundantPoolError, true);
  });

  it('reads its options from the `postgrejs` key', () => {
    const o = resolveFacadeOptions({
      postgrejs: { decoding: 'native', inferParameterTypes: true },
    });
    assert.strictEqual(o.decoding, 'native');
    assert.strictEqual(o.inferParameterTypes, true);
  });

  it('leaves prepare unset so PostgreJS keeps its own default', () => {
    assert.strictEqual(resolveFacadeOptions({}).prepare, undefined);
    assert.strictEqual(
      resolveFacadeOptions({ postgrejs: { prepare: false } }).prepare,
      false,
    );
  });

  it('defaults the connection pass-through to an empty object', () => {
    assert.deepStrictEqual(resolveFacadeOptions({}).connection, {});
  });
});

/**
 * The translation is an allowlist, which is the right shape for turning `pg`
 * options into PostgreJS ones and the wrong shape for everything PostgreJS
 * has that `pg` has no name for. Those were unreachable until
 * `postgrejs.connection` existed - `asyncErrorHandling` is the one that was
 * noticed, and the point of these tests is that the next one is not.
 */
describe('toPoolConfiguration, the connection pass-through', () => {
  it('forwards a setting the pg options have no name for', () => {
    const cfg = toPoolConfiguration({
      postgrejs: { connection: { asyncErrorHandling: false } },
    });
    assert.strictEqual(cfg.asyncErrorHandling, false);
  });

  it('forwards every such setting, not a second allowlist of them', () => {
    const cfg = toPoolConfiguration({
      postgrejs: {
        connection: {
          asyncErrorHandling: false,
          timing: true,
          preparedStatementCacheSize: 8,
          keepAlive: false,
          schema: 'app',
          timezone: 'UTC',
        },
      },
    });
    assert.strictEqual(cfg.asyncErrorHandling, false);
    assert.strictEqual(cfg.timing, true);
    assert.strictEqual(cfg.preparedStatementCacheSize, 8);
    assert.strictEqual(cfg.keepAlive, false);
    assert.strictEqual(cfg.schema, 'app');
    assert.strictEqual(cfg.timezone, 'UTC');
  });

  it('changes nothing when it is not given', () => {
    assert.deepStrictEqual(
      toPoolConfiguration({ host: 'h', port: 1 }),
      toPoolConfiguration({ host: 'h', port: 1, postgrejs: {} }),
    );
  });

  /**
   * The type keeps the translated keys out, so this is about a JavaScript
   * caller who is not held to it: the translation has to win rather than the
   * pass-through, or one option would silently have two sources.
   */
  it('never lets a translated key win over the translation', () => {
    const cfg = toPoolConfiguration({
      host: 'real-host',
      port: 5432,
      max: 9,
      postgrejs: {
        connection: {
          host: 'ignored',
          port: 1234,
          max: 1,
        },
      } as any,
    });
    assert.strictEqual(cfg.host, 'real-host');
    assert.strictEqual(cfg.port, 5432);
    assert.strictEqual(cfg.max, 9);
  });
});
