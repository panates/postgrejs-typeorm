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

Allocation is the total a batch asks for, counted as every fall in `heapUsed + external` plus what
the heap still holds at the end. Not a per-call peak - that is not measurable, and the worker's
header says why in full. `external` is in it because a `Buffer` is external and this is an
argument about bytes off a socket.

Every scenario binds at least one parameter. `pg` sends a statement with no values over
PostgreSQL's *simple* protocol and takes the extended one as soon as a parameter appears, which is
what PostgreJS always speaks; without one the two are not running the same protocol.

## Results

### Reading

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| point read - 1 row of 9 columns | 0.406 ms<br>**21 KB/call** | **0.353 ms**<br>28 KB/call | **1.15x**<br>+32% |
| page of 100 - 100 rows of 9 columns, mixed types | 0.606 ms<br>232 KB/call | **0.515 ms**<br>**166 KB/call** | **1.18x**<br>**-28%** |
| all 5000 rows - 5000 rows of 9 columns | 6.716 ms<br>10.4 MB/call | **5.273 ms**<br>**6.8 MB/call** | **1.27x**<br>**-34%** |
| float8 spread over rows - 5000 rows of 1 value | 1.328 ms<br>1.3 MB/call | **0.895 ms**<br>**1.1 MB/call** | **1.48x**<br>**-15%** |
| float8 packed in one row - 1 row holding 1 array of 5000 values | 2.275 ms<br>2.7 MB/call | **0.655 ms**<br>**216 KB/call** | **3.47x**<br>**-92%** |
| int4[] of 100k - 1 row holding 1 array of 100 000 values | 23.524 ms<br>23.3 MB/call | **6.172 ms**<br>**2.2 MB/call** | **3.81x**<br>**-91%** |
| bytea of 4 MB - 1 row holding 4 MB | 45.979 ms<br>51.9 MB/call | **20.248 ms**<br>**4.1 MB/call** | **2.27x**<br>**-92%** |
| count over a filter - 1 row back after a scan of 5000 | 0.452 ms<br>**15 KB/call** | **0.418 ms**<br>25 KB/call | **1.08x**<br>+68% |

### Writing

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| insert one row - 1 row of 2 columns | 0.342 ms<br>**12 KB/call** | **0.299 ms**<br>24 KB/call | **1.14x**<br>+100% |
| write a 4 MB bytea - 1 parameter of 4 MB - the one place both send binary | 20.962 ms<br>5.5 MB/call | **19.239 ms**<br>**3.5 MB/call** | **1.09x**<br>**-37%** |

### Through TypeORM

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| findOneBy - 1 entity of 9 columns | 0.568 ms<br>**64 KB/call** | **0.473 ms**<br>71 KB/call | **1.20x**<br>+10% |
| find 100 entities - 100 entities of 9 columns | 0.610 ms<br>433 KB/call | **0.522 ms**<br>**328 KB/call** | **1.17x**<br>**-24%** |
| find 5000 entities - 5000 entities of 9 columns | 8.552 ms<br>16.5 MB/call | **6.186 ms**<br>**10.8 MB/call** | **1.38x**<br>**-35%** |
| queryBuilder, 500 entities - 500 entities after a where and an order by | 1.277 ms<br>1.8 MB/call | **1.091 ms**<br>**1.1 MB/call** | **1.17x**<br>**-37%** |
| findOne with a 4 MB bytea - 1 entity holding 4 MB | 44.208 ms<br>51.5 MB/call | **19.931 ms**<br>**4.2 MB/call** | **2.22x**<br>**-92%** |
| findOne with a 100k int4[] - 1 entity holding 1 array of 100 000 values | 24.759 ms<br>22.7 MB/call | **6.918 ms**<br>**2.2 MB/call** | **3.58x**<br>**-90%** |
| save one entity - 1 entity of 1 assigned column | 0.894 ms<br>**79 KB/call** | **0.796 ms**<br>102 KB/call | **1.12x**<br>+29% |

### The control

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| count, server-dominated - 1 row back after a scan of 500 000 - its magnitude has to stay small | 9.054 ms<br>**27 KB/call** | **8.931 ms**<br>34 KB/call | 1.01x level<br>+24% |

