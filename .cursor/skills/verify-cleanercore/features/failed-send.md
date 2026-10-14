# Failed send is not delivered

A reminder whose send fails is not marked sent. The retry sends that same reminder once. A further run sends nothing.

## Sub-features

- `reminder-failed` records the morning-of reminder as `failed` and leaves it out of the transcript.
- `reminder-retry-once` sends that reminder on the next process and marks it `sent`.
- `reminder-no-third` sends nothing when reminders run again.

## How to get to it (user POV)

- The clock is Sunday, Oct 18 at 8:00 AM Eastern.
- The owner confirms checkout and check-in. The offer goes out.
- The reminder send fails. The owner does not get the reminder.
- A later process retries and the owner gets the reminder once.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- One temporary `--data` directory is shared by the three processes. `--fail-sends 1` applies only to the first process, and it is placed immediately before `--remind`.

- **Fail the reminder.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --data <dir> --now 2026-10-18T12:00:00.000Z --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550100=YES --reply +15555550100=YES --fail-sends 1 --remind`. Exit code 0. The transcript has the checkout question, the check-in question, and the offer, and does not contain `Reminder:`. The outbox item whose `kind` is `reminder` has `status` `failed`.
- **Retry.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --data <dir> --no-poll --now 2026-10-18T12:00:00.000Z --remind`. Exit code 0. `sent` is one reminder to `+15555550100`: `Reminder: checkout at 12 Scratch Lane, Teaneck, NJ 07666 is Sunday, Oct 18 at 11:00 AM. Reply STOP to opt out.` The outbox status for that id is `sent`.
- **Again.** Run the same `--no-poll --remind` command. Exit code 0. `sent` is `[]`.
- **Proof.** Save all three commands, stdouts, transcripts, and outboxes with feature id `failed-send`.

## Gotchas

- `--fail-sends` counts sink attempts in that process. Put it after the YES replies and before `--remind`, or it will fail a host question instead of the reminder.
- A `failed` row is not a delivery. Require that status on the first outbox, and require the reminder body to be missing from that process's transcript.
- The retry and the third run must share `--data`. A new directory would treat the reminder as new.
