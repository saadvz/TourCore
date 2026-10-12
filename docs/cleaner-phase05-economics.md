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
- `docs/evidence/cleaner-phase05-quadlet-cost-sources-2026-10-12.json`

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

## Proposed shared-container hosting design

Recorded at the user's request on 12 October 2026. Continue live testing on the
existing Railway Cleaner Core test service. The proposed future hosting design
is a shared Linux EC2 host running Podman containers managed by systemd Quadlets;
no AWS migration, Quadlet installation or hosting change has occurred.

Landlords share infrastructure. Neither the existing Railway projections nor
this design allocate an EC2 instance to each landlord. Start with one
multi-tenant Cleaner Core engine container, a separate HTTPS proxy container
(for example Caddy), a private container network and durable storage mounted
into the engine. Keep engine-owned rules, scheduling, access policy, templates,
outbox, leases, deadlines and deterministic fallback. Grok remains the external
first agent client under the agent-agnostic contract; no new inference stack is
part of this design.

Quadlets describe containers, networks and volumes as files from which Podman
generates systemd services. They support boot startup, restart policies, health
checks, dependencies, journald logs, rootless operation and resource controls;
they require systemd and cgroup v2. Use a supported, pinned Podman version and
versioned Quadlet definitions with digest-pinned images and controlled releases.
Prefer rootless application containers, with an explicit arrangement for the
HTTPS listener. The current OCI image recipe is a starting point, not proof of
Podman/rootless compatibility: build, mounted-volume permissions, startup lock,
health, graceful shutdown, reboot and recovery must be tested before deployment.

Authenticated tenant/agent grants remain the authority boundary inside the
shared engine. Container isolation does not replace tenant-scoped storage,
provider bindings, owner policies or revocation checks. Dedicated tenant
containers are a possible later isolation choice, and several could share a
host, but each process adds memory and operational overhead; that is not the
current two-tenant, one-runtime design.

AWS bills provisioned host capacity, allocated storage and networking rather
than tenant or container counts. The following **infrastructure baselines** use
one continuously running Linux On-Demand instance in US East (N. Virginia),
720 hours, an assumed 10GB gp3 volume at $0.08/GB-month and one public IPv4
address at $0.005/hour. The gp3 rate is a budget assumption from AWS's published
pricing example, not an account quote. Podman and Quadlets add no licence fee.

| Shared host | Compute USD/month | Storage + IPv4 USD/month | Shared baseline USD/month | USD/landlord at 2 | At 10 | At 100 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| t3.micro, 1GiB RAM, $0.0104/hour | 7.488 | 4.400 | 11.888 | 5.944 | 1.189 | 0.119 |
| t3.small, 2GiB RAM, $0.0209/hour | 15.048 | 4.400 | 19.448 | 9.724 | 1.945 | 0.194 |

Formula: `shared baseline = hourly instance price * 720 + 10 * 0.08 + 0.005 * 720`;
divide that total by the landlord count once. Do not multiply the host cost by
the number of engine/proxy containers or landlords. Conditional on capacity,
the same fixed baseline applies to the 20/100/300 request tiers. Ancillary costs
still vary with traffic and retained history.

These figures exclude backups, DNS, logs, image registry/S3, internet transfer,
CPU-credit overages, tax and external provider charges. The earlier Railway
model includes a backup allowance, so the table is not a complete comparison
of equivalent operating bills. A proxy on the host could avoid a paid AWS load
balancer for the initial single-host setup; an ALB adds its own hourly,
traffic and public-address charges. Private-subnet NAT is a separate topology
choice with additional charges, not a requirement of Quadlets. Free-tier
credits, reserved pricing and savings plans are not assumed.

Use the 2GiB host as the initial budget reference, not a validated capacity
selection. Preserve the existing raw local resource observations; do not
relabel them as EC2/Podman measurements. OS/proxy memory, bursts, TLS, image
storage, journald limits and real hosted CPU must be observed before sizing.
The T3 sustained CPU baseline and possible Unlimited credit charges need
validation on the chosen host. At two landlords both listed infrastructure
baselines exceed $5 each; at ten and one hundred they are below it before
ancillary costs. The target is therefore conditional, not universally passed.

For SQLite, keep exactly one writer/runtime using the persistent database and
outbox. An EBS-backed volume and stable mount path must have explicit
attachment, deletion protection, backup/restore and host-replacement procedures.
A Podman named volume alone does not survive losing its underlying host/disk.
Quadlets restart services on one host; they do not provide cluster scheduling,
cross-host failover or database replication. Scaling to multiple active engine
instances requires a shared transactional database and validated coordination;
its costs and implementation are outside this single-host baseline.

Public references and source hashes are retained in the Quadlet cost-source
record linked above. Ubiquiti's current self-hosting documentation confirms
systemd/Podman requirements; it is an analogy, not evidence that Cleaner Core
has reproduced UniFi's implementation.

## Live proof and closure status

The same existing Cleaner Core URL can host both tenants. The optional
`CLEANER_TEST_RUNTIME=phase05` entrypoint has been prepared and locally tested;
it keeps the previous proof ledgers and uses only indexed simulated receipts.
The account-side packet is `docs/cleaner-phase05-live-grok-packet.md`.

The user confirmed that Railway remains the live test host while the proposed
Quadlet design is recorded for future hosting. At 2026-10-12 17:40:02 UTC,
GET `/healthz` on that same existing URL returned HTTP 200 and
`{"service":"cleaner-core-test","mode":"sms-proof","ready":true}`.
This is still the earlier runtime; it is not Phase 0.5 live completion.
The sanitized observation is retained in
`docs/evidence/cleaner-phase05-live-status-2026-10-12.json`.

No deployment occurred during cost measurements. The publicly observed existing
endpoint reported the earlier `cleaner-core-test` / `sms-proof` service. That
health response establishes reachability only, not execution of this branch.
The workspace has GitHub access but no Railway deployment credential or Grok
account binding. The user will run the account-side packet after the existing
test service is updated. Costs are conditional tested models; live two-tenant
Grok completion is **pending**, not inferred from HTTP acceptance, old reports,
OpenRouter availability or local scripted clients. Phase 0.5 cannot be marked
fully closed until those fresh account-side results are reconciled.
