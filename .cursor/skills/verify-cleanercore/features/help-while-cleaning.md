# HELP and an emergency phrase work around the door code

HELP and an injury phrase still reply while the job is awaiting departure, after the private text, and after cleaning has started. The emergency reply does not contain the door code.

## Sub-features

- `help-waiting` answers HELP and one injury phrase while `status` is `awaiting_departure`, with `pinRecipients` empty.
- `help-cleared` answers the same pair after the private text, while `status` is `cleared`.
- `help-progress` answers the same pair after START, while `status` is `in_progress`.

## How to get to it (user POV)

- The cleaner texts HELP and receives the Cleaner Core help sentence.
- The host texts that someone fell and is hurt, and receives the 911 sentence once.
- Neither reply includes a door code.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Each drive passes `--with-pin`, the Guesty fixture, cleaner YES, three host YES replies, and `--now 2026-10-18T15:30:00.000Z`.

- **Waiting.** Add `--reply +15555550101=HELP --reply "+15555550100=I fell and I'm hurt"`. Exit code 0. The last two texts are the help sentence to the cleaner and `If someone is hurt, call 911 now. I couldn't reach the property team just now.` to the host. `status` is `awaiting_departure`. `pinRecipients` is `[]`.
- **After the code.** Add `--reply "+15555550100=guests have left"` before HELP. Exit code 0. `status` is `cleared`. `pinRecipients` is `["+15555550101"]`. The emergency body has no `[redacted]`.
- **In progress.** Add departure, then `--reply +15555550101=START`, then HELP and the injury phrase. Exit code 0. The transcript contains `Got it, cleaning started.` `status` is `in_progress`. Exactly one private text was sent, and it is the redacted cleaner text.
- **Proof.** Save the three commands with feature ids `help-waiting`, `help-cleared`, and `help-progress`.

## Gotchas

- A second injury phrase from the same sender is the step C safety journey. These drives send the phrase once.
- The emergency reply is not a place to repeat the door code. A body that contains the digits or `[redacted]` fails the cleared journey.
