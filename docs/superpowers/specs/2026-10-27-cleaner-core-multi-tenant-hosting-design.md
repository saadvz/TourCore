# Cleaner Core on one multi-tenant service: design

Date: 2026-10-27. Status: draft for Saad's review.

## Goal

Cleaner Core runs as one hosted service at one address. That service serves every host, and every host can use Grok, Claude, or ChatGPT. Today it runs as three deployments, each with one owner and one assistant:

| Today | Serves | Address |
| --- | --- | --- |
| Google VM (temporary, from when Railway went down) | Grok | `https://136-119-57-74.sslip.io` |
| Railway `tourcore-production-1056` | Claude | `https://tourcore-production-1056.up.railway.app` |
| Railway (ChatGPT) | ChatGPT | not in the repo (`hostedCleanerCoreUrl: null`) |

A Grok Bot user starts from the template. A Claude or ChatGPT user starts from the setup guide now, and from a plugin later. All of them reach the same URL.

## What Saad decided

- **Tenants are onboarded by hand for now.** Saad adds each host. The tenant boundary is built properly now, so self-serve signup can replace the manual step later without changing it.
- **One Twilio number per tenant.** Incoming one-to-one texts route by the `To` number.
- **An invite code on the Allow page.** Saad gives the host a one-time code. The host types it on Cleaner Core's Allow page when connecting. Nothing else comes from Saad: the URL is the same for every host and is already in the template or plugin.
- **Several assistants per tenant.** A host can connect Grok, Claude, and ChatGPT to the same tenant.
- **A password-protected admin web page** for Saad, not a CLI.
- **Railway, on its `*.up.railway.app` address.** Saad sets up a permanent domain later.
- **Start fresh.** All three current deployments hold test data only. Nothing is imported.
- **Folder per tenant in one process** (option 1). The alternatives were a shared database with a tenant column (too large a rewrite for now) and one Railway service per tenant (the problem being solved).

## Scope

- In: Cleaner Core only. The Tour Core touring service (`grok-template` → `tourcore-production`) stays where it is, unchanged.
- Not now:
  - self-serve signup (the phone check on the Allow page replaces the invite code later)
  - copying backups off Railway (the first follow-up once real hosts are on)
  - a per-tenant SMS allowlist
  - the Claude and ChatGPT plugins
  - a custom domain

## Rules that stay

- `docs/cleaner-core-safety-gates.md` stays green. Every existing gate runs per desk, unchanged.
- The door code goes only to the approved, opted-in cleaner, by the existing group rule.
- No live text to a real person without Saad's okay. Tests and Scratch runs use only 555 numbers and made-up door codes.
- Secrets stay out of code, logs, prompts, chat, and tool arguments.
- These modes behave exactly as today, and their tests stay green unchanged:
  - `HOSTED_RAILWAY_P0`
  - local
  - Grok-managed
  - single-tenant deployments that use `CLEANER_CORE_ASSISTANT`

## Part 1. Tenant registry

`/data/tenants.json`, written with `writeJsonAtomic`. One entry per tenant:

| Field | Meaning |
| --- | --- |
| `id` | `tnt_` plus random characters. Also names the desk folder `/data/tenants/<id>/` |
| `label` | Saad's name for the host, e.g. "Maria – 12 Main St". Only Saad sees it |
| `twilioNumber` | E.164. Unique across tenants |
| `primaryAssistant` | `grok`, `claude`, or `chatgpt`. Unset until the first connection |
| `connections[]` | `{ grantId, assistant, connectedAt }` |
| `invites[]` | `{ hash, expiresAt, usedAt? }`. Codes are shown once and only their hash is stored. They are valid for 7 days |
| `disabled` | Turns the tenant off without deleting anything |
| `createdAt` | ISO time |

**Per-tenant secrets** live in `/data/tenants/<id>/secrets.json` (mode 600, the same pattern as `src/install/secretStore.ts`). They never live in the process environment:

- `CLEANER_CORE_PIN_KEY` and `CLEANER_CORE_PHOTO_KEY`, one each per tenant, made the first time they're needed. An `x-cleaner-core-pin-key` header still wins when it is sent.
- The alert routine URL and key, stored per connection (keyed by `grantId`).

