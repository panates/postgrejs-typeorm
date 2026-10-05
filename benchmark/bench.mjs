/**
 * The runner: latency in this process, memory in a child per client, one
 * JSON file out. It renders nothing - `render-report.mjs` does that, from
 * the file, so wording can be iterated without re-measuring.
 *
 *   node benchmark/bench.mjs [read|write|control|all] [--latency] [--memory]
 *
 * Both passes default to on.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CONN,
  CONTROL,
  DRIVER,
  openDatabases,
  PREPARE,
  scenariosMatching,
  SCHEMA,
  seed,
} from './scenarios.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'heap-worker.mjs');

const median = a => {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

/**
 * The odds of winning `wins` of `n` alternated pairs if the two were
 * equally fast - a two-sided sign test, computed exactly.
 *
 * The medians alone are worth less than they look: on a shared machine the
 * absolute figures drift by more than the differences do. What does not
 * drift is *which* of the two won each pair, so that is counted
 * separately. It says the difference is real; it says nothing about its
 * size, which is what the median is for.
 */
const signTest = (wins, n) => {
  const k = Math.min(wins, n - wins);
  const lf = [0];
  for (let i = 1; i <= n; i++) lf[i] = lf[i - 1] + Math.log(i);
  let tail = 0;
  for (let i = 0; i <= k; i++)
    tail += Math.exp(lf[n] - lf[i] - lf[n - i] - n * Math.LN2);
  const p = Math.min(1, 2 * tail);
  return { wins, pairs: n, p };
};

/**
 * `level` on the sign test alone would never fire on the control row, and
 * that is a property of the clients rather than of the instrument: the
 * driver is a hair faster on every shape, so enough pairs always find it.
 * Measured on the same scan at three sizes, the win rate stayed near 60%
 * while the magnitude fell to -0.3%. So a difference under 5% is reported
 * as level however certain the sign test is of its direction, and the
 * certainty is kept in the file for a reader who wants it.
 *
 * 5% rather than something tighter because that is what the median itself
 * is worth on a 9 ms shape: the control read -1.5%, -6.4%, -0.3% and -4.6%
 * across four runs of the same scan. The control is not a threshold test.
 * What it says is that a shape the server dominates moves by a few percent
 * while a bulk read moves by forty - and a run where those two are the same
 * size is a run where the machine was measured, not the client.
 */
const verdict = ({ p }, ratio) => {
  if (Math.abs(ratio - 1) < 0.05) return 'level';
  if (p > 0.05) return 'level';
  return ratio < 1 ? 'faster' : 'slower';
};

async function latency(scenarios) {
  const out = {};
  for (const level of ['raw', 'orm']) {
    const inLevel = scenarios.filter(s => s.level === level);
    if (!inLevel.length) continue;
    for (const pooled of [false, true]) {
      const here = inLevel.filter(s => !!s.pooled === pooled);
      if (!here.length) continue;
      const opened = openDatabases(pooled, level);
      if (opened.ready) await opened.ready();
      for (const s of here) {
        /* **Collect between scenarios, or they contaminate each other.**
         *
         * `all 5000 rows` allocates some 7 MB a call. Run on its own it is
         * 1.44x and wins 61 of 61 in three rounds; run third in a process
         * that had just done 20 000 point reads it came out *slower*, 17 of
         * 61. Nothing about the workload changed - what changed is where the
         * collector was in its cycle when each side's turn came, and a
         * scenario large enough to trigger collections inherits whatever the
         * one before it left behind.
         *
         * The memory pass never had this problem: it is one child process per
         * client per scenario, for a related reason. This is the cheap
         * version of the same isolation - the heap starts each scenario in
         * the same place for both sides. Needs `--expose-gc`, and is skipped
         * without it rather than failing, since the pass still works.
         */
        globalThis.gc?.();
        globalThis.gc?.();

        // Warm both: the JIT, the pool, and the prepared statement each
        // distinct SQL earns on one of the two. Steady state is what is
        // being compared, not the first call.
        for (const db of Object.values(opened.dbs))
          for (let i = 0; i < Math.min(s.iters * 4, 60); i++)
            await s.run(db, i);

        const times = { [CONTROL]: [], [DRIVER]: [] };
        let wins = 0;
        for (let p = 0; p < s.pairs; p++) {
          const one = {};
          // Alternate inside the pair, so neither gets a warmer machine.
          for (const client of [CONTROL, DRIVER]) {
            const t = process.hrtime.bigint();
            for (let i = 0; i < s.iters; i++)
              await s.run(opened.dbs[client], p * s.iters + i);
            one[client] = Number(process.hrtime.bigint() - t) / 1e6 / s.iters;
            times[client].push(one[client]);
          }
          if (one[DRIVER] < one[CONTROL]) wins++;
        }
        const control = median(times[CONTROL]);
        const driver = median(times[DRIVER]);
        const sign = signTest(wins, s.pairs);
        out[s.name] = {
          ...out[s.name],
          name: s.name,
          group: s.group,
          level: s.level,
          note: s.note,
          iters: s.iters,
          msControl: control,
          msDriver: driver,
          ratio: driver / control,
          sign,
          verdict: verdict(sign, driver / control),
        };
        process.stderr.write(
          `  ${s.name.padEnd(28)} ${control.toFixed(3).padStart(9)} ${driver
            .toFixed(3)
            .padStart(9)}  ${wins}/${s.pairs}\n`,
        );
      }
      await opened.close();
    }
  }
  return out;
}

