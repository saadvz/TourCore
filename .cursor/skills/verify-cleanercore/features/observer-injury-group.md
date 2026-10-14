# Observer injury inside a group

An injury text from an opted-in observer in a native group gets the same 911 reply a cleaner injury gets, and the host is alerted. The reply is not a group text. A repeat sends nothing.

## Sub-features

- `alert` sends `An observer at 12 Scratch Lane, Teaneck, NJ 07666 says someone is hurt. They've been told to call 911.` to `+15555550100`.
- `reply` sends `If someone is hurt, call 911 now. I've let the host know.` to `+15555550122`.
- `once` sends no second pair when the observer repeats the injury.

## How to get to it (user POV)

- The cleaner and the observer have opted in, and the number can send a group.
- The observer texts `I fell and I'm hurt`, then the same words again.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Pass `--with-pin`, `--group-mode native`, `--group-capable`, and `--participant observer=+15555550122`.

- **Report from the group.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --group-mode native --group-capable --participant observer=+15555550122 --notion src/cleaner-core/fixtures/notion-lane-read.json --reply +15555550101=YES --reply +15555550122=YES --reply "+15555550122=I fell and I'm hurt" --reply "+15555550122=I fell and I'm hurt"`. Exit code 0.
- **Result.** After the checkout question and the two opt-in texts, `sent` has the host alert and the observer reply. Neither emergency text has a channel. `messaging.actual` is `native`. A second injury adds nothing.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `observer-injury-group`. `prove-step-f.sh`.

## Gotchas

- Quote the injury reply. The spaces belong to one `--reply` value.
- The observer's YES opts that number in. It does not schedule the cleaning.
