# Google Calendar read

A closed conversation reads one Google Calendar fixture for Scratch Lane. The host is asked the usual Sunday checkout question. The 10:00 event clock is not the checkout time. No reply is required.

## Sub-features

- `closed-read` records `conversation` `closed` and source `google-calendar`.
- `host-question` sends the Sunday 11:00 AM checkout question to `+15555550100`.
- `one-stay` keeps one live job, `google:evt-anita`, checking out on 2026-10-18.

## How to get to it (user POV)

- The landlord's Google Calendar is connected for 12 Scratch Lane. This drive uses a fixture, not a Google account.
- Nobody has a chat open. The sync still asks the host to confirm checkout.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- No `--reply`.

- **Read the fixture.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --closed --google src/cleaner-core/fixtures/google-lane-read.json`. Exit code 0.
- **Result.** `tenant` is `scratch-lane`. `sync.conversation` is `closed`. `sync.sources` is `["google-calendar"]`. `sent` is one `host-checkout` text to `+15555550100`: `Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.` The job id is `google:evt-anita`. The transcript has no line starting with `+1`. The body does not say `10:00`. `+15555550110` and `8 Scratch Court` do not appear.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `source-read`. `prove-step-e.sh`.

## Gotchas

- `--closed` does not add YES. A drive that also passes `--reply` is a different journey.
- The fixture description mentions the other tenant and the door codes as bait. Those words must not appear in the saved stdout.
