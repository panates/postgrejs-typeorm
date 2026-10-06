# The same TypeORM calls, on both clients

Generated from `benchmark/results/latest.json` by `benchmark/render-report.mjs`. Re-measure with
`node benchmark/bench.mjs`; nothing here is written by hand.

Node v24.15.0, `postgrejs` 3.12.1, `pg` 8.23.0, `typeorm` 1.1.1,
PostgreSQL 18.6 on loopback. Prepared statements: default (cached per connection).

> **The PostgreJS measured here is not a published build** - it is a build put into node_modules by hand, where the lockfile installed 3.12.2.
> This package is developed against the build in the next directory, because PostgreJS releases
> before it does and an unreleased fix is a scheduling detail, so these figures lead the registry
> rather than describing it. Installing 3.12.1 will not reproduce them.
> Re-measure before release.
PostgreJS's `asyncErrorHandling` is **off** here: it
captures a caller-preserving async stack on every call and `pg` has nothing equivalent, so
leaving it on would charge one client for a feature the comparison does not cover. Measured, it is
worth less than this harness's estimator can resolve - it is off to be like-for-like, not to move a
row.

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

**Two axes, three tables, and the join is worth knowing before reading them.** Every scenario is
either a read or a write, and runs either on a bare connection or through a TypeORM repository:

| | without the ORM | through TypeORM |
| --- | --- | --- |
| reading | 10 rows | 11 rows |
| writing | 4 rows | 4 rows |

**The right-hand column is the one to read**, and it is the reason this file exists rather than
PostgreJS's own benchmark. A reader of this package runs TypeORM; what they get is the right-hand
column, hydration included. Every shape in the left-hand column has a counterpart in the right-hand
one so that the two can be compared directly.

The left-hand column is kept for attribution rather than as a headline: entity hydration sits on
top of everything and dilutes any gain, so a row that moves at both levels is the client's and a
row that moves only at one is the layer above it. Neither answer substitutes for the other, and
without the raw level there is no way to tell which of the two a number belongs to.

### Through TypeORM, reading

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| findOneBy - 1 entity of 9 columns | 0.301 ms<br>**64 KB/call** | **0.258 ms**<br>68 KB/call | **1.17x**<br>+7% |
| find 100 entities - 100 entities of 9 columns | 0.583 ms<br>403 KB/call | **0.509 ms**<br>**313 KB/call** | **1.14x**<br>**-22%** |
| find 5000 entities - 5000 entities of 9 columns | 8.248 ms<br>15.9 MB/call | **5.926 ms**<br>**11.2 MB/call** | **1.39x**<br>**-30%** |
| queryBuilder, 500 entities - 500 entities after a where and an order by | 1.192 ms<br>1.7 MB/call | **0.997 ms**<br>**1.0 MB/call** | **1.20x**<br>**-39%** |
| findOne with a 4 MB bytea - 1 entity holding 4 MB | 34.391 ms<br>51.3 MB/call | **15.201 ms**<br>**4.1 MB/call** | **2.26x**<br>**-92%** |
| findOne with a 100k int4[] - 1 entity holding 1 array of 100 000 values | 22.976 ms<br>22.9 MB/call | **5.966 ms**<br>**2.2 MB/call** | **3.85x**<br>**-90%** |
| find 5000 floats - 5000 entities of 1 float8 | 2.219 ms<br>4.5 MB/call | **1.606 ms**<br>4.0 MB/call | **1.38x**<br>-11% level |
| findOne a 5000-float array - 1 entity holding 1 array of 5000 float8 | 2.153 ms<br>2.9 MB/call | **0.602 ms**<br>**251 KB/call** | **3.58x**<br>**-91%** |
| find 5000 uuids - 5000 entities of 1 uuid | 2.254 ms<br>4.6 MB/call | **1.740 ms**<br>4.1 MB/call | **1.30x**<br>-10% level |
| find 5000 boxes - 5000 entities of 1 box, asked for as text on both sides | **2.964 ms**<br>5.2 MB/call | 3.031 ms<br>4.7 MB/call | 0.98x level<br>-10% level |
| concurrent finds - 20 finds at once of 100 entities each, pool of 10 | 4.310 ms<br>7.1 MB/call | **3.739 ms**<br>**5.7 MB/call** | **1.15x**<br>**-21%** |

### Through TypeORM, writing

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| save one entity - 1 entity of 9 assigned columns, mixed types | 0.692 ms<br>**104 KB/call** | **0.624 ms**<br>122 KB/call | **1.11x**<br>+17% |
| insert 500 entities - 500 entities of 9 mixed columns in 1 statement | 10.672 ms<br>9.0 MB/call | **9.671 ms**<br>**8.2 MB/call** | **1.10x**<br>**-9%** |
| save a 100k int4[] - 1 entity holding 1 array of 100 000 values | 18.217 ms<br>27.3 MB/call | **12.630 ms**<br>**1020 KB/call** | **1.44x**<br>**-96%** |
| twenty saves in a transaction - 20 entities of 9 mixed columns, one statement each, in one transaction | 6.938 ms<br>**977 KB/call** | **5.875 ms**<br>1021 KB/call | **1.18x**<br>+4% |

