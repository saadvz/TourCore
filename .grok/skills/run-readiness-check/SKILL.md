---
name: run-readiness-check
description: Run Tour Core's real readiness check for a property and report each result honestly in plain language, with a fix offered for anything that fails.
when-to-use: "is it ready", "check the setup", "run readiness", "why can't I publish", "what's missing"
allowed-tools: list_properties run_readiness_check get_property_setup review_property_setup
argument-hint: "[property]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Honest readiness results with plain-language fixes
  version: "0.2.0"
---

# Run Readiness Check

The readiness check exercises the real pieces the setup selects: the setup
answers, tour hours, every unit's route, verification, visitor messaging, tour
records, saving tour progress (real phones), Durin access and audit/export.
Report exactly what it returns.

## When to use

Before a practice tour or publishing, after any setup change, or when the
operator asks why something isn't ready.

## Required inputs and access

- Which property (skip if there's only one).

## Sequence

1. `run_readiness_check`.
2. Show the `lines` as a checklist, e.g.
   > ✓ Property details
   > ✓ Tour hours
   > ✗ Unit routes: Unit 102 doesn't have a complete route yet.
   > ✓ Verification
   > ✓ Visitor messaging connected
   > ✓ Records
   > ✓ Tour progress can be safely saved
   > ✓ Durin access
   > ✓ Audit/export
   > No visitor help number or support email is set. Visitors who text HELP can reply here.
   An advisory line after the checks does not fail the check. Say it plainly.
3. If anything failed, explain each problem in one plain sentence and offer
   the fix ("Want me to map Unit 102's route now?"). Use **Map Route** or
   **Setup Property** for the fix, only with the operator's OK.
4. Problems on the Tour Core computer itself (for example "Visitor messaging
   isn't connected yet" or the texting number is used by another property)
   can't be fixed from chat. Say what needs doing there, in plain words.
5. After a fix, run the check again.

## Validate

- Never say a check passed unless `passed` is true for that line.
- Never skip or summarize away a failed line.

## Return

The checklist, and either "Everything's ready" or the list of what's left.

## Requires approval

Any change to fix a problem.

## Stop when

The check passes, or the remaining problems need the operator or the Tour Core
computer.
