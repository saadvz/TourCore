# Cleaner Core Phase 0: unattended agent execution

Status: **feasibility supported by one account-reported webhook-triggered
background MCP read and one scheduled read; reliability and SMS delegation
remain unverified**.
This discovery record attributes the live findings to the user's Grok account
report. It does not establish a general vendor guarantee or a production SLA.

## Scope and decision

The first gate is to establish whether an external event can start a Grok run
and whether that run can call the connected TourCore MCP server while the
landlord's conversation is closed. A scheduled background run proves a
different, narrower capability. Neither an HTTP 2xx response nor a posted
notification proves a successful MCP call.

Keep the current engine-owned SMS processing and safe deterministic handoff
while delegation deadlines, action validation, failure recovery, and live
messaging are still unverified. A read-only feasibility success does not
authorize handing live cleaner conversations to an unvalidated delegate.
Do not select a model or build the full Cleaner Core workflow as part of
this experiment.

## Current repository findings

- `grok-template/routines/operator-updates.md` describes authenticated webhook
  triggers, but explicitly states that the live Routine panel has not been
  verified from this environment. Treat its capabilities as proposed.
- `src/alerts/operatorEvents.ts` sends typed, minimal event envelopes with a
  bearer key and a ten-second delivery timeout. A 2xx response means only that
  the receiver accepted the request.
- `src/alerts/outbox.ts` persists stable event IDs, suppresses repeat scans,
  retries with bounded exponential backoff, and records terminal failures.
  The delivered state concerns notification delivery, not agent completion.
- `src/alerts/operatorUpdates.ts` derives tour/issue notifications from saved
  records. Its comment explicitly excludes ordinary texts and door requests.
  This is not an inbox delegating every incoming SMS to an agent.
- `src/install/checks.ts:testOperatorAlerts` directly sends an
  `installation.test` event and records acceptance. The routine's normal test
  instructions post a canned confirmation and stop without an MCP read.
- There is no verified agent completion callback, task lease, or per-event
  execution deadline in this notification path. Do not infer those guarantees
  from its delivery retries.

The user reports having a connected Grok Bot and routine. This cloud checkout
has no saved Grok routine bindings, Twilio bindings, or public endpoint.
The connected installation may be elsewhere; it has not been identified here.
No credentials were requested in chat or copied from another installation.

## Grok account report received 10 October 2026

Evidence source: the user supplied the connected Grok Bot's output. These
findings are attributed account reports, not independently observed UI or
tool traces from this cloud environment.

- Grok reports the existing Operator Updates routine uses a webhook trigger,
  has no schedule, and last ran successfully at 9:53 AM America/New_York on
  10 October (13:53 UTC). It reports leaving the routine unchanged.
- Grok's notes from 8–9 October contain visitor questions and tour status.
  Grok infers that background MCP inbox reads produced them but cannot see
  per-call logs. This is supporting evidence, not a direct MCP execution proof;
  retained context or other information sources have not been excluded.
- Grok reports creating a temporary, self-deleting one-off probe scheduled for
  5:52 PM America/New_York on 10 October (21:52 UTC). Its task is one read-only
  `get_state` call followed by scheduled/start/end times, MCP outcome, and any
  approval prompt. It reports no creation confirmation card.
- The user subsequently supplied Grok's successful unattended-run report:
  scheduled 5:52 PM ET; actual start 5:54:10 PM ET; actual end 5:54:20 PM ET.
  `get_state` reportedly succeeded, returning an installation that is published
  and running. No approval prompt, confirmation card, or auto-review block was
  reported. The temporary routine reportedly deleted itself and made no other
  changes. Property addresses from the report are intentionally omitted here.
- Timing derived from that report: 130 seconds of scheduler lateness,
  10 seconds of run duration, and 140 seconds from scheduled time to completion.
  These are one-run timings, not P50/P95 values or webhook/SMS latency.
- The result is account-reported evidence of scheduled background MCP access.
  An independent per-call trace was not supplied. The user described execution
  as unattended; no separate observation of the closed-chat interval was supplied.

The sender and trigger requirements for live test B remain separate. Do not
label this scheduled result as external-webhook execution proof or infer that
webhook-triggered runs share the scheduler's 130-second delay.