/**
 * One child per client per scenario, spawned one at a time - see the
 * worker's header for why it cannot share a process.
 *
 * `--trace-gc` is on so the parent can sum what each collection gave back
 * between the worker's two marks. That is a cross-check on the sampled
 * allocation figure, arrived at a completely different way, and it goes in
 * the file rather than into a column: it reports the JS heap only, so it
 * cannot see a Buffer and would flatter whichever side buffers more.
 */
/**
 * How many times each scenario's memory pass is run per client.
 *
 * One measurement each was what this did, and a single figure cannot say
 * whether a difference is real - which is the question the latency pass
 * answers with a sign test and the memory pass could not answer at all. Each
 * pair spawns both children with the order swapped, so neither side is always
 * the one that follows a cold start, and the wins are counted the same way.
 *
 * Seven rather than the fifteen next door, because each pair is two child
 * processes that each warm up from nothing: at 22 scenarios that is 308
 * spawns as it stands.
 *
 * **Seven buys a coarse answer, and it is the right coarseness here.** At
 * that count only 7/7 and 0/7 clear p < 0.05, so the test is really asking
 * "did it win every single pair" - and measured, every scenario but one is
 * exactly 7/7 or 0/7, because allocation is far steadier than the clock. The
 * one that is not, `uuid of 5k rows` at 6/7, is also the one whose
 * difference is 2%. Raise it with `--heap-pairs` when a row is close enough
 * that the difference between "every time" and "most times" is the question.
 */
const HEAP_PAIRS = Number(
  process.argv.find(a => a.startsWith('--heap-pairs='))?.split('=')[1] ?? 7,
);

