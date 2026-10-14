# The door code is not sent to a group or to Cory

A Scratch number marked as a group does not receive the private text. The host's copy says `Door code sent to the cleaner.` and does not include the code. There is no third recipient.

## Sub-features

- `cleaner-only` sends `kind` `pin` only to `+15555550101`.
- `host-notice` sends `Door code sent to the cleaner.` to `+15555550100`.
- `no-group-recipient` sends nothing to the `--group` number.

## How to get to it (user POV)

- The cleaner has opted in and the host says the guests have left.
- The cleaner receives the private text. The host is told it was sent, without the code.
- A group number receives nothing.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- `--group` is a Scratch test number. This journey uses `+15555550199`.

- **Depart with a group set.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --group +15555550199 --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550101=YES --reply +15555550100=YES --reply +15555550100=YES --reply +15555550101=YES --reply "+15555550100=guests have left"`. Exit code 0.
- **Recipients.** `pinRecipients` is `["+15555550101"]`. No `to` is `+15555550199`. The only `kind` `pin` body is the redacted cleaner sentence. The only `kind` `pin-notice` body is `Door code sent to the cleaner.`, to `+15555550100`.
- **Proof.** Save the command, stdout, stderr, exit code, and outbox with feature id `no-group`.

## Gotchas

- Cory does not have a Scratch handset in this demo. The host notice is the copy Cory reads. A separate Cory number is later.
- `--group` must be a Scratch 555 number. Any other value fails the command and sends nothing.
