# Cleaner Core verification map

This directory is the maintained source for verifying Cleaner Core's user-facing behavior. Read the index before driving, then use the matching feature file as the recipe.

The user here is the cleaning-service owner who receives the schedule text, and the approved cleaner who may receive the door code. The landlord's switch is `CLEANER_CORE_ENABLED`.

## Baseline preconditions

- Repo root of this checkout, Node 20 or newer, `node_modules/.bin/tsx` present (`npm ci` when it is not).
- No data directory. Doctor and smoke do not read `TOURCORE_HOME`.
- Recipients are only `+15555550100` (owner) and `+15555550101` (approved cleaner). `+15555550199` may be a reply sender and must not be a recipient. All three are Scratch 555 numbers. Never type a real person's number.
- Run doctor in the same flag setting as the drive and require `sends` false.
- Each command is a fresh process. Do not reuse a shell that still has `CLEANER_CORE_ENABLED` set when the recipe says unset.
- Never drive `sendblue:*` or any other live messaging script from this map.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise.
- Treat every command as literal. Keep the flag assignment and the npm script unchanged.
- Flag on: `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` and `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke`.
- Replies: `npm run cleaner:smoke -- --reply +15555550100=STOP`. Repeat `--reply` for each inbound text. A drive with `--reply` does not also inject YES.
- Flag off: `env -u CLEANER_CORE_ENABLED` in front of the same scripts.
- Assert the full stdout document and the exit code. A truthy `ok` is not a result.
- After smoke, every `+1` number in stdout must be a Scratch test number: area code 555, or exchange 555 with line 0100–0199.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the command, stdout, stderr, and exit code under `.cursor/skills/verify-cleanercore/evidence/<UTC timestamp>/`.
- Record the feature id and the entry point in that directory's `result.txt`.
- Smoke stdout is the only record of texts. The process does not write a second store.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path. Flag-on smoke with no `--reply` books a YES. That is not proof of STOP, HELP, injury, flag off, or an unapproved YES.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with the cleaner doctor/smoke CLI` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Same-day turnover offer and confirm](./same-day-turnover.md) covers the Scratch Lane offer and the owner's YES confirm.
- [Door code only to the approved cleaner](./door-code.md) covers who receives `4821` after that confirm, and a YES from `+15555550199` that receives no code.
- [STOP, HELP, and injury](./stop-help-injury.md) covers opt-out, help, and one emergency reply per sender on this job.
- [Flag off sends nothing](./flag-off.md) covers doctor and smoke with `CLEANER_CORE_ENABLED` unset, including a Scratch YES that must not be sent.
