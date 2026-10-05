/**
 * Reads `results/latest.json` and writes `doc/BENCHMARKS.md`. It runs
 * nothing.
 *
 * That separation is the point: a measurement takes tens of minutes and
 * the wording gets iterated a dozen times, so the two must not be the same
 * command. Re-run this against a measurement taken hours ago as often as
 * the prose needs it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const r = JSON.parse(
  readFileSync(join(HERE, 'results', 'latest.json'), 'utf8'),
);
const rows = Object.values(r.scenarios);

const ms = v => `${v.toFixed(3)} ms`;
/** Always with its unit and always per call - a bare total misleads. */
const kb = v =>
  v >= 1024 ? `${(v / 1024).toFixed(1)} MB` : `${Math.round(v)} KB`;
const speedup = v => `${(1 / v).toFixed(2)}x`;
/**
 * Capped, because an exponent past 18 is precision the instrument does not
 * have: it is the odds of a coin landing that way, not of the difference
 * being that size, and the machine underneath is shared.
 */
const odds = p =>
  p > 0.05
    ? 'not significant'
    : `< 1 in 10^${Math.min(18, Math.max(1, Math.floor(-Math.log10(p))))}`;
const pct = v => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;

const memRatio = s =>
  s.memory
    ? s.memory[r.driver].allocPerCallKb / s.memory[r.control].allocPerCallKb
    : undefined;

const bold = (text, yes) => (yes ? `**${text}**` : text);

function table(list) {
  const head = [
    `| Scenario | \`${r.control}\`<br>allocated per call | \`${r.driver}\`<br>allocated per call | |`,
    '| --- | --- | --- | --- |',
  ];
  const body = list.map(s => {
    const a = s.memory?.[r.control].allocPerCallKb;
    const b = s.memory?.[r.driver].allocPerCallKb;
    const mr = memRatio(s);
    const faster = s.ratio < 1;
    const lessMem = mr !== undefined && mr < 0.97;
    const moreMem = mr !== undefined && mr > 1.03;
    const memCell =
      mr === undefined
        ? ''
        : `<br>${bold(pct(mr - 1), lessMem)}${!lessMem && !moreMem ? ' level' : ''}`;
    return (
      `| ${s.name} - ${s.note} ` +
      `| ${bold(ms(s.msControl), !faster)}${a === undefined ? '' : `<br>${bold(`${kb(a)}/call`, !lessMem && !moreMem ? false : !lessMem)}`} ` +
      `| ${bold(ms(s.msDriver), faster)}${b === undefined ? '' : `<br>${bold(`${kb(b)}/call`, lessMem)}`} ` +
      `| ${bold(speedup(s.ratio), s.verdict !== 'level')}${s.verdict === 'level' ? ' level' : ''}${memCell} |`
    );
  });
  return [...head, ...body].join('\n');
}

const pick = (group, level) =>
  rows.filter(s => s.group === group && s.level === level);

/**
 * The rows that win on **both** columns, which is what "large payload"
 * means here. Selecting on the clock alone pulls in the spread half of the
 * float8 pair, which the next paragraph then calls close on memory - two
 * sentences each correct about their own column and contradicting each
 * other together.
 */
const payloadWins = list =>
  [...list]
    .filter(
      s => s.ratio < 0.7 && memRatio(s) !== undefined && memRatio(s) < 0.5,
    )
    .sort((a, b) => a.ratio - b.ratio);

/**
 * A held figure below the baseline is not a negative quantity - it is a
 * process that ended holding less than it started with, because the
 * collector reached something the baseline had counted. Print what that
 * means rather than a minus sign.
 */
const heldCell = v => (v < 32 ? '≈0' : kb(v));

/**
 * The prose is grouped by what a column says, not by the clock. A
 * paragraph that picks its examples on the time ratio will list a row the
 * next paragraph calls level on memory, and both sentences are correct
 * about their own column while contradicting each other together.
 */
const payloads = payloadWins(rows.filter(s => s.group !== 'Control'));
const clockWins = payloads
  .map(s => `**${s.name}** ${speedup(s.ratio)}`)
  .join(', ');
const memWins = [...payloads]
  .sort((a, b) => memRatio(a) - memRatio(b))
  .map(
    s =>
      `**${s.name}** ${kb(s.memory[r.driver].allocPerCallKb)}/call against ${kb(s.memory[r.control].allocPerCallKb)}`,
  )
  .join(', ');
const memLosses = rows
  .filter(s => s.memory && memRatio(s) > 1.03)
  .sort((a, b) => memRatio(b) - memRatio(a))
  .map(
    s =>
      `**${s.name}** ${kb(s.memory[r.driver].allocPerCallKb)} against ${kb(s.memory[r.control].allocPerCallKb)}`,
  )
  .join(', ');

