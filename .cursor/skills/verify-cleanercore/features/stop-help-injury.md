# STOP, HELP, and injury

The owner can opt out with STOP, ask for HELP, or report an injury. Each reply gets one acknowledgement back to that owner. None of those acknowledgements include the door code, and STOP ignores a later YES.

## Sub-features

- `stop-opt-out` answers STOP with the opt-out acknowledgement and ignores a later YES.
- `help-reply` answers HELP with the Cleaner Core help line.
- `injury-once` answers an injury report once, with the 911 line, and does not send the door code.

## How to get to it (user POV)

- After the offer, the owner at `+15555550100` replies `STOP`.
- The owner replies `HELP`.
- The owner replies `I fell and I'm hurt`.
- A second injury report on that same job gets no second text.

The observable replies, when a drive can deliver those messages, are:

- STOP: `Tour Core: You're opted out and won't receive more messages. Reply START to opt back in. Reply HELP for help.` to `+15555550100`, and no later confirm or door code.
- HELP: `Cleaner Core: Reply here if you need help with this turnover. Reply STOP to opt out.` to `+15555550100`, and no door code.
- Injury: `If someone is hurt, call 911 now. I couldn't reach the property team just now.` to `+15555550100`, once, and no door code.

Leave `TOURCORE_PUBLIC_BRAND_NAME` unset. A set brand changes the STOP line.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- The journey needs a command that delivers an inbound `STOP`, `HELP`, or `I fell and I'm hurt` from `+15555550100`. The doctor/smoke CLI has no such command.

- **STOP.** Reply STOP from the owner. The attempted command is `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- STOP`. That command does not deliver STOP. `cleaner:smoke` ignores arguments after the script name and still injects YES from `+15555550100`. Unmet precondition: no inbound-reply command. Do not record the YES confirm or the pin text as a STOP result. This sub-feature stays unverified.
- **HELP.** Reply HELP from the owner. The attempted command is `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- HELP`. Same unmet precondition. Smoke still injects YES. Do not record the confirm as a HELP acknowledgement.
- **Injury.** Reply `I fell and I'm hurt`. The attempted command is `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- "I fell and I'm hurt"`. Same unmet precondition. Smoke still injects YES and still texts the door code to `+15555550101`. Do not record that pin text as the injury result.

## Gotchas

- Running smoke to "see what happens" books the turnover and sends the door code in-process. That is the opposite of STOP and of an injury.
- `tsx src/cleaner-core/cli.ts smoke STOP` is the same trap. Only `argv[2]` selects the command. Later words are ignored.
- Do not satisfy this journey by calling `openCleanerCore` or `receive` from a test. That is not the doctor/smoke CLI.
- A unit test that already covers these replies is not this map's proof. The map drives the CLI the user runs.
- Do not point a live inbox, webhook, or `sendblue:*` script at a real phone to fill the gap.