/** One child, one client, one scenario - the measurement, without the pairing. */
async function measureInChild(scenario, client) {
  const { stdout } = await run(
    process.execPath,
    ['--expose-gc', '--trace-gc', WORKER, client, scenario],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const lines = stdout.trim().split('\n');
  // Not the last line: a collection can land after the worker prints, on its
  // way out, and `--trace-gc` writes to the same stream. Pick the line that
  // is the payload rather than assuming its position.
  const jsonLine = lines.findLast(l => l.startsWith('{'));
  if (!jsonLine)
    throw new Error(`worker printed no result for ${client} / ${scenario}`);
  const json = JSON.parse(jsonLine);

  // Sum what each collection between the worker's two marks gave back.
  // `--trace-gc` prints `before (heap) MB -> after (heap) MB`, so the
  // difference is the JS heap it reclaimed. This is the cross-check on the
  // sampled figure, arrived at a completely different way - and it stays in
  // the file rather than becoming a column, because it reports the JS heap
  // only and cannot see a Buffer.
  const at = l => Number(l.match(/]\s+(\d+) ms/)?.[1] ?? NaN);
  const from = at(lines.find(l => l.startsWith('MARK')) ?? '');
  const to = at(lines.find(l => l.startsWith('END')) ?? '');
  let tracedMb = 0;
  for (const line of lines) {
    const m = line.match(
      /(\d+(?:\.\d+)?) \(\d+(?:\.\d+)?\) MB -> (\d+(?:\.\d+)?) \(/,
    );
    if (!m) continue;
    const when = at(line);
    if (when < from || when > to) continue;
    tracedMb += Number(m[1]) - Number(m[2]);
  }
  return { ...json, tracedPerCallKb: (tracedMb * 1024) / json.iterations };
}

/**
 * The memory pass, paired the way the latency pass is.
 *
 * One child per client per pair, with the order swapped on alternate pairs so
 * neither side is always the one that follows a cold start, and the wins
 * counted on **allocation per call** - the column the report leads with. The
 * high-water is counted separately because the two rank the clients
 * differently on purpose: a client that allocates a third as much can sit
 * higher for reaching the collector's threshold a third as often.
 */
async function memory(scenarios) {
  const out = {};
  for (const s of scenarios) {
    const runs = { [CONTROL]: [], [DRIVER]: [] };
    let allocWins = 0;
    let sustainedWins = 0;
    for (let pair = 0; pair < HEAP_PAIRS; pair++) {
      const order = pair % 2 ? [DRIVER, CONTROL] : [CONTROL, DRIVER];
      const measured = {};
      for (const client of order)
        measured[client] = await measureInChild(s.name, client);
      for (const client of [CONTROL, DRIVER])
        runs[client].push(measured[client]);
      if (measured[DRIVER].allocPerCallKb < measured[CONTROL].allocPerCallKb)
        allocWins++;
      if (measured[DRIVER].sustainedKb < measured[CONTROL].sustainedKb)
        sustainedWins++;
    }
    const fold = client => {
      const all = runs[client];
      const pick = key => median(all.map(r => r[key]));
      return {
        ...all[0],
        allocPerCallKb: pick('allocPerCallKb'),
        allocLoKb: Math.min(...all.map(r => r.allocPerCallKb)),
        allocHiKb: Math.max(...all.map(r => r.allocPerCallKb)),
        heldKb: pick('heldKb'),
        sustainedKb: pick('sustainedKb'),
        sustainedRssKb: pick('sustainedRssKb'),
        wireKb: pick('wireKb'),
        wireOutKb: pick('wireOutKb'),
        tracedPerCallKb: pick('tracedPerCallKb'),
      };
    };
    out[s.name] = {
      [CONTROL]: fold(CONTROL),
      [DRIVER]: fold(DRIVER),
      heapPairs: HEAP_PAIRS,
      heapWins: allocWins,
      heapSign: signTest(allocWins, HEAP_PAIRS),
      sustainedWins,
    };
    process.stderr.write(
      `  ${s.name.padEnd(30)} ${out[s.name][CONTROL].allocPerCallKb
        .toFixed(1)
        .padStart(9)} ${out[s.name][DRIVER].allocPerCallKb
        .toFixed(1)
        .padStart(9)} KB/call  ${allocWins}/${HEAP_PAIRS}\n`,
    );
  }
  return out;
}

/** What a client holds at rest, asked twice - see the worker's header. */
async function held(scenarios) {
  const out = {};
  for (const s of scenarios) {
    out[s.name] = {};
    for (const client of [CONTROL, DRIVER]) {
      const { stdout } = await run(
        process.execPath,
        ['--expose-gc', WORKER, client, s.name, 'idle'],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      out[s.name][client] = JSON.parse(stdout.trim().split('\n').pop());
    }
  }
  return out;
}

/**
 * The mechanisms, isolated: the driver against *itself* with one thing
 * turned off, so what the scenario tables show can be attributed rather
 * than guessed at.
 *
 * Same alternation and same sign test as everything else. A mechanism that
 * cannot win its own A/B does not belong in the explanation - which is the
 * whole reason this pass exists, because the wire format could not, on the
 * shapes this harness had before the packed ones were added.
 */
async function mechanisms() {
  const facade = await import('../build/index.js');
  const out = {};
  const cases = {
    'prepared statements': {
      note: 'the same parameterized read, against `prepare: false`',
      off: { ...CONN, max: 4, postgrejs: { prepare: false } },
      on: { ...CONN, max: 4 },
      run: p => p.query(`select * from ${SCHEMA}.rows where id = $1`, [1234]),
      pairs: 401,
      iters: 10,
    },
  };
  for (const [name, c] of Object.entries(cases)) {
    const off = new facade.Pool(c.off);
    const on = new facade.Pool(c.on);
    for (const p of [off, on]) for (let i = 0; i < 40; i++) await c.run(p);
    const t = { off: [], on: [] };
    let wins = 0;
    for (let k = 0; k < c.pairs; k++) {
      const one = {};
      for (const [key, pool] of [
        ['off', off],
        ['on', on],
      ]) {
        const at = process.hrtime.bigint();
        for (let i = 0; i < c.iters; i++) await c.run(pool);
        one[key] = Number(process.hrtime.bigint() - at) / 1e6 / c.iters;
        t[key].push(one[key]);
      }
      if (one.on < one.off) wins++;
    }
    const a = median(t.off);
    const b = median(t.on);
    out[name] = {
      name,
      note: c.note,
      msWithout: a,
      msWith: b,
      ratio: b / a,
      sign: signTest(wins, c.pairs),
    };
    process.stderr.write(
      `  ${name.padEnd(28)} ${a.toFixed(3).padStart(9)} ${b.toFixed(3).padStart(9)}  ${wins}/${c.pairs}\n`,
    );
    await off.end();
    await on.end();
  }
  return out;
}

const args = process.argv.slice(2);
const which = args.find(a => !a.startsWith('--')) ?? 'all';
const doLatency = !args.includes('--memory') || args.includes('--latency');
const doMemory = !args.includes('--latency') || args.includes('--memory');
const doMechanisms =
  args.includes('--mechanisms') ||
  (!args.includes('--latency') && !args.includes('--memory'));
const scenarios = scenariosMatching(which);

await seed();

/**
 * A pass that was not asked for keeps what the last run measured.
 *
 * The two passes take tens of minutes between them and are usually run one
 * at a time, so a partial run that replaced the file would silently drop
 * the other half - which it did once, and the renderer printed empty
 * tables rather than complaining.
 */
const previous = (() => {
  try {
    return JSON.parse(
      readFileSync(join(HERE, 'results', 'latest.json'), 'utf8'),
    );
  } catch {
    return { scenarios: {} };
  }
})();

/**
 * A scenario that no longer exists is dropped, however narrow the pass.
 *
 * The merge above is what keeps a `--latency` run from discarding the memory
 * half, and the same line kept a deleted scenario alive in the file - the
 * renderer went on printing a row for a workload nobody could re-measure.
 * Pruning against the whole SCENARIOS list rather than against this run's
 * selection is what makes it safe: a scenario left out of `bench.mjs read`
 * is still declared, and stays.
 */
const declared = new Set(scenariosMatching('all').map(s => s.name));
for (const name of Object.keys(previous.scenarios ?? {}))
  if (!declared.has(name)) delete previous.scenarios[name];

const results = {
  ...previous,
  measuredAt: new Date().toISOString(),
  node: process.version,
  prepare: PREPARE,
  heapPairs: HEAP_PAIRS,
  control: CONTROL,
  driver: DRIVER,
  versions: {},
  scenarios: { ...previous.scenarios },
};
for (const p of ['pg', 'postgrejs', 'typeorm'])
  results.versions[p] = JSON.parse(
    await import('node:fs/promises').then(fs =>
      fs.readFile(`node_modules/${p}/package.json`, 'utf8'),
    ),
  ).version;
{
  const pool = new (await import('pg')).Pool(CONN);
  results.versions.postgresql = (
    await pool.query('select version()')
  ).rows[0].version.split(' ')[1];
  await pool.end();
}

if (doLatency) {
  process.stderr.write('\n== latency\n');
  const l = await latency(scenarios);
  for (const [name, v] of Object.entries(l))
    results.scenarios[name] = { ...results.scenarios[name], ...v };
}
if (doMemory) {
  process.stderr.write('\n== memory\n');
  const m = await memory(scenarios);
  const h = await held(scenarios.filter(s => s.group !== 'Control'));
  for (const [name, v] of Object.entries(m))
    results.scenarios[name] = {
      ...results.scenarios[name],
      name,
      memory: v,
      held: h[name],
    };
}

if (doMechanisms) {
  process.stderr.write('\n== mechanisms\n');
  results.mechanisms = await mechanisms();
}

mkdirSync(join(HERE, 'results'), { recursive: true });
const file = join(HERE, 'results', 'latest.json');
writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
process.stderr.write(`\nwrote ${file}\n`);