**Shared Railway variables:** the Twilio account SID and auth token (one account, many numbers), `CLEANER_CORE_ENABLED`, `CLEANER_CORE_LIVE_SMS`, `CLEANER_CORE_SMS_ALLOWLIST`, and `CLEANER_CORE_ADMIN_PASSWORD`.

## Part 2. Admin page

- `/admin` is password-protected by `CLEANER_CORE_ADMIN_PASSWORD`. When that variable is unset, `/admin` and everything under it return 404.
  - The password is compared in constant time, and login attempts are rate-limited (the OAuth rate limiter).
  - The session is an `HttpOnly; Secure; SameSite=Strict` cookie that lasts 12 hours, and every form carries a CSRF token.
- **Tenants list:** label, number, primary assistant, connections, last activity, disabled.
- **Create tenant:** label and Twilio number.
  - Checks that the number is on the Twilio account and not used by another tenant.
  - Points the number's SMS webhook at `<base>/webhooks/twilio/cleaner-core`.
  - Shows the invite code and the connector URL once, with copy buttons.
- **Per tenant:**
  - new invite code
  - change primary assistant
  - disconnect a connection
  - disable or enable
  - delete (the label must be typed to confirm)
- **Never shown:** door codes, calendar links, routine URLs or keys, cleaner or contact phone numbers, secrets.

## Part 3. How a request finds its tenant

Every way in resolves exactly one tenant before reading or writing any state. When it can't, the request stops there.

- **Connecting (OAuth).**
  - The Cleaner Core Allow page gets an "Invite code from Saad" field. Approving checks that the code's hash matches an invite, the invite hasn't expired or been used, and its tenant is enabled.
  - The **grant** then records `tenantId` and `assistant`, the invite is marked used, and the connection is added to the registry. The first connection becomes primary.
  - A failed check shows a plain error on the page, and no grant is created.
  - The binding is per grant, not per `client_id`, because Grok can give every user the same `client_id`. `Grant.id` is stable across token refresh.
  - The assistant comes from the callback host: `claude.ai` is Claude, `chatgpt.com` is ChatGPT, Grok's known hosts are Grok.
  - `hostedCleanerTenant` (first Allow claims the deployment) is not used in this mode.
  - `CLEANER_CORE_MCP_TOKEN` is refused in this mode, since a static token names no tenant.
- **MCP tool calls.**
  - Bearer token → grant → `tenantId` and `assistant` → that tenant's desk.
  - A grant with no tenant, or with a disabled or deleted tenant, is refused.
- **One-to-one texts.**
  - The Twilio signature is checked with the shared auth token over the full signed URL.
  - The `To` number picks the tenant.
  - An unknown or disabled `To` gets an empty TwiML reply and a log line. Nothing is sent.
- **Group texts.**
  - When a desk creates a group conversation, it registers that conversation's webhook as `<base>/webhooks/twilio/cleaner-core/group?t=<tenantId>`.
  - Twilio signs the full URL, so `t` can't be changed without the check failing.
  - The desk's existing check (only from the saved group and a saved person in it) still applies.
- **Links Cleaner Core gives out.**
  - Upload pages, private pages, and photos carry the tenant in the path: `/cleaner-core/t/<tenantId>/…`.
  - Photo links are signed with that tenant's photo key, so a link edited to point at another tenant fails the signature check.
- **Background work.** The alert retry timer and any scheduled checks run over enabled tenants, one desk at a time.
- **The tenant's environment.**
  - A desk gets a built environment: the process environment minus every name in `PER_TENANT_NAMES`, plus that tenant's secrets, plus `CLEANER_CORE_TWILIO_PHONE_NUMBER` set to its number.
  - `PER_TENANT_NAMES` covers the routine URL and key, the pin key, the photo key, the Cleaner Core phone number, and `CLEANER_CORE_ASSISTANT`.

## Part 4. Behavior per assistant

`CLEANER_CORE_ASSISTANT` is ignored on this service. What it decided today splits in two.

**Follows the calling connection** (`grant.assistant`):

- The MCP server instructions served at `initialize`. Grok's stay byte-for-byte the same, and the existing hash test keeps passing.
- Secret delivery:
  - Grok: a secure card.
  - Claude and ChatGPT: a one-time link to Cleaner Core's private page.
