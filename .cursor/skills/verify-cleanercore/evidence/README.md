# Evidence

Each subdirectory is one verification run. `prove-turnover.sh`, `prove-safety.sh`, and `prove-step-c.sh` each create one named with a UTC timestamp. Cleanup does not delete these directories.

A turnover run contains the doctor and smoke commands, stdout, stderr, exit codes, `result.txt`, and `stand-in.txt`.

A safety run contains one directory per journey (`flag-off`, `stop`, `help`, `injury`, `unapproved-yes`) with that journey's doctor and smoke output, plus `result.txt` and `stand-in.txt` for the run.

A step C run contains `step-c/` with one directory per blocker (`read-feed`, `host-time`, `corrected-time`, `reminder-once`, `blocks`, `one-live-job`, `stop-silences`, `no-pin`, `safety-states`, `failed-send`). Each journey keeps the doctor and smoke commands, stdout, stderr, exit codes, and the transcript, job list, and outbox taken from that stdout. `no-pin` also keeps a copy of the persisted store. `result.txt` and `stand-in.txt` sit on `step-c/`.

`prove-step-d.sh` overwrites the fixed directory `step-d/`. It does not add a timestamp. That directory holds `held`, `released`, `not-opted`, `unapproved-yes`, `not-approved`, `checkout-moved`, `full-turn`, `pin-stored`, `stop-holds`, `help-waiting`, `help-cleared`, `help-progress`, `pin-failed`, and `no-group`. `pin-stored` and `pin-failed` also keep a copy of the persisted store. `result.txt` and `stand-in.txt` sit on `step-d/`. The scratch digits must be absent. The private text is saved as `Door code: [redacted]`.

Runs dated before step C still show the earlier door-code demo. Those directories are history. A new step C tree must not contain the scratch door code. The step D tree must not contain the scratch digits.
