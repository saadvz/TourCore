# The door code is stored sealed

After the private text is sent, the persisted store, the transcript, the outbox, and the smoke stdout contain `[redacted]` where the digits were. The scratch digits appear in none of those files.

## Sub-features

- `redacted-stdout` prints the private body with `[redacted]` and lists only the cleaner in `pinRecipients`.
- `sealed-store` writes `cleaner-core.json` with no scratch digits.

## How to get to it (user POV)

- The cleaner opts in and the host confirms the turnover, then says the guests have left.
- The cleaner receives one private text. Everyone reading the saved record sees the redacted sentence.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- A temporary directory exists for `--data`. Copy `cleaner-core.json` into the evidence directory before removing the temporary directory.

- **Send into a store.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --data <dir> --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550101=YES --reply +15555550100=YES --reply +15555550100=YES --reply +15555550101=YES --reply "+15555550100=guests have left"`. Exit code 0.
- **Stdout.** `pinRecipients` is `["+15555550101"]`. The private body is the redacted sentence. The transcript contains that sentence.
- **Grep.** The scratch digits are absent from stdout, stderr, and `cleaner-core.json`.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, job list, outbox, and a copy of the store with feature id `pin-stored`. The harness greps `evidence/step-d` for the digits and fails the run if they appear.

## Gotchas

- The unit test that checks the sink may see the private text in memory. That process is not this evidence folder.
- Step C's `no-pin` journey must still omit both the digits and the phrase `door code`. This journey is allowed to say `door code` only in the redacted private text and the host notice.
