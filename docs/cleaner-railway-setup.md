# Cleaner Core temporary Railway service

Deploy a new service from `saadvz/TourCore`, branch
`cleaner-core/railway-agent-proof`. This branch contains the isolated delegation
test service. Its replies are simulated and it has no Guesty or SMS provider.
The existing touring application's default build and startup are unchanged.

## Railway settings

1. Create a new Railway project or a new, separate service. Connect the GitHub
   repository, select `cleaner-core/railway-agent-proof`, and name the service
   `cleaner-core-test`. If Railway immediately builds the default app, wait to
   treat it as usable until the settings below are saved and redeployed.
2. Let Railway detect the root `Dockerfile` on this test branch. If a builder
   override is set, select the Dockerfile builder instead of Railpack. Both the
   root `Dockerfile` and `RAILWAY_DOCKERFILE_PATH=Dockerfile.cleaner-test` build
   this same isolated service. Clear the custom build command (`npm run build`)
   and custom start command (`npm run start`/`npm start`); the Dockerfile's
   entrypoint must control startup.
3. Add a dedicated persistent volume mounted at `/data`. Use one replica.
   The container refuses startup without the volume. Never attach Tour Core's
   existing volume to this test service.
4. In Railway's service variables, save two different random secrets, each
   at least 32 characters long, generated using your password manager:
   `CLEANER_TEST_AGENT_TOKEN` and `CLEANER_TEST_ADMIN_TOKEN`.
   Save the values privately; never paste them into chat. The agent token is
   for the Grok connector. Keep the administrator token for test injection
   and evidence retrieval. Both are required; neither is logged.
5. Generate a public domain under the service's Networking settings. If a target
   port is requested, use 8080 and set `PORT=8080`. The service also accepts a
   different Railway-provided `PORT`. Railway's `RAILWAY_PUBLIC_DOMAIN` supplies
   the public hostname automatically. For a custom domain, explicitly set
   `CLEANER_TEST_PUBLIC_URL=https://YOUR_HOSTNAME` to its HTTPS origin.
6. Set the healthcheck path to `/healthz`, turn off sleeping/app suspension for
   this asynchronous test, and redeploy after all settings are saved.
   Leave the deployment replicas at one.
7. Open `https://YOUR_HOSTNAME/healthz`. A ready service returns:

   ```json
   { "service": "cleaner-core-test", "mode": "synthetic", "ready": true }
   ```

   Share the public domain and non-secret deployment result with Codex. A
   successful health check verifies the test service, not a live Grok run.

## Connect Grok

The connector URL is `https://YOUR_HOSTNAME/mcp`. Configure bearer
authentication through the supported masked field, using the agent token.
If it asks for a header, the name is `Authorization` and the value is
`Bearer YOUR_AGENT_TOKEN`. Do not send either actual token here.

After connection Grok must list these tools:

- `list_delegated_work`
- `read_delegated_work`
- `claim_delegated_work`
- `propose_cleaning_time`

OAuth is not implemented by this prototype. The user's Grok account reports
support for static bearer/header authentication; the actual connector setup
still needs to be verified. The existing Tour Core connector does not expose
these prototype tools.

## Container behavior and limits

The Docker build bundles only the Cleaner Core test entrypoint and its local
storage helper. Its final image has production dependencies. Docker excludes
local secrets, runtime state, and exports from the build context.
The deployment Dockerfiles use ordinary `RUN` steps with no mount flags.
Railway's cache mounts require a service-specific ID, so this portable test
build uses standard npm installation instead. Workspace proxy preparation
must stay outside the deployment Dockerfiles.

The entrypoint requires `/data` to be a mount point and writes to
`/data/cleaner-core-test`. `flock` enforces a single writer and automatically
releases the lock when the container exits or is killed. This permits crash
restarts without deleting saved work or a stale process-marker file. Do not
run the local CLI concurrently against this container's storage directory;
use the container entrypoint for every process sharing this volume.

Public HTTP access still checks the configured hostname and bearer token.
Railway's `healthcheck.railway.app` hostname is accepted when the Railway
environment is detected. Secrets are supplied through Railway variables,
not included in the image, and are never printed by the application.

The service is a single-process development prototype. It still needs an
outbound webhook notification adapter and a dedicated Grok test routine before
the unattended delegation trial. Do not inject a test request until that
setup is ready: its agent deadline starts immediately and lasts two minutes.
There are no real SMS sends or production cleaning operations in this test.

Verified locally on 11 October 2026: Docker image build, required-volume guard,
Railway-style port/domain/healthcheck handling, concurrent writer exclusion,
pending-work recovery after a forced container kill, authenticated SDK MCP
tool discovery and claim/proposal completion, and reply deduplication. Typecheck
and all 20 delegation/service tests passed. The agent in this container check
was scripted; actual Railway deployment and live Grok execution are pending.

## If Railway returns 502

Check the deployment's runtime and build logs. `using build driver railpack`,
`npm run start`, `node dist/server.js`, and `Tour Core setup is running` identify
the original touring build, not the Cleaner Core container. Confirm the source
branch, choose the Dockerfile build, clear custom commands, and deploy the latest
commit. The correct startup log includes
`Cleaner Core synthetic test service ready on 0.0.0.0:8080` when `PORT=8080`.
Keep the domain's target port at 8080. Changing it to 4321 would route to the
original app rather than fix the deployment selection.

If the correct container starts and then exits, its startup diagnostics name
missing/short token variables, matching token values, invalid HTTPS origins,
or unreadable stored data without printing credential values. Public startup
requires both token variables to be present, different, and at least 32
characters long. A successful build and mounted volume alone do not satisfy
those credential requirements.

## Optional Docker workflow

If using an image registry instead of Railway's GitHub source build:

```sh
docker build -f Dockerfile.cleaner-test -t YOUR_REGISTRY/cleaner-core-test:proof .
docker push YOUR_REGISTRY/cleaner-core-test:proof
```

Configure Railway to pull that image and use the same volume, variables,
domain, healthcheck, and single replica. Publishing an image requires access
to your chosen registry. The GitHub source route avoids that extra setup.
