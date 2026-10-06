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

### Reading

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| point read - 1 row of 9 columns | 0.297 ms<br>**17 KB/call** | **0.255 ms**<br>18 KB/call | **1.16x**<br>+5% |
| page of 100 - 100 rows of 9 columns, mixed types | 0.546 ms<br>236 KB/call | **0.468 ms**<br>**156 KB/call** | **1.17x**<br>**-34%** |
| all 5000 rows - 5000 rows of 9 columns | 6.184 ms<br>10.3 MB/call | **4.078 ms**<br>**6.9 MB/call** | **1.52x**<br>**-34%** |
| float8 spread over rows - 5000 rows of 1 value | 1.102 ms<br>1.3 MB/call | **0.764 ms**<br>**1.0 MB/call** | **1.44x**<br>**-24%** |
| float8 packed in one row - 1 row holding 1 array of 5000 values | 2.140 ms<br>2.7 MB/call | **0.579 ms**<br>**213 KB/call** | **3.70x**<br>**-92%** |
| int4[] of 100k - 1 row holding 1 array of 100 000 values | 22.657 ms<br>22.7 MB/call | **5.762 ms**<br>**2.2 MB/call** | **3.93x**<br>**-90%** |
| bytea of 4 MB - 1 row holding 4 MB | 31.232 ms<br>51.4 MB/call | **13.937 ms**<br>**4.0 MB/call** | **2.24x**<br>**-92%** |
| uuid of 5k rows - 5000 rows of 1 value, sixteen bytes against thirty-six characters | 1.318 ms<br>1.5 MB/call | **0.785 ms**<br>**1.3 MB/call** | **1.68x**<br>**-11%** |
| box of 5k rows - 5000 rows of 1 value, asked for as text on both sides | 2.053 ms<br>**1.9 MB/call** | **1.964 ms**<br>2.0 MB/call | 1.05x level<br>+5% |
| concurrent reads - 20 reads at once of 100 rows each, pool of 10 | 3.355 ms<br>4.3 MB/call | **2.612 ms**<br>**3.0 MB/call** | **1.28x**<br>**-32%** |

### Writing

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| insert one row - 1 row, 1 parameter, nothing returned | 0.234 ms<br>**9 KB/call** | **0.196 ms**<br>14 KB/call | **1.19x**<br>+52% |
| insert 500 rows - 500 rows in 1 statement, 2500 parameters | 3.366 ms<br>**948 KB/call** | **3.238 ms**<br>1.0 MB/call | 1.04x level<br>+11% |
| write a 100k int4[] - 1 parameter holding 100 000 values, text on both sides | 18.142 ms<br>**27.2 MB/call** | **17.835 ms**<br>27.5 MB/call | 1.02x level<br>+1% |
| twenty inserts in a transaction - 20 rows, one statement each, inside one transaction | 4.973 ms<br>**164 KB/call** | **4.241 ms**<br>266 KB/call | **1.17x**<br>+62% |

### Through TypeORM

| Scenario | `pg`<br>allocated per call | `typeorm-postgrejs`<br>allocated per call | |
| --- | --- | --- | --- |
| findOneBy - 1 entity of 9 columns | 0.313 ms<br>**64 KB/call** | **0.269 ms**<br>68 KB/call | **1.17x**<br>+6% |
| find 100 entities - 100 entities of 9 columns | 0.593 ms<br>404 KB/call | **0.520 ms**<br>**313 KB/call** | **1.14x**<br>**-22%** |
| find 5000 entities - 5000 entities of 9 columns | 9.081 ms<br>15.9 MB/call | **6.014 ms**<br>**11.1 MB/call** | **1.51x**<br>**-30%** |
| queryBuilder, 500 entities - 500 entities after a where and an order by | 1.166 ms<br>1.7 MB/call | **0.974 ms**<br>**1.1 MB/call** | **1.20x**<br>**-37%** |
| findOne with a 4 MB bytea - 1 entity holding 4 MB | 30.789 ms<br>51.6 MB/call | **14.465 ms**<br>**4.1 MB/call** | **2.13x**<br>**-92%** |
| findOne with a 100k int4[] - 1 entity holding 1 array of 100 000 values | 22.628 ms<br>22.3 MB/call | **6.017 ms**<br>**2.2 MB/call** | **3.76x**<br>**-90%** |
| save one entity - 1 entity of 1 assigned column | 0.642 ms<br>**79 KB/call** | **0.582 ms**<br>97 KB/call | **1.10x**<br>+23% |

## Reading them

