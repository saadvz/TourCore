# Safety replies in new states

STOP and one emergency phrase still reply while a job waits for the host, after the host confirms both times, and after a corrected-time text. HELP sends nothing in those states and does not schedule the job.

## Sub-features

- `waiting-safety` answers STOP and `I fell and I'm hurt` after the checkout question, and records HELP with no reply. The job stays `discovered`.
- `offered-safety` answers the same three after the offer. The offer is not confirmed.
- `corrected-safety` answers the same three after the Monday update. The update is not accepted as a new confirmation.

## How to get to it (user POV)

- Waiting: the owner receives the checkout question, then sends STOP, or HELP, or `I fell and I'm hurt`.
- Offered: the owner confirms both times, receives the offer, then sends one of those three.
- Corrected: the owner confirms the offer, the feed moves checkout to Monday, the update arrives, then the owner sends one of those three. The emergency phrase is also sent once from the approved cleaner.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Each of the nine drives is its own process. Replies are from `+15555550100`, plus `+15555550101` on the corrected emergency drive.

- **Waiting.** Run smoke with `--feed src/cleaner-core/fixtures/guesty-lite-scratch.ics` and one reply: `+15555550100=STOP`, then the same feed with `+15555550100=HELP`, then the same feed with `+15555550100=I fell and I'm hurt`. Exit code 0 each time. The last transcript line is the STOP ack, `+15555550100: HELP`, or `If someone is hurt, call 911 now.` The Anita job stays `discovered`.
- **Offered.** Add `--reply +15555550100=YES --reply +15555550100=YES` before the safety reply. No cleaner has opted in, so the job is `host_confirmed` and the host has the hold note. STOP and the injury phrase end the transcript. HELP ends on `+15555550100: HELP` and sends no reply. The transcript does not include `Cleaning is scheduled`.
- **Corrected.** Use the three YES replies, then `--then-feed src/cleaner-core/fixtures/guesty-lite-date-moved.ics`, then YES for the new Monday checkout and YES for the new Monday check-in, then the safety reply. The transcript includes the Monday checkout question before `Update: checkout at 12 Scratch Lane, Teaneck, NJ 07666 moved to Monday, Oct 19 at 11:00 AM. Reply YES to keep the cleaning, or STOP to opt out.`, and it ends with the safety line. The corrected emergency drive also passes `--reply "+15555550101=I fell and I'm hurt"`. That drive ends with `If someone is hurt, call 911 now. I've let the host know.` and includes `The cleaner at 12 Scratch Lane, Teaneck, NJ 07666 says someone is hurt. They've been told to call 911.` Neither body contains a door code.
- **Proof.** `test/cleanerCore.test.ts`, in the "one Scratch turnover" block. The old `prove-step-c.sh` was retired.

## Gotchas

- Quote the injury reply. The spaces belong to one `--reply` value.
- The safety line is the last line. A step C confirmation after it means the safety reply did not run first.
- The built-in STOP/HELP/injury feature uses the in-memory calendar and does not cover the offered or corrected states.
