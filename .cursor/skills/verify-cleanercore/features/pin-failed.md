# A failed door-code send is not delivered

If the private send throws, the job stays `awaiting_departure`, the outbox row is `failed`, and the host is told the code did not arrive. The next reminder sends that same text once. A second reminder sends nothing.

## Sub-features

- `failed` records the private outbox row as `failed` and texts the host `The door code didn't reach the cleaner. We'll try again in a few minutes.`
- `retry` sends the redacted private text once and the host notice once, then marks the job `cleared`.
- `again` sends nothing and leaves that outbox row `sent`.

## How to get to it (user POV)

- The host says the guests have left and the send fails. The cleaner does not get the code. The host sees the failure sentence.
- A later reminder delivers the code once. Another reminder does not send it again.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- One temporary `--data` directory is shared by the three processes. Copy `cleaner-core.json` into the evidence directory before removing it.

- **Fail the send.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --data <dir> --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550101=YES --reply +15555550100=YES --reply +15555550100=YES --reply +15555550101=YES --now 2026-10-18T15:30:00.000Z --fail-sends 1 --reply "+15555550100=guests have left"`. Exit code 0. `pinRecipients` is `[]`. The job `status` is `awaiting_departure`. The pin outbox `status` is `failed` and its body is redacted. The host receives the failure sentence.
- **Retry once.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --data <dir> --no-poll --remind`. Exit code 0. One private text goes to the cleaner and one notice goes to the host. The job `status` is `cleared`.
- **Retry again.** Run that remind command a second time. Exit code 0. `sent` is `[]`. The pin outbox `status` is `sent`. The transcript contains the redacted private sentence once.
- **Proof.** Save the three commands, stdout, stderr, exit codes, transcripts, job lists, and outboxes with feature id `pin-failed`.

## Gotchas

- `--fail-sends 1` fails the next sink call. The failure sentence itself must still be delivered, so the count is one.
- A new `--data` directory on the retry starts a new job. This proof is three processes and one directory.
