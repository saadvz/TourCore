# Phase 0.3: engine and agent contract

Decision: adopt this responsibility and recovery contract for Cleaner Core.
Revision 1.0. Core Phase 0.3 is complete as an architecture deliverable; the
production implementation gaps below remain open for later phases.

The roadmap's Phase 0.3 asks us to codify what can leave the backend, retain
enough authoritative state to recover without agent memory, and prefer
deterministic fallback. This document defines that contract. It distinguishes
the existing isolated prototype from requirements for the shared platform;
it does not claim that the prototype implements the full production contract.

## Responsibility and authority

The agent supplies optional reasoning. The engine decides whether an action
is authorized and commits its effects. Agent conversation history, model
output and native calendar observations cannot override engine state.

| Responsibility | Owner and rule | Existing prototype |
| --- | --- | --- |
| Intelligent reasoning and explanation | Agent may interpret, suggest and explain from supplied facts; consequential claims require current engine state | Structured time proposal and synthetic drafting probe |
| Message phrasing | Agent may draft; engine validates facts, chooses recipient and commits the exact outgoing text before sending | Live proof reply path uses fixed engine templates; probe drafts are never sent |
| Noncritical orchestration | Agent may combine scoped reads; every consequential action returns through an authorized engine command | Read/list/claim/propose tools only |
| Calendar lookup | Agent may read a verified, owner-granted resource; results are advisory until reconciled with the authoritative reservation source | No live native calendar or Guesty integration |
| Webhook receipt and sequencing | Engine verifies source, binds tenant, persists input, deduplicates and orders work for the affected entity | Signed test SMS and durable source-ID deduplication; per-booking event ordering remains a gap |
| Deadlines and leases | Engine sets absolute deadlines from first durable receipt and owns lease expiry | 120-second work deadline, 60-second lease bounded by that deadline |
| Authorization and access policy | Engine binds identity and checks permissions/approval; scheduling does not grant entry | Token-bound tenant/agent, fixed test recipient, explicit host clearance; no access operation |
| Booking invariants and state transitions | Engine validates fresh versions, windows and duration, then commits the change | One atomic decision/turn/reply/audit snapshot |
| Sends and retries | Engine/provider adapter owns transport, receipts, bounded retries and uncertain-outcome review | Local idempotent sink or opt-in Twilio test adapter |
| Audit and recovery | Engine retains decision/effect evidence and recovers without the conversation being open | Durable ledgers and independent workers |

Capability verification establishes an observed ability, not a business
permission. A tenant/agent cannot acquire booking, access or messaging authority
by declaring a capability or passing a probe. Owner/admin operations use a
separate credential. Tenant identity and message recipient are never accepted
from the delegated proposal's arguments.

## Delegation boundary

The current wakeup is the existing five-field wire envelope:

```json
{
  "schemaVersion": 1,
  "eventType": "cleaner.reschedule_requested",
  "eventId": "work_0123456789abcdef0123456789abcdef",
  "workId": "work_0123456789abcdef0123456789abcdef",
  "deadlineAt": "2026-10-12T12:02:00Z"
}
```

Its event ID matches the work ID. The routine authenticates the wakeup; the
agent then authenticates independently to MCP. The wakeup contains correlation
IDs and a deadline. It does not carry credentials, a phone number or booking
authority. Do not change this envelope to the roadmap's illustrative larger
event without an explicit versioned adapter migration.

`read_delegated_work` supplies the current request, status and cleaning turn:
version, time zone, scheduling window, minimum duration, next arrival and
confirmed start if present. It excludes the tenant and recipient from the
turn view, and excludes lease tokens from an ordinary read. The claim response
adds only that claimant's lease token and expiry. Future task-specific context
must be limited to the facts needed for the granted operation; external content
and conversation history remain input data rather than authorization.

The agent may retain richer conversational context. The backend must retain
the normalized user request and any consequential clarification, choice or
approval needed to reconstruct the decision. A fact held only in agent memory
cannot justify a booking change or be required to deliver a pending reply.
The current SMS proof normalizes its exact test phrase into synthetic scheduling
facts; it is not a general conversational SMS store or interpreter.

For new actions, the agent follows this sequence:

1. Read current work. Stop on `completed`, `review_required`, `reply_pending`
   or an elapsed deadline. A webhook replay does not create a new request.
2. Claim open work. Use the returned lease token and current `turn.version`.
   Do not compute a new deadline or assume a previous conversation still owns it.
3. Submit `propose_cleaning_time` with `id`, `leaseToken`, `actionKey`,
   `expectedTurnVersion` and `start`. The Grok routine uses `grok_<workId>`.
   The engine checks identity, live lease, current version and scheduling rules.
