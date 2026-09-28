---
name: simulate-tour
description: Run one complete practice tour through the real Tour Core engine (nobody is texted, no real door opens) and summarize the proof points that matter.
when-to-use: "run a practice tour", "run a dry tour", "test the tour", "simulate a visitor"
allowed-tools: list_properties run_dry_tour run_readiness_check
argument-hint: "[property] [unit]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Practice tour with safety proof points
  version: "0.2.0"
---

# Simulate Tour

The practice tour books a pretend visitor, records consent, verifies them,
tries an early arrival, opens the entrance at the right time, repeats a request,
opens the unit, tries a door that isn't on the route, completes the tour and
sends the follow-up, all through the real engine and policy with Durin in demo
mode.

## When to use

After the readiness check passes, before publishing, or whenever the operator
wants to prove the tour still works.

## Required inputs and access

- Which property (skip if only one). Optionally which unit (default: the first).

## Sequence

1. `run_dry_tour`.
2. If it says the readiness check found problems, switch to **Run Readiness
   Check** and report them.
3. Otherwise show the `proofPoints` as a short checklist:
   > ✓ Booking worked
   > ✓ Verification worked
   > ✓ Early arrival was denied
   > ✓ Entrance access was allowed at the right time
   > ✓ Unit 101 access was allowed
   > ✓ Unit 102 Door (not on the route) was denied before Durin was contacted
   > ✓ A repeated request didn't create a second access grant
   > ✓ Tour completed
   > ✓ Follow-up worked
4. If it stopped, say which step failed and why, in the tool's words, and
   suggest the next step (usually fixing the setup and checking again).

Don't list every low-level event unless the operator asks.

## Validate

Report `passed` exactly as returned. A ✗ line is never rounded up to a pass.

## Return

"Practice tour passed" (or where it stopped) and the checklist. If it passed
and the property isn't published, offer to publish, which goes through
`publish_demo_property` and its yes/no question.

## Requires approval

Nothing: the practice tour texts no one and opens no real door. Publishing
afterwards does require approval.

## Stop when

The result is reported.
