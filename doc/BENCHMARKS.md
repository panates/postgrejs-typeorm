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
| point read - 1 row of 9 columns | 0.281 ms<br>**20 KB/call** | **0.247 ms**<br>28 KB/call | **1.14x**<br>+42% |
| page of 100 - 100 rows of 9 columns, mixed types | 0.550 ms<br>235 KB/call | **0.477 ms**<br>**164 KB/call** | **1.15x**<br>**-30%** |
| all 5000 rows - 5000 rows of 9 columns | 5.569 ms<br>10.3 MB/call | **5.327 ms**<br>**6.7 MB/call** | 1.05x level<br>**-34%** |
| float8 spread over rows - 5000 rows of 1 value | 1.090 ms<br>1.2 MB/call | **0.658 ms**<br>**1.0 MB/call** | **1.66x**<br>**-13%** |
| float8 packed in one row - 1 row holding 1 array of 5000 values | 1.993 ms<br>2.7 MB/call | **0.540 ms**<br>**220 KB/call** | **3.69x**<br>**-92%** |
| int4[] of 100k - 1 row holding 1 array of 100 000 values | 23.210 ms<br>23.7 MB/call | **6.302 ms**<br>**2.2 MB/call** | **3.68x**<br>**-91%** |
| bytea of 4 MB - 1 row holding 4 MB | 36.412 ms<br>51.8 MB/call | **16.199 ms**<br>**4.1 MB/call** | **2.25x**<br>**-92%** |
| count over a filter - 1 row back after a scan of 5000 | 0.465 ms<br>**15 KB/call** | **0.427 ms**<br>26 KB/call | **1.09x**<br>+77% |

### Writing

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| insert one row - 1 row of 2 columns | 0.242 ms<br>**13 KB/call** | **0.203 ms**<br>24 KB/call | **1.19x**<br>+89% |
| write a 4 MB bytea - 1 parameter of 4 MB - the one place both send binary | 17.934 ms<br>5.3 MB/call | **16.044 ms**<br>**3.6 MB/call** | **1.12x**<br>**-34%** |

### Through TypeORM

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| findOneBy - 1 entity of 9 columns | 0.297 ms<br>**65 KB/call** | **0.250 ms**<br>69 KB/call | **1.19x**<br>+6% |
| find 100 entities - 100 entities of 9 columns | 0.591 ms<br>417 KB/call | **0.505 ms**<br>**318 KB/call** | **1.17x**<br>**-24%** |
| find 5000 entities - 5000 entities of 9 columns | 8.737 ms<br>16.0 MB/call | **6.163 ms**<br>**11.3 MB/call** | **1.42x**<br>**-29%** |
| queryBuilder, 500 entities - 500 entities after a where and an order by | 1.192 ms<br>1.7 MB/call | **0.994 ms**<br>**1.0 MB/call** | **1.20x**<br>**-38%** |
| save one entity - 1 entity of 8 assigned columns | 0.892 ms<br>**96 KB/call** | **0.855 ms**<br>122 KB/call | 1.04x level<br>+27% |

### The control

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| count, server-dominated - 1 row back after a scan of 500 000 - its magnitude has to stay small | 8.320 ms<br>**21 KB/call** | **8.259 ms**<br>38 KB/call | 1.01x level<br>+79% |

One row back after a scan the server dominates. Read it on magnitude, not on the sign test: there is
no shape where neither client wins - the driver is a hair faster on everything and enough pairs
always find it - so what this row checks is that a server-dominated shape moves by a few percent
while a bulk read moves by tens. A run where those two are the same size measured the machine.

## Reading them

**Large payloads are where it wins, and it wins them twice.** **float8 packed in one row** 3.69x, **int4[] of 100k** 3.68x, **bytea of 4 MB** 2.25x on the clock; on
allocation, **bytea of 4 MB** 4.1 MB/call against 51.8 MB, **float8 packed in one row** 220 KB/call against 2.7 MB, **int4[] of 100k** 2.2 MB/call against 23.7 MB. Those columns arrive in PostgreSQL's binary format rather than as text to be
parsed, and the parse is most of what that saves - `pg` has to materialise the whole value as a
string first.

**What decides it is values per row, not values.** `float8 spread over rows` and `float8 packed in one row` hold the
same 5000 `float8`s and differ in nothing but shape. Spread over rows the two are close, 1.66x on the
clock and -13% on allocation, because the protocol's per-row cost is most of what either client
pays. Packed into one row it is 3.69x and -92% - and `pg` gets worse rather than this
client getting better, because one row of 5000 values is one long array literal with a substring cut
per element.

**It allocates more per call on small ones**: **insert one row** 24 KB against 13 KB, **count, server-dominated** 38 KB against 21 KB, **count over a filter** 26 KB against 15 KB, **point read** 28 KB against 20 KB, **save one entity** 122 KB against 96 KB, **findOneBy** 69 KB against 65 KB. A higher fixed cost per call and a much
lower marginal cost per byte is the shape of it, and the control row shows the fixed part on its
own - weighting the server cannot dilute an allocation that does not scale with server time.

## Held between calls

What each client keeps at rest, warm. PostgreJS writes each message into one growing buffer per
connection and hands it back after five seconds of quiet, so a client that has just sent a large
parameter is still holding what it grew to. That is true while the calls keep coming and gone
shortly after they stop; one figure cannot say both, so both are here.

| Scenario | `pg` | `typeorm-postgrejs` |
| --- | --- | --- |
| point read | 565 KB | 727 KB |
| page of 100 | 722 KB | 863 KB |
| all 5000 rows | 6.1 MB | 2.9 MB → 775 KB idle |
| float8 spread over rows | 1.3 MB | 1.0 MB → 732 KB idle |
| float8 packed in one row | 618 KB | 715 KB |
| int4[] of 100k | 850 KB | 1.4 MB → 668 KB idle |
| bytea of 4 MB | 7.2 MB | 3.3 MB → ≈0 idle |
| insert one row | 459 KB | 629 KB |
| write a 4 MB bytea | ≈0 | 3.2 MB → ≈0 idle |
| count over a filter | 501 KB | 663 KB |
| findOneBy | 1.5 MB | 1.5 MB |
| find 100 entities | 1.5 MB | 1.8 MB |
| find 5000 entities | 5.2 MB | 4.5 MB → 1.5 MB idle |
| queryBuilder, 500 entities | 1.7 MB | 1.8 MB |
| save one entity | 1.6 MB | 1.8 MB |
