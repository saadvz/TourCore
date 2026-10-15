# DONE without START

After the private door code, DONE finishes the cleaning. START is not required. The host gets one done line. A second DONE does not send another. DONE before the private text gets one plain reply and does not finish the job.

## Sub-features

- `done-without-start` answers the first DONE with `Thanks, cleaning marked done.` and sends `The cleaner marked the cleaning at 12 Scratch Lane, Teaneck, NJ 07666 done.` once. The second DONE answers `This cleaning is already marked done.` The job `status` is `done`.
- `done-early` answers DONE before departure with `I'll text you the door code after the guests leave. Reply DONE after that.` The job stays `awaiting_departure`. No door code and no host done line go out.

## How to get to it (user POV)

- The cleaner replies YES, the host confirms both times, and the cleaner confirms the offer.
- The host says the guests have left. The cleaner gets the private text, then replies DONE twice.
- On a separate turn, the cleaner replies DONE before the host says the guests have left.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.

- **Run the proof.** `.cursor/skills/verify-cleanercore/scripts/prove-step-d.sh` takes no arguments. Exit code 0. The `done-without-start` and `done-early` directories each have a passing `result.txt`.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with those feature ids. The door code is `[redacted]`.

## Gotchas

- HELP stays unanswered. This journey does not send HELP.
- The host line is one text per job. The second DONE does not add another.
