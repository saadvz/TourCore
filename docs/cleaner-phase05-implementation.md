# Cleaner Core Phase 0.5 local implementation

Status: **implemented and locally demonstrated**, 12 October 2026, on
`cleaner-core/phase05-multitenant`, based on `cleaner-core/railway-agent-proof`.
Closure update: the user has now authorized economics and live Grok validation.
See [economics validation](cleaner-phase05-economics.md) and the
[same-endpoint Grok packet](cleaner-phase05-live-grok-packet.md). Live results
remain pending. The attached roadmap supplies background; the user's implementation request and
final architecture decision govern this work. The old onboarding-only restriction
in the earlier proof does not apply to this implementation task.

## Run and scope

Use the existing checkout and Node 24 (tested on 24.19.0). The new runtime uses
Node's built-in `node:sqlite`; no inference or database package was added.

```sh
npm run cleaner:phase05:demo
npx vitest run test/cleanerPhase05.test.ts
npm run cleaner:phase05:measure
```

The demo starts one loopback HTTP runtime, authorizes two fictional owners and
scripted MCP clients through PKCE, ingests two signed fictional events, then
claims/proposes and obtains two isolated injected-provider receipts. It deliberately
reuses source, booking, agent and action IDs. Its temporary SQLite database and
credentials are removed on exit. [Saved demo result](../eval/cleaner-phase05/results/multitenant-demo.json).

The reusable [service composition](../src/delegation/phase05/service.ts) starts
independent background workers by default. `workerIntervalMs: 0` is explicit
controlled-test mode. It requires trusted owner fixtures, provider bindings and
optional injected wakeup adapters; it does not discover or load real credentials.
No existing service startup imports this composition. Existing installation,
Grok routines/connector, Railway deployment and real provider settings were not
changed. No real SMS, access action or inference call was made by these fixtures.

## Implemented authority and recovery

- Every MCP request, including discovery, resolves a current authenticated agent
  grant. Tool execution rechecks the grant. Every owner operation resolves a
  separate current owner grant. Strict argument schemas reject supplied tenant
  or agent authority fields. Work, profile, probe, grant, property, access,
  notification and evidence routes use the resolved tenant.
- Owner-approved OAuth client registration and authorization bind tenant, agent,
  exact redirect, S256 challenge and a one-use 60-second code. Access tokens
  expire after an hour; refresh tokens rotate and detect reuse. Revocation
  increments the credential epoch, invalidates profiles/probes, cancels pending
  wakeups and releases leases atomically. Repeated replay from an already-retired
  credential epoch cannot revoke a newly approved epoch. Credential hashes are
  stored; bearer tokens and provider secrets are not stored in these records.
- Provider ingress uses a fictional HMAC protocol over timestamp and exact body.
  Account, receiving number and inbound cleaner sender must match the signing
  binding. Tenant, recipient and retry guarantees come from trusted configuration.
  This is deliberately not a Twilio or Sendblue signature adapter. Binding
  identity/epoch/recipient/guarantee changes require explicit reconciliation;
  reopening an existing database with a conflicting binding fails closed.
- SQLite WAL with FULL synchronous commits stores indexed tenant records,
  composite ownership foreign keys and unique tenant/provider/source,
  tenant/action and tenant/work outbox keys. Short transactions commit turn,
  action, reply and audit together. A failed outbox insertion rolls back all
  effects. Distinct events on one turn follow durable insertion order;
  earlier open work must settle before a later claim.
- Existing scheduling validation and exact operational templates are reused.
  Version comparison, grant-owned expiring leases, absolute first-receipt
  deadlines and exact action replay remain authoritative. An obsolete
  confirmation before first send enters review. At deadline the engine selects
  the unchanged-time/host-clearance fallback without agent participation.
- Reply workers and wakeup workers each use round-robin admission, a global
  limit of four outstanding transports and one lane per tenant. Replies and
  wakeups each allow two starts per tenant per second. Authenticated HTTP
  requests allow 50 per tenant per second and eight concurrent requests;
  signed ingress has a separate tenant rate budget. Rate counters are durable
  indexed atomic updates. Deadline sweeps process bounded batches, not retained
  audit history. Provider awaits own no database transaction or engine queue.
- A send attempt and ownership token are persisted before transport. Ownership
  tokens prevent stale completions overwriting another worker. Only adapter-
  guaranteed idempotent uncertainty, or an adapter-certified definitely-not-
  accepted outcome, is retryable. Retries reuse the committed key and exact
  recipient/text, with exponential backoff and three attempts maximum.
  Uncertain non-idempotent sends enter durable review. Recovery respects send
  leases and the persisted binding guarantee. An adapter ignoring cancellation
  keeps its transport slot occupied, preventing overlap in that process.
