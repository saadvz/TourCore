# Replay does not send again

A finished turn can be replayed from the saved store. Inbound ids and sent outbox rows produce no new text.

## Sub-features

- `turn` sends the checkout question, the check-in question, and one offer.
- `replay` on a second process sends nothing and leaves the offer `sent`.

## How to get to it (user POV)

- The host already confirmed the times.
- The same inbound events are delivered again.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false.
- Both processes share one `--data` directory.

- **Turn.** `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --data <dir> --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550101=YES --reply +15555550100=YES --reply +15555550100=YES`. Exit code 0. `sent` includes one offer to `+15555550101`.
- **Replay.** `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --no-poll --data <dir> --replay`. Exit code 0. `sent` is `[]`.

## Gotchas

- Replay of an uncertain row is the recovery journey, not this one. This journey's rows are already `sent`.
