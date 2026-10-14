# Consented group text

When group texting is available and the cleaner, the owner, and the observer have all opted in, the cleaner gets a private offer. The owner and the observer each get a group copy that does not ask them to reply YES. No door code is sent.

## Sub-features

- `native` sets `messaging.actual` to `native` and `messaging.note` to `This is a group text.`
- `three-offers` sends the private offer to `+15555550101`. The owner and the observer each get `Group text: ` plus the offer ending `The cleaner will reply to confirm.`
- `no-pin` leaves `pinRecipients` empty.

## How to get to it (user POV)

- The landlord asked for a group, and the number can send one.
- Each participant replies YES before the offer goes out.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- `--with-pin` is required so the cleaner must opt in before the offer. This drive does not say the guests have left.

- **Opt everyone in.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --group-mode native --group-capable --participant observer=+15555550122 --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550101=YES --reply +15555550122=YES --reply +15555550100=YES --reply +15555550100=YES`. Exit code 0.
- **Result.** The cleaner's offer has no channel and ends `Reply YES to schedule it, or STOP to opt out.` The owner and observer offers use channel `group`, start with `Group text: `, and end `The cleaner will reply to confirm.` `pinRecipients` is `[]`.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `group-native-consented`. `prove-step-f.sh`.

## Gotchas

- `--group-capable` without `--group-mode native` does not start a group.
- A participant who is still pending keeps this journey from being native. That is `group-unconsented-participant`.
