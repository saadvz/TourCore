# The door code stays private

The code goes only to the opted-in approved cleaner after the host says the guests have left. A group, a mirror, an observer, and an unapproved number do not get it. A code-like inbound opens one review and the saved text does not keep the digits.

## Sub-features

- `private-send` texts the redacted door-code line only to `+15555550101`.
- `group-and-mirror` copy the offer without the code.
- `exposure` alerts the host once and stores no digits.
- `sealed-backup` keeps a sealed reference in the backup and the log.

## How to get to it (user POV)

- The cleaner has opted in and the host says the guests have left.
- Someone texts the code by itself.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false.
- The exposure reply is an `@` path to a temporary file. The command line does not contain the digits.

- **Native group.** Run smoke with `--with-pin --group-mode native --group-capable --group +15555550199 --participant observer=+15555550122`, the Scratch feed, YES from the cleaner and the observer, YES twice from the owner, YES from the cleaner, and `guests have left`. Exit code 0. `pinRecipients` is `["+15555550101"]`. The pin body is `Guests have left 12 Scratch Lane, Teaneck, NJ 07666. Door code: [redacted]. This code is only for you. Reply DONE when the cleaning is finished.`
- **Mirror.** The same replies with `--group-mode mirrored`. The mirror copy does not contain `Door code`.
- **Exposure.** Run `--no-poll --with-pin --watch-freshness --reply +15555550101=@<temp file>`. `sent` is one possible-code-exposure review to `+15555550100`.

## Gotchas

- Smoke redacts the code in stdout. The proof still scans the backup file and the log.
- The host notice is `Door code sent to the cleaner.`
