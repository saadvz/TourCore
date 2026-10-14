# Cleaner Core verification map

This directory is the maintained source for verifying Cleaner Core's user-facing behavior. Read the index before driving, then use the matching feature file as the recipe.

Without `--with-pin`, the owner receives the schedule text. With `--with-pin`, the opted-in cleaner receives the offer, the confirmation, and the reminder, and only that cleaner's YES confirms the job. The approved cleaner also receives safety replies. A drive without `--with-pin` does not text a door code. `--with-pin` texts the private door code to the approved cleaner only after the host says the guests have left, and the saved record redacts the digits. The landlord's switch is `CLEANER_CORE_ENABLED`.

## Baseline preconditions

- Repo root of this checkout, Node 20 or newer, `node_modules/.bin/tsx` present (`npm ci` when it is not).
- Default doctor and smoke do not read `TOURCORE_HOME`. A journey that says `--data` uses only that temporary directory.
- Recipients are only `+15555550100` (owner) and `+15555550101` (approved cleaner). `+15555550199` may be a reply sender and must not be a recipient. All three are Scratch 555 numbers. Never type a real person's number.
- Run doctor in the same flag setting as the drive and require `sends` false.
- Each command is a fresh process. Do not reuse a shell that still has `CLEANER_CORE_ENABLED` set when the recipe says unset.
- Never drive `sendblue:*` or any other live messaging script from this map.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise.
- Treat every command as literal. Keep the flag assignment and the npm script unchanged.
- Flag on: `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` and `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke`.
- Replies: `npm run cleaner:smoke -- --reply +15555550100=STOP`. Repeat `--reply` for each inbound text. Any explicit operation (`--reply`, `--feed`, `--then-feed`, `--now`, `--remind`, `--fail-sends`, `--data`, `--no-poll`, `--with-pin`, `--unapproved`, `--group`) does not also inject YES.
- Flag off: `env -u CLEANER_CORE_ENABLED` in front of the same scripts.
- Assert the full stdout document and the exit code. A truthy `ok` is not a result.
- After smoke, every `+1` number in stdout must be a Scratch test number: area code 555, or exchange 555 with line 0100–0199.
- A drive without `--with-pin` leaves `pinRecipients` empty. Its stdout, job list, outbox, and persisted store contain no door code. A `--with-pin` drive may list `+15555550101` in `pinRecipients`. Its saved stdout, transcript, outbox, and store replace the scratch digits with `[redacted]`.
- Do not remove proof artifacts during cleanup. A temporary `--data` directory is removed only after its stdout is saved.

## Proof and skip reporting

- Capture the command, stdout, stderr, and exit code under `.cursor/skills/verify-cleanercore/evidence/<UTC timestamp>/`.
- Record the feature id and the entry point in that directory's `result.txt`.
- Default smoke stdout is the record of texts. Step C journeys also save the transcript, the job list, and the outbox from that stdout.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path. Flag-on smoke with no operation confirms the built-in turnover. That is not proof of STOP, a feed change, a block, or a failed send.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with the cleaner doctor/smoke CLI` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Same-day turnover offer and confirm](./same-day-turnover.md) covers the Scratch Lane host questions, the offer, and the owner's YES confirm. `prove-turnover.sh`.
- [No door code](./door-code.md) covers the confirmed turnover and an unapproved YES. Neither texts a door code. `prove-turnover.sh` and `prove-safety.sh`.
- [STOP, HELP, and injury](./stop-help-injury.md) covers opt-out, help, and one emergency reply per sender on the built-in job. `prove-safety.sh`.
- [Flag off sends nothing](./flag-off.md) covers doctor and smoke with `CLEANER_CORE_ENABLED` unset. `prove-safety.sh`.
- [Read the Guesty Lite feed](./read-feed.md) covers checkout, next check-in, a free night, a same-day turn, and a block that is not a departure. `prove-step-c.sh`.
- [Host time wins](./host-time.md) covers a host clock that stays after a later feed publishes a different clock. `prove-step-c.sh`.
- [Corrected time](./corrected-time.md) covers the update text after an offer, with the old offer left behind. `prove-step-c.sh`.
- [One reminder](./reminder-once.md) covers one reminder across a second poll and a restart. `prove-step-c.sh`.
- [Blocks create no job](./blocks.md) covers an owner block and a blocked date. `prove-step-c.sh`.
- [One live job](./one-live-job.md) covers a removed stay: the job list after the change, not only the outbox. `prove-step-c.sh`.
- [STOP silences later texts](./stop-silences.md) covers opt-out, then a feed change and a reminder, with no new text to the owner. `prove-step-c.sh`.
- [Persisted store has no door code](./no-pin.md) covers a confirmed job whose stdout and store omit the scratch door code. `prove-step-c.sh`.
- [Safety replies in new states](./safety-states.md) covers STOP, HELP, and one emergency phrase while waiting, after an offer, and after a corrected-time text. `prove-step-c.sh`.
- [Failed send is not delivered](./failed-send.md) covers a reminder whose first send fails and whose retry sends it once. `prove-step-c.sh`.
- [Door code only after departure](./pin-after-departure.md) covers a same-day turn that holds the code until the host says the guests have left, then sends it once. `prove-step-d.sh`.
- [Approved and opted in](./opted-in-only.md) covers no code without a cleaner YES, no code for `+15555550199`, and no opt-in for an unapproved cleaner. `prove-step-d.sh`.
- [Later checkout holds the code](./checkout-moved.md) covers a checkout moved to 2:00 PM and a code that waits for the cleaner's new YES. `prove-step-d.sh`.
- [One full Scratch turn](./full-turn.md) covers opt-in, the cleaner's YES, the cleaner reminder, departure, the private text, START, and DONE. `prove-step-d.sh`.
- [Sealed door code](./pin-stored.md) covers a persisted store and a stdout that redact the digits. `prove-step-d.sh`.
- [STOP holds the code](./stop-holds.md) covers STOP before departure and a later START that does not send the code. `prove-step-d.sh`.
- [HELP around the door code](./help-while-cleaning.md) covers HELP, a host injury, and a cleaner injury while waiting, after the code, and in progress, plus a failed host alert. `prove-step-d.sh`.
- [Failed door-code send](./pin-failed.md) covers a failed private send, one retry, and a second reminder that sends nothing. `prove-step-d.sh`.
- [No group and no code for Cory](./no-group.md) covers a group number that receives nothing and a host notice that omits the code. `prove-step-d.sh`.
