# Two Scratch tenants

Scratch Lane and Scratch Court each keep their own jobs, cleaners, and texts. A YES from the other tenant does not confirm a time, opt a cleaner in, or send a door code. The saved stores do not hold either door code or the other address.

## Sub-features

- `lane-texts` go only to `+15555550100` and `+15555550101`.
- `court-texts` go only to `+15555550110` and `+15555550111`.
- `ignored-yes` records the other tenant's YES and leaves the job `discovered`.
- `stores` keep 12 Scratch Lane out of the court file and 8 Scratch Court out of the lane file. Neither file contains `4821` or `7392`.

## How to get to it (user POV)

- Two landlords. Scratch Lane uses Guesty Lite plus Google Calendar. Scratch Court uses Google Calendar.
- Each cleaner is asked to opt in on that house's number only.
- A reply from the other house does not schedule anything.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Each drive has its own `--data` directory. Copy `cleaner-core.json` out before deleting the directory.

- **Lane.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --tenant scratch-lane --with-pin --data <lane-dir> --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --google src/cleaner-core/fixtures/google-lane-overlap.json --reply +15555550110=YES --reply +15555550111=YES`. Exit code 0. `sent` bodies are the Sunday checkout question and `Hi, this is Scratch's cleaning scheduler for 12 Scratch Lane, Teaneck, NJ 07666. Reply YES to get cleaning texts, or STOP to opt out.` Recipients are `+15555550100` and `+15555550101`. Job ids are the three Guesty stays. The transcript contains `+15555550110: YES` and `+15555550111: YES`. `pinRecipients` is `[]`.
- **Court.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --tenant scratch-court --with-pin --data <court-dir> --google src/cleaner-core/fixtures/google-court-stay.json --reply +15555550100=YES --reply +15555550101=YES`. Exit code 0. `sent` bodies are the Monday checkout question and the opt-in for `8 Scratch Court, Teaneck, NJ 07666`. Recipients are `+15555550110` and `+15555550111`. The only job is `google:evt-court` with `status` `discovered`. `pinRecipients` is `[]`.
- **Stores.** The court file does not contain `12 Scratch Lane`, `4821`, or `7392`. The lane file does not contain `8 Scratch Court`, `4821`, or `7392`. No outbox `to` on either file is the other tenant's phone.
- **Proof.** Save both commands, both stdouts, and both stores with feature id `tenant-isolation`. `prove-step-e.sh`.

## Gotchas

- The inbound YES from the other tenant is in the transcript on purpose. It is not a recipient.
- `--with-pin` seals that tenant's own code. The proof fails if either code appears in the evidence folder.
- Scratch Court's unapproved number is `+15555550119`. This drive does not text it.
