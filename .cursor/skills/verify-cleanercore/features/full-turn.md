# One full Scratch turn

One process covers opt-in, the cleaner's confirm, the morning reminder, departure, the private door code, START, and DONE. The job list ends `done`.

## Sub-features

- `offer-confirm-reminder` sends the checkout question, the opt-in, the check-in question, the offer, the confirmation, and one reminder.
- `private-pin` sends the redacted private text to the cleaner and `Door code sent to the cleaner.` to the host.
- `start-done` answers START with `Got it, cleaning started.` and DONE with `Thanks, cleaning marked done.` The host gets `The cleaner marked the cleaning at 12 Scratch Lane, Teaneck, NJ 07666 done.` once. The job `status` is `done`.

## How to get to it (user POV)

- The cleaner replies YES to opt in. The host confirms checkout and check-in. The cleaner replies YES to the offer.
- The morning of checkout, the cleaner gets one reminder: `Reminder: cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is Sunday, Oct 18 at 11:00 AM.`
- The host says the guests have left. The cleaner gets the private text. The host is told it was sent.
- The cleaner replies START, then DONE. The job is done.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- The drive passes `--with-pin`, the Guesty fixture, `--now 2026-10-18T12:00:00.000Z`, `--remind`, then `--now 2026-10-18T15:30:00.000Z`.

- **Run the turn.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550101=YES --reply +15555550100=YES --reply +15555550100=YES --reply +15555550101=YES --now 2026-10-18T12:00:00.000Z --remind --now 2026-10-18T15:30:00.000Z --reply "+15555550100=guests have left" --reply +15555550101=START --reply +15555550101=DONE`. Exit code 0.
- **Transcript.** The lines are the 11:00 AM checkout question, the Scratch opt-in, `+15555550101: YES`, `+15555550100: YES`, the 4:00 PM check-in question, `+15555550100: YES`, the Sunday offer, `+15555550101: YES`, the 11:00 AM confirmation, `Reminder: cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is Sunday, Oct 18 at 11:00 AM.`, `+15555550100: guests have left`, the redacted private text, `Door code sent to the cleaner.`, `+15555550101: START`, `Got it, cleaning started.`, `+15555550101: DONE`, `Thanks, cleaning marked done.`, and `The cleaner marked the cleaning at 12 Scratch Lane, Teaneck, NJ 07666 done.`
- **Job list.** The Anita job `status` is `done`. `pinRecipients` is `["+15555550101"]`. No body says `ready`.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `full-turn`.

## Gotchas

- START before the private text is the re-opt-in path, not this one. This START comes after departure.
- DONE is the whole message. A longer sentence is not this reply.
