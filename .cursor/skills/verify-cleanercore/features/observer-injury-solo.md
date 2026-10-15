# Observer injury outside a group

An injury text from a known observer, when group texting was not requested, still alerts the host and tells the observer to call 911. It does not say the property team could not be reached. A repeat sends nothing.

## Sub-features

- `alert` sends `An observer at 12 Scratch Lane, Teaneck, NJ 07666 says someone is hurt. They've been told to call 911.` to `+15555550100`, then the injury hold to the same number.
- `reply` sends `If someone is hurt, call 911 now. I've let the host know.` to `+15555550122`.
- `once` sends no second pair when the observer repeats the injury.

## How to get to it (user POV)

- The observer is on the property, and texts are one-to-one.
- The observer texts `I fell and I'm hurt`, then the same words again.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Pass `--group-mode cleaner-only` and `--participant observer=+15555550122`. Do not pass `--group-capable`.

- **Report outside the group.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --group-mode cleaner-only --participant observer=+15555550122 --notion src/cleaner-core/fixtures/notion-lane-read.json --reply "+15555550122=I fell and I'm hurt" --reply "+15555550122=I fell and I'm hurt"`. Exit code 0.
- **Result.** `sent` is the checkout question, the host alert, and the observer reply. No emergency text has a channel. A second injury adds nothing.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `observer-injury-solo`. `prove-step-f.sh`.

## Gotchas

- The observer does not have to opt in before an injury text is answered.
- `I couldn't reach the property team just now` is the touring line. This journey must not use it.
