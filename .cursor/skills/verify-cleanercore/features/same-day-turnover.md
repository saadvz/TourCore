# Same-day turnover offer and confirm

The cleaning-service owner is asked, one time at a time, whether checkout and check-in at 12 Scratch Lane are still the property defaults. After both YES replies, the owner gets one turnover offer. A third YES confirms the cleaning and names the day, the checkout time, and the address.

## Sub-features

- `host-checkout-question` asks whether Sunday checkout is still 11:00 AM.
- `host-checkin-question` asks whether Sunday check-in is still 4:00 PM, only after checkout is confirmed.
- `turnover-offer` texts the owner the checkout day, checkout time, and next guest time, and asks for YES.
- `turnover-confirm` texts that same owner that cleaning is scheduled, after the offer YES.
- `turnover-scratch` sends every text only to the Scratch owner number.

## How to get to it (user POV)

- A same-day gap at 12 Scratch Lane, Teaneck, NJ 07666 is on the built-in cleaning calendar (checkout Sunday, Oct 18, next guest the same day).
- The owner at `+15555550100` receives the checkout question, replies YES, receives the check-in question, replies YES, receives the offer, and replies YES.
- The harness entry is `npm run cleaner:smoke` with `CLEANER_CORE_ENABLED=1` and no extra operation. Smoke performs the questions and the three YES replies. There is no separate command for the reply.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `node_modules/.bin/tsx` is executable.
- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 and stdout matches `scripts/expected/doctor-on.json` (`enabled` true, `sends` false).
- No phone other than `+15555550100` and `+15555550101` will appear. Do not add one.

- **Check the flag.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor`. Exit code 0. Stdout `sends` is false and `enabled` is true. The note is `Cleaner Core is on. doctor does not send texts.`
- **Ask, offer, and confirm.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke`. Exit code 0. Stdout matches `scripts/expected/smoke-turnover.json`. `property` is `12 Scratch Lane, Teaneck, NJ 07666`. `checkout` is `2026-10-18T15:00:00.000Z`. `nextArrival` is `2026-10-18T20:00:00.000Z`. `pinRecipients` is `[]`.
- **Owner texts.** `sent` is four items, all to `+15555550100`. The checkout question is `Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.` The check-in question is `Is check-in at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18 still 4:00 PM? Reply YES or send the new time.` The offer is `Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.` The confirm is `Cleaning is scheduled for Sunday, Oct 18 at 11:00 AM at 12 Scratch Lane, Teaneck, NJ 07666.`
- **Job.** The `stay-a` job `status` is `confirmed` and `live` is true. No job `status` is `ready`.
- **Proof.** Save the command, stdout, stderr, and exit code under `.cursor/skills/verify-cleanercore/evidence/<UTC timestamp>/` with feature id `same-day-turnover`. Re-read the saved stdout and require the four owner bodies above.

## Gotchas

- Smoke injects three YES replies itself. A passing smoke does not show that a phone reply arrived.
- The calendar and the clock are fixtures (`2026-10-14T15:00:00.000Z` and the built-in iCal). This command does not read a live Guesty feed.
- `npm run cleaner:smoke -- YES` exits 1 and prints no JSON. Extra arguments are refused. Pass a reply as `--reply +15555550100=YES`, which replaces the built-in YES replies rather than adding another one.
- Flag unset is a different feature. Smoke then exits 2 and `sent` is empty. Do not record that as this journey.
- A door code is a different feature, and this drive does not send one. Matching the whole smoke document requires `pinRecipients` to stay empty.
