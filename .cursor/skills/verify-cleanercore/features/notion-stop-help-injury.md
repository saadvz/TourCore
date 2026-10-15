# STOP, HELP, and injury after a Notion read

STOP and an injury reply still win after a Notion stay asks the Sunday checkout question. STOP opts the owner out. HELP sends nothing after the checkout question. An injury is answered once.

## Sub-features

- `stop` sends the checkout question, then the STOP acknowledgement, and blocks later texts on that job.
- `help` sends the checkout question and nothing for HELP.
- `injury` sends the checkout question, one emergency reply to the owner, one host alert, and one cleaner reply. A repeat from the same sender adds nothing.

## How to get to it (user POV)

- The Notion sync has asked whether Sunday checkout is still 11:00 AM.
- The owner replies STOP, or HELP, or `I fell and I'm hurt`.
- The cleaner also reports the injury. Each sender is answered once.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Each reply is its own smoke process, after `--closed --notion src/cleaner-core/fixtures/notion-lane-read.json`.

- **STOP.** Add `--reply +15555550100=STOP`. `textsBlocked` is true. The second text is `You're opted out of cleaning texts for 12 Scratch Lane, Teaneck, NJ 07666. Reply START to get texts again.`
- **HELP.** Add `--reply +15555550100=HELP`. `sent` is only the checkout question. The transcript ends with `+15555550100: HELP`.
- **Injury.** Add `--reply "+15555550100=I fell and I'm hurt"` twice, then the same words from `+15555550101` twice. `sent` has four texts: the checkout question, `If someone is hurt, call 911 now.` to the owner, `The cleaner at 12 Scratch Lane, Teaneck, NJ 07666 says someone is hurt. They've been told to call 911.` to the owner, and `If someone is hurt, call 911 now. I've let the host know.` to the cleaner.
- **Proof.** Save the three stdout files with feature id `stop-help-injury`. `prove-step-f.sh`.

## Gotchas

- The built-in turnover safety journey stays in [stop-help-injury.md](./stop-help-injury.md). This file is the same replies after a Notion read.
- A second injury text from the same sender must not add another emergency body.
