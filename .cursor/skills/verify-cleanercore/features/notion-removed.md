# Removed Notion row

A Notion stay that later disappears cancels the cleaning with the existing cancel sentence. A second reminder and a second read of the removed row send nothing.

## Sub-features

- `scheduled` confirms Sunday, Oct 18 at 11:00 AM after the cleaner opts in and replies YES. The host's YES only answers the checkout question.
- `one-reminder` sends one cleaner reminder at `2026-10-18T12:00:00.000Z`.
- `canceled` sends one cancel sentence to the cleaner and marks the job canceled and not live.

## How to get to it (user POV)

- The cleaner at `+15555550101` replies YES, then the host confirms checkout. There is no next guest on this Notion stay, so the offer does not name a next arrival.
- The cleaner replies YES again. The offer, the confirmation, the reminder, and the cancel notice go only to that cleaner.
- The row is then removed. The cleaner is told the cleaning is canceled.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Pass `--with-pin` and seed the cleaner at `+15555550101` with YES before the host answers, then YES again to schedule.

- **Read, confirm, remind, remove.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --notion src/cleaner-core/fixtures/notion-lane-read.json --reply +15555550101=YES --reply +15555550100=YES --reply +15555550101=YES --now 2026-10-18T12:00:00.000Z --remind --notion src/cleaner-core/fixtures/notion-lane-removed.json --remind --notion src/cleaner-core/fixtures/notion-lane-removed.json`. Exit code 0.
- **Result.** `sent` is the checkout question to `+15555550100`, then the opt-in, offer, confirmation, reminder, and cancel notice to `+15555550101`. The offer is `Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 11:00 AM. Reply YES to schedule it, or STOP to opt out.` The reminder is `Reminder: cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is Sunday, Oct 18 at 11:00 AM.` The cancel sentence is `Update: the cleaning at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18 is canceled, so no need to come. Reply STOP to opt out.` The job status is `canceled` and `live` is false. The outbox has one sent reminder and one sent cancel. No offer, confirmation, reminder, or cancel goes to the host.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `notion-removed`. `prove-step-f.sh`.

## Gotchas

- The Guesty offer names a next guest. This Notion stay does not. Do not expect that phrase here.
- The second `--remind` and the second removed fixture must not add a text.
