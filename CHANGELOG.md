## Changelog

### [v1.0.0](https://github.com/panates/postgrejs-typeorm/compare/v0.0.1...v1.0.0) - 

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