4. Read authoritative status after acceptance. `accepted=true` means a saved
   decision and outbox entry. It does not establish send completion or delivery.
5. On an uncertain response, read status first. An exact retry uses the same
   action key and identical arguments. Never change a payload under that key
   or invent another key to bypass a failed/uncertain action. Changed facts or
   lease credentials require a separately authorized recovery decision; the
   current routine reports the error and leaves engine fallback active.

An exact replay of a committed action can return the existing result even
after its original lease expires. It performs no new state change. A new action
cannot supersede a committed reply through the prototype tool.

The engine commits the validated turn change, decision fingerprint, fixed
recipient, exact reply and audit before any send. Agent-generated wording is
not enabled for live replies in this prototype. Future wording support must
validate material facts, preserve required policy language and fall back to a
template if validation fails. A draft cannot claim approval, entry permission,
delivery or a booking confirmation that the engine has not established.

## Authoritative recovery state

These records must survive the agent being closed, losing its context or being
replaced. Private credentials remain in supported runtime secret storage.

| Record | Minimum recovery information | Current storage |
| --- | --- | --- |
| Inbound event | Tenant/source ID, affected entity, normalized request, first durable receipt, deadline, processing marker | `delegation.json`; signed SMS input/processing marker in `sms-proof.json` |
| Current cleaning state | Turn identity/version, trusted recipient binding, scheduling facts and committed start; production adds authoritative reservation/approval provenance | `delegation.json` turn records; SMS route bound to trusted configuration |
| Delegated work | Work ID, status, tenant/turn association, requested start, deadline, lease owner/token/expiry | `delegation.json` work records |
| Accepted decision | Stable action key, fingerprint, resulting state/version and decision source | Decision, turn and reply in the same `delegation.json` snapshot |
| Outgoing reply | Stable reply key, fixed recipient, exact text, status, attempts, next retry, receipt and source | Engine outbox in `delegation.json`; local sink in `replies.json` or Twilio ledger in `sms-proof.json` |
| Agent notification | Correlated work ID, deadline, attempts, next retry, HTTP outcome and transport status | `notifications.json` |
| Agent eligibility | Identity binding, declarations, evidence methods/scopes/expiry and permitted native resources | `agent-profiles.json` plus runtime authentication configuration |
| Audit | Receipt, claimant, validated action, fallback, send attempts, review and completion; production links source and provider records explicitly | Engine audit plus correlated notification/SMS ledgers |

Prototype state is stored as atomic JSON snapshots in one persistent directory,
with a single service writer. Separate ledgers are reconciled by stable IDs;
they are not one cross-file transaction. Corrupt records fail closed instead
of being reset to an empty queue. Keeping only an agent transcript, a webhook
HTTP response or an in-memory timer would not satisfy this contract.

The recovery rules are:

- Recover durable unprocessed SMS input into the same work ID using its first
  receipt time. A restart must not grant another two-minute response window.
- Discover missing notification records from open durable work. Notification
  HTTP 2xx records transport acceptance only; a failed notification leaves
  the engine deadline and fallback active.
- Reclaim an expired lease before the work deadline. At the deadline, close
  pending/leased work to new proposals and atomically select fallback.
- Resume a committed outbox independently of agent calls. If the booking changed
  before its first send, route the obsolete confirmation to review.
- Persist a send attempt before making the provider request. Retry an uncertain
  outcome only when the adapter guarantees idempotency for that same key.
  Twilio in this proof does not provide that guarantee: uncertainty requires
  review and does not authorize automatic resend.
- Preserve a committed booking change when delivery is uncertain; do not
  silently roll it back or create a second booking action to repair an SMS.
  Reconciliation needs an explicit authorized resolution.

The current lifecycle is `pending → leased → reply_pending → completed`, with
`leased → pending` on lease expiry, pending/leased work moving to
`reply_pending` on fallback, and `reply_pending → review_required` for uncertain
delivery, exhausted attempts or a stale confirmation. Agent deadline expiry
does not replace an already committed reply with another fallback reply.

`completed` and `deliveryStatus=sent` mean the reply adapter returned a receipt
and the engine persisted it. For Twilio, the receipt means provider acceptance.
Carrier `delivered`, `failed` or `undelivered` status is tracked separately.
A later delivery failure does not turn the original action into an unperformed
action or authorize a duplicate. The prototype records such callbacks but does
not implement an operator reconciliation workflow or automatically resolve
`review_required` after a later successful callback.

## Deterministic fallback and optional inference

Keep fallback in the always-running backend. Closing Grok, webhook rejection,
an approval block or loss of model availability cannot remove it.