**Large payloads are where it wins, and it wins them twice.** **int4[] of 100k** 3.93x, **findOne with a 100k int4[]** 3.76x, **float8 packed in one row** 3.70x, **bytea of 4 MB** 2.24x, **findOne with a 4 MB bytea** 2.13x on the clock; on
allocation, **float8 packed in one row** 213 KB/call against 2.7 MB, **bytea of 4 MB** 4.0 MB/call against 51.4 MB, **findOne with a 4 MB bytea** 4.1 MB/call against 51.6 MB, **int4[] of 100k** 2.2 MB/call against 22.7 MB, **findOne with a 100k int4[]** 2.2 MB/call against 22.3 MB. Those columns arrive in PostgreSQL's binary format rather than as text to be
parsed, and the parse is most of what that saves - `pg` has to materialise the whole value as a
string first.

**What decides it is values per row, not values.** `float8 spread over rows` and `float8 packed in one row` hold the
same 5000 `float8`s and differ in nothing but shape. Spread over rows the two are close, 1.44x on the
clock and -24% on allocation, because the protocol's per-row cost is most of what either client
pays. Packed into one row it is 3.70x and -92% - and `pg` gets worse rather than this
client getting better, because one row of 5000 values is one long array literal with a substring cut
per element.

**Entity hydration dilutes the ordinary gain and not the payload one**, which is the reason both
levels are here. `findOne` on a row holding 4 MB reads 14.465 ms against 30.789 ms and 4.1 MB
against 51.6 MB - within a few percent of the same read through `query()`, because what TypeORM
adds is per entity and the payload is one. On a shape of many small entities it is the layer above
that decides the ratio.

**It allocates more per call on small ones**: **twenty inserts in a transaction** 266 KB against 164 KB, **insert one row** 14 KB against 9 KB, **save one entity** 97 KB against 79 KB, **insert 500 rows** 1.0 MB against 948 KB, **findOneBy** 68 KB against 64 KB, **point read** 18 KB against 17 KB, **box of 5k rows** 2.0 MB against 1.9 MB, **write a 100k int4[]** 27.5 MB against 27.2 MB. A higher fixed cost per call and a much
lower marginal cost per byte is the shape of it, and that first part is charged **per statement**
rather than per byte - which is worth knowing before reading a percentage off that list. Swept
across insert
shapes, the **gap** moves between about 4 and 8 KB a statement while the **percentage** moves by a
factor of nine:

```
                                  pg      here      gap
  1 parameter                   8.2      13.8      5.6      +68%
  1 parameter, returning id    10.3      14.1      3.8      +37%
  5 parameters                  9.0      15.4      6.5      +72%
  5 parameters, returning *    17.0      18.4      1.4       +8%
  10 rows of 5                 23.2      31.3      8.1      +35%
```

Nothing about either client changes across those five; the denominator does. A row that asks for
one small statement is near the top of that range by construction, and the three rows above are
the three smallest statements in the set.

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
| prepared statements - the same parameterized read, against `prepare: false` | 0.288 ms | **0.250 ms** | **1.16x**<br>394/401 |

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
| point read | 448 KB | 640 KB |
| page of 100 | 552 KB | 775 KB |
| all 5000 rows | 3.2 MB | 2.8 MB → 705 KB idle |
| float8 spread over rows | 832 KB | 952 KB → 649 KB idle |
| float8 packed in one row | 470 KB | 625 KB |
| int4[] of 100k | ≈0 | 1.4 MB → 587 KB idle |
| bytea of 4 MB | 3.1 MB | 3.2 MB → ≈0 idle |
| uuid of 5k rows | 1.0 MB | 1.1 MB → 655 KB idle |
| box of 5k rows | 1.3 MB | 1.4 MB → 694 KB idle |
| insert one row | 346 KB | 543 KB |
| insert 500 rows | 414 KB | 752 KB |
| write a 100k int4[] | 348 KB | 1.7 MB → 522 KB idle |
| twenty inserts in a transaction | 467 KB | 679 KB |
| concurrent reads | 2.5 MB | 2.1 MB → 1.2 MB idle |
| findOneBy | 1.2 MB | 1.4 MB |
| find 100 entities | 1.2 MB | 1.7 MB |
| find 5000 entities | 3.9 MB | 3.6 MB → 1.4 MB idle |
| queryBuilder, 500 entities | 1.5 MB | 1.7 MB |
| findOne with a 4 MB bytea | 3.7 MB | 3.9 MB → ≈0 idle |
| findOne with a 100k int4[] | 628 KB | 2.1 MB → 1.3 MB idle |
| save one entity | 1.3 MB | 1.6 MB |