### Reading, without the ORM

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| point read - 1 row of 9 columns | 0.277 ms<br>16 KB/call | **0.239 ms**<br>18 KB/call | **1.16x**<br>+9% level |
| page of 100 - 100 rows of 9 columns, mixed types | 0.543 ms<br>235 KB/call | **0.461 ms**<br>**156 KB/call** | **1.18x**<br>**-34%** |
| all 5000 rows - 5000 rows of 9 columns | 6.227 ms<br>10.2 MB/call | **5.712 ms**<br>**6.8 MB/call** | **1.09x**<br>**-33%** |
| float8 spread over rows - 5000 rows of 1 value | 1.191 ms<br>1.3 MB/call | **0.805 ms**<br>**1.0 MB/call** | **1.48x**<br>**-25%** |
| float8 packed in one row - 1 row holding 1 array of 5000 values | 2.097 ms<br>2.7 MB/call | **0.581 ms**<br>**211 KB/call** | **3.61x**<br>**-92%** |
| int4[] of 100k - 1 row holding 1 array of 100 000 values | 22.818 ms<br>23.5 MB/call | **5.881 ms**<br>**2.2 MB/call** | **3.88x**<br>**-91%** |
| bytea of 4 MB - 1 row holding 4 MB | 33.805 ms<br>51.6 MB/call | **14.660 ms**<br>**4.0 MB/call** | **2.31x**<br>**-92%** |
| uuid of 5k rows - 5000 rows of 1 value, sixteen bytes against thirty-six characters | 1.259 ms<br>1.5 MB/call | **0.874 ms**<br>**1.3 MB/call** | **1.44x**<br>**-9%** |
| box of 5k rows - 5000 rows of 1 value, asked for as text on both sides | 2.246 ms<br>**1.9 MB/call** | **2.010 ms**<br>2.0 MB/call | **1.12x**<br>+3% |
| concurrent reads - 20 reads at once of 100 rows each, pool of 10 | 3.575 ms<br>4.4 MB/call | **2.887 ms**<br>**2.9 MB/call** | **1.24x**<br>**-34%** |

### Writing, without the ORM

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| insert one row - 1 row of 9 mixed columns, returning the key | 0.268 ms<br>**16 KB/call** | **0.223 ms**<br>18 KB/call | **1.20x**<br>+12% |
| insert 500 rows - 500 rows of 9 mixed columns in 1 statement, 4500 parameters | 6.742 ms<br>2.5 MB/call | **5.874 ms**<br>**1.9 MB/call** | **1.15x**<br>**-24%** |
| write a 100k int4[] - 1 parameter holding 100 000 values, text on both sides, built by each client | 18.282 ms<br>27.3 MB/call | **13.081 ms**<br>**982 KB/call** | **1.40x**<br>**-96%** |
| twenty inserts in a transaction - 20 rows of 9 mixed columns, one statement each, returning the key, in one transaction | 5.588 ms<br>**293 KB/call** | **4.583 ms**<br>349 KB/call | **1.22x**<br>+19% |

## Reading them

**Large payloads are where it wins, and it wins them twice.** **int4[] of 100k** 3.88x, **findOne with a 100k int4[]** 3.85x, **float8 packed in one row** 3.61x, **findOne a 5000-float array** 3.58x, **bytea of 4 MB** 2.31x, **findOne with a 4 MB bytea** 2.26x, **save a 100k int4[]** 1.44x on the clock; on
allocation, **save a 100k int4[]** 1020 KB/call against 27.3 MB, **float8 packed in one row** 211 KB/call against 2.7 MB, **bytea of 4 MB** 4.0 MB/call against 51.6 MB, **findOne with a 4 MB bytea** 4.1 MB/call against 51.3 MB, **findOne a 5000-float array** 251 KB/call against 2.9 MB, **int4[] of 100k** 2.2 MB/call against 23.5 MB, **findOne with a 100k int4[]** 2.2 MB/call against 22.9 MB. Those columns arrive in PostgreSQL's binary format rather than as text to be
parsed, and the parse is most of what that saves - `pg` has to materialise the whole value as a
string first.

**What decides it is values per row, not values.** `float8 spread over rows` and `float8 packed in one row` hold the
same 5000 `float8`s and differ in nothing but shape. Spread over rows the two are close, 1.48x on the
clock and -25% on allocation, because the protocol's per-row cost is most of what either client
pays. Packed into one row it is 3.61x and -92% - and `pg` gets worse rather than this
client getting better, because one row of 5000 values is one long array literal with a substring cut
per element.

