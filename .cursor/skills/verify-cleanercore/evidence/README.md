# Evidence

Each subdirectory is one verification run. `prove-turnover.sh`, `prove-safety.sh`, and `prove-step-c.sh` each create one named with a UTC timestamp. Cleanup does not delete these directories.

A turnover run contains the doctor and smoke commands, stdout, stderr, exit codes, `result.txt`, and `stand-in.txt`.

A safety run contains one directory per journey (`flag-off`, `stop`, `help`, `injury`, `unapproved-yes`) with that journey's doctor and smoke output, plus `result.txt` and `stand-in.txt` for the run.

A step C run contains `step-c/` with one directory per blocker (`read-feed`, `host-time`, `corrected-time`, `reminder-once`, `blocks`, `one-live-job`, `stop-silences`, `no-pin`, `safety-states`, `failed-send`). Each journey keeps the doctor and smoke commands, stdout, stderr, exit codes, and the transcript, job list, and outbox taken from that stdout. `no-pin` also keeps a copy of the persisted store. `result.txt` and `stand-in.txt` sit on `step-c/`.

`prove-step-d.sh` overwrites the fixed directory `step-d/`. It does not add a timestamp. That directory holds `held`, `released`, `not-opted`, `unapproved-yes`, `not-approved`, `checkout-moved`, `full-turn`, `done-without-start`, `done-early`, `pin-stored`, `stop-holds`, `help-waiting`, `help-cleared`, `help-progress`, `pin-failed`, and `no-group`. `pin-stored` and `pin-failed` also keep a copy of the persisted store. `result.txt` and `stand-in.txt` sit on `step-d/`. The scratch digits must be absent. The private text is saved as `Door code: [redacted]`.

`prove-step-e.sh` overwrites the fixed directory `step-e/`. It does not add a timestamp. That directory holds `source-read`, `closed-sync`, `removed`, `one-job`, `block`, `wrong-tenant`, and `tenant-isolation`. `tenant-isolation` keeps the one shared store for both Scratch tenants. `result.txt` and `stand-in.txt` sit on `step-e/`. Neither scratch door code may appear. The Google files in the commands are fixtures.

`prove-step-f.sh` overwrites the fixed directory `step-f/`. It does not add a timestamp. That directory holds `notion-permission-denied`, `notion-source-read`, `notion-sync-repeat`, `notion-removed`, `notion-cleaner-routing`, `group-no-optin`, `multi-source-dedupe`, `onboarding-full`, `onboarding-no-optin`, `group-native-consented`, `group-mirrored-fallback`, `group-unconsented-participant`, `pin-private-only`, `tenant-isolation`, `stop-help-injury`, `observer-injury-group`, `observer-injury-solo`, and `owner-injury`. `result.txt` and `stand-in.txt` sit on `step-f/`. The scratch door codes must be absent. Notion files in the commands are fixtures. The Annex lock reply is an `@` path.

`prove-group-chat.sh` overwrites the fixed directory `group-chat/`. It does not add a timestamp. That directory holds `eligible`, `private`, `held`, `stop-host`, `resume`, `time`, `injury`, `problem`, `before-yes`, `inert`, `done`, `twice`, `failed`, and `desk`. `result.txt` and `stand-in.txt` sit on `group-chat/`. Scratch door codes must be absent. Phones are area code 555.

`prove-step-g.sh` overwrites the fixed directory `step-g/`. It does not add a timestamp. That directory holds `ci-local`, `stale-source`, `host-override-beats-stale-feed`, `permanent-code`, `backup-restore`, `replay-no-resend`, `recovery-after-restart`, `review-queue`, `observability`, `tenant-isolation`, and `stop-help-injury`. `result.txt` and `stand-in.txt` sit on `step-g/`. Configured scratch codes must be absent. The exposure reply is an `@` path.

`20261014T010924Z/` and `20261014T013500Z/` were removed. Those runs stored a Scratch door code in plain text. A new evidence directory must not contain those digits.

Runs dated before step C still show the earlier door-code demo. Those directories are history. A new step C tree must not contain the scratch door code. The step D tree must not contain the scratch digits.
