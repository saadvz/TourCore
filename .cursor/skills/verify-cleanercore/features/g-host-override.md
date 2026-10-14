# A host time beats a stale feed

A checkout the host already corrected stays when a later stale feed names another day. That poll sends nothing new.

## Sub-features

- `host-clock` keeps Sunday, Oct 18 at 2:00 PM.
- `stale-read` records the feed as stale and does not send another offer.

## How to get to it (user POV)

- The host texts `2:00 PM`, then YES.
- A later feed says a different day, and that feed is older than three hours.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false.

- **Correct, then re-read.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --watch-freshness --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550100=2:00 PM --reply +15555550100=YES --now 2026-10-14T18:00:00.001Z --fetched-at 2026-10-14T15:00:00.000Z --then-feed src/cleaner-core/fixtures/guesty-lite-date-moved.ics`. Exit code 0. The offer says `Checkout 2:00 PM`. The job `stay-anita@guesty.com` stays on `2026-10-18` at `2:00 PM`. The source freshness is `stale`. `reviews` is empty.

## Gotchas

- The offer was already sent before the feed went stale, so this journey does not also send the stale alert. The stale-source journey covers that alert.
- A removed stay can still cancel. This feed is a date change, not a removal.