An attempted read of `https://docs.x.ai/docs/overview` was refused by the
egress proxy (CONNECT 403). No current vendor documentation was obtained;
this is a research access limit, not evidence that Grok lacks a capability.

## Webhook probe preparation reported 11 October 2026

The user supplied Grok's preparation report at approximately 12:58 AM ET.
The following records the setup as reported at that time; subsequent results
appear below.

- A separate temporary webhook-only receiver reportedly calls `get_state`
  exactly once for an `installation.test` event and does not follow setup
  next steps. Normal Operator Updates and TourCore alert settings were
  reportedly left unchanged.
- The user reportedly provided the receiver address and authorization through
  masked controls. No values were supplied to this chat.
- A separate one-time sender script on Grok's computer is scheduled for
  1:02 AM ET on 11 October (05:02 UTC). Its correlation ID is
  `probe-20261011005720-13933`; it will log actual send/response times and
  HTTP status to `/workspace/webhook-probe/sender.log` on **Grok's computer**.
  That path is not present in this Codex workspace.
- Cleanup is scheduled for 1:14 AM ET (05:14 UTC). Grok reports it will match
  sender and receiver evidence, preserve `evidence.md`, then delete only the
  temporary receiver, sender script, and cleanup routine. Actual cleanup,
  including temporary credential storage, still needs confirmation.

Retrieve the non-secret evidence after the experiment; do not reopen the
Grok conversation during the test. Required fields are the matching event ID,
actual POST send time, HTTP response time/status, receiver start/end times,
MCP read outcome or trace, approval behavior, and cleanup outcome. Preserve
failed or incomplete results as such if the receiver has not finished by
the cleanup time. No estimated timestamps should replace measured ones.

This sender's custom correlation ID does not match TourCore's current
`OperatorEventSchema` (`evt_...`). It is usable for an independent receiver
probe but does not exercise the application's typed event sender or Twilio
path. A successful result therefore establishes the narrower external
webhook-to-background-MCP capability; backend integration remains separate.

## Webhook probe result reported 11 October 2026

Grok's result was supplied by the user; sender logs and the actual tool trace
were not directly inspected from this Codex workspace.

| Observation | Account-reported evidence |
| --- | --- |
| Actual POST send | 1:02:00.757 AM ET (05:02:00.757 UTC) |
| HTTP acceptance | 1:02:01.017 AM ET (05:02:01.017 UTC), HTTP 200 |
| Receiver start | 1:02:49 AM ET (05:02:49 UTC), webhook-triggered |
| Correlation | Receiver carried `probe-20261011005720-13933`; Grok reports directly seeing this match |
| MCP action | Exactly one successful `get_state` call; no follow-up setup action |
| Non-sensitive result | Installation reportedly published and running; three demo properties published |
| Approval | No approval card, confirmation, or auto-review block reported |
| Receiver end | 1:02:56 AM ET (05:02:56 UTC), recorded by a date call immediately after successful `get_state` |
| Exact MCP completion time | Not separately recorded; unavailable |
| Temporary resources | Receiver, cleanup routine, and sender script reportedly deleted; no sender process remained |
| Evidence retained | Logs and `evidence.md` on Grok's computer under `/workspace/webhook-probe` |
| Existing alerts | Operator Updates routine and TourCore settings reportedly unchanged |
| Credential cleanup | Incomplete: `PROBE_WEBHOOK_URL` and `PROBE_WEBHOOK_AUTH` remain saved on Grok's computer |

The POST response returned run ID
`5e4d589d-abd7-4318-9c09-7716f3150142`. Grok explicitly describes the association
between that run ID and the receiver run as an inference from the matching
event ID and timing. Preserve that distinction: the event ID match was reported
as directly observed; the run-ID linkage was inferred.

Derived timing: 260 ms to HTTP acceptance; approximately 48 seconds from POST
send to receiver start; seven seconds of receiver runtime; approximately
55 seconds from POST send to receiver end. Receiver timestamps have second-level
precision. The date call after `get_state` provides a bound: the MCP read had
succeeded by the recorded receiver end, although its exact finish time is
unavailable. This one read-only trial finished within the provisional
120-second discovery threshold. It does not establish a product SLA or SMS
delivery latency. One run supplies no latency distribution, fault-handling
evidence, or reliability estimate.

