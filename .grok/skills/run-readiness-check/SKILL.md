---
name: run-readiness-check
description: Run Tour Core's real readiness check for a property and report each result honestly in plain language, with a fix offered for anything that fails.
when-to-use: "is it ready", "check the setup", "run readiness", "why can't I publish", "what's missing"
allowed-tools: get_state run_checks
argument-hint: "[property]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Honest readiness results with plain-language fixes
  version: "0.2.0"
---

# Run Readiness Check

Call only `get_state` and `run_checks`.

The readiness check exercises the real pieces the setup selects: the setup
answers, tour hours, every unit's route, verification, visitor messaging, tour
records, saving tour progress (real phones), door access and audit/export.
Report exactly what it returns.

## When to use

Before a practice tour or publishing, after any setup change, or when the
operator asks why something isn't ready.

## Required inputs and access

- Which property (skip if there's only one).

## Sequence

1. `run_checks`.
2. Say what it returned. A pass is "The check passed, and the practice tour passed." A block is the reason it returned. Say that reason. Do not turn it into a checklist it did not return.
3. If anything failed, explain each problem in one plain sentence and offer
   the fix ("Want me to map Unit 102's route now?"). Use **Map Route** or
   **Setup Property** for the fix, only with the operator's OK.
4. Problems on the Tour Core computer itself (for example "Visitor messaging
   isn't connected yet") can't be fixed from chat. One touring number covers
   every property; a second property is not blocked for sharing it. Say what
   needs doing there, in plain words. Never quote a property id.
5. After a fix, run the check again.

## Validate

- A pass is only "The check passed, and the practice tour passed."
- Say a blocked reason as returned. Do not say the check passed.

## Return

What `run_checks` returned: the pass sentence, or the blocked reason.

## Requires approval

Any change to fix a problem.

## Stop when

The check passes, or the remaining problems need the operator or the Tour Core
computer.
