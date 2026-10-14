# Wrong tenant calendar

Scratch Lane refuses Scratch Court's Google Calendar. No job is created and no text is sent. The court address does not appear.

## Sub-features

- `refused` sets `sync.reason` to `wrong-tenant` and `sync.conversation` to `closed`.
- `no-text` leaves `sent` and `jobs` empty.
- `no-leak` keeps the property at 12 Scratch Lane and does not print 8 Scratch Court or `+15555550110`.

## How to get to it (user POV)

- Someone points Scratch Lane at the other house's calendar.
- Scratch Lane does not adopt that house's stay and does not text that house.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.

- **Read the other tenant's fixture.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --tenant scratch-lane --closed --google src/cleaner-core/fixtures/google-court-stay.json`. Exit code 0.
- **Result.** `sync.reason` is `wrong-tenant`. `sent` is `[]`. `jobs` is `[]`. `property` is `12 Scratch Lane, Teaneck, NJ 07666`. The stdout does not contain `8 Scratch Court` or `+15555550110`.
- **Proof.** Save the command and stdout with feature id `wrong-tenant`. `prove-step-e.sh`.

## Gotchas

- Exit code 0 means the refusal was reported. It does not mean the calendar was applied.
- This drive does not text `+15555550100` either. There is no Scratch Lane stay in that fixture.