const ormBlob = rows.find(s => s.name === 'findOne with a 4 MB bytea');
const spread = rows.find(s => s.name === 'float8 spread over rows');
const packed = rows.find(s => s.name === 'float8 packed in one row');

const heldRows = rows
  .filter(s => s.held)
  .map(s => {
    const h = s.held[r.driver];
    const c = s.held[r.control];
    const drop = h.idleHeldKb < h.heldKb * 0.8;
    return `| ${s.name} | ${heldCell(c.heldKb)} | ${heldCell(h.heldKb)}${drop ? ` → ${heldCell(h.idleHeldKb)} idle` : ''} |`;
  })
  .join('\n');

const doc = `# The same TypeORM calls, on both clients

Generated from \`benchmark/results/latest.json\` by \`benchmark/render-report.mjs\`. Re-measure with
\`node benchmark/bench.mjs\`; nothing here is written by hand.

Node ${r.node}, \`postgrejs\` ${r.versions.postgrejs}, \`pg\` ${r.versions.pg}, \`typeorm\` ${r.versions.typeorm},
PostgreSQL ${r.versions.postgresql} on loopback. Prepared statements: ${r.prepare}.

## Method

Both clients run in one process and alternate on every pair, so neither gets a warmer machine. Each
figure is the median of 41 to 401 pairs. Memory is a separate pass: one child process per client,
one scenario each, \`--expose-gc\`, because a baseline taken with both clients alive has their pools
and buffers *under* it rather than in it.

Allocation is the total a batch asks for, counted as every fall in \`heapUsed + external\` plus what
the heap still holds at the end. Not a per-call peak - that is not measurable, and the worker's
header says why in full. \`external\` is in it because a \`Buffer\` is external and this is an
argument about bytes off a socket.

Every scenario binds at least one parameter. \`pg\` sends a statement with no values over
PostgreSQL's *simple* protocol and takes the extended one as soon as a parameter appears, which is
what PostgreJS always speaks; without one the two are not running the same protocol.

**Every scenario is one the client dominates**, and that is a selection rule rather than a
coincidence. A shape where PostgreSQL does most of the work measures PostgreSQL: its ratio is set
by how much scanning or writing the author asked for, and a reader takes it for a property of the
workload. There was a deliberately server-dominated row here as a control; it was removed, because
swept across scan sizes its speedup read 1.04x, 0.95x, 1.00x and 0.94x - it was not doing that job
either. The sign test is the guard instead.

## Results

### Reading

${table(pick('Read', 'raw'))}

### Writing

${table(pick('Write', 'raw'))}

### Through TypeORM

${table([...pick('Read', 'orm'), ...pick('Write', 'orm')])}

## Reading them

**Large payloads are where it wins, and it wins them twice.** ${clockWins} on the clock; on
allocation, ${memWins}. Those columns arrive in PostgreSQL's binary format rather than as text to be
parsed, and the parse is most of what that saves - \`pg\` has to materialise the whole value as a
string first.

**What decides it is values per row, not values.** \`${spread.name}\` and \`${packed.name}\` hold the
same 5000 \`float8\`s and differ in nothing but shape. Spread over rows the two are close, ${speedup(spread.ratio)} on the
clock and ${pct(memRatio(spread) - 1)} on allocation, because the protocol's per-row cost is most of what either client
pays. Packed into one row it is ${speedup(packed.ratio)} and ${pct(memRatio(packed) - 1)} - and \`pg\` gets worse rather than this
client getting better, because one row of 5000 values is one long array literal with a substring cut
per element.

**Entity hydration dilutes the ordinary gain and not the payload one**, which is the reason both
levels are here. \`findOne\` on a row holding 4 MB reads ${ms(ormBlob.msDriver)} against ${ms(ormBlob.msControl)} and ${kb(ormBlob.memory[r.driver].allocPerCallKb)}
against ${kb(ormBlob.memory[r.control].allocPerCallKb)} - within a few percent of the same read through \`query()\`, because what TypeORM
adds is per entity and the payload is one. On a shape of many small entities it is the layer above
that decides the ratio.

**It allocates more per call on small ones**: ${memLosses}. A higher fixed cost per call and a much
lower marginal cost per byte is the shape of it.

## Where it comes from

The driver against *itself* with one thing turned off, so what the tables above show can be
attributed rather than guessed at. Same alternation, same sign test.

| mechanism | without | with | |
| --- | --- | --- | --- |
${Object.values(r.mechanisms ?? {})
  .map(
    m =>
      `| ${m.name} - ${m.note} | ${ms(m.msWithout)} | **${ms(m.msWith)}** | **${speedup(m.ratio)}**<br>${m.sign.wins}/${m.sign.pairs} |`,
  )
  .join('\n')}

The wire format is the other one, and it is not isolated by turning something off - it is the
float8 pair above. That pair is why this section can say anything at all: measured only on
many-rows-few-values shapes the format's contribution came out 4% faster in one run and 7% slower in
another, neither significant, and the honest report was that it could not be claimed. The pair
answers it by holding the values constant and changing only the shape.

## Held between calls

What each client keeps at rest, warm. PostgreJS writes each message into one growing buffer per
connection and hands it back after five seconds of quiet, so a client that has just sent a large
parameter is still holding what it grew to. That is true while the calls keep coming and gone
shortly after they stop; one figure cannot say both, so both are here.

| Scenario | \`${r.control}\` | \`${r.driver}\` |
| --- | --- | --- |
${heldRows}
`;

