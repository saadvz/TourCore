# Persisted store has no door code

Step C sends no door code. After the owner confirms the cleaning, the scratch code `4821` is absent from the smoke stdout, the stderr log, and the persisted job file.

## Sub-features

- `confirm-without-pin` confirms Sunday at 11:00 AM and texts only the owner.
- `store-without-pin` writes `cleaner-core.json` with no scratch code and no door-code phrase.
- `job-not-ready` leaves the confirmed job short of ready.

## How to get to it (user POV)

- The owner answers YES to checkout, YES to check-in, and YES to the offer.
- The confirmation names Sunday, Oct 18 at 11:00 AM and 12 Scratch Lane.
- No door code is texted, logged, or stored.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- A temporary directory exists for `--data`. Copy `cleaner-core.json` into the evidence directory before removing the temporary directory.

- **Confirm into a store.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --data <dir> --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550100=YES --reply +15555550100=YES --reply +15555550100=YES`. Exit code 0.
- **Transcript.** The four lines are the checkout question, the check-in question, the 11:00 AM offer, and `Cleaning is scheduled for Sunday, Oct 18 at 11:00 AM at 12 Scratch Lane, Teaneck, NJ 07666.`
- **Grep.** `4821` is absent from stdout, stderr, and `cleaner-core.json`. No body contains `door code`. `pinRecipients` is `[]`. No job `status` is `ready`.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, job list, and a copy of the store with feature id `no-pin`. The harness greps the new evidence tree for `4821` and fails the run if it appears.

## Gotchas

- Older evidence directories from before step C contain `4821`. Grep the new run, not the whole history, when deciding whether this journey passed.
- The assert scripts mention `4821` so they can reject a leak. Those scripts are not evidence files.
- Confirming the built-in calendar with no `--feed` is the same-day turnover journey. This journey persists the Guesty fixture.
