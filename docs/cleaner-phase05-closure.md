# Cleaner Core Phase 0.5 closure

Status: **complete as the synthetic two-tenant proof**, 12 October 2026.
The implementation, isolation suite and conditional low/medium/high cost model
are delivered. Live Grok ordinary execution, controlled faults and post-restart
recovery are reconciled from account-exported records. Restoration A completed
with fresh evidence, and the owner retrospectively confirmed its whole closed
window. `productionReady=false` remains explicit. This is the Phase 0.5 proof
scope; real SMS/access, production hosting and broader cleaner workflows remain
later work.

The user's implementation request and final model decision govern scope; the
attached roadmap is background. Grok remains the first optional agent client,
with an agent-agnostic contract and engine-owned fallback. Scheduling, access
policy, recipients and reply templates remain deterministic. No inference
stack, production model generator, AWS migration or new paid provider was added.

## Delivered evidence

| Requirement | Result and evidence scope |
| --- | --- |
| Two tenants in one runtime | Local actual HTTP/MCP demo and hosted A/B runs share one runtime and `/mcp` URL; authenticated grants select authority. Same source IDs produce different tenant work IDs. |
| MCP/owner/OAuth/ingress/storage isolation | Reciprocal actual local transport tests, hosted native controls/denials, owner routes, synthetic signed ingress and isolated property/access records. Native credential errors and raw HTTP statuses are distinguished. |
| Indexed transactions and outbox | SQLite tenant keys/indexes, source deduplication, transactional decisions/replies/audits and short critical sections. Provider awaits use independent tenant lanes with rate/concurrency limits. |
| Grant/profile/lease revocation | Main A retirement clears capability evidence and active leases, old-epoch workflow re-attestation fails and B stays unchanged. Revoking any grant retires that entire tenant/agent, including its other live grants. |
| Deadlines, lease expiry, stale actions and stable keys | Lease expiry observed 57,334ms before deadline, old lease and stale version rejected, action conflict rejected, exact replay changes no exported values. Two forced requests receive one deterministic fallback each. |
| Restart and retry/uncertainty | One owner-confirmed test-service restart; five saved work replays, storage and grant controls persist. Local injected-provider/SDK and process-kill tests cover retry eligibility, uncertain outcomes and expired send leases. |
| Grok autonomous ordinary execution | A 10/10 and B 10/10 reconcile to completed agent decisions before deadlines, one simulated receipt each, no fallback/review/duplicates. Original owner-confirmed closed windows retained. |
| Resource/cost model | Raw indexed/fleet observations retained; 20/100/300 monthly requests and 2/10/100 landlord fleets modeled with tested arithmetic. Shared container/Podman Quadlet design is recorded; projections are conditional, not actual host invoices or customer demand. |

All 51 relevant local tests passed at the recorded source revision, along with
typecheck and bundling. The empty-profile timestamp correction is tested locally
and published on the review branch; it is **not deployed**. Neither the full
repository suite nor all integrations are claimed green. Earlier baseline
failures remain recorded. Raw resource samples were not regenerated or relabeled
as billed-host or live-Grok resource measurements.

## Live accounting and restoration

| Stage | Result |
| --- | --- |
| A onboarding | One created trial, one reconciled success. |
| B onboarding | Two created trials, one initial late-setup failure and one explicit successful server-clock retry. |
| Ordinary A/B | Twenty planned/accepted/fired/created trials, twenty on-time agent completions. |
| Security matrix | 76 rows: 71 marked PASS, three native failures with underlying HTTP status inferred, one browser UI check NOT_RUN and missing trace IDs. |
| Final fault/recovery matrix | 61 rows: 56 PASS, one restoration FAIL, two MISSING and two NOT_RUN. These rows overlap earlier stages and are not a grand total of independent tests. |
| Restoration | Two accepted schedules: initial UNAUTHORIZED/no work created; authorized single retry creates one work and succeeds. The failure remains recorded. |

Ordinary engine median/P95 are 19.446/31.604 seconds for A and
20.2885/35.691 seconds for B. At ten samples, nearest-rank P95 is the maximum.
The twenty-sample combined median/P95 is 19.6735/31.604 seconds. Onboarding,
forced faults and manual replay tests are excluded; this establishes no
production latency SLA.

