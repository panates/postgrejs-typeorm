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

**Every scenario is one the client dominates**, and that is a selection rule rather than a
coincidence. A shape where PostgreSQL does most of the work measures PostgreSQL: its ratio is set
by how much scanning or writing the author asked for, and a reader takes it for a property of the
workload. There was a deliberately server-dominated row here as a control; it was removed, because
swept across scan sizes its speedup read 1.04x, 0.95x, 1.00x and 0.94x - it was not doing that job
either. The sign test is the guard instead.

## Results

### Reading

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| point read - 1 row of 9 columns | 0.275 ms<br>**19 KB/call** | **0.246 ms**<br>28 KB/call | **1.12x**<br>+43% |
| page of 100 - 100 rows of 9 columns, mixed types | 0.626 ms<br>229 KB/call | **0.528 ms**<br>**164 KB/call** | **1.19x**<br>**-28%** |
| all 5000 rows - 5000 rows of 9 columns | 5.285 ms<br>10.8 MB/call | **3.925 ms**<br>**6.8 MB/call** | **1.35x**<br>**-37%** |
| float8 spread over rows - 5000 rows of 1 value | 1.035 ms<br>1.2 MB/call | **0.624 ms**<br>**1.0 MB/call** | **1.66x**<br>**-11%** |
| float8 packed in one row - 1 row holding 1 array of 5000 values | 2.133 ms<br>2.7 MB/call | **0.554 ms**<br>**215 KB/call** | **3.85x**<br>**-92%** |
| int4[] of 100k - 1 row holding 1 array of 100 000 values | 22.029 ms<br>23.0 MB/call | **5.448 ms**<br>**2.2 MB/call** | **4.04x**<br>**-90%** |
| bytea of 4 MB - 1 row holding 4 MB | 29.600 ms<br>51.8 MB/call | **13.231 ms**<br>**4.0 MB/call** | **2.24x**<br>**-92%** |

### Writing

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| insert one row - 1 row of 2 columns | 0.228 ms<br>**13 KB/call** | **0.198 ms**<br>24 KB/call | **1.15x**<br>+90% |
| write a 4 MB bytea - 1 parameter of 4 MB - the clock is the socket, the allocation is not | 13.500 ms<br>5.4 MB/call | **12.743 ms**<br>**3.7 MB/call** | **1.06x**<br>**-31%** |

### Through TypeORM

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| findOneBy - 1 entity of 9 columns | 0.308 ms<br>**64 KB/call** | **0.267 ms**<br>70 KB/call | **1.15x**<br>+11% |
| find 100 entities - 100 entities of 9 columns | 0.559 ms<br>410 KB/call | **0.490 ms**<br>**311 KB/call** | **1.14x**<br>**-24%** |
| find 5000 entities - 5000 entities of 9 columns | 7.603 ms<br>16.2 MB/call | **5.647 ms**<br>**11.0 MB/call** | **1.35x**<br>**-32%** |
| queryBuilder, 500 entities - 500 entities after a where and an order by | 1.104 ms<br>1.7 MB/call | **0.932 ms**<br>**1.0 MB/call** | **1.18x**<br>**-38%** |
| findOne with a 4 MB bytea - 1 entity holding 4 MB | 29.880 ms<br>51.1 MB/call | **13.835 ms**<br>**4.0 MB/call** | **2.16x**<br>**-92%** |
| findOne with a 100k int4[] - 1 entity holding 1 array of 100 000 values | 22.353 ms<br>23.5 MB/call | **5.607 ms**<br>**2.2 MB/call** | **3.99x**<br>**-91%** |
| save one entity - 1 entity of 1 assigned column | 0.614 ms<br>**78 KB/call** | **0.567 ms**<br>101 KB/call | **1.08x**<br>+30% |

## Reading them

**Large payloads are where it wins, and it wins them twice.** **int4[] of 100k** 4.04x, **findOne with a 100k int4[]** 3.99x, **float8 packed in one row** 3.85x, **bytea of 4 MB** 2.24x, **findOne with a 4 MB bytea** 2.16x on the clock; on
allocation, **bytea of 4 MB** 4.0 MB/call against 51.8 MB, **float8 packed in one row** 215 KB/call against 2.7 MB, **findOne with a 4 MB bytea** 4.0 MB/call against 51.1 MB, **findOne with a 100k int4[]** 2.2 MB/call against 23.5 MB, **int4[] of 100k** 2.2 MB/call against 23.0 MB. Those columns arrive in PostgreSQL's binary format rather than as text to be
parsed, and the parse is most of what that saves - `pg` has to materialise the whole value as a
string first.

**What decides it is values per row, not values.** `float8 spread over rows` and `float8 packed in one row` hold the
same 5000 `float8`s and differ in nothing but shape. Spread over rows the two are close, 1.66x on the
clock and -11% on allocation, because the protocol's per-row cost is most of what either client
pays. Packed into one row it is 3.85x and -92% - and `pg` gets worse rather than this
client getting better, because one row of 5000 values is one long array literal with a substring cut
per element.

**Entity hydration dilutes the ordinary gain and not the payload one**, which is the reason both
levels are here. `findOne` on a row holding 4 MB reads 13.835 ms against 29.880 ms and 4.0 MB
against 51.1 MB - within a few percent of the same read through `query()`, because what TypeORM
adds is per entity and the payload is one. On a shape of many small entities it is the layer above
that decides the ratio.

**It allocates more per call on small ones**: **insert one row** 24 KB against 13 KB, **point read** 28 KB against 19 KB, **save one entity** 101 KB against 78 KB, **findOneBy** 70 KB against 64 KB. A higher fixed cost per call and a much
lower marginal cost per byte is the shape of it.

## Where it comes from

The driver against *itself* with one thing turned off, so what the tables above show can be
attributed rather than guessed at. Same alternation, same sign test.

| mechanism | without | with | |
| --- | --- | --- | --- |
| prepared statements - the same parameterized read, against `prepare: false` | 0.287 ms | **0.251 ms** | **1.14x**<br>395/401 |

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
| all 5000 rows | 6.1 MB | 2.9 MB → 770 KB idle |
| float8 spread over rows | 1.3 MB | 1019 KB → 732 KB idle |
| float8 packed in one row | 609 KB | 705 KB |
| int4[] of 100k | 2.3 MB | 1.4 MB → 668 KB idle |
| bytea of 4 MB | 7.2 MB | 3.3 MB → ≈0 idle |
| insert one row | 459 KB | 629 KB |
| write a 4 MB bytea | ≈0 | 3.2 MB → ≈0 idle |
| findOneBy | 1.5 MB | 1.6 MB |
| find 100 entities | 1.5 MB | 1.8 MB |
| find 5000 entities | 4.2 MB | 3.8 MB → 1.5 MB idle |
| queryBuilder, 500 entities | 1.8 MB | 1.8 MB |
| findOne with a 4 MB bytea | 3.9 MB | 4.0 MB → ≈0 idle |
| findOne with a 100k int4[] | 804 KB | 2.2 MB → 1.5 MB idle |
| save one entity | 1.6 MB | 1.7 MB |
