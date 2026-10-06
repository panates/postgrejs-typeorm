/**
 * One client, one scenario, one process - and nothing else in it.
 *
 *   node --expose-gc benchmark/heap-worker.mjs <client> <scenario> [idle]
 *
 * Memory cannot be measured with both clients alive in one process: the
 * baseline is taken after both are up, so their pools, buffers and
 * decoders sit *under* it rather than in it, and what a client allocates
 * once and keeps is invisible by construction. A child per client, spawned
 * one at a time, is also how PostgreJS's own suite measures.
 *
 * It is a plain `.mjs` importing `../build/index.js` rather than a `.mts`
 * under `tsx`, and that is not a convenience: the baseline below is taken
 * *before a pool exists*, precisely so that what the client grows by is
 * separable from what the runtime was already holding. A TypeScript loader
 * inside that window gives the number away for nothing.
 *
 * It prints one JSON line and exits.
 *
 * ## Why there is no per-call peak here
 *
 * Because it is not measurable, and the three ways it was tried next door
 * fail in mutually exclusive directions:
 *
 * - **Sampled, it mostly samples nothing.** A timer cannot fire faster
 *   than once a millisecond. A 0.6 ms call took zero samples in five
 *   rounds of five and printed 0 KB for a call that allocates about 30.
 * - **Sampled over a longer call it understates unevenly.** On a 4 MB
 *   `bytea` read it caught 24.7 MB of one side's 53.5 while catching 8.2
 *   of the other's 8.4 - 2.2x low against 1.03x low. That moves the
 *   comparison, not just the figure.
 * - **Read at the end of the call, the baseline is wrong.** The first call
 *   after a forced collection is not like the ones after it, *by a
 *   different factor per client*. Settling it fixes the short rows and
 *   ruins the large ones.
 *
 * What replaced it is total allocation over a batch, which does not care
 * where a collection lands.
 */
import net from 'node:net';

// Bytes that actually crossed the socket, counted here rather than taken
// from either client's own accounting. Worth the twenty lines because it
// settles arguments otherwise conducted from the encoding source - next
// door the wire cost of the binary format for an `int4[]` of small numbers
// was argued from first principles and the argument had it backwards.
let received = 0;
let sent = 0;
const push = net.Socket.prototype.push;
net.Socket.prototype.push = function (chunk, ...rest) {
  if (chunk) received += chunk.length;
  return push.call(this, chunk, ...rest);
};
const write = net.Socket.prototype.write;
net.Socket.prototype.write = function (chunk, ...rest) {
  if (chunk) sent += chunk.length ?? Buffer.byteLength(chunk);
  return write.call(this, chunk, ...rest);
};

const { CONTROL, DRIVER, openDatabases, scenariosMatching } =
  await import('./scenarios.mjs');

// `heapUsed` alone is wrong: a Buffer is external, and the whole argument
// for this family of packages is about bytes off a socket. The same error
// in another costume is `--trace-gc`, which reports the JS heap only and
// read 284.7 KB for a call that moved 12 MB - it survives as a cross-check
// written into the results file, never as a printed column.
const usedBytes = () => {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external;
};

// Taken before a pool exists.
globalThis.gc();
globalThis.gc();
const cold = usedBytes();

const [which, name, mode] = process.argv.slice(2);
const scenario = scenariosMatching('all').find(s => s.name === name);
if (!scenario) throw new Error(`no scenario named ${name}`);
if (which !== CONTROL && which !== DRIVER)
  throw new Error(`no client named ${which}`);

// `which`, so this process builds only the client it measures - see
// openDatabases. A child that constructs both has them both alive in it,
// which is the whole thing a child per client is for.
const opened = openDatabases(scenario.pooled, scenario.level, which);
if (opened.ready) await opened.ready();
const db = opened.dbs[which];

// Warm first: the JIT, the pool's connections and - on this client - the
// prepared statement each distinct SQL earns. What is measured is a
// scenario in its steady state, not its first call.
const warmup = Math.min(scenario.iters * 4, 60);
for (let i = 0; i < warmup; i++) await scenario.run(db, i);

globalThis.gc();
globalThis.gc();
const atRest = usedBytes();

/**
 * The same question again after a pause, because one of these clients
 * answers it differently depending on when you ask.
 *
 * PostgreJS writes each message into one growing buffer per connection and
 * hands it back after `houseKeepMs` (5s) of quiet, so a client that just
 * sent a 4 MB parameter is still holding the 4 MB it grew to. That is true
 * while the calls keep coming and gone shortly after they stop, and one
 * figure cannot say both - next door it read 4.7 MB against 586 KB warm
 * and 755 KB six seconds later. `pg` builds a fresh buffer per message and
 * drops it, so it has nothing to hand back and reads the same either way,
 * which is what makes the gap look like a leak until you wait.
 */
if (mode === 'idle') {
  await new Promise(resolve => setTimeout(resolve, 6000));
  globalThis.gc();
  globalThis.gc();
  console.log(
    JSON.stringify({
      client: which,
      scenario: name,
      heldKb: (atRest - cold) / 1024,
      idleHeldKb: (usedBytes() - cold) / 1024,
    }),
  );
  await opened.close();
  process.exit(0);
}

/**
 * One batch, sampled at 1 ms, answering two questions that are not the
 * same and were confused for each other until they were split.
 *
 * **What a call allocates.** Every fall in `heapUsed + external` is a
 * collection handing memory back; summed over the batch and added to what
 * the heap still holds at the end, that is everything the calls asked for.
 * Nothing in it depends on where a collection lands, which is what made a
 * per-call peak unmeasurable. Additive and repeatable.
 *
 * **What the process peaks at.** The high-water of the same samples, which
 * is what the process has to be able to hold. It is not the same ranking
 * and is not meant to be: it is where the runtime chose to collect, so a
 * client that allocates a third as much can sit higher for reaching the
 * threshold a third as often. Print it as sizing, never as a verdict.
 *
 * Long enough to settle, and longer where the calls are cheap, because the
 * per-call figure converges with the batch length.
 */
const iterations = Math.max(scenario.iters * 20, 100);
let highest = 0;
let highestRss = 0;
let collected = 0;

globalThis.gc();
globalThis.gc();
const batchBase = usedBytes();
let previous = batchBase;

const watch = setInterval(() => {
  const usage = process.memoryUsage();
  const used = usage.heapUsed + usage.external;
  if (used > highest) highest = used;
  if (used < previous) collected += previous - used;
  previous = used;
  if (usage.rss > highestRss) highestRss = usage.rss;
}, 1);

// The parent runs this child under `--trace-gc` and sums what each
// collection gave back between these two marks, as a check on the sampled
// figure arrived at a completely different way.
console.log(`MARK ${performance.now().toFixed(0)}`);
const receivedBefore = received;
const sentBefore = sent;
for (let i = 0; i < iterations; i++) await scenario.run(db, i);
console.log(`END ${performance.now().toFixed(0)}`);

clearInterval(watch);
const batchEnd = usedBytes();
if (batchEnd < previous) collected += previous - batchEnd;

console.log(
  JSON.stringify({
    client: which,
    scenario: name,
    level: scenario.level,
    iterations,
    heldKb: (atRest - cold) / 1024,
    allocPerCallKb: (batchEnd - batchBase + collected) / iterations / 1024,
    sustainedKb: (highest - cold) / 1024,
    sustainedRssKb: highestRss / 1024,
    wireKb: (received - receivedBefore) / 1024 / iterations,
    wireOutKb: (sent - sentBefore) / 1024 / iterations,
  }),
);

await opened.close();
process.exit(0);
