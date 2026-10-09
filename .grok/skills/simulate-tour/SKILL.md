---
name: simulate-tour
description: Run one complete practice tour through the real Tour Core engine (nobody is texted, no real door opens) and summarize the proof points that matter.
when-to-use: "run a practice tour", "run a dry tour", "test the tour", "simulate a visitor", "local SMS", "inject a visitor text"
allowed-tools: inject_local_sms read_local_outbox use_local_demo_storage list_exceptions inspect_exception resolve_exception test_operator_alerts begin_restore_upload preview_portable_restore import_portable_backup schedule_one_off_tour resume_tours revoke_tour_access run_dry_tour get_installation_status
argument-hint: "[property] [unit]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Practice tour with safety proof points
  version: "0.2.4"
---

<!-- connector: qa-skill -->

# Simulate Tour

These tools are on the QA connector (`TOURCORE_QA_TOKEN`, URL ending in `/mcp/qa`). Leave property out of `inject_local_sms` to use the shared line.

The practice tour books a pretend visitor, records consent, verifies them,
tries an early arrival, opens the first door on the route at the right time
(the building entrance, including a single-family front door, or the unit door
on a unit-door-only apartment or condo), repeats a request, opens any later
doors, tries a door that isn't on the route, sends the 15-minutes-left
questions text and the 5-minute extra-time offer, grants one 10-minute
extension, completes the tour and sends the follow-up, then runs a second path
through tour-end, the +5 leave check-in, and the +15 close — all on a
deterministic simulated clock through the real engine and policy with door
access in demo mode. A 15-minute tour skips T-15 with a reason (it would be the start).
If extra time or the second path cannot apply (last slot of the day, no later
time), that step is reported as skipped with a reason — never a failure and
never silently.

## When to use

This skill runs on the QA connector (`/mcp/qa`) for testing, and not in a landlord conversation. Use it after the readiness check passes, before publishing, or whenever a test should prove the tour still works.

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
   > ✓ Unit 102 Door (not on the route) was turned away before any door was unlocked
   > ✓ A repeated request didn't create a second access grant
   > ✓ The 15-minutes-left questions text was sent
   > ✓ The 5-minute extra-time offer was sent
   > ✓ A one-time 10-minute extension was granted
   > ✓ Tour completed
   > ✓ Follow-up worked
   > ✓ The tour-end text was sent (no extra time taken)
   > ✓ The 5-minutes-after check-in was sent
   > ✓ The tour was closed 15 minutes after the end

   On a unit-door-only apartment or condo (no building entrance on the route),
   show the unit-door proof instead of an entrance line:
   > ✓ Unit 4B access was allowed

   A single-family home keeps the entrance line, even when its unit door is
   the front entrance. Do not say "{space name} access was allowed" for that
   first door.
4. If it stopped, say which step failed and why, in the tool's words, and
   suggest the next step (usually fixing the setup and checking again).

Don't list every low-level event unless the operator asks.

## Local SMS loopback (QA)

To exercise the real visitor SMS path without Sendblue or a carrier, publish the scratch building first. A draft does not take a new visitor text.

1. The property must be `messagingMode: live` on local test texts.
   Call `set_up_texting` on the landlord connector with `provider: local`
   and that property. That opts this building in
   without changing the installation's live texting or drafting other
   published buildings. Switching the installation to local does not
   clear saved account details. Switching the installation back uses
   the stored account and a new connection test.
2. `inject_local_sms` with the visitor's `from` number, the property line
   (`to`) or property, and their `text`. Set `hasMedia` when the inbound is a
   photo; Tour Core does not forward the file. A photo alone is told it
   can't take photos yet; a photo plus a question it can't answer is one
   combined text and is flagged. That is the same path as
   `POST /webhooks/local` → `handleProviderWebhook` → `conversations.receive`.
3. `read_local_outbox` for that conversation. Return **separate bubbles in
   order** (each body is one SMS). Never concatenate them.
4. `get_tours` on the landlord connector (Work Exception skill) sees the live
   session the same way it would for a real text.

`inject_local_sms` and `read_local_outbox` refuse unless that property is on
local. They never run against Sendblue, Twilio, Photon, or practice texts.

## Validate

Report `passed` exactly as returned. A ✗ line is never rounded up to a pass.

## Return

"Practice tour passed" (or where it stopped) and the checklist. If it passed
and the property isn't published, offer to publish, which goes through
`publish` on the landlord connector and its yes/no question.

## Requires approval

Nothing: the practice tour texts no one and opens no real door. Publishing
afterwards does require approval.

## Stop when

The result is reported.

<!-- /connector -->