- Notification records are indexed by tenant/work/agent adapter identity and
  credential epoch. Status reads are scoped. Automatic dispatch requires fresh
  scoped MCP/background evidence, a current grant and observed latency within
  the deadline. An owner may explicitly request a single onboarding wakeup;
  that request does not establish autonomy. Declarations do not verify capability.
  Workflow attestation requires correlated wakeup, agent claim/decision,
  provider acknowledgment and owner confirmation of a closed conversation.
- Grok is the default first adapter; generic MCP clients use the same eight
  tools and unchanged five-field wakeup. Synthetic drafting probes never send
  messages. No new inference integration or free-form operational SMS is enabled.

`accepted=true` means the decision/outbox transaction committed. Notification
HTTP 2xx means wakeup transport acceptance. Engine `completed` and reply `sent`
mean an injected provider returned a receipt, not phone delivery. Signed carrier
callbacks are separately tenant/receipt-bound and deduplicated. A later carrier
failure preserves the committed action and cannot authorize an automatic resend.
Owner access records require explicit host clearance and expiry and operate no doors.

## Pass, fail and limits

[Machine-readable test evidence](../eval/cleaner-phase05/results/multitenant-tests.json)
retains test names, outcomes and failures. Final focused validation: **98/98
passed across eight suites**, including **27/27 new Phase 0.5 tests**. Type checking,
build, whitespace validation and the standalone demo passed.

| Acceptance area | Result | What was exercised |
| --- | --- | --- |
| Reciprocal isolation | PASS | Actual loopback HTTP/SDK MCP, all eight tools reject injected authority; foreign work, probes, owner data/admin operations, OAuth consent/revocation and provider callbacks denied in both directions |
| Tenant storage | PASS | Shared IDs retain different tenant records; composite provider/turn/property foreign keys reject cross-tenant linkage; fixed number/recipient bindings govern replies |
| Atomic effects and order | PASS | Failed outbox transaction rolls back turn/action/audit; competing identical proposals commit once; action-key conflicts and later entity claims denied |
| OAuth and live revocation | PASS | Owner consent, PKCE/client/redirect binding, code replay/expiry, refresh rotation/reuse, token expiry, hot MCP denial, profile reset and lease release |
| Restart and process crash | PASS | Reopening preserves sources/deadlines/backoff; actual child-process SIGKILL during each provider guarantee; expired sending lease retries idempotent work and reviews non-idempotent uncertainty |
| Stale state and freshness | PASS | Expired lease, old token, stale booking version, invalid slot, stale first confirmation, stale worker token and expired automatic-dispatch evidence |
| Fairness and limits | PASS | Held A provider permits B reads/completion; round-robin limit-one serves B before second A; durable tenant rate budget, HTTP concurrency and cancellation-resistant overlap prevention |
| Notifications and delivery | PASS | Shared-root retries do not encounter foreign work; 202 leaves work pending; automatic fallback with closed agent; separate carrier receipts and no duplicate on failed delivery |

The earlier full repository run finished with **1,761 passed and three failed
out of 1,764** (it included 24 new tests at that point). Final focused validation
then exercised the final 27 new tests and the seven related legacy suites.
The three broad-run failures reproduced when the two changed legacy delegation
source files were temporarily restored from the base branch and the same three
legacy suites were rerun; the implementation files were restored afterward:

1. `hostedRailway.test.ts`: short-lived setup-session test times out at 5 seconds.
2. `operatorTools.test.ts`: configured-credential redaction test times out at 5 seconds.
3. `publicComplianceBoundaries.test.ts`: eight existing non-reserved phone
   occurrences in the unchanged SMS proof document/tests and startup fixtures.

The full suite is therefore **not green**. No test was weakened or existing
proof phone/configuration changed to hide these failures.

This establishes a local two-tenant implementation, not production readiness.
At initial local acceptance, live Grok unattended execution, real vendor
ingress/signatures/delivery, reservation authority and door/access-provider
integration remained untested. Later synthetic account-export evidence is
recorded below; real-provider and production boundaries remain unchanged.
OAuth here has an authenticated owner consent API, not a browser account/consent
UI or complete discovery integration. Owner credentials are local fixture
bootstrap credentials, not a landlord account system. Optional external native
connectors are explicitly unavailable. Review states are durable and readable;
operator resolution and provider reconciliation workflows remain future work.
There is no migration from existing JSON ledgers and no production startup wiring.
SQL foreign keys defend ownership relationships; the database is not a tenant-
exposed SQL service or row-level security system. Fair transport admission is
proved in one process; multi-host worker capacity enforcement is not established.
Deadlines close proposals at the exact boundary, while bounded worker sweeps may
process a large backlog over several cycles; no production deadline SLA is claimed.

