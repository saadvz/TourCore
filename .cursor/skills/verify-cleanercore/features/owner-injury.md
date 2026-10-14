# Owner injury

An injury text from the host gets the 911 line and nothing else. The host is not alerted about their own report. A repeat sends nothing.

## Sub-features

- `911` sends `If someone is hurt, call 911 now.` to `+15555550100`.
- `no-alert` does not send a second text that says the host has been told, or that someone at the property is hurt.
- `once` sends no second emergency when the host repeats the injury.

## How to get to it (user POV)

- A Notion stay has asked the Sunday checkout question.
- The host texts `I fell and I'm hurt`, then the same words again.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.

- **Report from the host.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --notion src/cleaner-core/fixtures/notion-lane-read.json --reply "+15555550100=I fell and I'm hurt" --reply "+15555550100=I fell and I'm hurt"`. Exit code 0.
- **Result.** `sent` is the checkout question and `If someone is hurt, call 911 now.`, both to `+15555550100`. A second injury adds nothing.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `owner-injury`. `prove-step-f.sh`.

## Gotchas

- Quote the injury reply. The spaces belong to one `--reply` value.
- A cleaner injury still alerts the host. That pair is [notion-stop-help-injury.md](./notion-stop-help-injury.md).
