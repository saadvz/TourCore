# Two Scratch tenants

Scratch Lane and Scratch Court keep their own jobs, cleaners, and door codes in one data folder. Each cleaner opts in, gets the offer, and replies YES. After that, the other house's host can say the guests have left and nothing is sent. The house's own host then says the guests have left, and that house's door code goes once to that house's cleaner. Scratch Court's job comes from Google Calendar and reaches the private text. The saved store does not hold either door code.

## Sub-features

- `lane-texts` go only to `+15555550100` and `+15555550101`. The private text goes to `+15555550101` once.
- `court-texts` go only to `+15555550110` and `+15555550111`. The private text goes to `+15555550111` once.
- `wrong-departure` records the other tenant's "guests have left" and sends nothing.
- `google-pin` takes `google:evt-court` from discovered through the offer to `cleared`.
- `stores` keep both tenants in one `cleaner-core.json`. Neither slice texts the other house. The file contains neither `4821` nor `7392`.

## How to get to it (user POV)

- Two landlords share a cleaner record folder. Scratch Lane uses Guesty Lite. Scratch Court uses Google Calendar.
- Each cleaner is asked to opt in on that house's number only.
- A reply from the other house does not schedule anything and does not release a door code.
- After the host of that house says the guests have left, only that house's cleaner receives the private text.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Both tenants use the same `--data` directory. Copy `cleaner-core.json` out before deleting the directory.

- **Lane, before departure.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --tenant scratch-lane --with-pin --data <dir> --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550111=YES --reply +15555550101=YES --reply +15555550100=YES --reply +15555550100=YES --reply +15555550101=YES --reply "+15555550110=guests have left"`. Exit code 0. `sent` is the Sunday checkout question, the opt-in for 12 Scratch Lane, the Sunday check-in question, the offer, and the confirmation. Recipients are `+15555550100` and `+15555550101`. `pinRecipients` is `[]`. `stay-anita@guesty.com` is `confirmed`. The transcript contains `+15555550111: YES` and `+15555550110: guests have left`. `8 Scratch Court` does not appear.
- **Court, before departure.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --tenant scratch-court --with-pin --data <dir> --google src/cleaner-core/fixtures/google-court-stay.json --reply +15555550101=YES --reply +15555550111=YES --reply +15555550110=YES --reply +15555550111=YES --reply "+15555550100=guests have left"`. Exit code 0. `sent` is the Monday checkout question, the opt-in for 8 Scratch Court, the offer, and the confirmation. Recipients are `+15555550110` and `+15555550111`. `pinRecipients` is `[]`. The only job is `google:evt-court` with `status` `confirmed`. The transcript contains `+15555550101: YES` and `+15555550100: guests have left`. `12 Scratch Lane` does not appear.
- **Lane departure.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --tenant scratch-lane --with-pin --data <dir> --no-poll --reply "+15555550100=guests have left"`. Exit code 0. `pinRecipients` is `["+15555550101"]`. `sent` is the redacted private text to `+15555550101` and `Door code sent to the cleaner.` to `+15555550100`. `stay-anita@guesty.com` is `cleared`.
- **Court departure.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --tenant scratch-court --with-pin --data <dir> --no-poll --reply "+15555550110=guests have left"`. Exit code 0. `pinRecipients` is `["+15555550111"]`. `sent` is the redacted private text to `+15555550111` and `Door code sent to the cleaner.` to `+15555550110`. `google:evt-court` is `cleared`.
- **Store.** The one file has a `scratch-lane` slice and a `scratch-court` slice. Each slice has one sent `pin`, to that house's cleaner only. No outbox `to` on either slice is the other tenant's phone.
- **Proof.** Save the commands, the stdouts, and the store with feature id `tenant-isolation`. `prove-step-e.sh`.

## Gotchas

- The inbound reply from the other tenant is in the transcript on purpose. It is not a recipient.
- The wrong-tenant "guests have left" is in the first stdout for that house. `pinRecipients` is still empty there. The private text is only in the later departure stdout.
- `--with-pin` seals that tenant's own code. The proof fails if either code appears in the evidence folder.
- Scratch Court's unapproved number is `+15555550119`. This drive does not text it.
