# Blocks create no job

An owner block and a blocked date create no cleaning job and send no offer.

## Sub-features

- `block-owner` records `block-owner@guesty.com` as a block.
- `block-date` records `block-date@guesty.com` as a block.
- `block-silent` sends no text and leaves `jobs` empty.

## How to get to it (user POV)

- The landlord points smoke at `src/cleaner-core/fixtures/guesty-lite-blocks-only.ics`.
- The owner at `+15555550100` receives nothing.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.

- **Read blocks only.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --feed src/cleaner-core/fixtures/guesty-lite-blocks-only.ics`. Exit code 0.
- **Nothing to clean.** `jobs` is `[]`. `sent` is `[]`. `outbox` is `[]`. `transcript` is `[]`. `pinRecipients` is `[]`.
- **Blocks.** `blocks` is `block-owner@guesty.com` with summary `Blocked`, then `block-date@guesty.com` with summary `Not available`.
- **Proof.** Save the command, stdout, stderr, exit code, job list, and outbox with feature id `blocks`.

## Gotchas

- A file that mixes stays and blocks is the read-feed journey. This file has only the two blocks.
- An empty `sent` with a non-empty `jobs` array would still be a job. Require both arrays empty.
