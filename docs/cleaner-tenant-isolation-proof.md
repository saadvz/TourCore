# Phase 0.5: tenant isolation and delegation reliability

Status of this historical runner: **partial, existing-core proof completed**.
The subsequent [local Phase 0.5 implementation](cleaner-phase05-implementation.md)
now demonstrates the two-tenant indexed runtime; this document preserves the
original diagnostic evidence and gaps. Costs are deferred by the
user on 12 October 2026 because the temporary hosting service is not the final
hosting choice. There is no hosting-price forecast or claimed cost target here.
The two-tenant hosted product remains undeployed; the local implementation is
reported separately.

The roadmap requires two landlords in one runtime with separate agent
authorizations, provider credentials, properties, SMS events, access data and
audit records. It also requires isolation through MCP, OAuth, event handling
and storage, plus budgets/rate limits. The final
[architecture decision](cleaner-model-evaluation.md) keeps the deterministic
engine and templates, prioritizes Grok delegation and adds no inference stack.

## What was actually exercised

The [standalone runner](../eval/cleaner-phase05/isolation.mjs) creates one
existing `DelegationPrototype` and one existing MCP app, shared by two tenant
bindings and profiles. Both tenants deliberately reuse the same agent name,
booking ID, provider-event ID and action key. Two scripted SDK clients exercise
the actual loopback HTTP/MCP endpoint. Runtime fixtures and tokens are temporary
and removed afterward. No new Grok routine, real SMS, booking, property or
access action is created.

The [result](../eval/cleaner-phase05/results/isolation.json) records **15 passed
checks, five reproduced integration/design gaps and no unexpected failures**.
These are diagnostic check groups, not a new count of repository unit tests.
The existing five delegation/capability suites separately passed **60 tests**.

| Boundary | Observed result | Scope limit |
| --- | --- | --- |
| Source/booking IDs | Same source ID creates distinct work per tenant; repeats within a tenant reuse work; same booking ID has separate records | Trusted fixture ingestion, not a deployed tenant event router |
| MCP list/read/claim/propose | Foreign work and leases denied; injected tenant fields rejected; list returns own work only | Static bearer bindings, not OAuth |
| MCP discovery/profiles/probes | Both SDK clients discover eight tools; declarations/evidence/probe nonces remain scoped despite identical agent names | Not a new Grok app-discovery or background run |
| Recipient/audit boundary | Two decisions complete with separate fixed recipients and one simulated reply each; evidence rejects foreign work; exact action replay leaves saved state unchanged | Local provider, no real account credentials or access records |
| Leases/recovery | Restart retains the deadline; reclaim rejects the previous lease; expired work uses one engine fallback | Controlled clock and re-instantiation, not a live deployment crash |
| Concurrent proposals | Same action commits once; another agent cannot take an active lease | One single-writer process |
| Uncertain sends | Non-idempotent uncertainty enters review; restart does not automatically resend | Injected provider response, no carrier receipt |
| Credential evidence | Changing A's profile binding invalidates A's capability evidence without changing B's | Does not hot-revoke the running app's old bearer |
| Webhook settings | Explicit separate notification directories keep tenant-specific URL/auth selection and work IDs apart | Injected fetch; deployed service has no tenant registry for this composition |

## Reproduced gaps

1. **Notification ledgers are not tenant-partitioned by default.** Two
   `DelegationNotifications` instances using the same root share
   `notifications.json`. If A has a pending failed wakeup, B's sweep encounters
   A's work and fails with `NOT_FOUND`. The internal status method is also
   unscoped. This is not evidence of a public cross-tenant data leak: that
   status method is not an authenticated tenant API in the current service.
2. **A provider await holds the global engine queue.** A pending send for A
   blocks a work read for B until the send completes or times out. The runner
   holds an injected send and observes the unrelated read still blocked after
   five milliseconds; it does not claim a measured production delay or SLA.
3. **Hosted OAuth policy deliberately refuses the second landlord.** The
   existing hosted-demo tenant policy permits the bound client and rejects a
   different client. This is a policy-function check, not an OAuth flow test.
4. **The SMS proof fixes the tenant to `synthetic_host`.** Two separate fixture
   account/number configurations sharing an engine do not bind to landlord A
   and B. Reusing one source message ID merges the work. The test calls trusted
   receive APIs with fictional numbers/injected clients; it does not bypass an
   existing public multi-tenant ingress boundary or demonstrate a real leak.
