# One live job

When the feed removes a stay, the old job is canceled. The job list after the change has one row for that turnover, and that row is not live. A later stay is not texted in the same poll. The canceled slot cannot send another owner text or a door code.

## Sub-features

- `cancel-text` tells the owner the Sunday checkout is canceled.
- `one-row` keeps a single job id for the removed stay, with `status` `canceled` and `live` false.
- `no-next-text` does not ask about the Tuesday checkout in that same poll.

## How to get to it (user POV)

- The owner confirms checkout and check-in, and the Sunday offer goes out.
- The next feed omits Anita's stay (`guesty-lite-stay-removed.ics`).
- The owner receives one cancel text. The job list shows Anita's job canceled.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Replies are from `+15555550100` only.

- **Offer, then remove the stay.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550100=YES --reply +15555550100=YES --then-feed src/cleaner-core/fixtures/guesty-lite-stay-removed.ics`. Exit code 0.
- **Transcript.** The outbound lines are the 11:00 AM checkout question, the 4:00 PM check-in question, the 11:00 AM offer, and `Update: the cleaning at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18 is canceled, so no need to come. Reply STOP to opt out.` The owner's YES replies appear on their own lines. The transcript does not contain `Tuesday, Oct 20`.
- **Job list.** `jobs` has one row whose `id` is `stay-anita@guesty.com`. That row has `status` `canceled`, `live` false, and `textsBlocked` true. The other two stays are `discovered` and were not texted. No job `status` is `ready`. `pinRecipients` is `[]`.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `one-live-job`. The job list is required. The outbox alone is not this proof.

## Gotchas

- A second poll after the removal may ask about the next open stay. This journey is one process and one `--then-feed`. Do not add another poll and still call it this proof.
- `live: false` on the canceled row is the check that the old slot cannot keep texting. An outbox cancel line with `live: true` still fails.
