# STOP, HELP, and injury still win

After a Notion read, STOP behaves as it did in step F, and HELP sends nothing. Injury phrases from the cleaner and the observer, in a group and one-to-one, use the 911 path once. STOP runs before that check.

## Sub-features

- `stop-help-injury` matches the step F safety replies.
- `observer-and-owner` alert the host for an observer and do not alert the host about their own report.
- `wording` covers hurt, injury, blood, and fall phrases in both modes.

## How to get to it (user POV)

- Someone replies STOP, HELP, or an injury phrase during a cleaning conversation.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false.
- The Notion file is `src/cleaner-core/fixtures/notion-lane-read.json`.

- **STOP, HELP, injury.** The step F commands: `--closed --notion` with STOP, with HELP, and with `I fell and I'm hurt` twice from the owner and twice from the cleaner. Exit code 0. STOP still gets the STOP sentence. HELP adds no sent text. Injury still gets the 911 sentences.
- **Observer and owner.** The step F observer group, observer one-to-one, and owner injury commands. An emergency text has no group channel.
- **Wordings.** The seven step F phrases from the cleaner and the observer, solo and in a group. Each report has four emergency texts and no group channel on those texts.

## Gotchas

- `that hurt my schedule lol, running late` is recorded and not required to pass or fail. Ordinary "fall" and that sentence are a later copy problem.
- This journey does not replace `prove-step-f.sh`. The step G proof runs that script as well.
