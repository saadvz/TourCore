# Mirrored group fallback

When a group was requested and the number cannot send one, the cleaner gets the normal offer. The owner and the observer each get a copy labeled `Copy of the group text:`.

## Sub-features

- `mirrored` sets `messaging.actual` to `mirrored`.
- `mirror-note` sets `messaging.note` to `Group texting isn't available on this number, so I mirrored the cleaner texts instead of starting a group.`
- `copies` sends the plain offer to `+15555550101` and a `Copy of the group text: ` offer, ending `The cleaner will reply to confirm.`, to `+15555550100` and `+15555550122`.

## How to get to it (user POV)

- The landlord asked for a group. The account cannot send one.
- Everyone has opted in. They still do not get a real group thread.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Do not pass `--group-capable`.

- **Ask for a group that is not available.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --group-mode mirrored --participant observer=+15555550122 --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550101=YES --reply +15555550122=YES --reply +15555550100=YES --reply +15555550100=YES`. Exit code 0.
- **Result.** The cleaner offer has no channel. The owner and observer offers use channel `mirror`.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `group-mirrored-fallback`. `prove-step-f.sh`.

## Gotchas

- A mirrored copy is not reply-all. The label has to stay on the body.
- This drive does not send a door code.
