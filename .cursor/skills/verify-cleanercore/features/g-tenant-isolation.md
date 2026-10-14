# Lane and Court stay apart under step G

A Lane review, backup, and replay do not change Court's job or Court's review list. Health counts are per tenant.

## Sub-features

- `lane-review` files one same-day capacity review for Lane.
- `court-job` keeps `google:evt-court` after Lane is restored.
- `replay` sends nothing new for either tenant.

## How to get to it (user POV)

- Two houses share a folder. A review on one house does not text the other.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false.
- One `--data` directory. Lane is backed up before Court is read, then Lane is restored.

- **Lane.** `--watch-freshness --feed` the Scratch iCal, `--review same-day-capacity`, `--backup`. Recipients are only `+15555550100` or `+15555550101`. `openReviews` is 1.
- **Court.** `--tenant scratch-court --google src/cleaner-core/fixtures/google-court-stay.json`. Recipients are only Court's phones.
- **Restore and replay.** Lane `--restore --no-poll` and `--replay` send nothing and keep the review. Court `--no-poll` still has `google:evt-court`, `openReviews` 0, and a replay that sends nothing.

## Gotchas

- This is the step G tenant journey. The step E file `tenant-isolation.md` is a different drive.
- Restoring Lane does not delete Court, because the backup is applied to one slice.
