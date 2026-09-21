#!/usr/bin/env bash
#
# Runs TypeORM's own functional suite against this facade, and against `pg`
# in the same invocation.
#
# TypeORM's suite is driven by an ormconfig.json, which cannot carry a
# `driver` object - so one function is patched, `getTypeOrmConfig()` in
# test/utils/test-utils.ts, to read a module path out of the environment and
# hand it to every postgres config. That is the whole integration; everything
# downstream of it already works.
#
# Two things about this suite decide the shape of the script:
#
#   * Its tests leave schema behind and read it back, so the same file scores
#     differently between two runs. Measured on create-table.test.js: 1 pass /
#     4 fail, then 5 pass / 0 fail, with nothing changed. So each file gets
#     its own mocha process and its own freshly reset database.
#   * For the same reason a pinned EXPECTED_FAILURES would be a lie. `pg` is
#     run over the same files, on the same server, in the same invocation,
#     and only a test this facade loses that `pg` wins is a failure.
#
# Everything lands in $WORK_DIR; nothing outside this repository is modified.
#
# Usage: scripts/run-typeorm-suite.sh [pattern ...]
#   TYPEORM_VERSION       git tag to test against (default: 1.1.1)
#   PG_CONNECTION_STRING  server to use; when unset, a container is started
#                         on a free port and removed at the end
#   PG_IMAGE              image for that container (default: postgres:18)
#   WORK_DIR              where the checkout lives
#                         (default: $TMPDIR/typeorm-postgrejs-suite)
#   KEEP_CONTAINER        set to keep the container running afterwards
#   SKIP_BUILD            set when the checkout is already compiled
#
# A pattern is a glob relative to the compiled test tree, e.g.
#   scripts/run-typeorm-suite.sh 'build/compiled/test/functional/query-runner/*.test.js'
set -uo pipefail

TYPEORM_VERSION="${TYPEORM_VERSION:-1.1.1}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${WORK_DIR:-${TMPDIR:-/tmp}/typeorm-postgrejs-suite}"
SRC_DIR="$WORK_DIR/typeorm"
REPORT_DIR="$WORK_DIR/reports"
PG_IMAGE="${PG_IMAGE:-postgres:18}"
CONTAINER_NAME="typeorm-postgrejs-suite-pg"

