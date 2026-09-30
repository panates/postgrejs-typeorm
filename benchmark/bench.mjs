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
async function memory(scenarios) {
  const out = {};
  for (const s of scenarios) {
    out[s.name] = {};
    for (const client of [CONTROL, DRIVER]) {
      const { stdout } = await run(
        process.execPath,
        ['--expose-gc', '--trace-gc', WORKER, client, s.name],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const lines = stdout.trim().split('\n');
      // Not the last line: a collection can land after the worker prints,
      // on its way out, and `--trace-gc` writes to the same stream. Pick
      // the line that is the payload rather than assuming its position.
      const jsonLine = lines.findLast(l => l.startsWith('{'));
      if (!jsonLine)
        throw new Error(`worker printed no result for ${client} / ${s.name}`);
      const json = JSON.parse(jsonLine);

      // Sum what each collection between the worker's two marks gave back.
      // `--trace-gc` prints `before (heap) MB -> after (heap) MB`, so the
      // difference is the JS heap it reclaimed. This is the cross-check on
      // the sampled figure, arrived at a completely different way - and it
      // stays in the file rather than becoming a column, because it reports
      // the JS heap only and cannot see a Buffer.
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
      out[s.name][client] = {
        ...json,
        tracedPerCallKb: (tracedMb * 1024) / json.iterations,
      };
      process.stderr.write(
        `  ${s.name.padEnd(28)} ${client.padEnd(18)} ${json.allocPerCallKb
          .toFixed(1)
          .padStart(10)} KB/call\n`,
      );
    }
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

const args = process.argv.slice(2);
const which = args.find(a => !a.startsWith('--')) ?? 'all';
const doLatency = !args.includes('--memory') || args.includes('--latency');
const doMemory = !args.includes('--latency') || args.includes('--memory');
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

const results = {
  ...previous,
  measuredAt: new Date().toISOString(),
  node: process.version,
  prepare: PREPARE,
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

mkdirSync(join(HERE, 'results'), { recursive: true });
const file = join(HERE, 'results', 'latest.json');
writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
process.stderr.write(`\nwrote ${file}\n`);
