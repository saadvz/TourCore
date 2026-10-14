# Door code only to the approved cleaner

After the owner confirms the Scratch Lane turnover, the door code `4821` is texted only to the approved cleaner. The owner's offer and confirmation do not contain the code.

## Sub-features

- `pin-cleaner` texts `4821` to `+15555550101` and to nobody else.
- `pin-owner-withheld` keeps `4821` out of the owner's offer and confirmation.
- `pin-recipients` lists only the approved cleaner.

## How to get to it (user POV)

- The owner confirms the same-day turnover (YES).
- The approved cleaner at `+15555550101` receives a separate text with the door code.
- The owner at `+15555550100` does not receive the code.
- The harness entry is the same flag-on smoke command. Smoke always uses this approved cleaner. There is no CLI switch for an unapproved cleaner.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- The turnover smoke has not been pointed at any number except `+15555550100` and `+15555550101`.

- **Confirm the turnover.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke`. Exit code 0. Stdout matches `scripts/expected/smoke-turnover.json`.
- **Cleaner text.** The only `sent` item with `kind` `pin` is `{ "to": "+15555550101", "body": "Door code for 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18: 4821. This code is only for you.", "kind": "pin" }`.
- **Owner texts stay clear.** The offer body and the confirm body do not contain `4821`. Their `to` is `+15555550100`.
- **Recipients.** `pinRecipients` is exactly `["+15555550101"]`. Every `to` and every `pinRecipients` entry is a Scratch test number.
- **Proof.** Save the command, stdout, stderr, and exit code with feature id `door-code`. Re-read the saved stdout and require the single pin recipient above.

## Gotchas

- This CLI cannot run the unapproved-cleaner case. There is no flag to withhold the pin. Do not treat a passing smoke as proof that an unapproved cleaner is skipped.
- The pin is only in the smoke JSON. No handset receives it. A passing run does not prove carrier delivery.
- Counting `sent` without reading `to` and `body` can hide the code on the owner's text. Assert the bodies.
- Booking STOP, HELP, or an injury is a different feature, and this CLI cannot send those replies. Do not pass them as smoke arguments. Extra arguments are ignored and the pin is still issued.
