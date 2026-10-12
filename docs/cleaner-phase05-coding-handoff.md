# Continue Phase 0.5 implementation

Closure update: [Phase 0.5 proof is complete](cleaner-phase05-closure.md), including
reconciled ordinary/recovery/restoration evidence and tested conditional cost
models, with explicit limits. This implementation brief is historical.

Implementation update: the [local two-tenant runtime and acceptance results](cleaner-phase05-implementation.md)
are now implemented on `cleaner-core/phase05-multitenant`. The copied request below
is preserved as the historical implementation brief; the latest user request authorizes economics and live Grok testing. See
[closure progress](cleaner-phase05-economics.md); the original copied request is historical.

The existing-core proof and concrete gaps are in
[cleaner-tenant-isolation-proof.md](cleaner-tenant-isolation-proof.md).
The setup-only session produced 15 passing diagnostic groups, five known gaps,
resource observations and 60 passing existing tests. It did not change the
application or implement the two-landlord hosted service. Hosting/cost analysis
is deferred by explicit user instruction, not blocked on a Railway invoice.

Use the same development environment and repository in a normal coding task.
Copy this request:

```text
Continue Cleaner Core Phase 0.5 as an implementation task, not environment
onboarding. Use /workspace/TourCore and read:
- docs/cleaner-tenant-isolation-proof.md
- docs/cleaner-model-evaluation.md (final architecture decision)
- docs/cleaner-engine-agent-contract.md

Create cleaner-core/phase05-multitenant from cleaner-core/railway-agent-proof
in the existing checkout. No additional worktree/environment is needed.
Application-source and test changes are part of this implementation request.

Build a working isolated two-tenant demonstration in one runtime. Keep rules,
scheduling constraints, access policies and reply templates deterministic.
Prioritize Grok as the first agent client with engine-owned fallback; retain
an agent-agnostic contract. Do not integrate a new inference stack. Perplexity
remains optional evaluation; do not integrate Microsoft, tested small D3
variants or Qwen as a production SMS generator.

Resolve authenticated tenant/agent grants for every MCP and owner operation;
add tenant-scoped OAuth/grant issuance and revocation. Bind provider credentials,
numbers, source events, properties, access records, replies and audits to that
tenant. Never let agent/body tenant fields choose authority.

Fix the shared notification-ledger conflict and profile-versus-MCP revocation
gap. Replace full global snapshots with appropriate indexed transactional
records and an outbox. Keep provider awaits outside global critical sections,
enforce fair per-tenant rate/concurrency limits, and handle retry eligibility
according to each provider's actual guarantees. Preserve version/lease checks,
source deduplication, stable action keys, deadlines and uncertain-send review.

Prove both directions of tenant isolation through actual transport, OAuth,
owner routes, provider ingress and storage, plus restart/retry/lease-expiry/
stale-action/capability-freshness behavior. Use synthetic tenants and injected
providers first. Report pass/fail/known limitations precisely. Do not mistake
HTTP acceptance for agent completion or provider acceptance for phone delivery.

Leave hosting selection, prices and cost modelling out for now. Preserve raw
resource observations as performance evidence. Do not change the current
Tour Core installation, existing Grok routines/connector, Railway deployment
or real provider configuration; do not send real SMS or operate doors.
Complete and test the local implementation before proposing deployment work.
```
