# Phase 0.5 economics validation

Status: cost model implemented and tested; live Grok validation pending.
Measured locally on 12 October 2026. The user authorized 20/100/300 requests per
landlord per month and fleets of 2/10/100 landlords. The original cost deferral
is superseded for this validation; no final hosting choice has been made.

The fleet sampler completed 33,600 distinct synthetic workflows in three shared
runtimes (one per fleet size), with 36,960 injected provider attempts and a
10% lost-first-acknowledgment rate. Nine retained-history checkpoints cover all
requested fleet/tier combinations. Every created workflow completed once with
one simulated receipt and one accepted injected wakeup. Gzip JSONL preserves every raw numeric record; use `gzip -dc FILE` to read it.
Raw per-workflow CPU,
wall time, sampled RSS and per-tenant counts are retained. These are scripted
local engine calls, not live Grok, carrier latency or billed-host measurements.

Sources and calculator:

- `eval/cleaner-phase05/fleet-meter.mts` and `results/fleet-resource-sample.json`
- `results/fleet-2-workflows.jsonl.gz`, `fleet-10-workflows.jsonl.gz`, `fleet-100-workflows.jsonl.gz`
- `src/delegation/phase05/costModel.ts` and `test/cleanerCostModel.test.ts`
- `eval/cleaner-phase05/cost-scenarios.mts` and `results/cost-scenarios.json`
- `docs/evidence/cleaner-phase05-price-sources-2026-10-12.json`

Run `npm run cleaner:phase05:fleet` to regenerate observations and
`npm run cleaner:phase05:costs` to regenerate the model. Arithmetic tests verify
units, included-credit billing, idle CPU, external API invoices, plan floors,
calendar time, cadence, capacity stress and invalid/missing inputs.

## Conditional monthly projections

The reference table below assumes 1 billable GB RAM, a 30-day month, observed
lifecycle/idle CPU, 250ms worker cadence, twelve months of retained history,
two full-copy backup allowances at volume prices, and a conservative 32KiB
protocol allowance per workflow. Required backend inference is zero. Hosting
credits apply once: hosting invoice is max(plan minimum, hosting usage), with
external API invoices added separately. No free trial credits are assumed.

Published Railway container rates were fetched successfully from primary sources:
CPU $0.000463/vCPU/minute, RAM $0.000231/GB/minute, used-volume storage
$0.000003472222222/GB/minute, egress $0.05/GB; Hobby has a $5 account minimum and
Pro a $20 minimum with included usage. References:
https://docs.railway.com/reference/pricing/plans,
https://railway.com/pricing, https://docs.railway.com/reference/volumes.
This is a price reference, not a decision to host the finished product on Railway.

| Landlords | Requests/landlord/month | Hobby reference USD/landlord | Pro reference USD/landlord |
| ---: | ---: | ---: | ---: |
| 2 | 20 | 5.036 | 10.000 |
| 2 | 100 | 5.014 | 10.000 |
| 2 | 300 | 5.019 | 10.000 |
| 10 | 20 | 1.015 | 2.000 |
| 10 | 100 | 1.027 | 2.000 |
| 10 | 300 | 1.036 | 2.000 |
| 100 | 20 | 0.122 | 0.200 |
| 100 | 100 | 0.122 | 0.200 |
| 100 | 300 | 0.131 | 0.200 |

The $5 ceiling is **not universally met at two landlords**: the 1GB Hobby
reference slightly exceeds it and the Pro minimum alone is $10 per landlord.
At 10 and 100 landlords, the baseline scenarios are below the ceiling for all
three tiers. The 0.5GB Hobby case at two landlords is about $2.52–$2.54 each, but
billable memory is an assumption and must be measured after hosting. At 100
landlords, 0.5GB is below the observed sampler RSS and is flagged as inadequate.
Sampled RSS includes the long-lived benchmark process, provider maps, raw rows,
Node/tsx, caches and GC; it is neither private tenant allocation nor the host's
billing measurement. No model input is silently treated as an actual invoice.

There are 324 sensitivity scenarios across 0.5/1/2GB RAM, 1/10/50 CPU multipliers,
12/60-month history and both price references. The model flags cases exceeding
one average CPU, measured RSS assumptions or plan volume limits. Heavy CPU
stress needs capacity validation; a low projected bill does not establish a
single-process throughput guarantee. Retention horizons are forecasts: no
history deletion or backup system was enabled. Backup prices/copies and protocol
bytes are explicit allowances, not measured vendor backup/TLS bills.

Idle CPU matters more than lifecycle CPU at these monthly traffic levels: the
100-landlord final observation used about 32ms per combined idle sweep, which
at 250ms cadence is approximately 0.128 average CPU before active work. Ignoring
idle time would substantially understate compute usage. Native SQLite I/O and
physical file sizes are retained separately; there is no full-history snapshot
write model. Host hardware, cgroup memory/cache accounting, real traffic,
retention growth, logging and paid external integrations can change the bill.

Landlord-owned agent subscriptions, SMS numbers/carrier fees and door hardware
remain outside the engine target as the roadmap specifies. A hypothetical paid
Grok API sensitivity uses the public `x-ai/grok-4.7` catalog ($2/M input tokens,
$6/M output tokens), 4,000 input + 1,000 output tokens and three calls per request:
$0.042/workflow. That would add $12.60/landlord at 300 requests/month and fail the
ceiling. No such backend integration or paid inference call was made. Actual
Grok-account reasoning usage is not available from this workspace.

## Live proof and closure status

The same existing Cleaner Core URL can host both tenants. The optional
`CLEANER_TEST_RUNTIME=phase05` entrypoint has been prepared and locally tested;
it keeps the previous proof ledgers and uses only indexed simulated receipts.
The account-side packet is `docs/cleaner-phase05-live-grok-packet.md`.

No deployment occurred during cost measurements. The publicly observed existing
endpoint reported the earlier `cleaner-core-test` / `sms-proof` service. That
health response establishes reachability only, not execution of this branch.
The workspace has GitHub access but no Railway deployment credential or Grok
account binding. The user will run the account-side packet after the existing
test service is updated. Costs are conditional tested models; live two-tenant
Grok completion is **pending**, not inferred from HTTP acceptance, old reports,
OpenRouter availability or local scripted clients. Phase 0.5 cannot be marked
fully closed until those fresh account-side results are reconciled.
