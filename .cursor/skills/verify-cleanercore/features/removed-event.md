# Removed Google event

When Scratch Court's only Google event disappears, the host receives the same cancel sentence Cleaner Core already uses. The job stays one row, and that row is not live. A block is not involved.

## Sub-features

- `asked` sends the Monday checkout question before the event disappears.
- `cancel-text` sends `Update: the cleaning at 8 Scratch Court, Teaneck, NJ 07666 on Monday, Oct 19 is canceled, so no need to come. Reply STOP to opt out.`
- `one-row` leaves `google:evt-court` with `status` `canceled` and `live` false.

## How to get to it (user POV)

- The host was asked about Monday's checkout.
- The Google event is removed. The next sync tells the host the cleaning is canceled.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- No `--reply`.

- **Read, then remove.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --tenant scratch-court --closed --google src/cleaner-core/fixtures/google-court-stay.json --google src/cleaner-core/fixtures/google-court-empty.json`. Exit code 0.
- **Result.** `sent` is the Monday question, then the cancel sentence, both to `+15555550110`. `jobs` has one row, `google:evt-court`, `status` `canceled`, `live` false. `sync.conversation` is `closed`.
- **Proof.** Save the command, stdout, and job list with feature id `removed`. `prove-step-e.sh`.

## Gotchas

- The cancel sentence is the existing one with the Scratch Court address filled in. It is not a new template.
- An empty item list is a successful read of a calendar that no longer has the event.
