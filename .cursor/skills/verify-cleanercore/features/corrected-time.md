# Corrected time

If the stay changes after an offer goes out, the owner gets one update that says what changed and gives the new time. That text is not a second offer. The old offer is not sent again.

## Sub-features

- `offer-at-host-time` offers Sunday, Oct 18 at 1:00 PM after the owner sends that checkout time.
- `confirm-once` confirms that same Sunday time after YES.
- `corrected-checkout` texts the Monday move as an update, and asks YES to keep the cleaning.

## How to get to it (user POV)

- The owner answers `1:00 PM`, then YES to check-in, then YES to the offer.
- The feed moves Anita's checkout from Sunday, Oct 18 to Monday, Oct 19 (`guesty-lite-date-moved.ics`).
- The owner receives one update naming Monday at 1:00 PM.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Replies are from `+15555550100` only.

- **Offer, confirm, then move the date.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550100=1:00 PM --reply +15555550100=YES --reply +15555550100=YES --then-feed src/cleaner-core/fixtures/guesty-lite-date-moved.ics`. Exit code 0.
- **Transcript.** The lines are the 11:00 AM checkout question, the 4:00 PM check-in question, the offer `Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 1:00 PM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.`, the confirm `Cleaning is scheduled for Sunday, Oct 18 at 1:00 PM at 12 Scratch Lane, Teaneck, NJ 07666.`, and `Update: checkout at 12 Scratch Lane, Teaneck, NJ 07666 moved to Monday, Oct 19 at 1:00 PM. Reply YES to keep the cleaning, or STOP to opt out.`
- **One offer.** `sent` contains one `kind` `offer` and one `kind` `corrected`. The corrected body does not start with `Turnover at`.
- **Proof.** Save the command, stdout, stderr, exit code, and transcript with feature id `corrected-time`.

## Gotchas

- The update names the address and the new day and time. A second `Turnover at` line would be a new job, and this journey forbids that.
- The host's 1:00 PM survives the date move. The feed does not put the clock back to 11:00 AM.
- This drive does not answer the update with YES. The job is waiting on that reply.
