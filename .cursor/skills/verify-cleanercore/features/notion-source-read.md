# Notion booking read

A closed conversation reads one Notion fixture for Scratch Lane. The host is asked the usual Sunday checkout question. The event clock is not the checkout time. An owner block is not a departure.

## Sub-features

- `host-question` sends the Sunday 11:00 AM checkout question to `+15555550100`.
- `one-stay` keeps one live job, `notion:row-anita`, checking out on 2026-10-18.
- `block-ignored` records `notion:row-block` as `Owner block` and does not open a job for it.
- `fresh` records the Notion read as not stale.

## How to get to it (user POV)

- The landlord's Notion database is readable for 12 Scratch Lane. This drive uses a fixture, not a Notion account.
- Nobody has a chat open. The sync still asks the host to confirm checkout.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- No `--reply`.

- **Read the fixture.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --closed --notion src/cleaner-core/fixtures/notion-lane-read.json`. Exit code 0.
- **Result.** `tenant` is `scratch-lane`. `sent` is one `host-checkout` text to `+15555550100`: `Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.` The job id is `notion:row-anita`. `blocks` is `notion:row-block` / `Owner block`. `sync.freshness` is one Notion row fetched at `2026-10-14T15:00:00.000Z` with `stale` false. The body does not say `10:00`.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `notion-source-read`. `prove-step-f.sh`.

## Gotchas

- `--closed` does not add YES. A drive that also passes `--reply` is a different journey.
- The timed checkout in the fixture is bait. The host question stays at 11:00 AM.
