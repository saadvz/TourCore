# A later checkout holds the door code until the host confirms again

After the cleaner is confirmed, a later checkout time drops the clearance. "Guests have left" before the host confirms the new time does not send the code. The code goes out once after that new YES and a second departure phrase.

## Sub-features

- `correction-first` texts the 2:00 PM update before the new confirmation.
- `held-until-reconfirm` ignores the first "guests have left" while the offer is open again.
- `one-pin` sends the private text once, after the host confirms the new time and says the guests have left again.

## How to get to it (user POV)

- The host confirms Sunday at 11:00 AM, then says checkout moved to 2:00 PM.
- The host says the guests have left before confirming 2:00 PM. No door code goes out.
- The host replies YES, then says the guests have left. The cleaner receives the private text once.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- The cleaner has opted in and the host has confirmed the 11:00 AM offer.

- **Move, hold, then release.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550101=YES --reply +15555550100=YES --reply +15555550100=YES --reply +15555550100=YES --reply "+15555550100=2:00 PM" --reply "+15555550100=guests have left" --reply +15555550100=YES --reply "+15555550100=guests have left"`. Exit code 0.
- **Order.** The 2:00 PM update appears before `Cleaning is scheduled for Sunday, Oct 18 at 2:00 PM at 12 Scratch Lane, Teaneck, NJ 07666.` That confirmation appears before the redacted private text. Exactly one `kind` `pin` is sent, to `+15555550101`. `pinRecipients` is `["+15555550101"]`.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, job list, and outbox with feature id `checkout-moved`.

## Gotchas

- The first "guests have left" is part of the command. Removing it proves a different path.
- The update names 2:00 PM. A feed change is the step C corrected-time journey, not this one.
