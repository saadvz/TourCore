# Each host review is sent once

The nine review kinds each text the host once. Filing the same kind again sends nothing. A host text of `booked on airbnb` opens the Airbnb review by itself.

## Sub-features

- `each-kind-once` sends nine reviews and leaves nine open.
- `airbnb-phrase` sends the Airbnb review from that inbound text.

## How to get to it (user POV)

- The host is told about a stale feed, a manual Airbnb exception, a tight same-day turn, a missed reminder, conflicting replies, a failed or uncertain text, a routing problem, or a possible code exposure.
- The same item is not texted on every poll.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false.

- **File each kind twice.** `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --no-poll` with each `--review` kind twice. Exit code 0. `sent` has nine reviews, all to `+15555550100`. `health.openReviews` is 9 and `health.sends` is false.
- **Airbnb words.** `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --watch-freshness --no-poll --reply +15555550100=booked on airbnb`. `sent` is one Airbnb review.

## Gotchas

- Same-day capacity, missed reminder, conflicting replies, and shared-chat routing are filed with `--review` on this demo. Stale, Airbnb, failed, uncertain, and exposure are opened by the turn itself.
- Failed-send reviews from a real send failure do not add a second SMS on top of the existing failure text.
