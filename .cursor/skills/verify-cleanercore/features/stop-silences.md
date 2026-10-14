# STOP silences later texts

Once the owner opts out, nothing more is sent. A later feed change and a due reminder produce no new text to `+15555550100`, including a corrected-time text, a reminder, and a new offer.

## Sub-features

- `stop-ack` answers STOP with the opt-out line.
- `stop-feed-change` reads the Monday date move and does not text the correction.
- `stop-reminder` runs the due reminder and does not text it.

## How to get to it (user POV)

- The clock is Sunday, Oct 18 at 8:00 AM Eastern, so a reminder would be due.
- The owner confirms checkout and check-in, receives the offer, and replies STOP.
- The feed then moves the checkout to Monday, and reminders run.
- The owner receives no further text.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Replies are from `+15555550100` only.

- **Opt out, then change the feed and remind.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --now 2026-10-18T12:00:00.000Z --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550100=YES --reply +15555550100=YES --reply +15555550100=STOP --then-feed src/cleaner-core/fixtures/guesty-lite-date-moved.ics --remind`. Exit code 0.
- **Transcript.** The last line is `Tour Core: You're opted out and won't receive more messages. Reply START to opt back in. Reply HELP for help.` The transcript has no `Update:`, no `Reminder:`, and no second offer.
- **Outbox.** Every `to` is `+15555550100`, and none of those bodies is a reminder, a corrected-time text, or an offer sent after the STOP line. `pinRecipients` is `[]`.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and outbox with feature id `stop-silences`.

## Gotchas

- STOP before any YES is the built-in safety journey. This journey needs the offer out first, so a feed change and a reminder would have had something to send.
- `--now` applies to the whole process. The offer still goes out before STOP. The reminder does not.
- A job can still show `textsBlocked: true` after STOP. That flag is not a sent text. Read the outbox.
