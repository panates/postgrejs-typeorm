# The same TypeORM calls, on both clients

Generated from `benchmark/results/latest.json` by `benchmark/render-report.mjs`. Re-measure with
`node benchmark/bench.mjs`; nothing here is written by hand.

Node v24.15.0, `postgrejs` 3.12.1, `pg` 8.23.0, `typeorm` 1.1.1,
PostgreSQL 18.6 on loopback. Prepared statements: default (cached per connection).

## Method

Both clients run in one process and alternate on every pair, so neither gets a warmer machine. Each
figure is the median of 41 to 401 pairs. Memory is a separate pass: one child process per client,
one scenario each, `--expose-gc`, because a baseline taken with both clients alive has their pools
and buffers *under* it rather than in it.

Allocation is measured in pairs too - 7 per scenario, one child per client with the order swapped -
and a row reads *level* when the sign test says so rather than when the medians happen to be close.
It is the total a batch asks for, counted as every fall in `heapUsed + external` plus what
the heap still holds at the end. Not a per-call peak - that is not measurable, and the worker's
header says why in full. `external` is in it because a `Buffer` is external and this is an
argument about bytes off a socket.

Every scenario binds at least one parameter. `pg` sends a statement with no values over
PostgreSQL's *simple* protocol and takes the extended one as soon as a parameter appears, which is
what PostgreJS always speaks; without one the two are not running the same protocol.

**And every one runs on a checked-out connection**, which is the path TypeORM takes: a
`QueryRunner` calls `pool.connect()` once and sends every statement of its life down that one
connection - `pool.query()` appears nowhere in its PostgreSQL driver. These scenarios used the
pool anyway until it was measured: each checkout builds a client wrapper, a release closure and two
events, and on a `point read` that is 25.0 KB a call against 17.4 on a held connection. Charging a
reader for a path their ORM never takes is the same mistake as weighting the server, one layer up.
The exception is `concurrent reads`, which keeps the pool because twenty concurrent reads in
TypeORM *are* twenty QueryRunners, and so twenty checkouts.

**Every scenario is one the client dominates**, and that is a selection rule rather than a
coincidence. A shape where PostgreSQL does most of the work measures PostgreSQL: its ratio is set
by how much scanning or writing the author asked for, and a reader takes it for a property of the
workload. There was a deliberately server-dominated row here as a control; it was removed, because
swept across scan sizes its speedup read 1.04x, 0.95x, 1.00x and 0.94x - it was not doing that job
either. The sign test is the guard instead.

**And every one carries enough payload that the fixed cost is not the answer.**
`concurrent reads` read one row per request until it was swept: at one row the facade allocated
57% more per call, at twenty rows 2% more, at a hundred rows 30% less. Nothing about either client
changed across those three - the row had been reporting the cost of checking a connection out,
twenty times, under the word "concurrent". It asks for a hundred rows each now, which is also
nearer what a request does.

Those three rules are one rule from three sides: a scenario has to put the thing being compared in
the majority of what it measures. A row that does not is not neutral - it answers a question
nobody asked, under a name that promises otherwise.

## Results

### Reading

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| point read - 1 row of 9 columns | 0.274 ms<br>**17 KB/call** | **0.238 ms**<br>20 KB/call | **1.15x**<br>+20% |
| page of 100 - 100 rows of 9 columns, mixed types | 0.530 ms<br>234 KB/call | **0.442 ms**<br>**157 KB/call** | **1.20x**<br>**-33%** |
| all 5000 rows - 5000 rows of 9 columns | 6.039 ms<br>10.4 MB/call | **4.307 ms**<br>**6.8 MB/call** | **1.40x**<br>**-34%** |
| float8 spread over rows - 5000 rows of 1 value | 1.159 ms<br>1.3 MB/call | **0.693 ms**<br>**1.0 MB/call** | **1.67x**<br>**-24%** |
| float8 packed in one row - 1 row holding 1 array of 5000 values | 2.131 ms<br>2.7 MB/call | **0.560 ms**<br>**209 KB/call** | **3.81x**<br>**-92%** |
| int4[] of 100k - 1 row holding 1 array of 100 000 values | 22.432 ms<br>23.1 MB/call | **5.579 ms**<br>**2.2 MB/call** | **4.02x**<br>**-91%** |
| bytea of 4 MB - 1 row holding 4 MB | 34.295 ms<br>51.6 MB/call | **15.132 ms**<br>**4.1 MB/call** | **2.27x**<br>**-92%** |
| uuid of 5k rows - 5000 rows of 1 value, sixteen bytes against thirty-six characters | 1.261 ms<br>1.5 MB/call | **0.846 ms**<br>**1.4 MB/call** | **1.49x**<br>**-8%** |
| box of 5k rows - 5000 rows of 1 value, asked for as text on both sides | 2.089 ms<br>**1.9 MB/call** | **2.049 ms**<br>2.0 MB/call | 1.02x level<br>+3% |
| concurrent reads - 20 reads at once of 100 rows each, pool of 10 | 3.289 ms<br>4.3 MB/call | **2.530 ms**<br>**3.0 MB/call** | **1.30x**<br>**-32%** |

### Writing

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| insert one row - 1 row of 2 columns | 0.231 ms<br>**9 KB/call** | **0.193 ms**<br>16 KB/call | **1.19x**<br>+73% |
| insert 500 rows - 500 rows in 1 statement, 2500 parameters | 3.088 ms<br>**958 KB/call** | **2.282 ms**<br>1.2 MB/call | **1.35x**<br>+29% |
| write a 100k int4[] - 1 parameter holding 100 000 values, text on both sides | 17.847 ms<br>**27.2 MB/call** | **17.782 ms**<br>28.1 MB/call | 1.00x level<br>+3% |
| twenty inserts in a transaction - 20 rows, one statement each, inside one transaction | 4.865 ms<br>**166 KB/call** | **4.161 ms**<br>306 KB/call | **1.17x**<br>+85% |

