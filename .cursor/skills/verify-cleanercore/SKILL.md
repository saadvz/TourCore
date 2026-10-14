---
name: verify-cleanercore
description: "Drive Cleaner Core (src/cleaner-core) through its doctor and smoke CLI to prove a Scratch Lane turnover. Use when changing CLEANER_CORE_ENABLED, turnover texts, the door code, or STOP/HELP/injury handling. Sends nothing to a real phone."
---

# Verify Cleaner Core

Cleaner Core texts one same-day turnover. The surface an agent can drive is the doctor/smoke CLI (`npm run cleaner:doctor`, `npm run cleaner:smoke`). There is no web UI and no listening port. The flag `CLEANER_CORE_ENABLED` is off unless it is `1` or `true`.

Drive only Scratch test numbers. The smoke path hard-codes `+15555550100` (owner) and `+15555550101` (approved cleaner) at 12 Scratch Lane. If a report contains any other phone, stop. Do not run `sendblue:*`, do not point the CLI at a live provider, and do not substitute a real person's number.

## Launch

This CLI is short-lived. Launch means install dependencies once, then start each drive as its own process. There is no data directory, migration, or seed step.

From the repo root, with Node 20 or newer:

```
npm ci
```

Skip `npm ci` when `node_modules/.bin/tsx` is already executable.

Do not wrap doctor or smoke in tmux. Neither command is a TUI. Each one prints one JSON document and exits. That exit is the ready signal for doctor, and the proof for smoke. Two drives may run at the same time: they share no port and no files.

## Doctor

Run doctor before every drive, in the same flag setting as that drive. It is read-only. `sends` is always false. Doctor does not text anyone.

Flag on, which is the setting for a turnover drive:

```
CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor
```

Stdout must be exactly `scripts/expected/doctor-on.json` in this skill, and the exit code must be 0:

```json
{
  "ok": true,
  "enabled": true,
  "sends": false,
  "note": "Cleaner Core is on. doctor does not send texts."
}
```

Flag off uses `env -u CLEANER_CORE_ENABLED` and the doctor document in [features/flag-off.md](features/flag-off.md). A flag-on doctor does not prove the flag-off journey.

If doctor exits non-zero, or `sends` is not false, do not run smoke. The process has already exited. Fix the checkout and run doctor again.

## Drive

The harness is only these two npm scripts:

```
CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor
CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke
env -u CLEANER_CORE_ENABLED npm run --silent cleaner:doctor
env -u CLEANER_CORE_ENABLED npm run --silent cleaner:smoke
```

Smoke with the flag on reads the built-in Scratch iCal, records an offer to `+15555550100`, injects that owner's `YES`, records the confirm to the owner, and records the door code only to `+15555550101`. Stdout must match `scripts/expected/smoke-turnover.json`. Exit code 0.

Smoke with the flag unset exits 2 and prints `sent: []`. See the feature files for the literal documents.

A Scratch test number is E.164 `+1` whose national number either has area code 555, or exchange 555 and line 0100–0199. `+15555550100` and `+15555550101` qualify. Anything else fails the run.

Extra arguments are ignored. `npm run cleaner:smoke -- STOP` still books the turnover. Do not pass a reply, a phone, or a property.

## Evidence

Write one directory per run:

`.cursor/skills/verify-cleanercore/evidence/<UTC timestamp>/`

Keep the command, stdout, stderr, and exit code for doctor and for the drive. Name the feature id in `result.txt`. Assert the literal JSON files under `scripts/expected/`. Also assert every `+1` number in smoke stdout is a Scratch test number, the only `pin` text is to `+15555550101`, and `4821` appears in no other body.

There is no database to read afterward. The smoke process exits and leaves the in-memory sink behind. The saved stdout is the record of what that sink accepted. Capture it before cleanup. Cleanup must not delete the evidence directory.

The smoke command is a stand-in for a live cleaning job. It does five things a live job will not. Those stay unverified until a run on the live target covers them, and that run still uses only Scratch test numbers:

1. It starts `tsx` on this checkout (`npm run cleaner:smoke`). A hosted job is not launched that way.
2. It reads the iCal fixture inside `src/cleaner-core/cli.ts`, including the folded checkout date. It does not fetch a Guesty Lite feed.
3. It freezes time at `2026-10-14T15:00:00.000Z`. It does not use the wall clock.
4. It pushes texts onto an in-memory array. It does not call a messaging provider.
5. It injects `{ id: "smoke-yes", from: "+15555550100", text: "YES" }` inside the process. It does not receive an inbound SMS.

The generator run also re-ran flag-on smoke inside `unshare -r -n` (loopback only). Exit code 0 and stdout matched the proof. That observation is stored beside the evidence as `smoke.no-network.*`. It is not part of `prove-turnover.sh`. Skip it on a host without `unshare`. It shows this CLI finished with no network. It does not show that a carrier delivered a text.

## Cleanup

Doctor and smoke exit on their own. Do not kill by process name. If a run you started is stuck, kill that process's pid and leave every other process alone.

Do not delete `.cursor/skills/verify-cleanercore/evidence/`. There is no scratch data directory to remove.

## Helpers

Prove the same-day turnover (feature `same-day-turnover`) with:

```
.cursor/skills/verify-cleanercore/scripts/prove-turnover.sh
```

The script takes no arguments. It runs the flag-on doctor command, requires the expected doctor JSON and exit 0, then runs the flag-on smoke command and requires `scripts/expected/smoke-turnover.json`, exit 0, and the Scratch and door-code checks above. It writes the evidence directory and prints that path. It does not drive flag-off, STOP, HELP, or injury.

After the script exits, the evidence directory must still be on disk. A cleanup that removes it fails the proof.

## Feature map

Read [features/README.md](features/README.md) before driving. One feature file is one user journey. The generator proof drives `same-day-turnover` only. The other files are the map for later runs. Do not mark a feature verified because a different feature's stdout happened to contain a related field.

When the map changes, run `/maintain-verification-skill` against `verify-cleanercore`.
