# No door code

Step C does not text a door code. After the owner confirms the Scratch Lane turnover, the only texts are the host questions, the offer, and the confirmation, all to the owner. A YES from a number that is not the owner does not receive a code either.

## Sub-features

- `no-pin-on-confirm` leaves `pinRecipients` empty on the confirmed turnover.
- `no-pin-in-owner-texts` keeps a door code out of the checkout question, the check-in question, the offer, and the confirmation.
- `no-ready` leaves every job status short of ready. Calendar time does not mark the job ready.
- `unapproved-yes` lets `+15555550199` reply YES. That number receives nothing, and this drive sends no door code.

## How to get to it (user POV)

- The owner confirms the same-day turnover (three YES replies: checkout, check-in, offer).
- The approved cleaner at `+15555550101` receives no door code.
- The owner at `+15555550100` does not receive a code.
- The harness entry for the confirmed turnover is `npm run cleaner:smoke` with the flag on and no `--reply`.
- An unapproved Scratch number replies through `npm run cleaner:smoke -- --reply +15555550199=YES`. That drive does not add the owner's YES.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- The confirm drive uses no `--reply`. The unapproved drive's only reply sender is `+15555550199`.

- **Confirm the turnover.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke`. Exit code 0. Stdout matches `scripts/expected/smoke-turnover.json`.
- **No code.** `sent` has no `kind` `pin`. `pinRecipients` is `[]`. No body contains `door code`. Every `to` is `+15555550100`.
- **No ready job.** No `jobs` item has `status` `ready`.
- **Unapproved YES.** Reply YES from `+15555550199`. Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --reply +15555550199=YES`. Exit code 0. Stdout matches `scripts/expected/smoke-unapproved.json`. `sent` is only the checkout question to `+15555550100`. `pinRecipients` is `[]`. The stdout does not contain `+15555550199`.
- **Proof.** Save the confirm command with feature id `door-code`, and the unapproved command with feature id `unapproved-yes`. Re-read each saved stdout and require `pinRecipients` empty. The persisted-store proof is [no-pin.md](./no-pin.md).

## Gotchas

- `+15555550199` is a Scratch sender, not a second cleaner. This drive does not switch the cleaner to unapproved, and it does not text the cleaner.
- The absence of a code is only in the smoke JSON. No handset is involved. A passing run does not prove a carrier skipped a text.
- Older evidence directories under this skill still contain a door-code demo from before step C. Do not treat those files as this journey. A new run must omit the code.
- STOP, HELP, and injury are a different feature. Pass them with `--reply`. A bare extra argument exits 1 and sends nothing.
