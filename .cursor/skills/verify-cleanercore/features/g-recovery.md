# A restart does not send a second copy

If the process stops after a send is accepted and before it is marked sent, the host is asked once and the offer is not repeated. If it stops after the guests have left and before the door code goes out, the next reminder pass sends that code once.

## Sub-features

- `uncertain-offer` alerts the host and does not send the offer again.
- `second-replay` sends nothing.
- `before-pin` saves clearance without a pin text.
- `resume-once` sends one redacted pin to `+15555550101`, and the next pass sends no pin.

## How to get to it (user POV)

- A text may have gone out. The host is asked to check before any retry.
- The guests have left, and the cleaner gets the code once after the process is back.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false.
- `--crash after-accept` and `--crash before-pin` exit 0 and set `halted`. They are not a kill of a live host.

- **Offer.** Smoke with `--with-pin --data <dir> --crash after-accept`, the feed, cleaner YES, and two owner YES replies. `halted` is `after-accept` and there is one offer. A later `--no-poll --replay` sends only `A text may not have gone out. I did not send it again. Please check, then tell me if I should retry.` A second replay sends nothing.
- **Code.** Smoke with `--crash before-pin` through `guests have left`. `sent` has no pin. `--now 2026-10-18T16:00:00.000Z --remind` sends one pin to `+15555550101` with `[redacted]`. The next remind sends no pin.

## Gotchas

- The uncertain alert goes to the owner through the same send path. It does not retry the offer.
- The reminder pass can also send the cleaning reminder. That reminder does not include the code.
