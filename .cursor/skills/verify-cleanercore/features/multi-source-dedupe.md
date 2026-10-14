# One booking, Guesty and Notion

The same Scratch Lane stay on Guesty Lite and Notion stays one job. Guesty keeps the job id. Notion is recorded as the second source. There is no date conflict and no second host question.

## Sub-features

- `both-sources` lists `guesty-lite` and `notion`.
- `one-job` keeps `stay-anita@guesty.com` and does not add `notion:row-anita` as its own job.
- `provenance` lists both sources on that job.
- `one-question` sends one Sunday checkout question.

## How to get to it (user POV)

- Guesty Lite already includes the stay. Notion has the same dates.
- The host is asked once. A block is still not a departure.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- No `--reply`.

- **Read both fixtures.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --closed --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --notion src/cleaner-core/fixtures/notion-lane-overlap.json`. Exit code 0.
- **Result.** `sync.sources` is `["guesty-lite", "notion"]`. `sync.conflicts` is `[]`. Job ids are `stay-anita@guesty.com`, `stay-same-day@guesty.com`, and `stay-after-gap@guesty.com`. Provenance for the first job lists the Guesty uid and `notion:row-anita`. `sent` is one `host-checkout` text to `+15555550100`.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `multi-source-dedupe`. `prove-step-f.sh`.

## Gotchas

- A different checkout date would be a conflict, not a second job. This fixture agrees with Guesty.
- Do not expect a Notion job id in `jobs`.