- Whether `get_job_photos` also returns images (Claude) or only links.
- The approval page's wording, picked from the callback host.
- `save_alert_routine`: the routine URL and key are saved for that connection.

**Follows the tenant's primary assistant:**

- Texts to the host name the primary ("talk to Claude", "your Grok Bot").
- An alert wakes only the primary's routine. If the primary hasn't connected a routine yet, alerts wait, as today.
  - Grok: its webhook.
  - Claude: its API trigger.
  - ChatGPT: its hourly task, which can't be woken and reads with `check_now`.
- The ChatGPT-only warnings appear only when the primary is ChatGPT: no check in 2.5 hours, and cleaner messages can take up to an hour.
- The first connection is primary. Saad changes it on the admin page. When the primary is disconnected, the oldest remaining connection becomes primary. When none remain, the tenant has no primary.

**Server-wide:**

- OAuth callbacks from Grok's hosts, `claude.ai`, and `chatgpt.com` are all allowed.
- Client ID metadata documents stay advertised, because Grok needs them.
  - They were off for Claude and ChatGPT only because ownership was bound by `client_id`. Binding per grant makes a shared `client_id` harmless.
  - Risk: Claude or ChatGPT may switch from registering their own client to a metadata document. Either should work. The cutover's live check connects each assistant once to confirm.

## Part 5. Data lifecycle and logs

- **Backups.** The existing per-tenant SQLite snapshot (`VACUUM INTO`) runs per tenant folder, on the volume. Backups keep only the sealed door-code reference.
- **Disable.** Tools refuse, texts to the number get an empty reply, and alerts stop. Data is kept.
- **Delete.**
  - Removes the tenant's grants, folder, secrets, and registry entry.
  - Clears the number's SMS webhook, so the number can go to another tenant.
- **Disconnect.** Revokes one grant and removes that connection's routine secrets.
- **Logs.** Every Cleaner Core line carries the `tnt_…` id. The existing `redact.ts` rules still apply: no full phone number and no door code.

## Part 6. Code layout

New files in `src/cleaner-core/hosted/`:

| File | Does | Depends on |
| --- | --- | --- |
| `registry.ts` | create, invite, redeem, connect, disconnect, set primary, disable, delete; number uniqueness | `writeJsonAtomic` |
| `tenantSecrets.ts` | reads and writes a tenant's `secrets.json` | the `secretStore.ts` pattern |
| `tenantEnv.ts` | builds a desk's environment; owns `PER_TENANT_NAMES` | registry, tenantSecrets |
| `resolve.ts` | grant, `To` number, group `?t=`, and link path → tenant or refuse | registry |
| `desks.ts` | `deskFor(tenantId)`; iterates enabled tenants for timers | `liveDeskFor`, tenantEnv |
| `twilioNumbers.ts` | checks a number is on the account; sets or clears its SMS webhook (Twilio REST, `fetch` injected) | shared Twilio credentials |
| `admin.ts`, `adminPages.ts` | `/admin` login, session, CSRF, and pages | registry, twilioNumbers |

Changed files:

- `src/cleaner-core/liveDesk.ts`
  - The caller's assistant (per tool call) and the primary assistant (per tenant) replace `env.CLEANER_CORE_ASSISTANT`.
  - Routine secrets are saved per connection through an injected saver.
  - The group webhook URL and link paths include the tenant id.
- `src/cleaner-core/mcp.ts`: instructions and output formats come from the caller's assistant.
- `src/mcp/oauth/store.ts`: `Grant` gains optional `tenantId` and `assistant`.
- `src/mcp/oauth/provider.ts` and `pages.ts`: the invite code field and its check, and the tenant policy for this mode.
- `src/install/deployment.ts`: a new mode, `HOSTED_CLEANER_CORE`.
  - Cleaner Core is on and the Tour Core `/mcp` is off.
  - It listens on `0.0.0.0:$PORT` and uses `RAILWAY_PUBLIC_DOMAIN`, like `HOSTED_RAILWAY_P0`.
