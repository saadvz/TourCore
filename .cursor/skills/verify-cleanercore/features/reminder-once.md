# One reminder

Each reminder goes out exactly once. Polling the same feed twice, asking for the reminder twice, and starting the process again do not send a second copy.

## Sub-features

- `reminder-after-offer` sends one morning-of reminder after checkout and check-in are confirmed and the offer is out.
- `reminder-second-poll` does not send another copy when the same feed is read again in that process.
- `reminder-restart` does not send another copy from a second process that only runs reminders.

## How to get to it (user POV)

- The clock is Sunday, Oct 18 at 8:00 AM Eastern (`2026-10-18T12:00:00.000Z`), which is when the morning-of reminder is due.
- The owner confirms checkout and check-in with YES. The offer goes out. The reminder follows once.
- A second process with the same store runs the reminder again and sends nothing new.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- A temporary directory exists for `--data`. Remove it only after stdout is saved.

- **Poll twice and remind twice.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --data <dir> --now 2026-10-18T12:00:00.000Z --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550100=YES --reply +15555550100=YES --remind --remind`. Exit code 0.
- **One reminder.** The transcript ends with `Reminder: checkout at 12 Scratch Lane, Teaneck, NJ 07666 is Sunday, Oct 18 at 11:00 AM. Reply STOP to opt out.` That line appears once. `sent` has one `kind` `reminder`.
- **Restart.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --data <dir> --no-poll --now 2026-10-18T12:00:00.000Z --remind`. Exit code 0. This process's `sent` is `[]`. The transcript still shows the one reminder from the first process.
- **Proof.** Save both commands, both stdouts, the transcript, and the outbox with feature id `reminder-once`. The harness is `prove-step-c.sh`, which creates the temporary directory.

## Gotchas

- The reminder is due only at or after 8:00 AM Eastern on the checkout date. The default smoke clock, `2026-10-14T15:00:00.000Z`, is too early, so `--remind` then sends nothing.
- `--no-poll` on the second process keeps the stored job. A fresh process without `--data` cannot see the first reminder.
- The transcript on the restart is the stored transcript, not a list of texts that process sent. Read `sent` for the restart.
