# Health does not send

The health command reports open reviews, stale sources, and counters. It does not send a text. The log keeps the last four digits of a phone number and does not keep a door code.

## Sub-features

- `stale-count` reports one open review and one stale source after the stale hold.
- `health-command` prints the same counts with `sends` false.
- `log-and-backup` write a redacted log and a scheduled snapshot.

## How to get to it (user POV)

- An operator asks whether the job is healthy.
- Nobody receives a text from that check.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false.

- **Watch the feed.** `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --watch-freshness --data <dir> --backup-dir <dir>/scheduled --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550100=YES --now 2026-10-14T18:00:00.001Z --reply +15555550100=YES`. Exit code 0. `health.staleSources` is 1, `health.openReviews` is 1, `health.sends` is false, and the note is `Cleaner Core health. This check does not send texts.`
- **Health.** `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:health -- --data <dir> --now 2026-10-14T18:00:00.001Z`. Exit code 0. The same counts. `<dir>/scheduled/scheduled.db` exists. The log has no full `+1555555` number.

## Gotchas

- Health uses the clock it is given. Without `--now` it uses the wall clock, which may not be the frozen smoke time.
- The rotation paragraph in the health document is the host-facing code text. It has no digits.
