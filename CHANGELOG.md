# Changelog

<!-- rman:documented-up-to 2de6ad1bad543744a6289ec1b60159a08031c4c4 -->

## v2.0.0 (2026-10-06)

### ✨ Features

- **config:** reach PostgreJS's own connection settings (a41b194)
- **params:** let PostgreJS type the parameters (e9026ef)
- **params:** render only what PostgreJS would declare a type for (7ce8dd8)
- **params:** let PostgreJS type a number, and render nothing by default (fba419a)

### 🐛 Bug Fixes

- **bench:** the memory worker was measuring both clients at once (afc040a)
- **typeorm:** send a real boolean for a boolean column (4b5c75f)

### 📚 Documentation

- restructure the README on prisma-postgrejs's flow (1cefe1c)
- point the README at a generated benchmark document (9886617)
- rewrite the README on the drizzle package's shape, and generate its numbers (7663c05)
- **params:** the two cases that justified this policy are fixed upstream (943dffb)
- **params:** the array cost is not a discarded binary encoding (f36e213)
- **params:** what actually holds this policy in place now (725d5a3)
- the parameter policy, and the two unreleased commits it needs (0f5263f)
- **bench:** say that the three tables are two axes, not three workloads (44b5a58)
- **params:** make the object-only fallthrough look like one (f3aa754)
- **src:** keep TSDoc for the API, plain comments for the reasoning (6caf3cb)
- rewrite DRIVER-DESIGN §5 around the policy that is actually in the code (b406149)

### 🧪 Tests

- **params:** the matrix compared values with the types taken off (a9e0685)

### 📦 Build System

- adopt rman 2.x and the shared v3 workflows (1d18753)

### 🧹 Chores

- **deps:** require postgrejs >=3.13.0, and measure against it (fdd13a3)
- restore .ncurc.yml, deleted by accident (c08406a)

### 💬 General Changes

- move to postgrejs 3.12.1, and fix a control that stopped controlling (bf7d54b)
- split the harness, and add the memory pass it never had (b53b6bd)
- generate doc/BENCHMARKS.md from the results file (4bccb90)
- read the payload shapes through TypeORM too (d1a4370)
- measure the client, and drop the rows that measure PostgreSQL (ad2e065)
- take the six scenarios the kysely harness has and this one lacked (b0c3a5c)
- pair the memory pass, so "level" is an answer rather than a threshold (b669583)
- run the raw scenarios the way TypeORM runs them (f30ba1c)
- make "concurrent reads" measure reading, not checking out (1f8ac94)
- say what "insert one row" measures, and whose cost it is (5c2ca03)
- turn off the one PostgreJS default pg has no equivalent of (22b206a)
- Revert "feat(params)!: let PostgreJS type the parameters" (3f3a559)
- re-measure on postgrejs 3.12.2, which carries the flexy-buffer fix (be45507)
- measure against the build in the next directory, not the registry (5bd3010)
- a write row that carries a row, measured under the new policy (d6f037a)
- give every shape a TypeORM counterpart, and lead with that level (8a8fd28)
- stop printing the raw tables, and state what they say instead (a8019e2)
- keep latest.json in the format bench.mjs writes (9f2e06b)

---

## Changelog

### [v1.0.1](https://github.com/panates/postgrejs-typeorm/compare/v1.0.0...v1.0.1) - 

#### 📖 Documentation Changes

- docs: say what a reader gains, not what the package is not @Eray Hanoğlu 
- docs: drop the pre-release note @Eray Hanoğlu 

## [v1.0.0](https://github.com/panates/postgrejs-typeorm/compare/v0.0.1...v1.0.0) -  22 September 2026 

#### 🚀 New Features

- feat: a pg-compatible facade over PostgreJS @Eray Hanoğlu 
- feat: take the scalar-only fetchAsString ask, and close the last divergence @Eray Hanoğlu 

#### 🪲 Fixes

- fix: two bugs a coverage report found, and the tests that find them @Eray Hanoğlu 
- fix: five pg divergences the TypeORM suite could not reach @Eray Hanoğlu 
- fix: answer money as pg answers it, and pin the text date path @Eray Hanoğlu 
- fix: drop postgres-array, and a rowMode bug the new build exposed @Eray Hanoğlu 

#### 📖 Documentation Changes

- docs: a README that says what a reader gets, with the numbers measured @Eray Hanoğlu 
- docs: settle the packaging question, and say what makes the copy safe @Eray Hanoğlu 
- docs: warn that prepare:false plus a non-default DateStyle corrupts dates @Eray Hanoğlu 

#### 🛠 Refactoring and Updates

- refactor: delete the fixup table, and every runtime dependency with it @Eray Hanoğlu 
- refactor: drop the caret-stripping fallback, and the instruction that kept it @Eray Hanoğlu 

#### 🧪 Changes to Test Assests

- test: run TypeORM's own suite from the repository @Eray Hanoğlu 
- test: close the coverage gaps, and report the one they turned up @Eray Hanoğlu 

#### 💬 General Changes

- doc: recon report for running TypeORM on PostgreJS @Eray Hanoğlu 
- Adapt to PostgreJS 3.8, and serialise statements per client @Eray Hanoğlu 
- Correct the claims the recon round disproved @Eray Hanoğlu 
- Correct the cause of the timestamptz Date defect @Eray Hanoğlu 

### v0.0.1

#### 💬 General Changes

- Initial commit @Eray Hanoglu 