| Situation | Engine response | Current implementation |
| --- | --- | --- |
| Authorized proposal fits current rules before deadline | Commit state and a controlled confirmation, then send from outbox | Implemented |
| Invalid slot, stale version or invalid lease | Reject without changing state; preserve the original deadline | Implemented; routine reports rather than inventing another action |
| No valid agent decision by deadline | Keep the existing cleaning time, acknowledge requested review, preserve host-clearance rule | Implemented deterministic template |
| Booking changed before first confirmation send | Hold obsolete reply for review | Implemented |
| Uncertain non-idempotent send or retry exhaustion | Record review state; do not start another automatic send | Implemented |
| Profile unavailable/expired or required tools missing | Do not select autonomous dispatch; apply a deterministic supported response or human review | Profile readiness exists; capability-based event routing is future platform work |
| Ambiguous natural-language request beyond deterministic rules | Ask a controlled clarification or route to human review; optionally evaluate bounded inference | General interpreter and inference routing are not implemented in this proof |

The current deadline fallback says:

> Your cleaning time change is awaiting host review. Your existing time is
> unchanged. Entry still requires host clearance.

It does not confirm the requested start or grant access. `decisionSource=fallback`
distinguishes it from an agent proposal. The prototype does not yet create a
host-review ticket or ensure a host follows up; that operational path must exist
before using this template for real cleaning requests.

No fallback inference provider is selected or enabled in Phase 0.3. Phase 0.4
must compare the rules-first baseline, the external agent and candidate models
on labeled messages, actual latency and cost. If evaluation later justifies a
small inference API, the backend may invoke it only for a configured task that
rules and the available agent cannot handle reliably, with an explicit tenant
budget, remaining-deadline timeout and supported structured output.

Inference output remains a proposal under the same fresh-state, authorization,
approval and idempotency checks. It cannot extend the work deadline, take over
a committed agent action, choose a recipient or send directly. Missing budget,
timeout, unavailable provider or invalid output returns to deterministic
clarification/review. Deterministic access and booking policy stays mandatory
even when a model appears confident.

## Implementation gaps and acceptance boundary

The contract is finalized; these are implementation requirements for subsequent
platform/product phases, not features claimed by the isolated proof:

| Gap | Required implementation and acceptance evidence |
| --- | --- |
| Shared persistence and entity sequencing | Transactional tenant-scoped storage, unique source/action/outbox keys, monotonic entity version and a defined order for distinct events on the same booking; test concurrent requests/imports and stale confirmations |
| Conversation recovery | Persist relevant normalized messages, clarification/approval facts and their provenance; reconstruct pending work after losing all agent context |
| Capability-based dispatch | Select routes from fresh scoped profiles and permission grants; test expiry, revoked credentials and absent tools without relying on the routine to enforce readiness |
| External reservation/calendar authority | Import and reconcile Guesty/reservation changes; native reads cannot directly change bookings or override the authorized cleaning window |
| Review and delivery reconciliation | Durable host/operator queue, authorized resolution/replay commands and provider reconciliation; test later failed/undelivered receipts and uncertain sends without duplicates |
| Production policy, access and quotas | Explicit approval/access rules, tenant limits and cost accounting; no property-entry inference from arrival or scheduling text |
| Shared worker scheduling | Durable job ownership and fair scheduling so a slow provider/tenant cannot stall others; the current engine serializes local work and waits on bounded sends |
| General SMS reasoning and phrasing | Evaluate on labeled messages before enabling parsing, inference or live agent drafts; validate policy facts before committing replies |

Source review mapped the contract to
[`prototype.ts`](../src/delegation/prototype.ts),
[`mcp.ts`](../src/delegation/mcp.ts),
[`notifications.ts`](../src/delegation/notifications.ts),
[`smsProof.ts`](../src/delegation/smsProof.ts),
[`worker.ts`](../src/delegation/worker.ts),
[`testService.ts`](../src/delegation/testService.ts), and
[`grok.ts`](../src/agents/grok.ts). Existing tests were run for this contract
review: **36 passed across three suites** (delegation, notifications and SMS).
They cover authenticated scope, stale versions/leases, slot rejection, exact
deadline fallback, restart recovery, duplicate actions, notification retry
limits, signed SMS and uncertain-provider outcomes. Their clocks and provider
responses are controlled; this was not another live Grok/Twilio trial.

This phase changes documentation only. It does not modify deployed tools,
receiver instructions, runtime configuration or production Tour Core behavior.
The [execution evidence](cleaner-agent-execution-decision.md) and
[capability profile](cleaner-agent-capabilities.md) remain the current feasibility
record. Next is Phase 0.4 model evaluation; the other Phase 0 feasibility gates
remain separate.