## Live evidence and synthetic server-clock scheduling

The user deployed the optional Phase 0.5 test runtime on the existing Railway
URL. Uploaded A engine/profile exports reconcile one background agent decision
and one simulated receipt in 21,246ms. Reciprocal tenant read/claim and owner
denials are reported with own-tenant controls; their raw denial logs are not
supplied. An initial reverse-direction attempt authenticated as cached A and
is excluded. B onboarding failed: its notification was queued 46,176ms after
the deadline and cancelled with zero attempts. Its unchanged-booking fallback
and single simulated receipt passed. These outcomes are retained in
`docs/evidence/cleaner-phase05-live-reconciliation-2026-10-12.json`.

`testSchedules.ts` adds an indexed, durable fixture scheduler only to the
synthetic hosted-test runtime. Owner POST `/test/schedules` queues a stable
event for the server clock; GET/DELETE its ID read or cancel only owned,
not-yet-fired jobs. One owner/tenant cannot select another through request
fields. Both owner authority and a live agent grant are checked at submission
and fire time. Queues are bounded per tenant, with one due job per tenant per
pass; there is no always-polling idle timer when the queue is empty.

At fire time, the server creates the source under existing deduplication and
prepares onboarding probe/wakeup/fired-marker records transactionally, without
network awaits. A crash between source creation and setup recovers the same
work and original deadline. It checks that deadline again before preparing
setup; expired work receives no stale wakeup. A not-yet-created job over five
seconds late expires visibly. The engine retains all booking, lease, action,
reply and provider authority. Ordinary test scheduling uses normal capability-
gated dispatch; it does not assert native agent scheduled_runs capability.

Local scheduler regression, core isolation and cost checks pass, along with
typecheck, bundle and bundled-server smoke. Exact commands/counts/source hashes
are in `docs/evidence/cleaner-phase05-server-clock-validation-2026-10-12.json`.
This supplements the earlier acceptance runs and does not claim the full
repository suite is green. The existing volume, environment settings and
five-field receiver envelope are retained. No real SMS/access adapter or new
inference stack is introduced. The subsequent uploaded server-clock B retry
schedule, engine and profile records reconcile to 94,349ms agent completion
with one simulated receipt and 25,652ms remaining before its stored deadline.
Both tenants therefore have one successful exported onboarding observation;
the earlier failed B trial remains recorded. Ordinary-run, fault and recovery
live checks remain pending; use the ordinary A/B section in the live packet.

## Raw resource observations

The [indexed sampler](../eval/cleaner-phase05/indexed-meter.mts) and
[raw measurements](../eval/cleaner-phase05/results/indexed-resource-sample.json)
record every lifecycle, process CPU/RSS, Linux process I/O counters and physical
SQLite/WAL/shared-memory sizes. The original
[JSON-store observations](../eval/cleaner-phase05/results/resource-sample.json)
remain unchanged. Measurements exclude HTTP/MCP, live agent reasoning, real SMS,
startup and hosting. The sampler injects a lost first acknowledgment every tenth
A request and retries the same key. RSS is sampled whole-process memory, not a
continuous peak or tenant allocation. Linux I/O accounting is not exact device
write amplification. The raw report records source hashes and measurement limits.
No hosting selection, prices or cost model is included.

| Requests | Active CPU seconds | Lifecycle P95 ms | Checkpointed files bytes | Idle CPU ms/cycle |
| ---: | ---: | ---: | ---: | ---: |
| 20 | 0.155 | 10.59 | 307,200 | 0.152 |
| 100 | 0.580 | 11.24 | 503,808 | 0.148 |
| 300 | 1.892 | 22.28 | 1,036,288 | 0.151 |

Checkpointed bytes include SQLite shared memory and exclude the truncated WAL.
The raw report also retains pre-checkpoint WAL sizes, per-request I/O/RSS and
per-tenant record counts. Idle measurements cover completed work with no
configured wakeup routes. These observations are not a controlled hardware
comparison with the earlier snapshot sampler and do not establish a throughput SLA.
