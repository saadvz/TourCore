# Notion permission denied

A closed read of a Notion fixture with no permission tells the host the database was not read. No booking is synced and no cleaning text is sent.

## Sub-features

- `permission-missing` sets `sync.reason` to `permission-denied` and `sync.fallback` to the missing-permission sentence.
- `no-send` leaves `sent` empty, `jobs` empty, and `pinRecipients` empty.

## How to get to it (user POV)

- The landlord pointed Cleaner Core at a Notion database for 12 Scratch Lane. This drive uses a fixture, not a Notion account.
- The connection cannot read that database. Nobody is texted.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- No `--reply`.

- **Read the denied fixture.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --closed --notion src/cleaner-core/fixtures/notion-lane-denied.json`. Exit code 0.
- **Result.** `sync.reason` is `permission-denied`. `sync.fallback` is `I can't read that Notion database. Permission is missing, so I did not sync bookings and I did not send a cleaning text.` `sent` is `[]`. `jobs` is `[]`.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `notion-permission-denied`. `prove-step-f.sh`.

## Gotchas

- A fixture that says permission is insufficient uses a different sentence and is covered by the unit tests, not this drive.
- Rows in the denied fixture are ignored. They must not become jobs.
