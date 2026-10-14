# Host time wins

When the owner sends a checkout time, the job uses that time. A later calendar update that publishes a different clock does not replace it. The offer names the owner's time.

## Sub-features

- `host-checkout-clock` accepts `1:00 PM` as the checkout time.
- `host-checkin-yes` accepts the proposed 4:00 PM check-in.
- `calendar-clock-ignored` keeps 1:00 PM after a feed whose events say 10:00 AM and 3:00 PM.

## How to get to it (user POV)

- The owner receives the Sunday checkout question and replies `1:00 PM`.
- The owner receives the check-in question and replies YES.
- The calendar is replaced by `guesty-lite-clock-bait.ics`, which carries clocks the job must ignore.
- The offer says checkout 1:00 PM.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Replies are from `+15555550100` only.

- **Confirm the host clock, then re-read.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550100=1:00 PM --reply +15555550100=YES --then-feed src/cleaner-core/fixtures/guesty-lite-clock-bait.ics`. Exit code 0.
- **Transcript.** The three lines are the 11:00 AM checkout question, the 4:00 PM check-in question, and `Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 1:00 PM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.`
- **No feed clock.** No text contains `10:00` or `3:00 PM`. `pinRecipients` is `[]`.
- **Proof.** Save the command, stdout, stderr, exit code, and transcript with feature id `host-time`.

## Gotchas

- The first question still proposes 11:00 AM. That proposal is the property default. The owner's later `1:00 PM` is the time the offer uses.
- This drive stops at the offer. It does not send the third YES, so it does not confirm the cleaning. Confirmation after a date move is the corrected-time journey.
- `--then-feed` is a second poll in the same process. It is not a second job.
