# Google block is not a departure

A Google Calendar owner block on the checkout day is a block. It does not become a job, and it does not become the next arrival. The reserved stay is still the Sunday checkout.

## Sub-features

- `block-row` lists `google:evt-block` with summary `Owner block`.
- `one-stay` keeps one job, `google:evt-stay`, checking out on 2026-10-18.
- `not-a-departure` does not create a job for the block or for 2026-10-19.

## How to get to it (user POV)

- The calendar has a reserved stay ending Sunday and an owner block that starts that same day.
- The host is asked about Sunday. Nobody is asked to leave because of the block.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.

- **Read the stay and the block.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --closed --google src/cleaner-core/fixtures/google-lane-block.json`. Exit code 0.
- **Result.** `blocks` is one row, uid `google:evt-block`, summary `Owner block`. `jobs` is one row, id `google:evt-stay`, checkout date `2026-10-18`. `sent` is the Sunday 11:00 AM question to `+15555550100`.
- **Proof.** Save the command, stdout, job list, and blocks with feature id `block`. `prove-step-e.sh`.

## Gotchas

- `Owner block` is classified by the same words as a Guesty Lite block. The block's end date is not a checkout.
