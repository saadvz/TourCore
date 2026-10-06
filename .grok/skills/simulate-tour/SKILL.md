---
name: simulate-tour
description: Run one complete practice tour through the real Tour Core engine (nobody is texted, no real door opens) and summarize the proof points that matter.
when-to-use: "run a practice tour", "run a dry tour", "test the tour", "simulate a visitor", "local SMS", "inject a visitor text"
allowed-tools: list_properties run_dry_tour run_readiness_check inject_local_sms read_local_outbox
argument-hint: "[property] [unit]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Practice tour with safety proof points
  version: "0.2.3"
---

# Simulate Tour

The practice tour books a pretend visitor, records consent, verifies them,
tries an early arrival, opens the first door on the route at the right time
(the building entrance, including a single-family front door, or the unit door
on a unit-door-only apartment or condo), repeats a request, opens any later
doors, tries a door that isn't on the route, completes the tour and sends the
follow-up, all through the real engine and policy with Durin in demo mode.

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

To exercise the real visitor SMS path without Sendblue or a carrier:

1. The property must be `messagingMode: live` on local test texts
   (`choose_messaging_provider` with `local` and that property, or
   `set_services` with `messaging: local`). That opts this building in
   without changing the installation's live texting or drafting other
   published buildings. Switching the installation to local does not
   clear saved account details. Switching the installation back uses
   the stored account and a new connection test.
2. `inject_local_sms` with the visitor's `from` number, the property line
   (`to`) or property, and their `text`. Set `hasMedia` when the inbound is a
   photo; Tour Core replies that it can't take photos yet and does not
   forward the file. That is the same path as
   `POST /webhooks/local` → `handleProviderWebhook` → `conversations.receive`.
3. `read_local_outbox` for that conversation. Return **separate bubbles in
   order** (each body is one SMS). Never concatenate them.
4. `inspect_tour` / `list_active_tours` (Work Exception skill) see the live
   session the same way they would for a real text.

`inject_local_sms` and `read_local_outbox` refuse unless that property is on
local. They never run against Sendblue, Twilio, Photon, or practice texts.

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
