/**
 * Making a PostgreJS `DatabaseError` read like `pg`'s.
 *
 * Every structured field is already identical - verified across seven error
 * classes (undefined table, syntax, unique, not-null, foreign key, check,
 * division by zero): `code`, `severity`, `constraint`, `detail`, `table`,
 * `column`, `schema`, `hint`, `where`, `dataType`, `internalQuery`,
 * `internalPosition`. TypeORM itself branches on none of them, so this is
 * entirely for the code above it, and for anyone migrating from `pg`.
 *
 * Two differences are worth closing and one is not:
 *
 * - `message` carries a caret diagram pointing into the SQL. Useful, but it
 *   reaches the user through `QueryFailedError`'s message, which `pg` users
 *   log and match on. PostgreJS keeps the undecorated text on
 *   `serverMessage`, so this is a copy rather than a parse - there is no
 *   regex here and there must not be one: taking the decorated text apart is
 *   guesswork, and the field exists precisely because that is what callers
 *   were reduced to.
 * - `position` is a number where `pg` gives a string.
 * - `line` means something else on each side - PostgreSQL's own C source line
 *   in `pg`, the SQL text of the line in PostgreJS - and `file`/`routine` are
 *   absent here. Those are left alone: faking them would mean inventing
 *   values, and nothing can be invented for `routine`.
 */

export function normalizeError(err: any): any {
  if (!err || typeof err !== 'object') return err;

  // PostgreSQL's own text, decorated or not, which is exactly what `pg` puts
  // in `message`. An error from somewhere else has no `serverMessage` and
  // passes through untouched.
  if (typeof err.serverMessage === 'string') err.message = err.serverMessage;

  // `pg` reads position off the wire and never parses it.
  if (typeof err.position === 'number') err.position = String(err.position);

  return err;
}
