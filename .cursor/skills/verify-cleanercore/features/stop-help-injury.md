# STOP, HELP, and injury

The owner can opt out with STOP or report an injury while the checkout question is waiting. STOP answers once and ignores a later YES, so the turnover is not scheduled. HELP sends nothing and leaves the job discovered. An owner injury gets one emergency reply. A cleaner injury alerts the host and answers the cleaner once. A repeat from the same sender adds no second text. None of these replies schedule the cleaning.

## Sub-features

- `stop-opt-out` answers STOP from `+15555550100` and ignores that owner's later YES. No confirmation.
- `help-reply` records HELP from `+15555550100` and sends nothing more.
- `injury-per-sender` answers `I fell and I'm hurt` once per sender on this job. The owner gets one emergency text. The cleaner gets one, and the host is alerted once. A repeat from either sender adds nothing.

## How to get to it (user POV)

- After the checkout question, the owner at `+15555550100` replies `STOP`, then `YES`.
- The owner replies `HELP`.
- The owner replies `I fell and I'm hurt`, then the same words again.
- The approved cleaner at `+15555550101` replies `I fell and I'm hurt`, then the same words again.
- The harness entry is `npm run cleaner:smoke -- --reply <from>=<text>`. Each reply is one `--reply`. These drives do not add YES on their own.

A set `TOURCORE_PUBLIC_BRAND_NAME` does not change the STOP line. The confirmation has no product prefix.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Reply numbers are `+15555550100` and `+15555550101` only. Both are Scratch test numbers.

- **STOP.** Reply STOP, then YES, from the owner. Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --reply +15555550100=STOP --reply +15555550100=YES`. Exit code 0. Stdout matches `scripts/expected/smoke-stop.json`. `sent` is the checkout question to `+15555550100`, then `You're opted out of cleaning texts for 12 Scratch Lane, Teaneck, NJ 07666. Reply START to get texts again.` to `+15555550100` with `kind` `stop`. There is no confirm. `pinRecipients` is `[]`. The `stay-a` job `textsBlocked` is true.
- **HELP.** Reply HELP from the owner. Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --reply +15555550100=HELP`. Exit code 0. Stdout matches `scripts/expected/smoke-help.json`. `sent` is only the checkout question. The transcript ends with `+15555550100: HELP`. The job stays `discovered`. `pinRecipients` is `[]`.
- **Injury.** Reply the injury twice from the owner and twice from the cleaner. Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --reply "+15555550100=I fell and I'm hurt" --reply "+15555550100=I fell and I'm hurt" --reply "+15555550101=I fell and I'm hurt" --reply "+15555550101=I fell and I'm hurt"`. Exit code 0. Stdout matches `scripts/expected/smoke-injury.json`. After the checkout question, `sent` has the owner's emergency `If someone is hurt, call 911 now.`, then `The cleaner at 12 Scratch Lane, Teaneck, NJ 07666 says someone is hurt. They've been told to call 911.` to `+15555550100`, then `The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.` to `+15555550100`, then `If someone is hurt, call 911 now. I've let the host know.` to `+15555550101`. Repeats add nothing. `pinRecipients` is `[]`.
- **Proof.** Save each command, stdout, stderr, and exit code under its own directory with feature ids `stop`, `help`, and `injury`. Re-read each saved stdout and require the bodies above. Safety replies after an offer and after a corrected-time text are [safety-states.md](./safety-states.md).

## Gotchas

- A bare `npm run cleaner:smoke -- STOP` exits 1 and prints no JSON. The reply form is `--reply +15555550100=STOP`.
- With no `--reply`, smoke injects three YES replies and confirms the turnover. That is the turnover journey, not STOP, HELP, or injury.
- HELP does not opt the owner out. This HELP drive sends no YES, so it does not show what a later YES would do.
- Smoke's injury drive uses one built-in job. It does not show the emergency line going out again on a later job.
- Do not satisfy this journey by calling `openCleanerCore` or `receive` from a test. Drive the CLI.
- Do not point a live inbox, webhook, or `sendblue:*` script at a real phone.
