# Same-day turnover offer and confirm

The cleaning-service owner gets one text for a same-day turnover at 12 Scratch Lane, replies YES, and gets a confirmation that names the day, the checkout time, and the address.

## Sub-features

- `turnover-offer` texts the owner the checkout day, checkout time, and next guest time, and asks for YES.
- `turnover-confirm` texts that same owner that cleaning is scheduled, after YES.
- `turnover-scratch` sends both texts only to the Scratch owner number.

## How to get to it (user POV)

- A same-day gap at 12 Scratch Lane, Teaneck, NJ 07666 is on the cleaning calendar (checkout 11:00 AM, next guest 4:00 PM, Sunday, Oct 18).
- The owner at `+15555550100` receives the offer and replies YES.
- The harness entry is `npm run cleaner:smoke` with `CLEANER_CORE_ENABLED=1`. Smoke performs both the offer and the YES. There is no separate command for the reply.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `node_modules/.bin/tsx` is executable.
- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 and stdout matches `scripts/expected/doctor-on.json` (`enabled` true, `sends` false).
- No phone other than `+15555550100` and `+15555550101` will appear. Do not add one.

- **Check the flag.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor`. Exit code 0. Stdout `sends` is false and `enabled` is true. The note is `Cleaner Core is on. doctor does not send texts.`
- **Offer and confirm.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke`. Exit code 0. Stdout matches `scripts/expected/smoke-turnover.json`. `property` is `12 Scratch Lane, Teaneck, NJ 07666`. `checkout` is `2026-10-18T15:00:00.000Z`. `nextArrival` is `2026-10-18T20:00:00.000Z`.
- **Owner texts.** The first `sent` item is `{ "to": "+15555550100", "kind": "offer" }` and its body is `Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.` The second is `{ "to": "+15555550100", "kind": "confirm" }` and its body is `Cleaning is scheduled for Sunday, Oct 18 at 11:00 AM at 12 Scratch Lane, Teaneck, NJ 07666.`
- **Proof.** Save the command, stdout, stderr, and exit code under `.cursor/skills/verify-cleanercore/evidence/<UTC timestamp>/` with feature id `same-day-turnover`. Re-read the saved stdout and require the two owner bodies above. The process writes no second file.

## Gotchas

- Smoke injects YES itself. A passing smoke does not show that a phone reply arrived.
- The calendar and the clock are fixtures (`2026-10-14T15:00:00.000Z` and the built-in iCal). This command does not read a live Guesty feed.
- `npm run cleaner:smoke -- YES` exits 1 and prints no JSON. Extra arguments are refused. Pass a reply as `--reply +15555550100=YES`, which replaces the built-in YES rather than adding a second one. With no `--reply`, smoke injects YES itself.
- Flag unset is a different feature. Smoke then exits 2 and `sent` is empty. Do not record that as this journey.
- The third `sent` item is the door code. Asserting it belongs to [door-code.md](./door-code.md). Matching the whole smoke document still requires that item to be present and unchanged.