### Through TypeORM

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| findOneBy - 1 entity of 9 columns | 0.276 ms<br>**64 KB/call** | **0.231 ms**<br>70 KB/call | **1.19x**<br>+9% |
| find 100 entities - 100 entities of 9 columns | 0.610 ms<br>399 KB/call | **0.539 ms**<br>**316 KB/call** | **1.13x**<br>**-21%** |
| find 5000 entities - 5000 entities of 9 columns | 8.118 ms<br>15.8 MB/call | **5.841 ms**<br>**11.3 MB/call** | **1.39x**<br>**-29%** |
| queryBuilder, 500 entities - 500 entities after a where and an order by | 1.179 ms<br>1.7 MB/call | **0.991 ms**<br>**1.0 MB/call** | **1.19x**<br>**-39%** |
| findOne with a 4 MB bytea - 1 entity holding 4 MB | 34.366 ms<br>51.7 MB/call | **15.242 ms**<br>**4.1 MB/call** | **2.25x**<br>**-92%** |
| findOne with a 100k int4[] - 1 entity holding 1 array of 100 000 values | 26.240 ms<br>23.7 MB/call | **7.677 ms**<br>**2.2 MB/call** | **3.42x**<br>**-91%** |
| save one entity - 1 entity of 1 assigned column | 0.711 ms<br>**78 KB/call** | **0.650 ms**<br>103 KB/call | **1.09x**<br>+31% |

## Reading them

**Large payloads are where it wins, and it wins them twice.** **int4[] of 100k** 4.02x, **float8 packed in one row** 3.81x, **findOne with a 100k int4[]** 3.42x, **bytea of 4 MB** 2.27x, **findOne with a 4 MB bytea** 2.25x on the clock; on
allocation, **float8 packed in one row** 209 KB/call against 2.7 MB, **bytea of 4 MB** 4.1 MB/call against 51.6 MB, **findOne with a 4 MB bytea** 4.1 MB/call against 51.7 MB, **findOne with a 100k int4[]** 2.2 MB/call against 23.7 MB, **int4[] of 100k** 2.2 MB/call against 23.1 MB. Those columns arrive in PostgreSQL's binary format rather than as text to be
parsed, and the parse is most of what that saves - `pg` has to materialise the whole value as a
string first.

**What decides it is values per row, not values.** `float8 spread over rows` and `float8 packed in one row` hold the
same 5000 `float8`s and differ in nothing but shape. Spread over rows the two are close, 1.67x on the
clock and -24% on allocation, because the protocol's per-row cost is most of what either client
pays. Packed into one row it is 3.81x and -92% - and `pg` gets worse rather than this
client getting better, because one row of 5000 values is one long array literal with a substring cut
per element.

**Entity hydration dilutes the ordinary gain and not the payload one**, which is the reason both
levels are here. `findOne` on a row holding 4 MB reads 15.242 ms against 34.366 ms and 4.1 MB
against 51.7 MB - within a few percent of the same read through `query()`, because what TypeORM
adds is per entity and the payload is one. On a shape of many small entities it is the layer above
that decides the ratio.

**It allocates more per call on small ones**: **twenty inserts in a transaction** 306 KB against 166 KB, **insert one row** 16 KB against 9 KB, **save one entity** 103 KB against 78 KB, **insert 500 rows** 1.2 MB against 958 KB, **point read** 20 KB against 17 KB, **findOneBy** 70 KB against 64 KB, **box of 5k rows** 2.0 MB against 1.9 MB, **write a 100k int4[]** 28.1 MB against 27.2 MB. A higher fixed cost per call and a much
lower marginal cost per byte is the shape of it.

## Where it comes from

The driver against *itself* with one thing turned off, so what the tables above show can be
attributed rather than guessed at. Same alternation, same sign test.

| mechanism | without | with | |
| --- | --- | --- | --- |
| prepared statements - the same parameterized read, against `prepare: false` | 0.299 ms | **0.255 ms** | **1.17x**<br>389/401 |

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

| Scenario | `pg` | `typeorm-postgrejs` |
| --- | --- | --- |
| point read | 448 KB | 661 KB |
| page of 100 | 549 KB | 797 KB |
| all 5000 rows | 3.2 MB | 2.8 MB → 716 KB idle |
| float8 spread over rows | 856 KB | 945 KB → 666 KB idle |
| float8 packed in one row | 445 KB | 668 KB |
| int4[] of 100k | ≈0 | 1.4 MB → 606 KB idle |
| bytea of 4 MB | 3.1 MB | 3.2 MB → ≈0 idle |
| uuid of 5k rows | 1.0 MB | 1.1 MB → 678 KB idle |
| box of 5k rows | 1.2 MB | 1.4 MB → 684 KB idle |
| insert one row | 346 KB | 556 KB |
| insert 500 rows | 414 KB | 759 KB |
| write a 100k int4[] | 356 KB | 1.8 MB → 532 KB idle |
| twenty inserts in a transaction | 467 KB | 728 KB |
| concurrent reads | 2.5 MB | 2.1 MB → 1.2 MB idle |
| findOneBy | 1.2 MB | 1.4 MB |
| find 100 entities | 1.2 MB | 1.7 MB |
| find 5000 entities | 3.9 MB | 3.7 MB → 1.4 MB idle |
| queryBuilder, 500 entities | 1.4 MB | 1.7 MB |
| findOne with a 4 MB bytea | 3.7 MB | 3.9 MB → ≈0 idle |
| findOne with a 100k int4[] | 681 KB | 2.1 MB → 1.3 MB idle |
| save one entity | 1.3 MB | 1.6 MB |
