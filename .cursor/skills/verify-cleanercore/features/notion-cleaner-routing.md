# Notion job texts go to the opted-in cleaner

A Notion stay's offer and confirmation go to the cleaner who replied YES. A later YES from the host does not schedule the job.

## Sub-features

- `cleaner-only` sends the offer and `Cleaning is scheduled` only to `+15555550101`.
- `host-yes` leaves the job unscheduled when the host replies YES after the offer. The cleaner's YES is what confirms it.

## How to get to it (user POV)

- The cleaner opts in, the host confirms Sunday checkout, and the host replies YES again.
- The cleaner then replies YES. The cleaning is scheduled for that cleaner.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Pass `--with-pin`. This drive does not say the guests have left.

- **Seed the cleaner.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --notion src/cleaner-core/fixtures/notion-lane-read.json --reply +15555550101=YES --reply +15555550100=YES --reply +15555550100=YES --reply +15555550101=YES`. Exit code 0.
- **Result.** `sent` is the checkout question to `+15555550100`, then the opt-in, the offer, and the confirmation to `+15555550101`. The job status is `confirmed`. The host receives no offer and no confirmation. `pinRecipients` is `[]`.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `notion-cleaner-routing`. `prove-step-f.sh`.

## Gotchas

- The second host YES is the one that used to schedule the job. It must stay in the command so the proof shows it does not.
- The reminder and the cancel notice are covered by [notion-removed.md](./notion-removed.md).
