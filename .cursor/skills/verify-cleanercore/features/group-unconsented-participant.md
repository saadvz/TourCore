# Unconsented participant left out

A group was requested and the number can send one, but the observer has not opted in. The offer is mirrored to the people who are in, and the observer is left out. STOP and HELP from that observer go only to that number.

## Sub-features

- `left-out` sets `messaging.actual` to `mirrored`, `excluded` to `+15555550122`, and the note to `I left +15555550122 out because that number has not opted in.`
- `no-offer` does not send the offer to the observer, and no offer uses channel `group`.
- `stop-help` answers STOP and HELP from `+15555550122` with the existing STOP and HELP sentences.

## How to get to it (user POV)

- The cleaner and the owner reply YES. Cory does not.
- Cory later replies STOP, then HELP. Those replies do not opt the number in and do not schedule the cleaning.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- The first drive stops before Cory's STOP, so the exclusion note is still the current note.
- The second drive adds STOP and HELP. Do not send YES from `+15555550122`.

- **Leave Cory out.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --group-mode native --group-capable --participant observer=+15555550122 --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550101=YES --reply +15555550100=YES --reply +15555550100=YES`. Exit code 0. `messaging.note` is the left-out sentence. The observer's only text is `opt-in`.
- **STOP and HELP.** Repeat that command and add `--reply +15555550122=STOP --reply +15555550122=HELP`. Exit code 0. The observer's texts are `opt-in`, `stop`, then `help`. The observer still has no offer.
- **Proof.** Save both stdout files with feature id `group-unconsented-participant`. `prove-step-f.sh`.

## Gotchas

- After STOP, that number is opted out, so a later view can call the remaining people a group. The offers already sent stay mirrored. Judge the exclusion on the first stdout.
- Do not treat the opt-in text as consent. Consent is the YES that this drive never sends.
