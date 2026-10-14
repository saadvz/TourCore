# Restore does not send the turn again

A backup taken after STOP restores that opt-out. The next feed poll sends nothing. Scratch Court, saved in the same folder, keeps its job.

## Sub-features

- `restore-quiet` sends nothing on the poll after restore.
- `opt-out-kept` leaves the offer and the STOP row in the outbox and blocks further texts.
- `court-kept` still has `google:evt-court` and sends nothing.

## How to get to it (user POV)

- The host has already replied STOP.
- The store is restored from a snapshot taken after that STOP.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false.
- Court is read first, then Lane is driven through STOP and `--backup`. The Lane slice is emptied without dropping Court, then Lane is restored.

- **Court.** `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --tenant scratch-court --data <dir> --google src/cleaner-core/fixtures/google-court-stay.json` sends the Monday checkout question to `+15555550110`.
- **Restore.** `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --data <dir> --restore <backup> --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics` has `sent` `[]`, a blocked Lane job, and an offer row already `sent`.
- **Court again.** `--tenant scratch-court --data <dir> --no-poll` has `sent` `[]` and job `google:evt-court`.

## Gotchas

- `--backup` has to run after STOP. A backup taken first restores an empty turn.
- The backup file is scanned. It must not contain a configured scratch code.
