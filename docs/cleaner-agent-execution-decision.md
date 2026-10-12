# Cleaner Core agent execution decision

Status: asynchronous execution feasibility supported for the isolated prototype
by synthetic trials and one real SMS trial on account-reported evidence.
Production suitability remains unverified. Decision date: 11 October 2026.
The real SMS trial used a separate Twilio number, a controlled phone and
synthetic cleaning state; the user confirmed one phone reply and a closed
conversation throughout execution.

## Supported execution mode

Use authenticated, webhook-triggered Grok execution as the reference external
agent adapter. The separate Cleaner Core connector exposes tenant-bound
read/list/claim/propose tools; its token-forwarding bridge successfully served
background calls in the supplied account reports. The first full synthetic
trial completed in 23.656 seconds with the conversation explicitly confirmed
closed and no approval prompt. A subsequent 20-request ordinary sample reported
20 completed agent decisions, no deadline misses, and one simulated reply per
work. The user explicitly confirmed the conversation stayed closed throughout
all 20 trials.

The repeated sample's independently recomputed receipt-to-completion median is
22.908 seconds, nearest-rank P95 25.343 seconds, and maximum 41.612 seconds.
These describe durable engine receipt through a local simulated reply receipt.
They do not measure real SMS ingestion or carrier delivery. The 120-second
deadline is a provisional prototype limit, not an agreed live-SMS SLA.

The subsequent real SMS trial completed through the agent in **23.847 seconds**
from the engine's received audit timestamp. Twilio `delivered` status was
recorded **24.803 seconds** after that timestamp. The user confirmed exactly
one reply arrived on the phone, but no precise phone receipt time was supplied.
There was no approval prompt or block. This is one observation, separate from
the 20 simulated trials and their percentiles.

## Engine and agent boundary

The engine owns durable receipt, tenant/recipient binding, deadlines, leases,
booking-version checks, valid scheduling windows, reply composition, delivery,
idempotency and audit. The agent may propose structured changes inside that
contract. Completion requires an engine-recorded reply receipt, not HTTP
notification acceptance or merely an accepted proposal. Keep deterministic
fallback in the always-running engine so the external agent remains optional.

Observed fault behavior supports this boundary: a malformed auth header and
an explicitly paused receiver both led to one engine fallback reply, with no
agent claim or proposal. The pause trial completed fallback in 120.236 seconds
with the conversation confirmed closed. Completed-event replay and a duplicate
webhook left the booking, audit and one-reply ledger unchanged. One ordinary
POST timeout recovered the existing work by retrying the same event ID.

## Adapter and operational constraints

- Use HTTPS and the routine's full Authorization value, `Bearer <key>`;
  exclude the `Authorization:` header-name prefix. The sender forwards the
  saved value unchanged and refuses redirects.
- Match the sender's `eventType` discriminator and five-field event envelope.
  A webhook's HTTP 2xx acknowledges delivery, not agent execution.
- Preserve a stable action key, leased ownership and current turn version.
  The engine must validate every consequential action.
- Report collector/scheduler delays separately from engine execution. Scheduled
  collectors were minutes late even when the engine completed promptly.
- Routine runs could not resume another routine. Pause tests need supported
  interactive restoration. The existing test receiver was restored successfully.
- Availability, credential expiry and restart behavior of the Grok runtime's
  bridge have not been proven as production guarantees. Deliberate paid-quota
  exhaustion was not tested.

## Remaining gates and next boundary

The plan's real inbound SMS -> durable event -> Grok tools -> validated action
-> outbound SMS feasibility chain now has one passing isolated account report
with user-confirmed phone receipt and a closed conversation. The opt-in
[SMS proof adapter](cleaner-sms-proof.md) provides reusable transport. Its
cleaning state is synthetic and its recipient is fixed by trusted configuration.
Remote raw evidence was not directly inspected; the report omitted the
outbound record's deterministic key, so that specific field remains an expected
source contract rather than an independently observed correlation.

Phase 0.2 now adds the [AgentProfile, capability checks and Grok adapter](cleaner-agent-capabilities.md).
The implementation is verified locally, and current-account core onboarding
passed on the user-supplied 11 October report. The profile verifies actual
connector MCP reads, a synthetic policy draft and background execution;
optional scheduled/native/file/reminder capabilities remain unverified.
Its readiness is `autonomous` for `cleaner.reschedule_requested`, with no missing
autonomous requirements, `fallback=engine_owned` and `productionReady=false`.
The app's tool inventory remains four despite server/bridge discovery of eight
and an advertised version update. Capability onboarding has a compatible path:
an actual existing connector read verifies core MCP, and protected admin APIs
handle declarations/draft grading. The app discovery limitation stays recorded
separately; HTTP grading cannot promote MCP verification.
The [sanitized profile evidence](evidence/cleaner-agent-profile-2026-10-11.json)
records methods, scopes and seven-day expiries. Background evidence expires
first on October 18 at approximately 5:54 PM ET; expired evidence cannot retain
autonomous readiness. No new SMS, event or routine was needed for onboarding.
The supported execution evidence is webhook-triggered
background execution with authenticated MCP calls and engine-owned deadline
fallback. Polling latency, quota exhaustion, credential revocation, concurrent
live SMS and provider-restart reconciliation remain unverified boundaries.

An SMS adapter must not claim provider idempotency merely because the engine
supplies a key. Lost acknowledgments through a non-idempotent provider need
reconciliation or review. Keep engine acceptance, provider acceptance and actual
delivery status distinct. The prototype's single-process JSON storage and local
reply sink are not a production shared database or SMS provider.

Other Phase 0 work remains separate: optional capability probes; two-tenant hosted
isolation and economics; Guesty account feasibility; model evaluation; and live
concurrent/restart/revocation failure cases. None is established by the synthetic
latency sample. The evidence and exact limitations are in
[the proof record](async-agent-proof.md).

Core Phase 0.2 is complete. Phase 0.3 has now finalized the
[engine/agent contract](cleaner-engine-agent-contract.md): responsibility,
delegated data and commands, minimum recovery state, deterministic fallback,
and the gate for optional inference. The contract records production gaps
separately from existing prototype behavior. Next is Phase 0.4 model evaluation.
