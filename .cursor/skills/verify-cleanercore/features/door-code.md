# Door code only to the approved cleaner

After the owner confirms the Scratch Lane turnover, the door code `4821` is texted only to the approved cleaner. The owner's offer and confirmation do not contain the code.

## Sub-features

- `pin-cleaner` texts `4821` to `+15555550101` and to nobody else.
- `pin-owner-withheld` keeps `4821` out of the owner's offer and confirmation.
- `pin-recipients` lists only the approved cleaner.
- `pin-unapproved-yes` lets `+15555550199` reply YES. That number is not the approved cleaner. It receives no door code, and this drive sends no door code at all.

## How to get to it (user POV)

- The owner confirms the same-day turnover (YES).
- The approved cleaner at `+15555550101` receives a separate text with the door code.
- The owner at `+15555550100` does not receive the code.
- The harness entry for the confirmed code is `npm run cleaner:smoke` with the flag on and no `--reply`.
- An unapproved Scratch number replies through `npm run cleaner:smoke -- --reply +15555550199=YES`. That drive does not add the owner's YES.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- The confirm drive uses no `--reply`. The unapproved drive's only reply sender is `+15555550199`.

- **Confirm the turnover.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke`. Exit code 0. Stdout matches `scripts/expected/smoke-turnover.json`.
- **Cleaner text.** The only `sent` item with `kind` `pin` is `{ "to": "+15555550101", "body": "Door code for 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18: 4821. This code is only for you.", "kind": "pin" }`.
- **Owner texts stay clear.** The offer body and the confirm body do not contain `4821`. Their `to` is `+15555550100`.
- **Recipients.** `pinRecipients` is exactly `["+15555550101"]`. Every `to` and every `pinRecipients` entry is `+15555550100` or `+15555550101`.
- **Unapproved YES.** Reply YES from `+15555550199`. Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --reply +15555550199=YES`. Exit code 0. Stdout matches `scripts/expected/smoke-unapproved.json`. `sent` is only the offer to `+15555550100`. `pinRecipients` is `[]`. The stdout does not contain `+15555550199` or `4821`.
- **Proof.** Save the confirm command with feature id `door-code`, and the unapproved command with feature id `unapproved-yes`. Re-read each saved stdout and require the recipient lists above.

## Gotchas

- `+15555550199` is a Scratch sender, not a second cleaner. Smoke's cleaner stays `+15555550101` and approved. This drive does not switch that cleaner to unapproved.
- The pin is only in the smoke JSON. No handset receives it. A passing run does not prove carrier delivery.
- Counting `sent` without reading `to` and `body` can hide the code on the owner's text. Assert the bodies.
- STOP, HELP, and injury are a different feature. Pass them with `--reply`. A bare extra argument exits 1 and sends nothing.
