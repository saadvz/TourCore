# Read the Guesty Lite feed

A Guesty Lite fixture gives the checkout date and the next check-in date. A free night between stays stays a free night. A same-day turn is a same-day turn. An owner block or a blocked date is never a departure and never the next arrival. The owner is asked about the earliest open checkout and is not offered a job from the calendar alone.

## Sub-features

- `feed-same-day` reads Anita's stay as checkout Sunday, Oct 18, with the next guest the same day.
- `feed-free-night` reads the next stay as checkout Tuesday, Oct 20, and the following check-in Thursday, Oct 22.
- `feed-block-skipped` leaves the stay that ends Saturday, Oct 24, with no next arrival, because the following event is a block.
- `feed-one-question` texts only the first checkout question.

## How to get to it (user POV)

- The landlord points smoke at `src/cleaner-core/fixtures/guesty-lite-scratch.ics`.
- The owner at `+15555550100` receives one question about Sunday, Oct 18 at 11:00 AM.
- No offer goes out. The block events are recorded as blocks, not jobs.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- The fixture path is `src/cleaner-core/fixtures/guesty-lite-scratch.ics`.

- **Read the feed.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics`. Exit code 0.
- **One text.** `transcript` is exactly `Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.` `sent` has that one `host-checkout` item to `+15555550100`.
- **Jobs.** `jobs` has three rows. `stay-anita@guesty.com` has `checkoutDate` `2026-10-18`, `nextCheckInDate` `2026-10-18`, `sameDay` true, `status` `discovered`, `asking` `checkout`. `stay-same-day@guesty.com` has `checkoutDate` `2026-10-20` and `nextCheckInDate` `2026-10-22`. `stay-after-gap@guesty.com` has `checkoutDate` `2026-10-24` and `nextCheckInDate` null. No job id is `block-owner@guesty.com` or `block-date@guesty.com`.
- **Blocks.** `blocks` lists `block-owner@guesty.com` (`Blocked`) and `block-date@guesty.com` (`Not available`).
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `read-feed`.

## Gotchas

- This drive passes `--feed`, so smoke does not inject YES and does not send the offer.
- The clock inside a timed fixture is ignored. `guesty-lite-clock-bait.ics` is the host-time journey, not this one.
- A block in the same file as stays is still not a job. The blocks-only file is a separate journey.
