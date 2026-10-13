# Phase 0.6 lab on the existing Railway test service

The owner's latest instruction is to **edit the existing Railway project and
point the existing Cleaner Core test service at a different branch if needed**.
Reuse that test service and its existing volume/domain. Inspect the actual
project, service and current settings before applying the change; do not create
a new project or automatically select the live touring service. The earlier
proposal for a new lab service is superseded by this instruction.

This concrete configuration has not been applied to Railway. The Railway
plugin and account access are now available. The selected existing project is
`zucchini-endurance`, test service `TourCore`, with its domain
`tourcore-production-72ec.up.railway.app` and volume at `/data`. Save the test service's
branch, Dockerfile/start command and routing settings, then apply only the
test-service changes below. Do not apply the main `.railway/railway.ts`
definition to achieve this: that file describes touring.

## Service settings

| Setting | Value |
| --- | --- |
| Service | Existing Cleaner Core test service, retain its name |
| GitHub source | `saadvz/TourCore` |
| Branch | `cleaner-core/phase06-integrations` |
| Root directory | Repository root |
| Dockerfile | `Dockerfile.cleaner-phase06` |
| `RAILWAY_DOCKERFILE_PATH` | `Dockerfile.cleaner-phase06` |
| Build/start overrides | Leave unset; use the dedicated Dockerfile's build and CMD |
| CMD | `node dist/cleaner-phase06.js lab --live` |
| Healthcheck | `/healthz`, timeout 120 seconds |
| Replica count | One |
| Volume | Existing test-service volume; use a new Phase 0.6 subdirectory without modifying earlier records |
| Public networking | Reuse the existing test-service domain and match its target port to the lab's listening port |
| `RAILWAY_RUN_UID` | `0`, so the lab can create private files on Railway's root-owned volume |
| `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` | `0` |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `15`, allowing bounded send/shutdown and lock cleanup to finish |
| `CLEANER_PHASE06_PREFLIGHT_ON_START` | `true`: bounded read-only Twilio checks are logged without credentials/phones |
| `CLEANER_PHASE06_EVIDENCE_LOGGING` | `true`: controlled-lab evidence changes are recorded in private Railway logs without phone numbers, text bodies or credentials |
| `CLEANER_PHASE06_HOME` | `/data/phase06` if the existing test volume mounts at `/data`; otherwise a new `phase06` folder under its actual mount |
| `CLEANER_PHASE06_HOST` | `0.0.0.0` |
| `CLEANER_PHASE06_PORT` | Leave unset to use Railway's `PORT`; the lab falls back to 4336 outside Railway |
| `CLEANER_PHASE06_PUBLIC_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}`, or the exact generated HTTPS origin |

Select the custom Dockerfile before the first usable deployment: the repository
also contains the touring Dockerfile. The public domain must reach the port
used by `PORT`. The healthcheck shows `productionReady=false` for this lab.

## Secure configuration and first live message

Add the dedicated Twilio, owner-token, test-phone and consent settings from the
[live runbook](cleaner-phase06-live-twilio.md) through Railway's secure Variables
page or supported secret references. Do not paste keys into chat. Do not copy
all touring variables or OAuth/agent grants into the lab. If an existing test
service already holds the exact dedicated Twilio credentials, use explicit
Railway reference variables for those particular settings instead of exposing
their values. Confirm the sender/test-phone pairing and approved cleaner use case.

Deployment and `/healthz` alone send no message. First inspect the read-only
Twilio probe results and ensure the lab is healthy on its isolated data path. Only then
route the dedicated test line's effective POST webhook to:

```text
https://LAB_DOMAIN/phase06/twilio/test/inbound
```

The phone owner sends `CLEANER CORE TEST` once during the joint test. Follow the
runbook for response/carrier evidence, STOP/START, a graceful restart and cleanup.
After a forced kill, a stale `lab.lock` can require explicit recovery after the
old process is confirmed stopped; never clear SQLite evidence or opt-out state
to get the lab running. No live SMS has been sent by this setup work.

Switching the test service to the lab CMD replaces the earlier Phase 0.5 test
endpoints while retaining their stored records. Save the original configuration
for rollback; restoring it should not delete either phase's records. A source
branch change alone does not enable the lab if the service still uses its
earlier start command or the main touring Dockerfile.

## Provider references

The local Docker build and smoke passed using synthetic credentials and a fresh
root-owned bind volume: the assigned `PORT` was used, a signed STOP was stored,
and graceful stop/start preserved opt-out while releasing the process lock.
There were zero replies and zero real Twilio requests. Typecheck and all 24
focused checks pass after the port change. See the
[container validation record](evidence/cleaner-phase06-railway-validation.json).
The original [implementation validation](evidence/cleaner-phase06-validation.json)
remains the earlier snapshot; its source hashes do not describe this port/build
follow-up. No Railway deployment, forced-kill lock recovery or live phone
delivery is claimed by the container smoke.

- [Custom Dockerfile selection](https://docs.railway.com/builds/dockerfiles).
- [Volume mounting and root permissions](https://docs.railway.com/volumes).
- [PORT and healthchecks](https://docs.railway.com/deployments/healthchecks).
- [UID and shutdown/draining settings](https://docs.railway.com/variables/reference).

The deployed Dockerfile uses normal TLS trust with npm's strict verification
enabled. Railway's Dockerfile parser rejects secret mounts, including optional
ones. Managed local builds that need a development proxy CA must use a temporary
Dockerfile with the CA mounted only during npm steps; do not commit that session
configuration or copy its CA into image layers.
