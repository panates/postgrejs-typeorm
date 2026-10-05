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
| point read - 1 row of 9 columns | 0.270 ms<br>**20 KB/call** | **0.235 ms**<br>27 KB/call | **1.15x**<br>+37% |
| page of 100 - 100 rows of 9 columns, mixed types | 0.525 ms<br>231 KB/call | **0.457 ms**<br>**161 KB/call** | **1.15x**<br>**-30%** |
| all 5000 rows - 5000 rows of 9 columns | **5.558 ms**<br>10.3 MB/call | 5.689 ms<br>**6.8 MB/call** | 0.98x level<br>**-34%** |
| float8 spread over rows - 5000 rows of 1 value | 1.055 ms<br>1.2 MB/call | **0.648 ms**<br>**1015 KB/call** | **1.63x**<br>**-16%** |
| float8 packed in one row - 1 row holding 1 array of 5000 values | 2.184 ms<br>2.8 MB/call | **0.576 ms**<br>**222 KB/call** | **3.79x**<br>**-92%** |
| int4[] of 100k - 1 row holding 1 array of 100 000 values | 22.266 ms<br>22.5 MB/call | **5.644 ms**<br>**2.2 MB/call** | **3.95x**<br>**-90%** |
| bytea of 4 MB - 1 row holding 4 MB | 30.337 ms<br>51.5 MB/call | **13.730 ms**<br>**4.0 MB/call** | **2.21x**<br>**-92%** |
| uuid of 5k rows - 5000 rows of 1 value, sixteen bytes against thirty-six characters | 1.245 ms<br>**1.3 MB/call** | **0.798 ms**<br>1.4 MB/call | **1.56x**<br>+3% |
| box of 5k rows - 5000 rows of 1 value, asked for as text on both sides | 2.038 ms<br>**1.8 MB/call** | **1.984 ms**<br>2.0 MB/call | 1.03x level<br>+9% |
| concurrent reads - 20 reads at once of 1 row each, pool of 10 | 1.062 ms<br>**310 KB/call** | **1.037 ms**<br>452 KB/call | 1.02x level<br>+46% |

### Writing

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| insert one row - 1 row of 2 columns | 0.238 ms<br>**12 KB/call** | **0.202 ms**<br>24 KB/call | **1.18x**<br>+93% |
| insert 500 rows - 500 rows in 1 statement, 2500 parameters | 3.086 ms<br>**879 KB/call** | **2.504 ms**<br>1.2 MB/call | **1.23x**<br>+41% |
| write a 100k int4[] - 1 parameter holding 100 000 values, text on both sides | **18.134 ms**<br>27.3 MB/call | 18.162 ms<br>28.1 MB/call | 1.00x level<br>+3% level |
| twenty inserts in a transaction - 20 rows, one statement each, inside one transaction | 5.041 ms<br>**171 KB/call** | **4.280 ms**<br>312 KB/call | **1.18x**<br>+82% |
| write a 4 MB bytea - 1 parameter of 4 MB - the clock is the socket, the allocation is not | 14.092 ms<br>5.5 MB/call | **13.049 ms**<br>**3.6 MB/call** | **1.08x**<br>**-35%** |

### Through TypeORM

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| findOneBy - 1 entity of 9 columns | 0.302 ms<br>**64 KB/call** | **0.261 ms**<br>70 KB/call | **1.16x**<br>+9% |
| find 100 entities - 100 entities of 9 columns | 0.570 ms<br>429 KB/call | **0.496 ms**<br>**313 KB/call** | **1.15x**<br>**-27%** |
| find 5000 entities - 5000 entities of 9 columns | 7.912 ms<br>16.5 MB/call | **5.781 ms**<br>**11.2 MB/call** | **1.37x**<br>**-32%** |
| queryBuilder, 500 entities - 500 entities after a where and an order by | 1.140 ms<br>1.8 MB/call | **0.907 ms**<br>**1.0 MB/call** | **1.26x**<br>**-41%** |
| findOne with a 4 MB bytea - 1 entity holding 4 MB | 30.584 ms<br>51.0 MB/call | **14.279 ms**<br>**4.0 MB/call** | **2.14x**<br>**-92%** |
| findOne with a 100k int4[] - 1 entity holding 1 array of 100 000 values | 22.636 ms<br>24.5 MB/call | **5.840 ms**<br>**2.2 MB/call** | **3.88x**<br>**-91%** |
| save one entity - 1 entity of 1 assigned column | 0.629 ms<br>**78 KB/call** | **0.577 ms**<br>102 KB/call | **1.09x**<br>+31% |

