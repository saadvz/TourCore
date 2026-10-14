# STOP, HELP, and injury

The owner can opt out with STOP, ask for HELP, or report an injury while the checkout question is waiting. STOP answers once and ignores a later YES, so the turnover is not scheduled. HELP answers with the Cleaner Core help line. An injury gets one emergency reply per sender on this job: the owner and the approved cleaner each get it once, and a repeat from the same sender adds no second text. None of these replies schedule the cleaning.

## Sub-features

- `stop-opt-out` answers STOP from `+15555550100` and ignores that owner's later YES. No confirmation.
- `help-reply` answers HELP from `+15555550100` with the Cleaner Core help line.
- `injury-per-sender` answers `I fell and I'm hurt` once per sender on this job. `+15555550100` and `+15555550101` each get one emergency text. A repeat from either sender adds nothing.

## How to get to it (user POV)

- After the checkout question, the owner at `+15555550100` replies `STOP`, then `YES`.
- The owner replies `HELP`.
- The owner replies `I fell and I'm hurt`, then the same words again.
- The approved cleaner at `+15555550101` replies `I fell and I'm hurt`, then the same words again.
- The harness entry is `npm run cleaner:smoke -- --reply <from>=<text>`. Each reply is one `--reply`. These drives do not add YES on their own.

Leave `TOURCORE_PUBLIC_BRAND_NAME` unset. A set brand changes the STOP line.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Reply numbers are `+15555550100` and `+15555550101` only. Both are Scratch test numbers.

- **STOP.** Reply STOP, then YES, from the owner. Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --reply +15555550100=STOP --reply +15555550100=YES`. Exit code 0. Stdout matches `scripts/expected/smoke-stop.json`. `sent` is the checkout question to `+15555550100`, then `Tour Core: You're opted out and won't receive more messages. Reply START to opt back in. Reply HELP for help.` to `+15555550100` with `kind` `stop`. There is no confirm. `pinRecipients` is `[]`. The `stay-a` job `textsBlocked` is true.
- **HELP.** Reply HELP from the owner. Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --reply +15555550100=HELP`. Exit code 0. Stdout matches `scripts/expected/smoke-help.json`. The second `sent` item is `Cleaner Core: Reply here if you need help with this turnover. Reply STOP to opt out.` to `+15555550100` with `kind` `help`. `pinRecipients` is `[]`.
- **Injury.** Reply the injury twice from the owner and twice from the cleaner. Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --reply "+15555550100=I fell and I'm hurt" --reply "+15555550100=I fell and I'm hurt" --reply "+15555550101=I fell and I'm hurt" --reply "+15555550101=I fell and I'm hurt"`. Exit code 0. Stdout matches `scripts/expected/smoke-injury.json`. After the checkout question, `sent` has one `emergency` to `+15555550100` and one `emergency` to `+15555550101`. Both bodies are `If someone is hurt, call 911 now. I couldn't reach the property team just now.` `pinRecipients` is `[]`.
- **Proof.** Save each command, stdout, stderr, and exit code under its own directory with feature ids `stop`, `help`, and `injury`. Re-read each saved stdout and require the bodies above. Safety replies after an offer and after a corrected-time text are [safety-states.md](./safety-states.md).

## Gotchas

- A bare `npm run cleaner:smoke -- STOP` exits 1 and prints no JSON. The reply form is `--reply +15555550100=STOP`.
- With no `--reply`, smoke injects three YES replies and confirms the turnover. That is the turnover journey, not STOP, HELP, or injury.
- HELP does not opt the owner out. This HELP drive sends no YES, so it does not show what a later YES would do.
- Smoke's injury drive uses one built-in job. It does not show the emergency line going out again on a later job.
- Do not satisfy this journey by calling `openCleanerCore` or `receive` from a test. Drive the CLI.
- Do not point a live inbox, webhook, or `sendblue:*` script at a real phone.