**Entity hydration dilutes the ordinary gain and not the payload one**, which is the reason both
levels are here. `findOne` on a row holding 4 MB reads 15.201 ms against 34.391 ms and 4.1 MB
against 51.3 MB - within a few percent of the same read through `query()`, because what TypeORM
adds is per entity and the payload is one. On a shape of many small entities it is the layer above
that decides the ratio.

**It allocates more per call on small ones**: **twenty inserts in a transaction** 349 KB against 293 KB, **save one entity** 122 KB against 104 KB, **insert one row** 18 KB against 16 KB, **findOneBy** 68 KB against 64 KB, **twenty saves in a transaction** 1021 KB against 977 KB, **box of 5k rows** 2.0 MB against 1.9 MB. A higher fixed cost per call and a much
lower marginal cost per byte is the shape of it, and that first part is charged **per statement**
rather than per byte - which is worth knowing before reading a percentage off that list. Swept
across insert
shapes, the **gap** moves between about 4 and 8 KB a statement while the **percentage** moves by a
factor of nine:

```
                                  pg      here      gap
  1 parameter                   8.1      13.4      5.3      +66%
  1 parameter, returning id    10.5      14.4      3.9      +37%
  5 parameters                 10.2      14.6      4.4      +43%
  5 parameters, returning *    17.3      19.9      2.6      +15%
  10 rows of 5                 23.8      30.4      6.6      +28%
```

Nothing about either client changes across those five; the denominator does. A row that asks for
one small statement is near the top of that range by construction. **Returning anything at all is
what moves it most**, because until the statement gives the decoder work the comparison excludes
the only thing this package is faster at - which is why the write scenarios here carry a row of
mixed columns and read the key back, the way TypeORM's own insert does.

Most of the gap is not this package. The same one-parameter statement, one client per process,
medians of three: `pg` 8.4 KB a call, PostgreJS with nothing on it 12.9, this facade 14.2 - so
about 4.5 KB is the client underneath and 1.4 KB is what the facade adds. The larger share is
reported upstream rather than worked around here, which is this package's rule for anything that
belongs to the client, and `flexy-buffer@1.1.2` in PostgreJS 3.12.2 is the first instalment
coming back: it took two `setTimeout`s a query out of the send buffer.

## Where it comes from

The driver against *itself* with one thing turned off, so what the tables above show can be
attributed rather than guessed at. Same alternation, same sign test.

| mechanism | without | with | |
| --- | --- | --- | --- |
| prepared statements - the same parameterized read, against `prepare: false` | 0.314 ms | **0.266 ms** | **1.18x**<br>390/401 |

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
| point read | 448 KB | 677 KB |
| page of 100 | 556 KB | 803 KB |
| all 5000 rows | 3.3 MB | 2.9 MB → 734 KB idle |
| float8 spread over rows | 855 KB | 970 KB → 682 KB idle |
| float8 packed in one row | 502 KB | 720 KB |
| int4[] of 100k | ≈0 | 1.4 MB → 617 KB idle |
| bytea of 4 MB | 3.1 MB | 3.2 MB → ≈0 idle |
| uuid of 5k rows | 1.0 MB | 1.1 MB → 695 KB idle |
| box of 5k rows | 1.2 MB | 1.4 MB → 727 KB idle |
| insert one row | 437 KB | 677 KB |
| insert 500 rows | 459 KB | 1.0 MB |
| write a 100k int4[] | 356 KB | 1.6 MB → 551 KB idle |
| twenty inserts in a transaction | 557 KB | 855 KB |
| concurrent reads | 2.5 MB | 2.1 MB → 1.2 MB idle |
| findOneBy | 1.2 MB | 1.5 MB |
| find 100 entities | 1.2 MB | 1.7 MB |
| find 5000 entities | 3.9 MB | 3.7 MB → 1.4 MB idle |
| queryBuilder, 500 entities | 1.5 MB | 1.7 MB |
| findOne with a 4 MB bytea | 3.7 MB | 3.9 MB → ≈0 idle |
| findOne with a 100k int4[] | 670 KB | 2.2 MB → 1.4 MB idle |
| save one entity | 1.4 MB | 1.7 MB |
| find 5000 floats | 1.5 MB | 1.8 MB → 1.4 MB idle |
| findOne a 5000-float array | 1.2 MB | 1.4 MB |
| find 5000 uuids | 1.7 MB | 2.0 MB → 1.4 MB idle |
| find 5000 boxes | 1.9 MB | 2.2 MB → 1.4 MB idle |
| insert 500 entities | 1.3 MB | 2.0 MB |
| save a 100k int4[] | 1.0 MB | 2.3 MB → 1.3 MB idle |
| twenty saves in a transaction | 1.3 MB | 1.6 MB |
| concurrent finds | 2.6 MB | 3.4 MB → 2.4 MB idle |
