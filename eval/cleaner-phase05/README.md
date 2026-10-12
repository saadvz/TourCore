# Phase 0.5 validation

The [local implementation report](../../docs/cleaner-phase05-implementation.md)
describes the indexed two-tenant runtime and its 27 new acceptance tests.
Run `npm run cleaner:phase05:demo` for its loopback HTTP/OAuth/MCP demonstration
or `npm run cleaner:phase05:measure` for the indexed resource sampler.
`results/multitenant-tests.json`, `results/multitenant-demo.json` and
`results/indexed-resource-sample.json` record the new evidence. The historical
runner and raw JSON-store measurements below remain available.

## Historical existing-core proof

These are standalone validation helpers for the existing delegation components.
They do not implement a multi-tenant hosted product or change application source,
tests, dependencies, runtime settings, live Grok routines or the Railway service.
Hosting costs/price forecasts are deferred by the user; resource sampling is
performance evidence only.

From `/workspace/TourCore`, with the existing Node dependencies:

```sh
node --import tsx eval/cleaner-phase05/isolation.mjs /tmp/cleaner-isolation.json
node --import tsx eval/cleaner-phase05/meter.mjs /tmp/cleaner-resources.json
npm test -- test/delegationPrototype.test.ts test/delegationNotifications.test.ts test/delegationSmsProof.test.ts test/agentProfiles.test.ts test/agentProfileService.test.ts --maxWorkers=2 --testTimeout=30000
```

The first command starts one temporary loopback MCP server, connects two actual
scripted SDK clients with independent synthetic tenant tokens, checks existing
scope/recovery behavior, records known integration gaps, then closes clients and
server. Fixture records, nonces and tokens are destroyed afterward. No real
Grok, provider, booking or access operation is performed. Run reports expose
sanitized results only. Known gaps are distinct from unexpected failures; an
unexpected failure returns a nonzero exit status, so do not equate exit zero
with production readiness.

The sampler creates 20/100/300-request sequential fixture stores, tracing actual
CPU deltas, sampled RSS, physical file sizes and write/fsync activity. It includes
controlled lost acknowledgments and 50 idle engine/notification cycles. It
temporarily instruments Node fs functions only for that process's temporary
fixture files, then restores them and deletes those stores. It makes no network
calls. Run it alone for useful timing observations; results vary by machine and
do not include agent/transport/carrier latency or concurrent tenant billing.

The five existing suites passed 60 tests. The standalone isolation result is
15 passed diagnostic groups and five known gaps, with no unexpected failures.
The [proof/specification](../../docs/cleaner-tenant-isolation-proof.md) describes
limits and the application changes needed for a real two-landlord runtime.
Use a new output path to preserve the measured reports in `results/`.

## Economics and live closure

`npm run cleaner:phase05:fleet` measures the 2/10/100-landlord and 20/100/300-request
combinations. `npm run cleaner:phase05:costs` computes price-reference scenarios.
Raw per-workflow files and `results/cost-scenarios.json` are retained.
See `docs/cleaner-phase05-economics.md` and the same-endpoint account packet in
`docs/cleaner-phase05-live-grok-packet.md`. Live execution remains pending.
