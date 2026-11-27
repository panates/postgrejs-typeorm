# The PostgreJS peer floor, and why there is no compatibility code

The peer range is `>=3.13.0 <4`, and that floor is exact rather than cautious. **3.13.0** is where
the parameter policy's two requirements landed, both found by this package:

| what `src/` needs | upstream |
| --- | --- |
| a non-integer scalar declared `numeric`, not `float8` - without it `$1::money` with `12.34` is `42846` | `341f343` |
| an undeclared parameter written the way `pg` writes one - without it a plain object bound at OID 0 is `[object Object]` | `a11a9af` |

Both were verified by behaviour rather than by version number before the floor was moved.

## The floor's history

The floor was `>=3.10.0` until 2026-10-06, for six things that landed in 3.10.0 and that `src/`
still uses. The table is kept because it is the history of what this package has needed:

| what `src/` needs | upstream |
| --- | --- |
| `fetchAsString` naming an array column by its element type | `313c71e` |
| `fetchAsString`'s `{ oid, arrays: false }`, which is how `numeric` is asked for without `numeric[]` | `423977d` |
| the value classes serialising as their fields, not as the literal | `ac5ba39` |
| `toPostgres()` on them, so a value read can be written back | `3d84fb5` |
| `Circle` naming its radius `radius` | `8d30acc` |
| a lost connection reported on `'error'`, not only `'close'` | `93b07c3` |

Every one of those was found by this package's own tests and written up in
`../postgrejs/.claude/local/` rather than worked around here, which is why there is no
compatibility code to delete.

## Why the table does not decide what `src/` carries

Build against the copy in `node_modules`, not against a release. PostgreJS is maintained in the
next directory and released before this package ships, so an unreleased fix is a scheduling detail.
That is why there is no branch, no fallback and no feature test for a published version, and why
`git tag --contains` is not a reason to keep one.

The same reasoning removed the caret-stripping fallback that used to be in `src/errors.ts`:
`serverMessage` is in the build, so the regex was a branch for a version this package will never be
installed against. It was not replaced with anything. An error carrying a caret diagram but no
`serverMessage` did not come from this client, and guessing at its shape is what the field was
added to stop.

## Why a gap goes upstream instead of into a fixup here

The facade carries no post-decode fixups and nothing of `pg`'s: no table that rewrites values after
decoding, no `postgres-interval`, no `postgres-array`. The knowledge of what `pg` answers belongs
in the client that decodes, once, not reconstructed afterwards by every adapter - otherwise the
client's behaviour ends up defined by whichever adapter last worked around it.

That round is done: `value-shapes.ts` and both dependencies are gone, and the divergences that
justified them were closed upstream instead (`313c71e`, `3d84fb5`, `8d30acc`, `ac5ba39`).

`money` is the worked example for why the type matrix is re-run after every upstream bump, not only
the TypeORM suite: a new decoder upstream is a new *divergence* here, because the facade's job is to
answer what `pg` answers - and `pg` has no parser for `money` at all. The suite was silent about it;
the matrix failed on the first run.
