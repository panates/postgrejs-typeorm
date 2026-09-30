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
| point read - 1 row of 9 columns | 0.287 ms<br>**20 KB/call** | **0.252 ms**<br>29 KB/call | **1.14x**<br>+45% |
| page of 100 - 100 rows of 9 columns, mixed types | 0.523 ms<br>235 KB/call | **0.454 ms**<br>**169 KB/call** | **1.15x**<br>**-28%** |
| all 5000 rows - 5000 rows of 9 columns | 5.781 ms<br>11.0 MB/call | **4.217 ms**<br>**6.6 MB/call** | **1.37x**<br>**-40%** |
| float8 spread over rows - 5000 rows of 1 value | 1.082 ms<br>1.2 MB/call | **0.679 ms**<br>**1.1 MB/call** | **1.59x**<br>**-8%** |
| float8 packed in one row - 1 row holding 1 array of 5000 values | 2.150 ms<br>2.8 MB/call | **0.601 ms**<br>**217 KB/call** | **3.58x**<br>**-92%** |
| int4[] of 100k - 1 row holding 1 array of 100 000 values | 22.700 ms<br>22.4 MB/call | **6.089 ms**<br>**2.2 MB/call** | **3.73x**<br>**-90%** |
| bytea of 4 MB - 1 row holding 4 MB | 35.941 ms<br>51.5 MB/call | **15.685 ms**<br>**4.1 MB/call** | **2.29x**<br>**-92%** |
| count over a filter - 1 row back after a scan of 5000 | 0.524 ms<br>**15 KB/call** | **0.486 ms**<br>28 KB/call | **1.08x**<br>+85% |

### Writing

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| insert one row - 1 row of 2 columns | 0.247 ms<br>**13 KB/call** | **0.214 ms**<br>25 KB/call | **1.15x**<br>+95% |
| write a 4 MB bytea - 1 parameter of 4 MB - the one place both send binary | 18.176 ms<br>5.0 MB/call | **16.453 ms**<br>**3.4 MB/call** | **1.10x**<br>**-32%** |

### Through TypeORM

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| findOneBy - 1 entity of 9 columns | 0.351 ms<br>**65 KB/call** | **0.300 ms**<br>72 KB/call | **1.17x**<br>+10% |
| find 100 entities - 100 entities of 9 columns | 0.749 ms<br>418 KB/call | **0.619 ms**<br>**323 KB/call** | **1.21x**<br>**-23%** |
| find 5000 entities - 5000 entities of 9 columns | 8.043 ms<br>**29.9 MB/call** | **5.801 ms**<br>48.6 MB/call | **1.39x**<br>+63% |
| queryBuilder, 500 entities - 500 entities after a where and an order by | 1.169 ms<br>1.8 MB/call | **0.977 ms**<br>**1.1 MB/call** | **1.20x**<br>**-39%** |
| save one entity - 1 entity of 8 assigned columns | 1.047 ms<br>**98 KB/call** | **0.969 ms**<br>123 KB/call | **1.08x**<br>+25% |

### The control

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| count, server-dominated - 1 row back after a scan of 500 000 - its magnitude has to stay small | 8.559 ms<br>**37 KB/call** | **8.448 ms**<br>46 KB/call | 1.01x level<br>+25% |

One row back after a scan the server dominates. Read it on magnitude, not on the sign test: there is
no shape where neither client wins - the driver is a hair faster on everything and enough pairs
always find it - so what this row checks is that a server-dominated shape moves by a few percent
while a bulk read moves by tens. A run where those two are the same size measured the machine.

## Reading them

**Large payloads are where it wins, and it wins them twice.** **int4[] of 100k** 3.73x, **float8 packed in one row** 3.58x, **bytea of 4 MB** 2.29x on the clock; on
allocation, **float8 packed in one row** 217 KB/call against 2.8 MB, **bytea of 4 MB** 4.1 MB/call against 51.5 MB, **int4[] of 100k** 2.2 MB/call against 22.4 MB. Those columns arrive in PostgreSQL's binary format rather than as text to be
parsed, and the parse is most of what that saves - `pg` has to materialise the whole value as a
string first.

**What decides it is values per row, not values.** `float8 spread over rows` and `float8 packed in one row` hold the
same 5000 `float8`s and differ in nothing but shape. Spread over rows the two are close, 1.59x on the
clock and -8% on allocation, because the protocol's per-row cost is most of what either client
pays. Packed into one row it is 3.58x and -92% - and `pg` gets worse rather than this
client getting better, because one row of 5000 values is one long array literal with a substring cut
per element.

**It allocates more per call on small ones**: **insert one row** 25 KB against 13 KB, **count over a filter** 28 KB against 15 KB, **find 5000 entities** 48.6 MB against 29.9 MB, **point read** 29 KB against 20 KB, **save one entity** 123 KB against 98 KB, **count, server-dominated** 46 KB against 37 KB, **findOneBy** 72 KB against 65 KB. A higher fixed cost per call and a much
lower marginal cost per byte is the shape of it, and the control row shows the fixed part on its
own - weighting the server cannot dilute an allocation that does not scale with server time.

## Where it comes from

The driver against *itself* with one thing turned off, so what the tables above show can be
attributed rather than guessed at. Same alternation, same sign test.

| mechanism | without | with | |
| --- | --- | --- | --- |
| prepared statements - the same parameterized read, against `prepare: false` | 0.622 ms | **0.545 ms** | **1.14x**<br>304/401 |

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
| point read | 565 KB | 727 KB |
| page of 100 | 721 KB | 855 KB |
| all 5000 rows | 6.1 MB | 2.9 MB → 779 KB idle |
| float8 spread over rows | 1.3 MB | 1.0 MB → 730 KB idle |
| float8 packed in one row | 666 KB | 735 KB |
| int4[] of 100k | 885 KB | 1.4 MB → 668 KB idle |
| bytea of 4 MB | 7.2 MB | 3.3 MB → ≈0 idle |
| insert one row | 459 KB | 629 KB |
| write a 4 MB bytea | ≈0 | 3.2 MB → ≈0 idle |
| count over a filter | 501 KB | 663 KB |
| findOneBy | 1.5 MB | 1.5 MB |
| find 100 entities | 1.5 MB | 1.8 MB |
| find 5000 entities | 15.4 MB | 12.4 MB → 1.6 MB idle |
| queryBuilder, 500 entities | 1.7 MB | 1.8 MB |
| save one entity | 1.6 MB | 1.8 MB |
