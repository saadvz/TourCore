# Corrected time

If the stay's date changes after an offer goes out, the host-confirmed clock for that side is cleared. The owner is asked the host time question for the new day before any update. The update goes out only after that answer, and it uses the new answer. That text is not a second offer.

## Sub-features

- `offer-at-host-time` offers Sunday, Oct 18 at 1:00 PM after the owner sends that checkout time.
- `confirm-once` confirms that same Sunday time after YES.
- `date-clears-host-time` drops the Sunday 1:00 PM checkout when the feed moves the stay to Monday.
- `ask-again` asks whether Monday checkout is still 11:00 AM, then whether Monday check-in is still 4:00 PM.
- `corrected-checkout` texts the Monday move only after those answers, at the newly confirmed 11:00 AM.

## How to get to it (user POV)

- The owner answers `1:00 PM`, then YES to check-in, then YES to the offer.
- The feed moves Anita's checkout from Sunday, Oct 18 to Monday, Oct 19 (`guesty-lite-date-moved.ics`).
- The owner is asked about Monday, answers YES to the new checkout and the new check-in, and then receives one update naming Monday at 11:00 AM.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Replies are from `+15555550100` only.

- **Offer, confirm, move the date, then answer again.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550100=1:00 PM --reply +15555550100=YES --reply +15555550100=YES --then-feed src/cleaner-core/fixtures/guesty-lite-date-moved.ics --reply +15555550100=YES --reply +15555550100=YES`. Exit code 0.
- **Transcript.** Outbound lines, in order, are the Sunday 11:00 AM checkout question, the Sunday 4:00 PM check-in question, the offer `Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 1:00 PM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.`, the confirm `Cleaning is scheduled for Sunday, Oct 18 at 1:00 PM at 12 Scratch Lane, Teaneck, NJ 07666.`, `Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Monday, Oct 19 still 11:00 AM? Reply YES or send the new time.`, `Is check-in at 12 Scratch Lane, Teaneck, NJ 07666 on Monday, Oct 19 still 4:00 PM? Reply YES or send the new time.`, and `Update: checkout at 12 Scratch Lane, Teaneck, NJ 07666 moved to Monday, Oct 19 at 11:00 AM. Reply YES to keep the cleaning, or STOP to opt out.` The Monday checkout question appears before the update. Each Scratch reply is on its own transcript line, `+15555550100:` plus the text.
- **New host time.** The Anita job `checkoutDate` is `2026-10-19` and `checkoutTime` is `11:00 AM`. The transcript does not contain `moved to Monday, Oct 19 at 1:00 PM`.
- **One offer.** `sent` contains one `kind` `offer` and one `kind` `corrected`. The corrected body does not start with `Turnover at`.
- **Proof.** Save the command, stdout, stderr, exit code, and transcript with feature id `corrected-time`.

## Gotchas

- The update names the address and the new day and time. A second `Turnover at` line would be a new job, and this journey forbids that.
- A date change clears that side's host time. A later feed that only changes the clock does not. That is the host-time journey.
- This drive answers the new Monday questions and does not answer the update with YES. The job is waiting on that reply.
