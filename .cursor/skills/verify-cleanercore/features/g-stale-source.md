# A stale feed does not offer a cleaning

After three missed hourly Guesty Lite polls, the host is told once and no new offer goes out. A fresh read clears that hold and sends the offer once.

## Sub-features

- `stale-holds-offer` sends the stale-source review instead of the offer.
- `one-alert` does not text that review again on the next stale poll.
- `fresh-clears` sends the offer after a fetch at the current clock and resolves the review.

## How to get to it (user POV)

- The booking feed has not succeeded for more than three hours.
- The host gets one text and no turnover offer until a fresh read.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false.
- The default threshold is three hours. A fetch at `2026-10-14T15:00:00.000Z` is stale at `2026-10-14T18:00:00.001Z`.

- **Go stale, then fresh.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --watch-freshness --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550101=YES --reply +15555550100=YES --now 2026-10-14T18:00:00.001Z --reply +15555550100=YES --fetched-at 2026-10-14T15:00:00.000Z --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --fetched-at 2026-10-14T18:00:00.001Z --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics`. Exit code 0. `sent` is the checkout question, the cleaner opt-in, the check-in question, one stale review, then one offer to `+15555550101`. The stale review is `resolved`. `pinRecipients` is `[]`.

## Gotchas

- `--watch-freshness` is required. A clock jump without it still sends, so older proofs keep working.
- Exactly three hours (`2026-10-14T18:00:00.000Z`) is still fresh.
- The host alert is `I can't see the latest bookings for 12 Scratch Lane, Teaneck, NJ 07666 right now, so I'm holding new cleanings and the door code. I'll pick back up once the calendar updates. If a time changed, just text it to me.` It contains the words "door code" and does not contain digits.
