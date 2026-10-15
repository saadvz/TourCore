# Door code stays private

After the host says the guests have left, the door code goes only to the approved cleaner. The group, the observer, the mirrored copies, and `+15555550199` do not receive it. The host notice does not include the code.

## Sub-features

- `cleaner-only` lists `+15555550101` in `pinRecipients` and sends one `pin` text to that number.
- `host-notice` sends `Door code sent to the cleaner.` to `+15555550100` only.
- `no-share` sends nothing to `+15555550199`, no pin to the observer, and no group or mirror body that says `Door code` or `[redacted]`.

## How to get to it (user POV)

- The cleaner, the observer, and the owner have opted in, and the offer was a group text.
- The cleaner confirms. The owner says the guests have left.
- Only the cleaner receives the private text.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- `--group +15555550199` is an unapproved number, not a participant.

- **Release the code.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --group-mode native --group-capable --group +15555550199 --participant observer=+15555550122 --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550101=YES --reply +15555550122=YES --reply +15555550100=YES --reply +15555550100=YES --reply +15555550101=YES --reply "+15555550100=guests have left"`. Exit code 0.
- **Result.** The pin body is `Guests have left 12 Scratch Lane, Teaneck, NJ 07666. Door code: [redacted]. This code is only for you. Reply DONE when the cleaning is finished.` It has no channel. The notice goes to the owner and not to the observer.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `pin-private-only`. `prove-step-f.sh`. The evidence tree must not contain the scratch digits.

## Gotchas

- `[redacted]` in the private text is expected. `[redacted]` inside a group or mirror body fails the proof.
- Do not pass `--unapproved` here. That journey sends no code at all.