- `src/web/server.ts`: in that mode, Cleaner Core routes go through `resolve.ts`, then `desks.ts`, and `/admin` is mounted. Every other mode keeps today's code path.
- Railway: a `cleaner-core` service with its own volume at `/data` and `TOURCORE_DEPLOYMENT_MODE=HOSTED_CLEANER_CORE`. It uses the same build, start, healthcheck, and Node version as `.railway/railway.ts`.

## Part 7. Templates and cutover

**Templates.** One address in `hostedCleanerCoreUrl`:

- `cleaner-template` (Grok): the VM address is replaced with the new service's.
- `claude-template` and `chatgpt-template`:
  - point at the same address
  - drop the "deploy your own service with `CLEANER_CORE_ASSISTANT`" sections
  - add one step: enter Saad's invite code on the page that opens when connecting
- `.cursor/skills/verify-cleanercore/SKILL.md` and `test/cleanerTemplate.test.ts` take the new address.

**Cutover.**

1. Saad creates the `cleaner-core` Railway service and sets its variables.
2. The verify-cleanercore preflight runs against it. Nothing is sent to a real phone.
3. On `/admin`, Saad creates test tenants with the existing Twilio numbers from the VM, Claude, and ChatGPT services. Creating a tenant repoints that number's webhook, which takes it off its old deployment.
4. Live check: Grok, Claude, and ChatGPT each connect once with an invite code. Any live text goes only to Saad's test phones, with his okay first.
5. The templates change merges only after step 4 passes.
6. Saad stops, then deletes, the VM and the two old Railway services. Their old Twilio conversations are test data and are left alone.

Rollback before step 6: point a number's webhook back at its old service.

**Docs.**

- `docs/hosted-multitenancy.md` is rewritten to describe what is built.
- `docs/deployment.md` gains a `HOSTED_CLEANER_CORE` row.
- `docs/cleaner-core-safety-gates.md` gains the Hosted tenants row.
- `AGENTS.md` is not edited. A lesson for it goes in a separate proposed PR for QA bot.

## Part 8. Testing

Vitest. Only 555 numbers and made-up door codes. Twilio is faked through the injected `fetch`.

- **Unit tests.**
  - `registry`:
    - number uniqueness
    - invite hash, expiry, and single use
    - primary fallback on disconnect
    - delete removes the grants, folder, secrets, and entry
  - `tenantEnv`: every `PER_TENANT_NAMES` value set in the process environment never reaches a desk.
  - `resolve`: each route, plus unknown, disabled, and deleted tenants.
  - `admin`:
    - 404 without a password
    - rate-limited wrong password
    - a form without its CSRF token is refused
    - an invite code is shown once
    - delete needs the typed label
- **OAuth.**
  - A wrong, expired, used, or disabled-tenant code creates no grant.
  - Two grants sharing one Grok `client_id` bind to two tenants and stay apart.
  - The callback host sets the assistant.
- **Hosted tenants gate.** A new safety-gates row: two tenants (Scratch Lane and Scratch Court, each with its own 555 number) through the real HTTP server. Each of these is refused or sends nothing:
  - a text to A's number from B's cleaner
  - B's grant calling A's tools
  - a group webhook with `t` changed
  - a photo or upload link with the tenant changed
  - the process environment leaking a per-tenant value

  Each tenant's door code reaches only its own approved cleaner, once.
- **Mixed assistants.** A tenant with Grok as primary and a Claude connection:
  - Claude's calls get private pages and photo images.
  - Host texts say "your Grok Bot".
  - An alert wakes only Grok's routine.
  - After the primary changes to Claude, alerts wake Claude's routine.
- **Unchanged and green.** Every existing test, including the Grok instructions hash and the single-tenant Claude and ChatGPT tests.
- **Before any push.** `npm run typecheck`, `npm test`, `scripts/ci-check.sh`, and the verify-cleanercore gates.

## Build order

Each step is its own reviewable change:

1. Registry, tenant secrets, tenant environment.
2. Tenant resolution, desks, and server routing behind `HOSTED_CLEANER_CORE`.
3. Invite code on the Allow page; the grant carries `tenantId` and `assistant`.
4. Split the caller's assistant from the primary in `liveDesk.ts` and `mcp.ts`.
5. Admin page and Twilio number setup.
6. Hosted tenants gate, docs, Railway service config.
7. Templates, after the cutover's live check.
