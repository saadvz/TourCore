# Door code only after the host confirms departure

With `--with-pin`, a confirmed same-day turn that has reached checkout does not text a door code and does not mark the job ready. After the host says the guests have left, the private text goes once to the approved cleaner.

## Sub-features

- `held` leaves the job `awaiting_departure` with `pinRecipients` empty when checkout time has passed and the host has not confirmed departure.
- `released` sends the private text once to `+15555550101` and tells the host `door code sent to the cleaner`.

## How to get to it (user POV)

- The cleaner opts in, and the host confirms checkout, check-in, and the offer.
- Before "guests have left", nobody receives a door code.
- After "guests have left", only the cleaner receives the private text. The host sees that it was sent and does not see the code.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Both drives pass `--with-pin` and the Guesty fixture. The cleaner replies YES before the host's three YES replies.

- **Hold the code.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550101=YES --reply +15555550100=YES --reply +15555550100=YES --reply +15555550100=YES --now 2026-10-18T15:30:00.000Z`. Exit code 0. `pinRecipients` is `[]`. The job `status` is `awaiting_departure`. No `sent` item has `kind` `pin`. No `status` is `ready`.
- **Release it once.** Add `--reply "+15555550100=guests have left"` to that command. Exit code 0. `pinRecipients` is `["+15555550101"]`. The job `status` is `cleared`. The private body is `Guests have left 12 Scratch Lane, Teaneck, NJ 07666. Door code: [redacted]. This code is only for you.` The host body is `door code sent to the cleaner`.
- **Proof.** Save each command, stdout, stderr, exit code, transcript, job list, and outbox with feature ids `held` and `released`. The saved stdout must not contain the scratch digits.

## Gotchas

- Checkout time alone does not release the code. `--now` after 11:00 AM without "guests have left" is the held journey.
- The smoke stdout redacts the digits. A body that still shows them fails the proof even when the recipient is correct.
- A drive without `--with-pin` is the step C turnover. It is not this proof.
