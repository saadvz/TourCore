# No offer until the cleaner opts in

A native group with no opted-in cleaner does not send the offer, and a host YES does not schedule the job. The host is told the cleaning is on hold.

## Sub-features

- `held` sends `The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is on hold until the cleaner replies YES.` to `+15555550100`.
- `no-schedule` leaves the Anita job at `host_confirmed` after three host YES replies. No offer, confirmation, group text, or mirror copy is sent.

## How to get to it (user POV)

- The landlord asked for a group, and the number can send one.
- The cleaner has not replied YES. The host confirms checkout and check-in, then replies YES again.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Do not pass `--with-pin` and do not reply from `+15555550101`.

- **Ask for a group before anyone opts in.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --group-mode native --group-capable --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550100=YES --reply +15555550100=YES --reply +15555550100=YES`. Exit code 0.
- **Result.** `sent` is the checkout question, the check-in question, and the hold notice, all to `+15555550100`. The Anita job status is `host_confirmed`. Nothing is sent to `+15555550101`.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `group-no-optin`. `prove-step-f.sh`.

## Gotchas

- `--group-capable` does not make the host the cleaner. The third YES must not confirm the job.
- A copy prefixed `Group text: ` or `Copy of the group text: ` means the offer left the hold.
