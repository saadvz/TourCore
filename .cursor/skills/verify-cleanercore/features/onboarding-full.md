# Full onboarding

A new Scratch property is named, previewed, staffed, scheduled, and activated. The cleaner and the observer each get one opt-in text. Activation happens after both reply YES and the owner replies APPROVE. The door code is stored as a sealed reference and is not printed.

## Sub-features

- `preview` shows one stay and one block, and says a block is not a departure.
- `people` asks who should get texts, lists the roles owner, manager, and observer, and says nobody is texted until they reply YES. It does not name Cory.
- `lock-limit` says this demo cannot rotate, revoke, or control the lock.
- `old-texts` says old texts are not consent.
- `activated` sets `setup.activated` true, `setup.tenantId` to `annex`, and `setup.sealed` true.
- `opt-in-only` sends two opt-in texts, to `+15555550121` and `+15555550122`.

## How to get to it (user POV)

- The owner at `+15555550120` answers each setup question for Annex at 9 Scratch Annex.
- The cleaner at `+15555550121` and Cory at `+15555550122` reply YES.
- The owner replies APPROVE. No cleaning text goes out during setup.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- The outdoor code is passed as `--reply +15555550120=@src/cleaner-core/fixtures/annex-lock.txt`. Do not type the digits on the command line.

- **Walk the eight steps.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --onboard --notion src/cleaner-core/fixtures/notion-annex.json` with the property line, the source line, `OK`, the people line, YES from the cleaner, YES from the observer, the quiet-hours line, the `@` lock reply, `SKIP`, and `APPROVE`. Exit code 0.
- **Result.** `setup.prompt` is `Activated Annex. I will text only the numbers that opted in. I will not infer consent, a vacancy, or a lock-code change.` `sent` is the two Annex opt-in texts. The stdout does not mention `+15555550100`, 12 Scratch Lane, or 8 Scratch Court, and it does not contain a door code.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `onboarding-full`. `prove-step-f.sh`.

## Gotchas

- A second APPROVE in the same process does not send another opt-in. This drive sends APPROVE once.
- The saved command must keep the `@` path. Expanding the lock file into the command line fails the proof.
