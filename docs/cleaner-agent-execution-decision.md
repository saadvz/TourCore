# Cleaner Core agent execution decision

Status: supported for the isolated synthetic prototype on account-reported
evidence; production live-SMS suitability remains unverified. Decision date:
11 October 2026. The roadmap informs this decision. The authorized work so far
has used isolated synthetic requests and simulated replies; a real messaging
test needs an identified test sender and controlled recipient.

## Supported execution mode

Use authenticated, webhook-triggered Grok execution as the reference external
agent adapter. The separate Cleaner Core connector exposes tenant-bound
read/list/claim/propose tools; its token-forwarding bridge successfully served
background calls in the supplied account reports. The first full synthetic
trial completed in 23.656 seconds with the conversation explicitly confirmed
closed and no approval prompt. A subsequent 20-request ordinary sample reported
20 completed agent decisions, no deadline misses, and one simulated reply per
work. Batch closed-conversation confirmation is pending.

The repeated sample's independently recomputed receipt-to-completion median is
22.908 seconds, nearest-rank P95 25.343 seconds, and maximum 41.612 seconds.
These describe durable engine receipt through a local simulated reply receipt.
They do not measure real SMS ingestion or carrier delivery. The 120-second
deadline is a provisional prototype limit, not an agreed live-SMS SLA.

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

The synthetic execution feasibility gate has supporting evidence. The plan's
full live-SMS chain still needs an isolated, explicitly authorized provider
test: inbound SMS -> verified provider webhook -> durable event -> Grok tools ->
validated action -> real outbound SMS and provider status evidence. Before
implementing that live test, identify an isolated Twilio sender/account and
controlled recipient, verify account/campaign/consent coverage, and supply
credentials through supported private controls. Do not repurpose production
Tour Core messaging bindings to run it.

An SMS adapter must not claim provider idempotency merely because the engine
supplies a key. Lost acknowledgments through a non-idempotent provider need
reconciliation or review. Keep engine acceptance, provider acceptance and actual
delivery status distinct. The prototype's single-process JSON storage and local
reply sink are not a production shared database or SMS provider.

Other Phase 0 work remains separate: capability profiles; two-tenant hosted
isolation and economics; Guesty account feasibility; model evaluation; and live
concurrent/restart/revocation failure cases. None is established by the synthetic
latency sample. The evidence and exact limitations are in
[the proof record](async-agent-proof.md).
