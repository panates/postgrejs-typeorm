import assert from 'node:assert';
import pgUtils from 'pg/lib/utils.js';
import { prepareValue } from '../../src/prepare-value.js';
import { toPgResult } from '../../src/result.js';
import { isSubmittable, streamFromSubmittable } from '../../src/stream.js';

const pgPrepare = (pgUtils as any).prepareValue as (v: any) => any;

/**
 * Branches nothing else reaches. Written from a coverage report rather than
 * from a failure, and kept separate from the behavioural specs because
 * that is what they are: the second half of an `if`, the null arm of a map,
 * the path a caller takes only when something has already gone wrong.
 */
describe('edge branches', () => {
  describe('prepareValue, west of Greenwich', () => {
    // `dateToString` writes the sign of the local UTC offset, and only one
    // arm of that runs on any given machine. The tests elsewhere run at
    // whatever the developer's zone is; this one forces the other.
    const withTZ = (tz: string, fn: () => void) => {
      const before = process.env.TZ;
      process.env.TZ = tz;
      try {
        fn();
      } finally {
        if (before === undefined) delete process.env.TZ;
        else process.env.TZ = before;
      }
    };

    for (const [label, tz] of [
      ['a negative offset', 'America/New_York'],
      ['a positive offset', 'Asia/Tokyo'],
      ['no offset', 'UTC'],
      ['a half-hour offset', 'Asia/Kolkata'],
    ] as const) {
      it(`renders ${label} exactly as pg does`, () => {
        withTZ(tz, () => {
          const d = new Date('2024-03-05T06:07:08.900Z');
          // Both sides read the same process zone, so pg stays the oracle
          // here rather than a hard-coded string that would encode one zone.
          assert.strictEqual(prepareValue(d), pgPrepare(d));
        });
      });
    }

    it('renders a BC year as pg does', () => {
      const d = new Date(Date.UTC(-1, 0, 1));
      assert.strictEqual(prepareValue(d), pgPrepare(d));
    });
  });

  describe('toPgResult with no command', () => {
    it('leaves command undefined rather than inventing one', () => {
      const r = toPgResult({ rows: [], fields: [] } as any, true);
      assert.strictEqual(r.command, undefined);
      assert.strictEqual(r.commandTag, undefined);
    });
  });

  describe('stream', () => {
    it('recognises a submittable by its submit method', () => {
      assert.strictEqual(isSubmittable({ submit() {} }), true);
      assert.strictEqual(isSubmittable({}), false);
      assert.strictEqual(isSubmittable(null), false);
      assert.strictEqual(isSubmittable('select 1'), false);
    });

    it('reads a submittable that carries text itself, not under .cursor', () => {
      // pg-query-stream puts them on `.cursor`; the protocol only requires
      // `submit`, so a hand-rolled submittable may not.
      let asked: string | undefined;
      const connection: any = {
        query(text: string) {
          asked = text;
          return Promise.resolve({ cursor: { next: async () => undefined } });
        },
      };
      const stream = streamFromSubmittable(
        connection,
        { submit() {}, text: 'select 1', values: [] } as any,
        {},
      );
      return new Promise<void>((ok, fail) => {
        stream.on('data', () => undefined);
        stream.on('end', () => {
          try {
            assert.strictEqual(asked, 'select 1');
            ok();
          } catch (e) {
            fail(e);
          }
        });
        stream.on('error', fail);
      });
    });

    it('destroys cleanly before the cursor has been opened', () => {
      // `_read` is what opens it, so a stream destroyed first has no cursor
      // to close - and calling close() on undefined would throw inside
      // destroy(), where it is hardest to see.
      const connection: any = {
        query: () => Promise.reject(new Error('should not be reached')),
      };
      const stream = streamFromSubmittable(
        connection,
        { submit() {}, cursor: { text: 'select 1', values: [] } } as any,
        {},
      );
      return new Promise<void>((ok, fail) => {
        stream.on('error', fail);
        stream.on('close', ok);
        stream.destroy();
      });
    });

    it('surfaces an error raised while opening the cursor', () => {
      const connection: any = {
        query: () =>
          Promise.reject(Object.assign(new Error('nope'), { code: '42P01' })),
      };
      const stream = streamFromSubmittable(
        connection,
        { submit() {}, cursor: { text: 'select 1', values: [] } } as any,
        {},
      );
      return new Promise<void>((ok, fail) => {
        stream.on('data', () => undefined);
        stream.on('error', (e: any) => {
          try {
            assert.strictEqual(e.code, '42P01');
            ok();
          } catch (err) {
            fail(err);
          }
        });
        stream.on('end', () => fail(new Error('expected an error')));
      });
    });

    it('closes the cursor when the reader goes away mid-stream', async () => {
      let closed = false;
      let handed = 0;
      const connection: any = {
        query: () =>
          Promise.resolve({
            cursor: {
              next: async () => ({ n: ++handed }),
              close: async () => {
                closed = true;
              },
            },
          }),
      };
      const stream = streamFromSubmittable(
        connection,
        { submit() {}, cursor: { text: 'select 1', values: [] } } as any,
        {},
      );
      await new Promise<void>(ok => {
        stream.once('data', () => {
          stream.destroy();
          stream.once('close', ok);
        });
      });
      assert.ok(closed, 'the cursor has to be closed or the portal leaks');
    });
  });
});
