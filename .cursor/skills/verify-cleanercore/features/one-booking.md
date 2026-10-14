# One booking from two sources

Anita's stay is on the Guesty Lite feed and on Google Calendar. Google's checkout is a day later. Cleaner Core keeps Guesty's Sunday checkout and does not open a second job. The disagreement is recorded and does not send a new sentence.

## Sub-features

- `one-row` leaves three Guesty jobs, and exactly one of them checks out on 2026-10-18.
- `no-google-job` does not add a job id that starts with `google:`.
- `conflict` records job `stay-anita@guesty.com`, checkout `2026-10-18`, other checkout `2026-10-19`.
- `one-text` sends only the Sunday checkout question to `+15555550100`.

## How to get to it (user POV)

- 12 Scratch Lane is on Guesty Lite and on Google Calendar.
- Both show Anita's stay. Google's checkout date is October 19. The host is still asked about Sunday, October 18.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.

- **Read both sources.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --closed --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --google src/cleaner-core/fixtures/google-lane-overlap.json`. Exit code 0.
- **Result.** `sync.sources` is `["guesty-lite", "google-calendar"]`. `sync.conflicts` is one object for `stay-anita@guesty.com`. Job ids are `stay-anita@guesty.com`, `stay-same-day@guesty.com`, and `stay-after-gap@guesty.com`. `sent` is the Sunday 11:00 AM question to `+15555550100` and nobody else.
- **Proof.** Save the command, stdout, and job list with feature id `one-job`. `prove-step-e.sh`.

## Gotchas

- Guesty Lite wins the checkout date when both sources have the stay. The conflict is on the report. It is not a text.
- A second poll is not part of this proof.