The first restoration schedule failed authorization at fire time and created
no work. The account reports accidentally minting then revoking an extra A
grant, which matches the deliberately agent-wide retirement semantics. The
actual extra revoke call was not exported, so the specific causal attribution
remains account-reported. Two rejected INVALID_INPUT mint calls and wrong-path
404 reads are also retained. Failure to create work establishes safe rejection,
not a successful onboarding.

The authorized retry `p05_s10121857_restore_onboard_retry` fired at
19:37:53.601 EDT, producing `work_9f5dbc97def60de4fcfbc9cd7b4dd77e`.
Engine receipt was 19:37:53.595, claim 19:38:07.996, validated decision
19:38:12.120 and provider acceptance/completion 19:38:12.236. Completion took
18,641ms with 101,359ms left before the stored deadline. Exactly one simulated
receipt went to `synthetic_cleaner_A`; there were no carrier events or doors.
The receiver's interim phone-text guess is contradicted by the synthetic
engine evidence and was corrected in the final account report.

A's notification epoch is now 4, with a new MCP probe and work-linked background
evidence expiring the next day. Verification returned HTTP 200; the final
profile is autonomous with no missing requirements for this scoped workflow.
B's exported profile equals the pre-restart baseline. Backend verification was
called during the closed window using the advance promise; the owner confirmed
**afterward in this thread** that Grok stayed closed throughout 19:32:53–19:40:54
EDT. That distinction is retained in the provenance record. No rerun is needed.

The final report's `aStillCleared=true`, connector label `(cleared)` and initial
`onboardingSchedule` are stale summary fields. The final r9 schedule, engine
record and full profile supply the reconciled successful state. Native resource
`profile.grants` lists are not the OAuth bearer registry and do not prove token
validity. The final export additionally had one private grant identifier
redacted before publication; original and published source hashes are recorded.

## Limits carried forward

- All recipients/providers/access data are synthetic. Provider acceptance is
  distinct from phone delivery. No real SMS, carrier delivery or door operation
  was performed.
- Native bridge errors expose `/register` HTTP 404 or connection closure;
  that is not the MCP endpoint's observed status. Post-restart A7/A8 HTTP 401s
  and 19:23 EDT timing are account-reported; the exported UNAUTHORIZED bodies
  lack numeric status/time wrappers. Local actual HTTP tests separately prove
  revoked-grant enforcement across persistent restart.
- Earlier original native/refresh/revoke response files, native per-call trace
  IDs and a global scheduled-job listing remain missing. A tenantId-added live
  calls and a separate revoke-fixture pre-claim read were not run; the local
  transport suite covers schema rejection and authority binding. No successful
  browser OAuth consent/discovery UI is claimed.
- Owner turn updates are reflected in stored versions but have no separate
  audit entry. Work/lease/action/reply audit records remain tenant-bound. The
  proof does not claim complete owner CRUD auditing.
- Hosted send faults and natural 24-hour capability expiry were not forced.
  Local injected-provider/clock/process-crash tests establish those behaviors;
  no real provider's idempotency/delivery guarantees are inferred from the
  simulator.
- Hosting restart control/configuration was owner-confirmed, not inspected
  through Railway credentials here. Existing deployed revision/volume/variables
  and unrelated Tour Core routines/providers were not changed by this workspace.
- Cost projections use synthetic measurements and stated shared-host assumptions.
  Live billed infrastructure, actual customer demand and Grok per-request account
  spend remain unmeasured; no hosting choice or production economics guarantee
  is made.

## Reproduce the reconciliation

```sh
node eval/cleaner-phase05/reconcile-live.mjs
node eval/cleaner-phase05/reconcile-fault.mjs
node eval/cleaner-phase05/reconcile-recovery.mjs
```

These commands verify uploaded records and hashes without contacting the host,
Grok or providers. Historical pre-restart snapshots remain unchanged. The latest
records are [closure evidence](evidence/cleaner-phase05-closure-2026-10-12.json),
[final recovery reconciliation](evidence/cleaner-phase05-recovery-final-reconciled-2026-10-12.json)
and [provenance/owner confirmation](evidence/cleaner-phase05-recovery-provenance-2026-10-12.json).
