# Notion sync repeat

Reading the same Notion stay three times, then again in a new process, asks the host once. The restart sends nothing and keeps the one job.

## Sub-features

- `first-question` sends one Sunday checkout question on the first read.
- `no-duplicate` sends nothing on the later reads in that process.
- `restart` loads the saved store and sends nothing. The outbox still has one `host-checkout`.

## How to get to it (user POV)

- A scheduled read runs more than once, including after the process starts again.
- The host is not asked the same checkout question again.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Both drives share one temporary `--data` directory. Remove it after both stdout files are saved.

- **Read three times.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --closed --data <dir> --notion src/cleaner-core/fixtures/notion-lane-read.json --notion src/cleaner-core/fixtures/notion-lane-read.json --notion src/cleaner-core/fixtures/notion-lane-read.json`. Exit code 0. `sent` is one `host-checkout` text. The job id is `notion:row-anita`.
- **Restart.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --closed --data <dir> --notion src/cleaner-core/fixtures/notion-lane-read.json`. Exit code 0. `sent` is `[]`. The job id is still `notion:row-anita`. The outbox has one `host-checkout`.
- **Proof.** Save both stdout files with feature id `notion-sync-repeat`. `prove-step-f.sh`.

## Gotchas

- A new `--data` directory is a new tenant store. The restart must reuse the first directory.
- Do not copy the temporary store into the evidence folder.