## Reading them

**Large payloads are where it wins, and it wins them twice.** **int4[] of 100k** 3.95x, **findOne with a 100k int4[]** 3.88x, **float8 packed in one row** 3.79x, **bytea of 4 MB** 2.21x, **findOne with a 4 MB bytea** 2.14x on the clock; on
allocation, **bytea of 4 MB** 4.0 MB/call against 51.5 MB, **findOne with a 4 MB bytea** 4.0 MB/call against 51.0 MB, **float8 packed in one row** 222 KB/call against 2.8 MB, **findOne with a 100k int4[]** 2.2 MB/call against 24.5 MB, **int4[] of 100k** 2.2 MB/call against 22.5 MB. Those columns arrive in PostgreSQL's binary format rather than as text to be
parsed, and the parse is most of what that saves - `pg` has to materialise the whole value as a
string first.

**What decides it is values per row, not values.** `float8 spread over rows` and `float8 packed in one row` hold the
same 5000 `float8`s and differ in nothing but shape. Spread over rows the two are close, 1.63x on the
clock and -16% on allocation, because the protocol's per-row cost is most of what either client
pays. Packed into one row it is 3.79x and -92% - and `pg` gets worse rather than this
client getting better, because one row of 5000 values is one long array literal with a substring cut
per element.

**Entity hydration dilutes the ordinary gain and not the payload one**, which is the reason both
levels are here. `findOne` on a row holding 4 MB reads 14.279 ms against 30.584 ms and 4.0 MB
against 51.0 MB - within a few percent of the same read through `query()`, because what TypeORM
adds is per entity and the payload is one. On a shape of many small entities it is the layer above
that decides the ratio.

**It allocates more per call on small ones**: **insert one row** 24 KB against 12 KB, **twenty inserts in a transaction** 312 KB against 171 KB, **concurrent reads** 452 KB against 310 KB, **insert 500 rows** 1.2 MB against 879 KB, **point read** 27 KB against 20 KB, **save one entity** 102 KB against 78 KB, **box of 5k rows** 2.0 MB against 1.8 MB, **findOneBy** 70 KB against 64 KB, **uuid of 5k rows** 1.4 MB against 1.3 MB. A higher fixed cost per call and a much
lower marginal cost per byte is the shape of it.

## Where it comes from

The driver against *itself* with one thing turned off, so what the tables above show can be
attributed rather than guessed at. Same alternation, same sign test.

| mechanism | without | with | |
| --- | --- | --- | --- |
| prepared statements - the same parameterized read, against `prepare: false` | 0.298 ms | **0.257 ms** | **1.16x**<br>390/401 |

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
| page of 100 | 729 KB | 855 KB |
| all 5000 rows | 6.1 MB | 2.9 MB → 793 KB idle |
| float8 spread over rows | 1.3 MB | 997 KB → 726 KB idle |
| float8 packed in one row | 618 KB | 750 KB |
| int4[] of 100k | 916 KB | 1.4 MB → 668 KB idle |
| bytea of 4 MB | 7.2 MB | 3.3 MB → ≈0 idle |
| uuid of 5k rows | 1.8 MB | 1.2 MB → 740 KB idle |
| box of 5k rows | 2.1 MB | 1.4 MB → 752 KB idle |
| insert one row | 460 KB | 630 KB |
| insert 500 rows | 628 KB | 799 KB |
| write a 100k int4[] | 459 KB | 1.8 MB → 593 KB idle |
| twenty inserts in a transaction | 560 KB | 788 KB |
| write a 4 MB bytea | ≈0 | 3.2 MB → ≈0 idle |
| concurrent reads | 992 KB | 1.3 MB |
| findOneBy | 1.5 MB | 1.6 MB |
| find 100 entities | 1.5 MB | 1.8 MB |
| find 5000 entities | 4.1 MB | 3.8 MB → 1.5 MB idle |
| queryBuilder, 500 entities | 1.8 MB | 1.8 MB |
| findOne with a 4 MB bytea | 4.0 MB | 4.0 MB → ≈0 idle |
| findOne with a 100k int4[] | 756 KB | 2.3 MB → 1.5 MB idle |
| save one entity | 1.6 MB | 1.7 MB |
