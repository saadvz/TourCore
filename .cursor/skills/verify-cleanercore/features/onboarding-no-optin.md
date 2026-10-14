# Onboarding without opt-in

The owner can finish every setup step and reply APPROVE. If the cleaner has not replied YES, the property is not activated and no cleaning text is sent. The opt-in requests still go out.

## Sub-features

- `not-activated` leaves `setup.activated` false.
- `refusal` sets the prompt to the not-activated sentence.
- `opt-in-only` sends two `opt-in` texts and no offer, pin, reminder, host question, or confirmation.

## How to get to it (user POV)

- The owner answers the setup questions and replies APPROVE.
- The cleaner never replies YES.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Do not pass a YES reply from `+15555550121` or `+15555550122`.
- Pass the outdoor code as `--reply +15555550120=@src/cleaner-core/fixtures/annex-lock.txt`.

- **Approve too early.** Run the onboard drive through `APPROVE` with no YES replies. Exit code 0.
- **Result.** `setup.prompt` is `Not activated. The cleaner has not opted in, so I did not send a cleaning text.` `sent` kinds are `opt-in` then `opt-in`.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `onboarding-no-optin`. `prove-step-f.sh`.

## Gotchas

- The opt-in texts are not cleaning texts. Their presence does not mean the property is active.
- Do not put the lock digits in the command or the saved stdout.
