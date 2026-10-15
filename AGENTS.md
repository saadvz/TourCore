# Agent safety

Cloud agents load this file at the start of a run.

Tour Core setup and the operator skills stay in [GROK_BOOTSTRAP.md](GROK_BOOTSTRAP.md) and [.grok/skills/](.grok/skills/). Read those for property setup, a tour, or a landlord question.

## Safety rules

A live text to a real person waits for Saad's okay.

Door codes in this repo are made-up. A real lock code stays out of tests, fixtures, logs, and prompts.

The door code goes only in a private text to the approved cleaner. The proof for that gate is [docs/cleaner-core-safety-gates.md](docs/cleaner-core-safety-gates.md).

Secrets stay out of code, logs, and prompts. [GROK_BOOTSTRAP.md](GROK_BOOTSTRAP.md) already says not to ask for a secret in chat, and not to repeat one if someone pastes it.

Cory (the host) never texts the Cleaner Core number.

## How to verify a change

Prove a Cleaner Core change with the [verify-cleanercore skill](.cursor/skills/verify-cleanercore/SKILL.md). The gates that have to stay green are [docs/cleaner-core-safety-gates.md](docs/cleaner-core-safety-gates.md). The skill sends nothing to a real phone.

## Lessons

At most eight one-line notes. A note with a test links to that test.

- 2026-10-14: `noteUnsentHost` records a declined host text as unsent (#99). [test/cleanerHostTexts.test.ts](test/cleanerHostTexts.test.ts)
- 2026-10-14: The live connector must point at the Railway service `tourcore-production-72ec`. checklist, no test.
- 2026-10-14: The Twilio inbound webhook must be set. checklist, no test.
- 2026-10-14: A carrier STOP block (Twilio error 21610) is cleared by that phone texting START. checklist, no test.

## Upkeep

Cloud agents never edit this file on their own. A change comes only through a proposed pull request that QA bot reviews. Delete a lesson once a test enforces it.
