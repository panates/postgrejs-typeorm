# The rman pipeline, and which scripts may exist

`.rmanrc.yml` is short on purpose, and **the ground truth is `rman config --from-root`, never the
preset's source**. Reading the preset would have been wrong here: 1.6.0 carries neither
`group: false` nor `changelog.unreleased` nor `version.changelog`, because rman 2.7 absorbed all
three as its own defaults, and only the resolved config shows them.

This is a single-package repository, so `group`, `version.cascade` and `changelog.groupBy` are all
deliberately unset - there is nothing to group and nothing to cascade to, and setting them would
change nothing.

## What the preset owns

`build` (its `before` is `rman check`, `rman lint`, `rman clean`; its `exec` is `tsc -b`; its
`after` copies README/LICENSE, writes the build manifest and stamps the version), plus `lint`,
`check`, `format` and `clean`.

**`build` and `prebuild` must not come back as npm scripts.** A `build` script would silently win
over the config's `exec` and keep this repository on its old pipeline with the config looking
correct; a `prebuild` would run the same three steps twice. `rman build` names each step as it
runs, and each has to appear once.

## Why `lint`, `check` and `format` are a different case

This was measured rather than assumed. With `"lint": "exit 7"` in `package.json`, `rman lint` still
ran eslint and still passed - so the rman command does not defer to a script of the same name, and
the warning above is specific to `build` and `prebuild`.

The repository standard asks for those three as scripts, so they are there, each one line
delegating to the rman command: `rman lint`, `rman check`, `rman format`. They are a spelling for
people who type `pnpm run`, not a second pipeline. `build` was never tested this way and does not
need to be, because nothing asks for it.

## Why the suite script calls `rman build` directly

`scripts/run-typeorm-suite.sh` calls `rman build`. It called `npm run build` until that script was
deleted in the same commit - the sibling that missed this exited before its first test for weeks,
because nothing ran it. Ours runs weekly on a cron, which is why it would have been caught, but the
fix belongs with the cause.

It is plain `rman`, not `npx rman`: rman is not a devDependency, and npx answered from its own cache
with a different version than the one on the PATH.
