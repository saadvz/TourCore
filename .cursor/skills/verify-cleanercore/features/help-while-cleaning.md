# HELP and an emergency phrase work around the door code

HELP and an injury phrase still reply while the job is awaiting departure, after the private text, and after cleaning has started. An injury from the cleaner also alerts the host. None of those replies contain the door code.

## Sub-features

- `help-waiting` answers HELP, one host injury, and one cleaner injury while `status` is `awaiting_departure`, with `pinRecipients` empty.
- `help-cleared` answers the same three after the private text, while `status` is `cleared`.
- `help-progress` answers the same three after START, while `status` is `in_progress`.
- `injury-failed` answers a cleaner injury when the host alert fails, and a repeat sends nothing.

## How to get to it (user POV)

- The cleaner texts HELP and receives `Need help with this cleaning? Reply here and the host will see it. Reply STOP to opt out.`
- The host texts that someone fell and is hurt, and receives the 911 sentence once.
- The cleaner texts that someone fell and is hurt. The host receives `The cleaner at 12 Scratch Lane, Teaneck, NJ 07666 says someone is hurt. They've been told to call 911.` The cleaner receives `If someone is hurt, call 911 now. I've let the host know.`
- If that host alert fails, the cleaner receives `If someone is hurt, call 911 now. I couldn't reach the host, so please call them too.` A second cleaner injury adds nothing.
- None of these replies include a door code.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Each drive passes `--with-pin`, the Guesty fixture, cleaner YES, two host YES replies, the cleaner's offer YES, and `--now 2026-10-18T15:30:00.000Z`.

- **Waiting.** Add `--reply +15555550101=HELP --reply "+15555550100=I fell and I'm hurt" --reply "+15555550101=I fell and I'm hurt"`. Exit code 0. The last four texts are the help sentence to the cleaner, `If someone is hurt, call 911 now.` to the host, the host alert, and `If someone is hurt, call 911 now. I've let the host know.` to the cleaner. `status` is `awaiting_departure`. `pinRecipients` is `[]`.
- **After the code.** Add `--reply "+15555550100=guests have left"` before HELP. Exit code 0. `status` is `cleared`. `pinRecipients` is `["+15555550101"]`. The emergency bodies have no `[redacted]`.
- **In progress.** Add departure, then `--reply +15555550101=START`, then HELP, the host injury, and the cleaner injury. Exit code 0. The transcript contains `Got it, cleaning started.` `status` is `in_progress`. Exactly one private text was sent, and it is the redacted cleaner text.
- **Host alert fails.** Run the confirmed turn with `--fail-sends 1` before `--reply "+15555550101=I fell and I'm hurt" --reply "+15555550101=I fell and I'm hurt"`. Exit code 0. The only emergency in `sent` is `If someone is hurt, call 911 now. I couldn't reach the host, so please call them too.` to the cleaner. The host alert outbox row is `failed`. The transcript contains that cleaner sentence once.
- **Proof.** Save the four commands with feature ids `help-waiting`, `help-cleared`, `help-progress`, and `injury-failed`.

## Gotchas

- A second injury phrase from the same sender sends nothing. These drives send the cleaner phrase twice only on `injury-failed`, to show the second one is quiet.
- The emergency reply is not a place to repeat the door code. A body that contains the digits or `[redacted]` fails the cleared journey.