One row back after a scan the server dominates. Read it on magnitude, not on the sign test: there is
no shape where neither client wins - the driver is a hair faster on everything and enough pairs
always find it - so what this row checks is that a server-dominated shape moves by a few percent
while a bulk read moves by tens. A run where those two are the same size measured the machine.

## Reading them

**Large payloads are where it wins, and it wins them twice.** **int4[] of 100k** 3.81x, **findOne with a 100k int4[]** 3.58x, **float8 packed in one row** 3.47x, **bytea of 4 MB** 2.27x, **findOne with a 4 MB bytea** 2.22x on the clock; on
allocation, **float8 packed in one row** 216 KB/call against 2.7 MB, **bytea of 4 MB** 4.1 MB/call against 51.9 MB, **findOne with a 4 MB bytea** 4.2 MB/call against 51.5 MB, **int4[] of 100k** 2.2 MB/call against 23.3 MB, **findOne with a 100k int4[]** 2.2 MB/call against 22.7 MB. Those columns arrive in PostgreSQL's binary format rather than as text to be
parsed, and the parse is most of what that saves - `pg` has to materialise the whole value as a
string first.

**What decides it is values per row, not values.** `float8 spread over rows` and `float8 packed in one row` hold the
same 5000 `float8`s and differ in nothing but shape. Spread over rows the two are close, 1.48x on the
clock and -15% on allocation, because the protocol's per-row cost is most of what either client
pays. Packed into one row it is 3.47x and -92% - and `pg` gets worse rather than this
client getting better, because one row of 5000 values is one long array literal with a substring cut
per element.

**Entity hydration dilutes the ordinary gain and not the payload one**, which is the reason both
levels are here. `findOne` on a row holding 4 MB reads 19.931 ms against 44.208 ms and 4.2 MB
against 51.5 MB - within a few percent of the same read through `query()`, because what TypeORM
adds is per entity and the payload is one. On a shape of many small entities it is the layer above
that decides the ratio.

**It allocates more per call on small ones**: **insert one row** 24 KB against 12 KB, **count over a filter** 25 KB against 15 KB, **point read** 28 KB against 21 KB, **save one entity** 102 KB against 79 KB, **count, server-dominated** 34 KB against 27 KB, **findOneBy** 71 KB against 64 KB. A higher fixed cost per call and a much
lower marginal cost per byte is the shape of it, and the control row shows the fixed part on its
own - weighting the server cannot dilute an allocation that does not scale with server time.

## Where it comes from

The driver against *itself* with one thing turned off, so what the tables above show can be
attributed rather than guessed at. Same alternation, same sign test.

| mechanism | without | with | |
| --- | --- | --- | --- |
| prepared statements - the same parameterized read, against `prepare: false` | 0.753 ms | **0.636 ms** | **1.18x**<br>291/401 |

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
| point read | 564 KB | 727 KB |
| page of 100 | 729 KB | 855 KB |
| all 5000 rows | 6.1 MB | 2.9 MB → 778 KB idle |
| float8 spread over rows | 1.3 MB | 1.0 MB → 730 KB idle |
| float8 packed in one row | 634 KB | 705 KB |
| int4[] of 100k | 2.3 MB | 1.4 MB → 668 KB idle |
| bytea of 4 MB | 7.2 MB | 3.3 MB → ≈0 idle |
| insert one row | 459 KB | 629 KB |
| write a 4 MB bytea | ≈0 | 3.2 MB → ≈0 idle |
| count over a filter | 501 KB | 663 KB |
| findOneBy | 1.5 MB | 1.6 MB |
| find 100 entities | 1.5 MB | 1.8 MB |
| find 5000 entities | 4.2 MB | 3.8 MB → 1.5 MB idle |
| queryBuilder, 500 entities | 1.8 MB | 1.8 MB |
| save one entity | 1.6 MB | 1.7 MB |
| findOne with a 4 MB bytea | 4.0 MB | 4.0 MB → ≈0 idle |
| findOne with a 100k int4[] | 777 KB | 2.2 MB → 1.5 MB idle |