const out = join(HERE, '..', 'doc', 'BENCHMARKS.md');
writeFileSync(out, doc);
process.stderr.write(`wrote ${out}\n`);

/**
 * Rewrites one `<!-- bench:name -->` … `<!-- /bench:name -->` region of the
 * README, so the numbers a reader meets first are generated rather than
 * hand-copied. They were hand-copied once and every one of them was two
 * releases out of date by the time anybody looked.
 *
 * Missing markers are an error rather than a no-op: silently rendering
 * nothing is how a document keeps last quarter's figures.
 */
function replaceRegion(text, name, body) {
  const open = `<!-- bench:${name} -->`;
  const close = `<!-- /bench:${name} -->`;
  const from = text.indexOf(open);
  const to = text.indexOf(close);
  if (from === -1 || to === -1)
    throw new Error(`README.md has no ${open} … ${close} region`);
  return `${text.slice(0, from + open.length)}\n\n${body}\n\n${text.slice(to)}`;
}

const headline = [
  'findOneBy',
  'find 100 entities',
  'find 5000 entities',
  'queryBuilder, 500 entities',
  'save one entity',
  'point read',
  'page of 100',
  'insert one row',
  'bytea of 4 MB',
  'int4[] of 100k',
]
  .map(n => rows.find(s => s.name === n))
  .filter(Boolean);

const env = `TypeORM ${r.versions.typeorm}, \`pg\` ${r.versions.pg}, PostgreJS ${r.versions.postgrejs}, PostgreSQL ${r.versions.postgresql}, loopback, Node ${r.node.replace('v', '')}. Medians per call, and allocation per call. How that was measured and how far each row can be trusted are in [How the numbers were measured](#how-the-numbers-were-measured); the full set is in [\`doc/BENCHMARKS.md\`](doc/BENCHMARKS.md).`;

const big = payloads[0];
const bytea = rows.find(s => s.name === 'bytea of 4 MB');
const arr = rows.find(s => s.name === 'int4[] of 100k');
const point = rows.find(s => s.name === 'point read');

const signRows = rows
  .filter(s => s.sign)
  .map(
    s => `| ${s.name} | ${s.sign.pairs} | ${s.sign.wins} | ${odds(s.sign.p)} |`,
  )
  .join('\n');

const README = join(HERE, '..', 'README.md');
let readme = readFileSync(README, 'utf8');
readme = replaceRegion(
  readme,
  'intro',
  `It is faster where it counts and holds far less memory doing it. A 4 MB \`bytea\` comes back in
${ms(bytea.msDriver)} against ${ms(bytea.msControl)}, and at ${kb(bytea.memory[r.driver].allocPerCallKb)} a call against ${kb(bytea.memory[r.control].allocPerCallKb)} - \`pg\` reads that column as
hex text, twice the size, off the JS heap where a heap figure alone cannot see it. A
100 000-element \`int4[]\` runs ${speedup(arr.ratio)}, at ${kb(arr.memory[r.driver].allocPerCallKb)} against ${kb(arr.memory[r.control].allocPerCallKb)}. Ordinary queries gain less and gain it
repeatably: a point read is the faster of the two in ${point.sign.wins} of ${point.sign.pairs} alternated pairs. All of it
measured through TypeORM against \`pg\` on the same server: [\`doc/BENCHMARKS.md\`](doc/BENCHMARKS.md).`,
);
readme = replaceRegion(
  readme,
  'payload',
  `- **Faster where the payload is large** - ${speedup(bytea.ratio)} on a 4 MB \`bytea\` and ${speedup(arr.ratio)} on a
  100 000-element \`int4[]\`, on a fraction of the memory, because the values arrive in
  PostgreSQL's binary format rather than as text to be parsed.`,
);
readme = replaceRegion(readme, 'headline', `${table(headline)}\n\n${env}`);
readme = replaceRegion(
  readme,
  'signtest',
  `| workload | pairs | \`${r.driver}\` faster in | odds of that by luck |\n| --- | --- | --- | --- |\n${signRows}`,
);
writeFileSync(README, readme);
process.stderr.write(`wrote ${README}\n`);
void big;