The result supports **external-event-triggered background MCP feasibility in
this connected Grok account**. It does not prove a complete Twilio-to-agent-to-
validated-action-to-SMS workflow, safe replay, tenant isolation, token-expiry
behavior, or general production readiness. The returned statement that texting
works is installation status, not a new real SMS delivery test.

Grok subsequently reported that no supported deletion control exists for
the two temporary saved bindings. It declined to edit the platform secret
store file manually. Both bindings remain and reportedly target only the
deleted receiver. Record this as an unavailable cleanup capability, not
successful secret deletion. Do not edit the platform store or submit
placeholder values as a deletion workaround. If a supported removal control
becomes available, remove only those bindings while preserving evidence and
normal alerts. No further secret input is needed for the feasibility result.
Cleanup reportedly ran about four minutes later than its scheduled
1:14 AM ET time; no exact cleanup-run timestamp was supplied.

The user subsequently reported that the response came back at 1:18 AM ET
(05:18 UTC). Record this as the final report's return time, reported to the
minute. It is consistent with the approximately four-minute-late cleanup,
but does not establish the cleanup's exact start time or the receiver's MCP
completion time. Do not attribute the roughly 16-minute send-to-report interval
to webhook delivery or MCP execution.

## Reproducible local evidence

From `/workspace/TourCore`:

```sh
node scripts/probe-agent-execution.mjs --local
```

The collector runs the existing `operatorAlerts`, `operatorUpdates`, and
`routineSetup` suites with two workers and a 30-second test timeout. It writes
sanitized assertion outcomes and the checkout SHA to
`logs/agent-execution/local.json` (ignored by Git), preserves failure status,
and explicitly leaves live agent execution unverified.

These suites exercise HTTP/MCP requests, actual application behavior, and
file-backed restart recovery. The messaging SDK and Grok webhook network are
simulated. They cover immediate visitor fallback during a routine outage,
pending-event recovery after restart, retry IDs, duplicate suppression,
canonical MCP reads, preference filtering, and secure routine setup.
They do not measure Grok latency, token lifetime, quotas, approval behavior,
Twilio delivery, or arbitrary-event support.

## Live test A: background MCP permission

Use the already-connected Bot. Inspect the actual routine trigger types and
background tool permissions without displaying any credential. If the account
supports a one-off scheduled run, create a temporary read-only probe that calls
`get_state` once after the conversation is closed. Record its actual MCP tool
trace, not just its generated claim that the tool ran.

Record scheduled time, actual run start/end times, successful tool result,
any approval prompt, and whether a user conversation was active. Do not follow
setup next steps, change properties, publish, send SMS, or operate doors.
An authenticated successful read demonstrates scheduled/background MCP use;
it does not establish external-event triggering.

## Live test B: external event to unattended MCP read

First confirm the actual Grok account provides an authenticated external-event
trigger. Identify the connected TourCore installation and its existing secure
configuration. Keep normal operator alerts intact. The next requested test
uses a separate temporary authenticated-webhook probe with the existing
TourCore MCP connection. Do not modify the Operator Updates routine or replace
TourCore's normal alert destination to perform this probe. If a separate
authenticated sender cannot be configured securely, report that specific
prerequisite rather than changing production alerts or exposing credentials.

For the separate probe, on `installation.test`, call `get_state` once and
record the event ID, start/end times, MCP success/failure, and approval prompts
in the private run history. The read must be permitted by the routine's tool
allowlist. Do not run follow-up setup actions. A test event cannot be looked
up through `get_inbox(eventId)` because the standard alert self-test bypasses
the outbox. The normal Operator Updates test handler remains unchanged.

The collector below is available for an isolated test installation whose
secure routine bindings already point to the temporary probe. It reads the
existing configured destination; it does not create or select a separate
routine. Do not run it against the normal Operator Updates destination and
interpret a canned confirmation as a successful MCP probe:

```sh
cd /workspace/TourCore
node --import tsx scripts/probe-agent-execution.mjs --live-trigger --delay-seconds=300
```