5. **Profile rotation is separate from MCP token revocation.** After changing
   A's persisted profile credential binding, the old SDK bearer can still read
   A's work through the already-running app's original static binding list.
   Replace/restart the auth binding to change that list. Profile evidence
   invalidation alone is not live token revocation; no foreign tenant access
   was observed.

## Performance observations, not hosting costs

The [resource sampler](../eval/cleaner-phase05/meter.mjs) ran 20, 100 and 300
sequential requests split equally between two tenants. Each request used the
actual save/receive/claim/propose/tick/read lifecycle and a durable local sink.
Every tenth A request deliberately lost its first acknowledgment after local
delivery; idempotent retries reused the same key and kept one reply per work.
It also measured 50 idle cycles over retained completed work, each containing
one engine sweep and two tenant notification sweeps. No network calls occurred.

| Completed requests | Active process CPU seconds | Lifecycle P95 wall ms | Retained physical bytes | Cumulative atomic-write bytes | Idle CPU ms / cycle |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 20 | 0.257 | 17.9 | 48,330 | 2,641,388 | 3.456 |
| 100 | 4.019 | 76.5 | 241,726 | 65,686,280 | 18.277 |
| 300 | 36.169 | 248.9 | 725,616 | 590,910,910 | 53.885 |

These measurements include local JSON/fsync work and controlled immediate
retries. They exclude HTTP/MCP transport, Grok inference, real SMS delivery and
startup. CPU attribution is sequential, not concurrent production billing.
RSS samples are whole-process observations including Node/tsx/dependency and
garbage-collection effects; they are not per-tenant allocated memory or a
continuous peak. Compact per-tenant JSON contributions differ from physical
file sizes. See the [full measurements](../eval/cleaner-phase05/results/resource-sample.json).

Fifteen times as many requests required about 141 times the active CPU and
224 times the written bytes. The 300-request sample wrote about 814 times its
final retained size. Every idle sweep still reads/validates retained history.
The global full-snapshot store cannot be extrapolated as constant work per
message or claimed to meet a production shared-runtime deadline. Resource
samples are performance evidence only; costs and host selection stay deferred.

## Concrete coding work required

1. Resolve tenant and agent from an authenticated grant/credential registry.
   Add scoped landlord administration and grant/rotate/revoke operations.
   Replace the hosted single-client binding with per-tenant OAuth grants;
   check current grant/credential epoch on every request and reconcile revoked
   leases. An agent-supplied tenant ID never selects its authority.
2. Resolve inbound provider account/number to an owned tenant before touching
   business state. Verify the signature with that binding's credential; isolate
   source IDs, properties, turns, SMS status callbacks and recipient selection.
   Provide equivalent isolation for access data. Never inherit the test
   adapter's synthetic identity or one allowed phone pair as product tenancy.
3. Replace global JSON snapshots with indexed, transactional tenant-scoped
   records and a durable outbox. Enforce source-ID uniqueness within tenant and
   provider binding; compare booking versions and leases atomically. Separate
   hot work from retained audit history without discarding idempotency evidence.
4. Partition wakeup state by tenant, work and adapter; enforce scope on status
   reads. Release database/engine critical sections before network awaits.
   Add fair bounded workers, per-tenant rate limits, request/concurrency budgets
   and backoff so one provider/agent cannot block another landlord. Bind retry
   eligibility to the actual delivery adapter: the current sink has one global
   `idempotent` flag, not mixed per-tenant provider guarantees.
5. Run the two-tenant hosted acceptance exercise against real auth/ingress:
   reciprocal negative checks through all reads/writes/admin routes, OAuth
   revocation, credential/number routing, properties/access records, webhook
   retries, late/stale actions, restarts and uncertain provider receipts.
   Use scoped test fixtures; keep the existing Tour Core installation separate.
   Check agent capability freshness and delivery acknowledgments without
   confusing HTTP acceptance with completed work. Do not enable free-form
   agent SMS phrasing or a new decision-model dependency.

The source/test changes above are not implemented here. This session's
environment-onboarding instructions prohibit application-source and test edits;
the standalone helpers exercise existing interfaces. Continue the production
implementation in a normal coding task using `cleaner-core/railway-agent-proof`
and this specification. No new development environment is required for the
existing code/fixtures. Leave the cost-model portion deferred as requested.
