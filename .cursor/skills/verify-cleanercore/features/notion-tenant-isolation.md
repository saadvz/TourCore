# Notion tenants stay apart

Scratch Lane, Scratch Court, and a property onboarded in the same folder keep their own bookings and phones. Lane's Notion stay is still there after Annex is activated. Onboarding does not text either existing house.

## Sub-features

- `lane-stay` asks `+15555550100` the Sunday checkout question and keeps job `notion:row-anita`.
- `court-stay` asks `+15555550110` the Monday checkout question and keeps job `notion:row-court`.
- `annex` activates tenant `annex` and texts only `+15555550121` and `+15555550122`.
- `lane-remains` loads Scratch Lane again with `--no-poll` and sends nothing. The Lane job is still `notion:row-anita`.

## How to get to it (user POV)

- Two houses already have Notion bookings. A third property is set up in the same records.
- A text for one house does not arrive at another house.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- All four drives share one temporary `--data` directory. Remove it after the stdout files are saved.
- The onboard lock reply uses `@src/cleaner-core/fixtures/annex-lock.txt`.

- **Lane.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --tenant scratch-lane --closed --data <dir> --notion src/cleaner-core/fixtures/notion-lane-read.json`.
- **Court.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --tenant scratch-court --closed --data <dir> --notion src/cleaner-core/fixtures/notion-court-stay.json`. Court's question is `Is checkout at 8 Scratch Court, Teaneck, NJ 07666 on Monday, Oct 19 still 11:00 AM? Reply YES or send the new time.`
- **Annex.** Run the full `--onboard` drive in that same directory, including YES from the cleaner and the observer, then APPROVE.
- **Lane again.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --tenant scratch-lane --no-poll --data <dir>`. `sent` is `[]`.
- **Proof.** Save the four stdout files with feature id `tenant-isolation`. `prove-step-f.sh`.

## Gotchas

- This is the step F journey. The step E file [tenant-isolation.md](./tenant-isolation.md) still proves the door-code split with Google Calendar.
- Court must not receive Lane's Sunday question, and Lane must not receive Court's Monday question.
