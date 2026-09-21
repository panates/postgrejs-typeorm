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
 *   log and match on. PostgreJS 3.8 keeps the undecorated text on
 *   `serverMessage`, so on that version this is a copy rather than a parse.
 * - `position` is a number where `pg` gives a string.
 * - `line` means something else on each side - PostgreSQL's own C source line
 *   in `pg`, the SQL text of the line in PostgreJS - and `file`/`routine` are
 *   absent here. Those are left alone: faking them would mean inventing
 *   values, and nothing can be invented for `routine`.
 */

/**
 * Where PostgreJS starts appending its caret diagram.
 *
 * Only used against PostgreJS 3.7, which has no `serverMessage`. Taking the
 * text apart with a regex is guesswork - 3.8 added the field precisely
 * because parsing the decorated message is what callers were doing and it
 * breaks anchored patterns - so it is the fallback, not the method.
 */
const CARET_DIAGRAM = /\n\s+at line \d+ column \d+\n[\s\S]*$/;

export function normalizeError(err: any): any {
  if (!err || typeof err !== 'object') return err;

  // 3.8 keeps PostgreSQL's own text here, decorated or not, which is exactly
  // what `pg` puts in `message`.
  if (typeof err.serverMessage === 'string') {
    err.message = err.serverMessage;
  } else if (typeof err.message === 'string') {
    const stripped = err.message.replace(CARET_DIAGRAM, '');
    // Only touch it when the diagram was actually there, so an error from
    // somewhere else passes through untouched.
    if (stripped !== err.message) err.message = stripped;
  }

  // `pg` reads position off the wire and never parses it.
  if (typeof err.position === 'number') err.position = String(err.position);

  return err;
}
