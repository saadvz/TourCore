# Separate Phase 0.6 lab in the existing Railway project

The owner selected a **new, separate service in the existing Railway project**.
Use `cleaner-phase06-lab`; leave `tour-core` and the Phase 0.5 synthetic service
on their existing branches, settings, volumes and routines. No new Railway
project or inference provider is needed.

This concrete configuration has not been applied to Railway. The workspace has
no Railway token or connected Railway plugin yet. Once Railway is connected,
select the actual existing project/environment and create only the lab service
and its dedicated volume. Do not apply the main `.railway/railway.ts` definition
to achieve this: that file describes touring.

## Service settings

| Setting | Value |
| --- | --- |
| Name | `cleaner-phase06-lab` |
| GitHub source | `saadvz/TourCore` |
| Branch | `cleaner-core/phase06-integrations` |
| Root directory | Repository root |
| Dockerfile | `Dockerfile.cleaner-phase06` |
| `RAILWAY_DOCKERFILE_PATH` | `Dockerfile.cleaner-phase06` |
| Build/start overrides | Leave unset; use the dedicated Dockerfile's build and CMD |
| CMD | `node dist/cleaner-phase06.js lab --live` |
| Healthcheck | `/healthz`, timeout 120 seconds |
| Replica count | One |
| Volume | New `cleaner-phase06-data`, mounted at `/data`; never reuse the touring/Phase 0.5 volume |
| Public networking | Generate a Railway HTTPS domain for the lab's listening port |
| `RAILWAY_RUN_UID` | `0`, so the lab can create private files on Railway's root-owned volume |
| `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` | `0` |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `15`, allowing bounded send/shutdown and lock cleanup to finish |
| `CLEANER_PHASE06_HOME` | `/data/phase06` |
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
Twilio probe results and ensure the lab is healthy on its new volume. Only then
route the dedicated test line's effective POST webhook to:

```text
https://LAB_DOMAIN/phase06/twilio/test/inbound
```

The phone owner sends `CLEANER CORE TEST` once during the joint test. Follow the
runbook for response/carrier evidence, STOP/START, a graceful restart and cleanup.
After a forced kill, a stale `lab.lock` can require explicit recovery after the
old process is confirmed stopped; never clear SQLite evidence or opt-out state
to get the lab running. No live SMS has been sent by this setup work.

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

The optional `proxy_ca` build secret supports the managed development proxy.
It is mounted only for npm's build steps and is not copied into image layers.
Railway can build without that session-specific secret using normal TLS trust.
