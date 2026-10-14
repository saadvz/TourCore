# Evidence

Each subdirectory is one verification run. `prove-turnover.sh` and `prove-safety.sh` each create one named with a UTC timestamp. Cleanup does not delete these directories.

A turnover run contains the doctor and smoke commands, stdout, stderr, exit codes, `result.txt`, and `stand-in.txt`.

A safety run contains one directory per journey (`flag-off`, `stop`, `help`, `injury`, `unapproved-yes`) with that journey's doctor and smoke output, plus `result.txt` and `stand-in.txt` for the run.