The collector follows the application's secure-store-over-environment
precedence and `.env` loading. It reads existing bindings without displaying
or persisting them and requires HTTPS. Without bindings it exits 2 and sends
nothing. With bindings it sends one synthetic `installation.test` after the
delay, allowing the conversation to be closed before delivery. This produces
a routine notification, not an SMS or property mutation. Its evidence file
contains only event metadata, delivery times, duration, and acceptance status.
It does not alter TourCore's alert readiness checks or configuration.

Keep the sender process alive while waiting. The delay is not a durable
scheduled job: interruption means this probe must be started again. Confirm
the configured installation/routine is the intended test target before use.
Do not paste the routine URL, bearer key, setup-session link, or OAuth token
into chat. Configure values through the existing secure setup flow.

Match the sender's private event ID to the Grok run and tool trace. A valid
result requires all of: authenticated event acceptance; a corresponding Grok
background run with the conversation closed; a successful remote MCP read;
and no intervening user prompt. A 2xx without a run or tool trace is inconclusive.

## Acceptance evidence and failure matrix

The plan's 120-second event deadline is illustrative. Use 120 seconds as a
provisional discovery threshold only; agree the live SMS requirement before
making it a product commitment. Capture separate webhook acceptance, agent
start, MCP completion, and eventual SMS delivery times.

| Experiment | Required evidence | Current status |
| --- | --- | --- |
| Local outage/restart/retry/fallback | Current passing assertions | Passed, simulated provider boundaries |
| Scheduled run, chat closed | Real run history and successful MCP read | One success reported; 130s late, 10s duration; independent trace not supplied |
| External trigger, chat closed | Correlated event, real run and MCP trace | One successful webhook-triggered MCP read reported; ~48s to start, 7s receiver run, ~55s to receiver end |
| OAuth expiry/revocation | No unauthorized action; visible failure/escalation | Unrun |
| Approval prompt | Explicitly observed block or permitted read | None reported for scheduled or webhook read; consequential actions untested |
| Duplicate event | Receiver processes/rejects repeat safely | Unrun live; engine deduplication tested locally |
| Disabled routine/quota limit | No lost input; measured fallback/alert behavior | Unrun live; transport outage tested locally |
| Twilio SMS to event to action to SMS | Authorized test sender/number; complete timestamps and audit | Unrun; later delegation experiment |

Begin with one read-only probe for feasibility. If it succeeds, collect at
least 20 ordinary offline trials for useful preliminary P50/P95 latency,
plus explicit failure cases. Report that small sample's limits. Do not provoke
paid quota exhaustion; use supported test controls or observed failures.
Never revoke production credentials to perform a failure test.

Classify only after evidence:

- **Autonomous candidate:** external events start successful unattended MCP
  runs within the agreed deadline. This still needs fault/replay and authorized
  end-to-end messaging validation before production delegation.
- **Scheduled:** verified background polling/scheduled MCP runs, with no proven
  timely external wake-up. Suitable for nonurgent work; retain live SMS fallback.
- **Interactive:** verified tool use only while a conversation is active.
- **Unknown:** prerequisites or evidence are missing. Do not label missing
  access as an unsupported vendor capability.

The current working classification is **autonomous candidate: event-triggered
background MCP feasibility supported by one account-reported trial completing
in approximately 55 seconds**, plus scheduled background access. The first
feasibility priority is complete with the evidence attribution and cleanup
limitation recorded. Production suitability for live SMS remains undetermined;
its full path, latency distribution, and failure/replay behavior need validation.
Retain the engine fallback. The next engineering milestone is the plan's
delegation prototype with completion acknowledgment, deadlines, idempotency,
validated actions, and timeout fallback. Unimplemented recovery guarantees
must not be inferred from this read-only probe.

The next local delegation milestone has now been implemented and verified in
[`delegation-prototype.md`](delegation-prototype.md): durable request -> scripted
agent over actual MCP SDK HTTP -> engine-validated reply -> delivery acknowledgment,
plus independent timeout fallback. All 17 prototype tests passed within the
1,686-test product run; the demo, typecheck, build, and 26 baseline evaluation
tests also passed. Live Grok/Guesty/SMS adapters are separate remaining work.