# The slices this facade is held to. Not the whole suite: most of the other
# 800-odd compiled files are for other databases and self-skip, and the ones
# below are where a `pg` difference would actually show. Override by passing
# patterns on the command line.
DEFAULT_PATTERNS=(
  'build/compiled/test/functional/query-runner/*.test.js'
  'build/compiled/test/functional/transaction/*/*.test.js'
  'build/compiled/test/functional/repository/*/*.test.js'
  'build/compiled/test/functional/persistence/*/*.test.js'
  'build/compiled/test/functional/query-builder/*/*.test.js'
  'build/compiled/test/functional/database-schema/*/*.test.js'
  'build/compiled/test/functional/database-schema/column-types/postgres*/*.test.js'
)
PATTERNS=("$@")
[ ${#PATTERNS[@]} -eq 0 ] && PATTERNS=("${DEFAULT_PATTERNS[@]}")

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

started_container=
cleanup() {
  if [ -n "$started_container" ] && [ -z "${KEEP_CONTAINER:-}" ]; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------- database

if [ -z "${PG_CONNECTION_STRING:-}" ]; then
  command -v docker >/dev/null 2>&1 ||
    die "No PG_CONNECTION_STRING and no docker. Set one or install the other."
  say "Starting $PG_IMAGE"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  # Port 0 lets the daemon pick a free one, so a local server is left alone.
  docker run -d --name "$CONTAINER_NAME" \
    -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=postgres -p 0:5432 "$PG_IMAGE" >/dev/null
  started_container=1
  PORT="$(docker port "$CONTAINER_NAME" 5432 | head -1 | sed 's/.*://')"
  : "${PORT:?the container published no host port}"
  ready=
  for _ in $(seq 1 60); do
    if docker exec "$CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  : "${ready:?postgres did not become ready}"
  PG_CONNECTION_STRING="postgres://postgres:postgres@127.0.0.1:$PORT/postgres"
fi
say "Server: ${PG_CONNECTION_STRING//:*@/:***@}"

# Parsed once here rather than in each of the three places that need parts
# of it.
eval "$(node -e '
  const u = new URL(process.argv[1]);
  const q = s => `'"'"'${String(s).replace(/'"'"'/g, `'"'"'\\'"'"''"'"'`)}'"'"'`;
  console.log(`PGHOST=${q(u.hostname)}`);
  console.log(`PGPORT=${q(u.port || 5432)}`);
  console.log(`PGUSER=${q(decodeURIComponent(u.username) || "postgres")}`);
  console.log(`PGPASSWORD=${q(decodeURIComponent(u.password))}`);
  console.log(`PGDATABASE=${q(u.pathname.slice(1) || "postgres")}`);
' "$PG_CONNECTION_STRING")"
export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE

# ---------------------------------------------------------- the checkout

say "TypeORM $TYPEORM_VERSION in $SRC_DIR"
mkdir -p "$WORK_DIR" "$REPORT_DIR"
if [ ! -d "$SRC_DIR/.git" ]; then
  git clone --filter=blob:none --quiet --no-checkout \
    https://github.com/typeorm/typeorm.git "$SRC_DIR" ||
    die "could not clone typeorm"
fi
git -C "$SRC_DIR" fetch --quiet --depth 1 origin tag "$TYPEORM_VERSION" 2>/dev/null || true
git -C "$SRC_DIR" checkout --quiet --force "$TYPEORM_VERSION" ||
  die "no such typeorm tag: $TYPEORM_VERSION"

cat > "$SRC_DIR/ormconfig.json" <<EOF
[
  {
    "skip": false,
    "name": "postgres",
    "type": "postgres",
    "host": "$PGHOST",
    "port": $PGPORT,
    "username": "$PGUSER",
    "password": "$PGPASSWORD",
    "database": "$PGDATABASE",
    "logging": false
  }
]
EOF

# The one patch. `getTypeOrmConfig()` is `require(ormconfig.json)`, and JSON
# cannot carry a driver object - so the module path arrives by environment
# instead. Applied to the source before compiling, and idempotent: a second
# run over an already-patched checkout is a no-op.
say "Patching getTypeOrmConfig to accept an injected driver"
node - "$SRC_DIR/test/utils/test-utils.ts" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.argv[2];
const src = readFileSync(path, 'utf8');
if (src.includes('TYPEORM_PG_DRIVER')) {
  console.log('    already patched');
  process.exit(0);
}
const anchor = `export function getTypeOrmConfig(): TestingConnectionOptions[] {
    return require(getOrmFilepath())
}`;
if (!src.includes(anchor)) {
  console.error(
    '\x1b[31m    getTypeOrmConfig() is not the shape this script patches.\x1b[0m\n' +
      '    TypeORM changed it; re-read test/utils/test-utils.ts and update the anchor.',
  );
  process.exit(1);
}
writeFileSync(
  path,
  src.replace(
    anchor,
    `export function getTypeOrmConfig(): TestingConnectionOptions[] {
    const configs = require(getOrmFilepath())
    // Injected by scripts/run-typeorm-suite.sh. The postgres driver option
    // is the only seam TypeORM offers (PostgresDriver.loadDependencies()),
    // and an ormconfig.json cannot carry an object.
    const injected = process.env.TYPEORM_PG_DRIVER
    if (injected)
        for (const c of configs)
            if (c.type === "postgres") (c as any).driver = require(injected)
    return configs
}`,
  ),
);
console.log('    patched');
EOF
[ $? -eq 0 ] || die "the patch did not apply"

# ------------------------------------------------------------ install, build

if [ -z "${SKIP_BUILD:-}" ]; then
  say "Installing and compiling TypeORM (slow, once per checkout)"
  # corepack's signature check fails on current Node, and npx pnpm trips
  # TypeORM's own devEngines block - so the download is allowed through
  # instead of being worked around.
  (cd "$SRC_DIR" && COREPACK_INTEGRITY_KEYS=0 pnpm install --ignore-scripts) ||
    die "pnpm install failed"
  (cd "$SRC_DIR" && COREPACK_INTEGRITY_KEYS=0 pnpm run compile) ||
    die "typeorm did not compile"
fi
[ -d "$SRC_DIR/build/compiled/test" ] ||
  die "no compiled tests; re-run without SKIP_BUILD"

say "Building this facade"
(cd "$REPO_DIR" && npm run build >/dev/null) || die "build failed"

# The facade is loaded from where it was built, not copied into the
# checkout's node_modules. It imports nothing from TypeORM - it is a `pg`
# facade, and TypeORM only ever `require()`s the path it is handed - so Node
# resolves its own imports from this repository's node_modules, where
# postgrejs and postgres-interval already are.
#
# Copying it in instead is what the sibling drizzle script does, and it is
# wrong here: that one has to share one copy of drizzle-orm between the suite
# and the driver. Doing it here put postgrejs somewhere its own dependencies
# could not be resolved from, and every test died in a before-hook with
# `Cannot find package 'flexy-buffer'`.
FACADE="$REPO_DIR/build/index.js"
node -e '
  const dir = process.argv[1];
  for (const p of ["postgrejs", "postgres-interval"])
    console.log(`    ${p} ${require(dir + "/node_modules/" + p + "/package.json").version}`);
' "$REPO_DIR"

# ------------------------------------------------------------------ run it

cat > "$WORK_DIR/reset-db.cjs" <<'EOF'
// `drop schema public cascade` rather than dropping the database: the suite
// creates types, sequences and views as well as tables, and leaving any of
// them behind is what makes a second run score differently.
const { Client } = require(process.argv[2] + '/node_modules/pg');
(async () => {
  const c = new Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
  });
  await c.connect();
  await c.query(
    'drop schema if exists public cascade; create schema public;' +
      ' grant all on schema public to public;',
  );
  await c.end();
})().catch(e => {
  console.error(e.message);
  process.exit(1);
});
EOF

cat > "$WORK_DIR/mocharc.json" <<'EOF'
{}
EOF

rm -rf "$REPORT_DIR"
mkdir -p "$REPORT_DIR/control" "$REPORT_DIR/facade"

FILES=()
for pattern in "${PATTERNS[@]}"; do
  while IFS= read -r f; do
    [ -n "$f" ] && FILES+=("$f")
  done < <(cd "$SRC_DIR" && ls $pattern 2>/dev/null)
done
[ ${#FILES[@]} -gt 0 ] || die "no test files matched: ${PATTERNS[*]}"
# The default patterns overlap by design (column-types is under
# database-schema), so the same file can appear twice.
IFS=$'\n' FILES=($(printf '%s\n' "${FILES[@]}" | sort -u)); unset IFS

say "Running ${#FILES[@]} files, each twice, on a freshly reset database"

run_one() {
  local label="$1" file="$2" index="$3" driver="${4:-}"
  node "$WORK_DIR/reset-db.cjs" "$SRC_DIR" >/dev/null 2>&1
  (cd "$SRC_DIR" && TYPEORM_PG_DRIVER="$driver" \
    node_modules/.bin/mocha --config "$WORK_DIR/mocharc.json" \
    --reporter json --timeout 30000 --exit \
    --file build/compiled/test/utils/test-setup.js "$file" \
    > "$REPORT_DIR/$label/$index.json" 2>"$REPORT_DIR/$label/$index.err") || true
}

i=0
for file in "${FILES[@]}"; do
  i=$((i + 1))
  printf '  %3d/%d  %s\n' "$i" "${#FILES[@]}" "$(basename "$file")"
  run_one control "$file" "$i" ""
  run_one facade "$file" "$i" "$FACADE"
done

# ---------------------------------------------------------------- compare

say "Comparing"
node - "$REPORT_DIR" <<'EOF'
import { readdirSync, readFileSync } from 'node:fs';

const dir = process.argv[2];

const read = (label) => {
  const run = { label, passed: new Set(), failed: new Set(), files: 0, unparsable: [] };
  for (const name of readdirSync(`${dir}/${label}`).filter(n => n.endsWith('.json'))) {
    const text = readFileSync(`${dir}/${label}/${name}`, 'utf8');
    const start = text.indexOf('{');
    let report;
    try {
      report = JSON.parse(text.slice(start));
    } catch {
      run.unparsable.push(name);
      continue;
    }
    run.files++;
    for (const t of report.passes ?? []) run.passed.add(`${name}::${t.fullTitle}`);
    for (const t of report.failures ?? []) run.failed.add(`${name}::${t.fullTitle}`);
  }
  run.total = run.passed.size + run.failed.size;
  return run;
};

const control = read('control');
const ours = read('facade');

// A run that collected nothing reports no failures, which would otherwise
// read as a clean sweep - mocha prints `0 passing` and exits 0 when a glob
// misfires, which has happened here.
for (const run of [control, ours]) {
  if (run.unparsable.length) {
    console.error(
      `\n\x1b[31m  ${run.label}: ${run.unparsable.length} run(s) produced no report.\x1b[0m`,
    );
    console.error(`  See ${dir}/${run.label}/${run.unparsable[0].replace('.json', '.err')}`);
    process.exit(1);
  }
  if (run.total === 0) {
    console.error(`\n\x1b[31m  ${run.label} ran no tests at all.\x1b[0m`);
    process.exit(1);
  }
}
if (control.total !== ours.total) {
  console.error(
    `\n\x1b[31m  The two runs collected different tests: ` +
      `${control.total} and ${ours.total}.\x1b[0m`,
  );
  process.exit(1);
}

const line = run =>
  `  ${run.label.padEnd(10)} ${String(run.passed.size).padStart(4)} / ${run.total} passing` +
  `   (${run.files} files)`;
console.log(line(control));
console.log(line(ours));

const name = k => k.replace(/^\d+\.json::/, '');
const regressions = [...ours.failed].filter(k => control.passed.has(k));
const shared = [...ours.failed].filter(k => control.failed.has(k));
const better = [...control.failed].filter(k => ours.passed.has(k));

if (shared.length) {
  console.log(`\n  ${shared.length} the control loses too - the suite's own, not ours:`);
  for (const k of shared) console.log(`    - ${name(k)}`);
}
if (better.length) {
  console.log(`\n  ${better.length} this facade passes and pg does not:`);
  for (const k of better) console.log(`    + ${name(k)}`);
}
if (regressions.length) {
  console.log(`\n\x1b[31m  ${regressions.length} this facade loses and pg wins:\x1b[0m`);
  for (const k of regressions) console.log(`    ! ${name(k)}`);
  process.exit(1);
}
console.log('\n\x1b[32m  No test is lost here that pg wins.\x1b[0m');
EOF
