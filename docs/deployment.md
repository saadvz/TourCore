# Deploying Tour Core

Tour Core is the system of record and the policy authority. Grok is the
installer and the operator console. This document describes how a Tour Core
installation is deployed, set up and kept running, and what is (and isn't)
automated.

```
Grok cloud computer
   │  installs / runs / repairs  (npm run bootstrap:grok, npm run service:*)
   ▼
Tour Core runtime (src/web/server.ts)
   ├── public https address (Cloudflare quick tunnel in P0, or a stable URL)
   │     ├── /mcp                 Grok's OAuth MCP connection (operator + installation tools)
   │     ├── /webhooks/sendblue   visitor texts
   │     ├── /verify/<token>      identity form
   │     └── /healthz             "is this Tour Core?" (fingerprint only)
   ├── this computer only
   │     ├── /install             secure setup page (credentials go in here)
   │     ├── /grok                approve Grok's connection
   │     └── /                    browser operator app
   ├── outbound → Grok Routine webhook (operator alerts, durable outbox)
   ▼
Tour Core state, policy and audit (tourcore-data/)
```

No Tour Core business logic lives in Grok's instructions. Grok decides nothing
about installation order, readiness or access: it reads Tour Core's
installation status and follows its next step.

## Deployment modes

| Mode | Where Tour Core runs | Who sets it up | Public address |
| --- | --- | --- | --- |
| `GROK_MANAGED_P0` | Grok's own cloud computer | Grok, with `npm run bootstrap:grok` | Cloudflare quick tunnel (temporary) or a URL Grok is given |
| `SELF_HOSTED` | A server you run, at a stable https URL | You deploy; Grok only connects and configures | `PUBLIC_BASE_URL` |
| `LOCAL_DEVELOPER` (default) | A developer's computer | `npm run setup`, `.env`, a manual tunnel | `PUBLIC_BASE_URL` |

The mode is resolved from `TOURCORE_DEPLOYMENT_MODE`, then the installation
manifest, then `LOCAL_DEVELOPER` (`src/install/deployment.ts`). It changes how
Tour Core is installed and reached, never a tour, policy or access rule.

**`GROK_MANAGED_P0` is a demo deployment.** Tour Core runs as long as Grok's
cloud computer does, and the quick-tunnel address changes whenever the tunnel
restarts. It is not the recommended way to host Tour Core around the clock.

## The installation manifest

`tourcore-data/install/manifest.json` (`src/install/manifest.ts`), versioned
and non-secret:

```json
{
  "schemaVersion": 1,
  "deploymentMode": "GROK_MANAGED_P0",
  "installationId": "inst_...",
  "publicBaseUrl": "https://....trycloudflare.com",
  "publicEndpointProvider": "CLOUDFLARE_QUICK_TUNNEL",
  "messagingProvider": "SENDBLUE",
  "storageProvider": "LOCAL_DEMO",
  "accessProvider": "DURIN_DEMO",
  "operatorNotificationProvider": "GROK_ROUTINE",
  "options": { "grokLegacyOAuthCompat": true },
  "installedAt": "...",
  "updatedAt": "..."
}
```

The schema is strict (no extra fields), and every write is refused if any
configured credential value appears anywhere in it. The installation id is
created once and never changes, which is what makes the bootstrap idempotent.
Check results (public address, messaging, alerts) and the history of public
addresses live next to it in `install/state.json`, also non-secret.

## SecretStore

`src/install/secretStore.ts`. `LocalSecretStore` is one JSON file,
`tourcore-data/install/secrets.json`, inside the git-ignored data folder,
written atomically and `chmod 600` where the file system supports it. It holds
the Sendblue API key, API secret and incoming-webhook secret, the texting
number, and the Grok Routine's webhook address and key.

- Written only by the secure setup page (or created by Tour Core itself, for
  the Sendblue webhook secret).
- Read only through the settings layer (`src/install/settings.ts`), which
  layers: the environment (a developer's `.env`), then SecretStore values
  (which win), then the manifest's public address (used when
  `PUBLIC_BASE_URL` isn't set, and always in `GROK_MANAGED_P0`). Adapters keep
  reading the familiar names, so `.env`-only developer setups are unchanged.
- Never in the manifest, install state, MCP arguments or results, the secure
  setup API's responses, audit, exports or logs. Tool results and secure setup
  responses are also passed through a redaction step that removes any
  configured credential value, whatever produced it.

## Secure setup

The secure setup page is served by Tour Core on the Tour Core computer:
`http://localhost:4321/install` (`src/web/public/install.*`,
`src/install/secureSetup.ts`). In a Grok-managed install that's Grok's cloud
computer: Grok opens it in its cloud browser and asks the operator to take
over the browser for the typing. Values go straight to Tour Core; Grok never
sees them.

Protection:

- The server listens on `127.0.0.1` only.
- `/install` and `/api/install/*` answer only for a local `Host` **and** only
  when the request carries no proxy or tunnel headers (`cf-connecting-ip`,
  `cf-ray`, `x-forwarded-for`, `forwarded`, ...). Through the public address
  they're "Not found", whatever `Host` is sent.
- Every API call needs a live **setup session** (30 minutes). Sessions are
  minted by something already on the Tour Core computer: the bootstrap, the
  server at startup, `npm run install:link`, or the `get_secure_setup_url`
  tool. The token travels in the URL fragment (never sent as part of a URL or
  a `Referer`) and back in a custom header, which a cross-site page can't set.
  Only its hash is stored. Expired sessions are rejected.
- A session can write provider settings. Nothing can read a credential back.

## Installation status and next step

`src/install/status.ts`. Components, in the order Tour Core works through
them, with the requirement Tour Core (not the agent) assigns:

| Component | Requirement | Phase |
| --- | --- | --- |
| `RUNTIME`, `PUBLIC_ENDPOINT` | required before property | BOOTSTRAP |
| `GROK_OPERATOR` | required before property | CONNECT |
| `VISITOR_MESSAGING`, `STORAGE` (LOCAL_DEMO accepted), `ACCESS` (DURIN_DEMO accepted) | required before property | INFRASTRUCTURE |
| `PROPERTY` | required to publish | PROPERTY |
| `OPERATOR_ALERTS` | recommended; offered only after the property is saved; can be declined (`skip_optional_setup`) | PROPERTY |
| `READINESS`, `PRACTICE_TOUR` | required to publish; run automatically | VALIDATE |
| `PUBLISH` | explicit yes | PUBLISH |

States: `NOT_CONFIGURED`, `ACTION_REQUIRED`, `CONFIGURING`, `READY`,
`DEGRADED`, `ERROR`. Once published, the phase is `OPERATE`.

The next step is the first component that isn't ready, with an action, its
phase, who does it (`GROK`, `OPERATOR`, `OPERATOR_IN_SECURE_SETUP`,
`OPERATOR_DECISION`), the tool or skill to use, an `operatorMessage` that's
safe to say to a landlord as-is, and `grokInstructions` with anything
technical (addresses, commands) for Grok only. Nothing on the property path
has a next step until the infrastructure is ready, so Grok can't offer
property setup early. Every step carries a `rule`: Tour Core decides the
order, so Grok doesn't offer alternatives or ask the operator what to do
next. Technical values (public address, connector address, providers) are
under `technical`, marked for Grok only. A future component or provider
(Google Drive as `STORAGE`, real Durin as `ACCESS`) changes what this
returns; the Install Tour Core skill doesn't change.

### Installation tools (MCP)

`src/install/tools.ts`: `get_installation_status`,
`get_next_installation_step`, `get_installation_component`,
`skip_optional_setup`, `check_runtime_health`, `check_public_endpoint`, `test_visitor_messaging`,
`test_operator_alerts`, `test_storage`, `test_access`, `get_secure_setup_url`.

None takes a credential (no input field may even be named like one; a test
enforces it), none returns one, and none runs a shell command. There is no
`set_api_key`, `set_sender_key` or `set_sendblue_secret`.

## Bootstrap (`npm run bootstrap:grok`)

`scripts/bootstrap-grok.mjs` (plain Node: checks Node 20+, installs
dependencies with `npm ci` on a fresh folder) hands off to
`src/install/bootstrap.ts`:

1. detect the existing installation;
2. validate dependencies;
3. create the data folders;
4. create or reuse the manifest (same installation id every time);
5. validate configuration that would stop Grok connecting;
6. start the runtime, or keep the healthy one (a stuck or stopped one is
   restarted);
7. check local health (`/healthz`);
8. establish the public address and check it from outside (the public
   `/healthz` must return this installation's fingerprint);
9. mint a secure setup link and print operator-safe status (`--json` for
   machines);
10. exit, leaving Tour Core (and the tunnel) running in the background.

Running it again repairs and checks; it never creates a second installation.

`npm run bootstrap:self-hosted` runs the same steps without a tunnel, using
`PUBLIC_BASE_URL`.

## Runtime management

`src/install/service.ts`, for the install layer only (never an MCP tool):

```bash
npm run service:start     # start in the background; no-op if healthy
npm run service:stop      # stop (add -- --tunnel to stop the tunnel too)
npm run service:restart   # restart; the tunnel and its address are kept
npm run service:status    # running? healthy? pid, log file
npm run install:status    # installation status, component by component
npm run install:link      # a fresh secure setup link
```

The server writes `tourcore-data/service/runtime.json` (pid, port) when it's
listening and removes it on a clean stop; the service manager combines that
with the process table and `/healthz`. Output goes to
`tourcore-data/service/tourcore.log`. It works the same on Linux (Grok's
cloud computer) and Windows (developers).

**Self-healing (P0):** if Tour Core stopped, `npm run bootstrap:grok` (or
`service:start`) starts it again, and pending operator alerts are retried on
startup. There is no supervisor process: no systemd, no containers.

## Public address

`src/install/publicEndpoint.ts`: `PublicEndpointProvider` with
`ManualPublicEndpointProvider` and `CloudflareQuickTunnelProvider`. Tour Core's
business logic only ever sees the resulting address.

The quick tunnel provider finds `cloudflared` on `PATH` or in
`tourcore-data/bin`; on Linux it downloads Cloudflare's official static binary
there; elsewhere (or if the download fails) it returns one clear step (install
cloudflared or set `PUBLIC_BASE_URL`). It runs `cloudflared tunnel --url
http://127.0.0.1:<port>` in the background, captures the `trycloudflare.com`
address from its log, and reuses a running tunnel on the next bootstrap.

**Quick tunnel addresses change.** A new address invalidates Grok's MCP
connection and OAuth issuer/resource, Sendblue's webhook, and any identity-form
link built on the old address. Tour Core records every address; when it
changes, the installation status marks `PUBLIC_ENDPOINT` (check the new
address), `GROK_OPERATOR` (reconnect at the new connector address) and
`VISITOR_MESSAGING` (`test_visitor_messaging` moves Tour Core's own Sendblue
webhook to the new address and removes the old one) as needing action. OAuth
already refuses tokens issued for a different address. Nothing continues
silently on a stale address.

## Visitor messaging (Sendblue)

The operator enters the API key, API secret and texting number on the secure
setup page. Tour Core stores them, checks the account and line, creates an
incoming-webhook secret if there isn't one, registers (or repairs) its own
receive webhook for the current public address, removes its webhook for an
old address, and runs the readiness checks (`src/messaging/sendblue/connect.ts`).
Other webhooks on the account are never touched. The running server uses new
values immediately. `.env`-based setups and `npm run sendblue:*` keep working.

## Operator alerts

```
visitor asks something with no approved answer
   → safe fallback texted to the visitor right away
   → exception derived from the canonical records (unchanged)
   → operator event saved in the durable outbox (runtime/operator-events/)
   → POST to the Grok Routine webhook (Authorization: Bearer <routine key>)
   → Tour Core Exception Alert routine wakes, calls inspect_exception
   → the operator gets a plain message, without having asked
```

- `OperatorNotificationSink` with `NoopOperatorNotificationSink` and
  `GrokRoutineWebhookSink` (`src/alerts/operatorEvents.ts`).
- Event payload: `schemaVersion`, `eventId`, `eventType`
  (`exception.created` or `installation.test`), `propertyId`, `exceptionId`,
  `occurredAt`. No visitor PII, message text or credentials.
- `src/alerts/outbox.ts`: saved before delivery, keyed by a stable `eventId`
  derived from the exception (so the same exception is never queued twice),
  delivered after the visitor has been answered, retried with exponential
  backoff (5 s doubling to 15 min, 20 attempts), retried after a restart, and
  skipped (marked suppressed) if the exception was handled before delivery.
  Operator-placed holds aren't announced back to the operator.
- On the first start with alerts, exceptions that already exist are recorded
  but not announced.
- A delivery failure never affects the visitor; the installation status shows
  operator alerts as degraded until deliveries go through.

## Full new-user experience (Grok-managed)

Instruction hierarchy, with nothing duplicated between levels:
`GROK_BOOTSTRAP.md` (entry point) → `.grok/skills/install-tour-core/SKILL.md`
(detailed installation workflow) → the other `.grok/skills/*/SKILL.md`
(specific workflows) → Tour Core's MCP tools (actual state and actions).

Two ways in:

- **Final template experience:** add the Tour Core Bot, say "Set up Tour
  Core." The template knows the canonical repository and bootstrap behavior.
- **Development / open-source fallback:** a blank Grok Bot, no attachments,
  one prompt that names the repository URL and asks Grok to follow
  `GROK_BOOTSTRAP.md` (prompt in `docs/grok-manual-test.md`, test B). Grok
  discovers everything else from the clone.

The canonical repository is `repository.url` in `grok-template/template.json`.
An address from the operator's message (or `TOURCORE_REPO_URL`) is a fallback;
if it differs, Grok asks the operator, and the bootstrap refuses to start a
clone whose git origin isn't the canonical repository.

1. The operator installs the Tour Core Grok template (or sends the one-prompt
   bootstrap to a blank Bot).
2. They say **"Set up Tour Core."**
3. Grok checks whether Tour Core exists (the connector, then its cloud computer).
4. If not, Grok clones the canonical repository on its own cloud computer and
   reads `GROK_BOOTSTRAP.md`.
5. Grok runs `npm run bootstrap:grok`: Tour Core starts and gets its secure
   public connection. ("I'll handle the technical setup and only ask when I
   need a login, approval or decision.")
6. Grok adds the Tour Core connection itself; **the operator approves** it on
   Tour Core's approval screen in Grok's cloud browser. Grok continues on its
   own: "Connected. I'm checking the rest of the setup now."
7. Grok follows `get_next_installation_step`: the secure setup page for
   texting, where **the operator enters** the Sendblue details; Grok tests it.
   Tour records (stored with this installation) and access (Demo) need nothing.
8. "Everything needed to run Tour Core is connected and tested. Would you like
   to add your first property?"
9. Grok configures the property conversationally (Setup Property, Map Route).
10. Tour Core offers alerts (recommended). If yes, Grok creates the Tour Core
    Exception Alert routine itself, and **the operator enters** its connection
    details on the secure setup page; Grok sends a test alert. If no, Grok
    records the choice and moves on.
11. Grok explains how prospects use it and runs the readiness check and a
    practice tour without asking whether to skip them.
12. Grok asks for an explicit yes to publish.
13. "Your property is live for demo. I'll keep an eye on tours and let you
    know when something needs your attention."
14. A real visitor can text the property; Tour Core wakes Grok whenever a
    visitor needs judgment.

In the happy path the operator never sees addresses, tool counts, connectors,
tunnels, commands or protocol names, and is never asked to choose the setup
order.

### What still needs the operator

Grok can clone code, run commands, open pages, fill in non-sensitive settings
and run tests. The operator may still need to create or sign in to provider
accounts (Sendblue, Grok routines), pass MFA, accept provider terms, approve
Grok's connection, type credentials into the secure setup page, and make
policy decisions (property facts, publishing). This is not zero-click setup.

## Limitations of `GROK_MANAGED_P0`

- Availability depends on Grok's cloud computer staying up; there's no
  supervisor restarting Tour Core between Grok sessions.
- The quick tunnel address is temporary; each change needs Grok reconnected
  (with the operator approving again) and Sendblue re-pointed.
- Records live on that computer's disk (`LOCAL_DEMO`). If the cloud computer
  is reset, tour history is lost unless exported.
- `cloudflared` is auto-installed only on Linux x64/arm64.
- Grok's current OAuth callback still needs the legacy compatibility option,
  which the Grok-managed bootstrap turns on by default (`--strict-oauth` turns
  it off).
- The secure setup session token is visible to Grok (it opens the link). It
  lets a browser on that computer write settings, never read them.

## Path to stable self-hosted production

1. Deploy the same repository to a stable host with a stable https URL (a VM,
   a container host, Railway, Render, Fly, Cloudflare, ...). Nothing in Tour
   Core's business logic changes.
2. Set `TOURCORE_DEPLOYMENT_MODE=SELF_HOSTED` and `PUBLIC_BASE_URL`; run
   `npm run bootstrap:self-hosted` (or the host's own process manager with
   `npm run setup -- --no-open`).
3. Connect Grok over OAuth and say "Set up Tour Core": the same installation
   status, secure setup page (reached through the host's own local access,
   e.g. an SSH tunnel) and skill apply.
4. Longer term, Grok's cloud computer deploys Tour Core to such a host through
   a new `PublicEndpointProvider`/deployment target instead of being the server
   itself.

## Remaining work before Google Drive

- A `StorageProvider` seam for canonical tour records (today `TourCoreStore`
  plus the workspace folder) that a Drive adapter can implement, with an OAuth
  flow started from the secure setup page (a new secure setup step; no
  credentials through Grok).
- A `STORAGE` component that reports `GOOGLE_DRIVE` and offers the move as an
  `optionalActions` entry while it's `LOCAL_DEMO` (the status model already has
  the slot; the skill already offers optional actions).
- Migration/export of existing local records into Drive, and where runtime
  documents (sessions, outbox, OAuth) live once records are remote.
- Drive-scoped consent and revocation handling in the readiness check.

## Technical debt

- Installation checks record results but the public address isn't re-checked
  on a schedule; a tunnel that dies between bootstraps shows up only when
  something fails or the bootstrap runs.
- The settings layer is a process-wide registration (one installation per
  process), kept simple for P0.
- The service manager relies on a pid file plus `/healthz`; there's no
  supervisor, log rotation or crash-loop protection.
- The outbox keeps delivered events indefinitely; it needs pruning before
  long-running use.
- `npm run sendblue:configure` still writes the webhook secret to `.env`
  (developer path); the secure setup path uses the SecretStore. They coexist,
  with SecretStore values taking precedence.
- The Grok Routine webhook authentication is assumed to be a bearer token;
  if Grok changes the header format, `GrokRoutineWebhookSink` is the one place
  to adjust.
