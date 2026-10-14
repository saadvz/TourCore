# Only an approved, opted-in cleaner receives the door code

The private text goes to `+15555550101` only after that cleaner replies YES to the opt-in. A cleaner who never replies receives nothing. A YES from `+15555550199` receives nothing. An unapproved cleaner is not asked to opt in.

## Sub-features

- `not-opted` asks the cleaner to opt in and sends no door code when the host says the guests have left first.
- `unapproved-yes` records YES from `+15555550199` and does not text that number or release the code.
- `not-approved` skips the opt-in when `--unapproved` is set and texts only the host.

## How to get to it (user POV)

- The cleaner sees: `Hi, this is Scratch's cleaning scheduler for 12 Scratch Lane, Teaneck, NJ 07666. Reply YES to get cleaning texts, or STOP to opt out.`
- Without that YES, departure does not send a door code.
- A stranger's YES does not enroll them.
- A cleaner the host has not approved is not enrolled.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Each drive passes `--with-pin` and the Guesty fixture.

- **No opt-in.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550100=YES --reply +15555550100=YES --reply +15555550100=YES --reply "+15555550100=guests have left"`. Exit code 0. The transcript contains the opt-in sentence. `pinRecipients` is `[]`. No `kind` is `pin`.
- **Unapproved YES.** Add `--reply +15555550199=YES` before the host replies. Exit code 0. The transcript contains `+15555550199: YES`. No `to` is `+15555550199`. `pinRecipients` is `[]`.
- **Cleaner not approved.** Run the same departure drive with `--unapproved` and `--reply +15555550101=YES`. Exit code 0. The transcript does not contain the opt-in sentence. Every `to` is `+15555550100`. `pinRecipients` is `[]`.
- **Proof.** Save the three commands with feature ids `not-opted`, `unapproved-yes`, and `not-approved`.

## Gotchas

- `+15555550199` is a Scratch sender, not a second cleaner. This drive does not give that number the code.
- `--unapproved` changes the cleaner's approval. It is not the same as a YES from `+15555550199`.
