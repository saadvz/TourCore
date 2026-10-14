# CI runs the cleaner suite both ways

Every pull request to master installs, typechecks, builds, runs the full test suite, runs the cleaner-core tests with the flag on and off, scans for configured scratch codes, and checks that the Grok setup prompt is unchanged.

## Sub-features

- `ci-commands` runs `scripts/ci-check.sh` on Node 22.
- `flag-off-smoke` exits 2 and sends nothing when the flag is unset, even with a freshness watch and a review.

## How to get to it (user POV)

- A pull request to master starts the CI workflow.
- With the flag unset, nobody at Scratch Lane receives a text.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- Node 22, `npm ci` already done, and doctor on before the flag-off smoke.
- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false.

- **CI.** Run `bash scripts/ci-check.sh`. Exit code 0. The log names typecheck, build, the default test suite, cleaner-core tests with the flag on, the same tests with the flag off, the secret scan, the baseline eval, and an unchanged `grok-template/SETUP_PROMPT.md`.
- **Flag off.** Run `env -u CLEANER_CORE_ENABLED npm run --silent cleaner:smoke -- --watch-freshness --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --review stale-source`. Exit code 2. `sent` is `[]` and `reason` is `disabled`.

## Gotchas

- Node 20 cannot open the SQLite backup store. CI uses Node 22.
- The secret scan allowlists the historical tenant store and the step C through F proofs. A new file that contains a configured scratch code fails the scan.
- `prove-step-g.sh` runs this journey after the step D, E, and F proofs.
