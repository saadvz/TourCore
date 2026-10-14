# Closed sync of a changed checkout

Scratch Court's Google Calendar is read, then the same event's checkout moves from Monday to Wednesday, then the moved calendar is read again. The host gets one question per checkout date. The third read and a restarted process send nothing. No conversation is open.

## Sub-features

- `read` asks `+15555550110` about Monday, Oct 19 at 11:00 AM.
- `change` asks about Wednesday, Oct 21 at 11:00 AM and keeps one job, `google:evt-court`.
- `sync-again` sends nothing for the same snapshot, including after a new process reloads the store.

## How to get to it (user POV)

- 8 Scratch Court has a Google Calendar fixture and no open chat.
- The checkout date on that event moves from October 19 to October 21.
- A later sync of the same calendar does not text again.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- `--data` is a temporary directory this script creates and deletes after the stdout is saved.

- **Read, change, and read again.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --tenant scratch-court --closed --data <dir> --google src/cleaner-core/fixtures/google-court-stay.json --google src/cleaner-core/fixtures/google-court-stay-moved.json --google src/cleaner-core/fixtures/google-court-stay-moved.json`. Exit code 0.
- **Restart.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --tenant scratch-court --closed --data <dir> --google src/cleaner-core/fixtures/google-court-stay-moved.json`. Exit code 0. `sent` is `[]`. The job is still `google:evt-court` on 2026-10-21.
- **First process.** `sent` is the Monday question, then the Wednesday question, both to `+15555550110`. `sync.conversation` is `closed`. The transcript has no inbound line. There is one job.
- **Proof.** Save both commands and both stdouts with feature id `closed-sync`. `prove-step-e.sh`.

## Gotchas

- Scratch Court does not read Scratch Lane's built-in calendar. A court drive without `--google` or `--feed` exits 1.
- The third read is in the same process as the change. The restart is a second process with the same `--data` directory.
