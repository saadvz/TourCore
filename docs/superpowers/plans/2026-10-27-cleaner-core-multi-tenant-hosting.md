# Cleaner Core Multi-Tenant Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One hosted Cleaner Core service that serves many hosts (tenants), each connected from Grok, Claude, or ChatGPT, replacing the VM and the two per-assistant Railway services.

**Architecture:**
- One process, with one folder per tenant (`/data/tenants/<id>/`), each the root of an unchanged `LiveDesk`.
- A tenant registry, per-tenant secrets, and a built per-tenant environment are added. A router resolves each request to one tenant (OAuth grant, Twilio `To` number, or a `/t/<id>/` path prefix), then calls the existing `http.ts` handlers with that tenant's root and environment.
- The calling assistant travels in an `AsyncLocalStorage` caller. The primary assistant travels in the tenant's environment.

**Tech Stack:** TypeScript (Node ≥ 22.13), Express 5, `@modelcontextprotocol/sdk` OAuth, `node:async_hooks`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-27-cleaner-core-multi-tenant-hosting-design.md`

## Global Constraints

- Multi-tenant mode is on only when `CLEANER_CORE_MULTI_TENANT=1` and `TOURCORE_DEPLOYMENT_MODE=HOSTED_RAILWAY_P0`. With it off, every route keeps today's code path and every existing test stays green unchanged.
- Tests use only 555 numbers and made-up door codes (the Scratch pins in `src/cleaner-core/tenants.ts` and `DOOR_CODE` in `test/wiringProof.ts`; never spell a code out in docs, since `scripts/scan-cleaner-secrets.mjs` fails CI on one). Never Saad's phones or the real Twilio number.
- No live text to a real person. Twilio REST is faked with an injected `fetch` in every test.
- Secrets never appear in logs, tool replies, the registry, or the admin page:
  - door codes
  - calendar links
  - routine URLs and keys
  - pin and photo keys
  - invite codes after they are first shown
  - the admin password
- Logs carry `tnt_…` and never a full phone number (`redact.ts` rules).
- Grok's MCP instructions stay byte-for-byte the same.
- `AGENTS.md` is not edited.
- Tenant id format: `tnt_` + 10 chars of `[a-z0-9]`. Any path segment that doesn't match `/^tnt_[a-z0-9]{10}$/` is treated as unknown.
- Invite code format: three groups of four Crockford base32 characters joined by `-` (e.g. `K7QM-3XRP-9DWT`). Normalized by uppercasing and removing spaces and dashes before hashing. Valid for 7 days. Used up when the host clicks Allow.
- Before every commit: `npm run typecheck` and the task's tests. Before the final push: `npm test` and `scripts/ci-check.sh`.

## Review Focus

1. **A host clicks Allow, then closes the tab before the assistant exchanges the code.** The invite is used up, the tenant has no new connection, and Saad's admin page shows the invite as used. A new invite works. Test: Task 4.
2. **A grant disappears without a disconnect** (refresh-token reuse revokes it, or it expires). The tenant's primary falls back to the oldest connection whose grant still exists, and alerts wake that connection's routine, never the dead one's. Test: Task 5.
3. **Saad types a number or code in a different format** (`(555) 555-0150`, `k7qm 3xrp 9dwt`). Numbers normalize to E.164 before the uniqueness check. Codes normalize before hashing. Test: Task 1.
4. **One tenant's alert drain throws.** The other tenants' alerts still go out on the same tick. Test: Task 5.
5. **A tenant is deleted while its desk is cached.** Later requests with its id get 404. The cached desk is dropped, so no timer touches the deleted folder. Test: Task 6.

---

### Task 1: Multi-tenant flag and tenant registry

**Files:**
- Modify: `src/cleaner-core/flag.ts`
- Create: `src/cleaner-core/hosted/registry.ts`
- Test: `test/cleanerHostedRegistry.test.ts`

**Interfaces:**
- Produces:
  - `cleanerMultiTenant(env?: NodeJS.ProcessEnv): boolean`: true only for `"1"` or `"true"`.
  - `interface TenantConnection { grantId: string; assistant: CleanerAssistant; connectedAt: string }`
  - `interface Tenant { id: string; label: string; twilioNumber: string; primaryGrantId?: string; connections: TenantConnection[]; invites: { hash: string; expiresAt: string; usedAt?: string }[]; disabled?: boolean; createdAt: string; lastActivityAt?: string }`
  - `type InviteRefusal = "invalid" | "expired" | "used" | "disabled"`
  - `class RegistryError extends Error { constructor(readonly reason: "bad-label" | "bad-number" | "number-taken" | "unknown-tenant") }`
  - `class TenantRegistry`:
    - `constructor(dataRoot: string, now: () => Date)`. The file is `join(dataRoot, "tenants.json")`.
    - `list(): Tenant[]`
    - `get(id: string): Tenant | undefined`
    - `byNumber(raw: string): Tenant | undefined`
    - `create(input: { label: string; twilioNumber: string }): { tenant: Tenant; inviteCode: string }`
    - `invite(id: string): string`
    - `claimInvite(code: string): { tenantId: string } | { refused: InviteRefusal }`
    - `connect(tenantId: string, connection: TenantConnection): void`
    - `disconnect(tenantId: string, grantId: string): void`
    - `setPrimary(tenantId: string, grantId: string): void`
    - `primary(tenantId: string, isLive: (grantId: string) => boolean): TenantConnection | undefined`
    - `setDisabled(id: string, disabled: boolean): void`
    - `remove(id: string): Tenant | undefined`
    - `touch(id: string): void`
  - `tenantFolder(dataRoot: string, id: string): string`, which is `join(dataRoot, "tenants", id)`
  - `isTenantId(value: string): boolean`

- [ ] **Step 1: Write the failing tests** in `test/cleanerHostedRegistry.test.ts`. Use a temp dir and a clock the test moves.

```ts
it("creates a tenant with a normalized unique number and a one-time invite", () => {
  const { tenant, inviteCode } = reg.create({ label: "Lane", twilioNumber: "(555) 555-0150" });
  expect(tenant.id).toMatch(/^tnt_[a-z0-9]{10}$/);
  expect(tenant.twilioNumber).toBe("+15555550150");
  expect(inviteCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  expect(readFileSync(join(dir, "tenants.json"), "utf8")).not.toContain(inviteCode.replaceAll("-", ""));
  expect(() => reg.create({ label: "Court", twilioNumber: "+1 555 555 0150" })).toThrow(expect.objectContaining({ reason: "number-taken" }));
  expect(() => reg.create({ label: " ", twilioNumber: "+15555550151" })).toThrow(expect.objectContaining({ reason: "bad-label" }));
  expect(() => reg.create({ label: "Court", twilioNumber: "12" })).toThrow(expect.objectContaining({ reason: "bad-number" }));
});

it("claims an invite once, ignoring case, spaces and dashes", () => {
  const { tenant, inviteCode } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
  expect(reg.claimInvite(inviteCode.toLowerCase().replaceAll("-", " "))).toEqual({ tenantId: tenant.id });
  expect(reg.claimInvite(inviteCode)).toEqual({ refused: "used" });
  expect(reg.claimInvite("AAAA-AAAA-AAAA")).toEqual({ refused: "invalid" });
});

it("refuses an expired invite and an invite for a disabled tenant", () => {
  const a = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
  advance(7 * DAY + 1);
  expect(reg.claimInvite(a.inviteCode)).toEqual({ refused: "expired" });
  const code = reg.invite(a.tenant.id);
  reg.setDisabled(a.tenant.id, true);
  expect(reg.claimInvite(code)).toEqual({ refused: "disabled" });
});

it("makes the first connection primary and falls back to the oldest live one", () => {
  const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
  reg.connect(tenant.id, { grantId: "g1", assistant: "grok", connectedAt: "2026-10-27T10:00:00.000Z" });
  reg.connect(tenant.id, { grantId: "g2", assistant: "claude", connectedAt: "2026-10-27T11:00:00.000Z" });
  reg.connect(tenant.id, { grantId: "g3", assistant: "chatgpt", connectedAt: "2026-10-27T12:00:00.000Z" });
  expect(reg.primary(tenant.id, () => true)?.grantId).toBe("g1");
  expect(reg.primary(tenant.id, (g) => g !== "g1")?.grantId).toBe("g2");
  reg.setPrimary(tenant.id, "g3");
  reg.disconnect(tenant.id, "g3");
  expect(reg.get(tenant.id)?.primaryGrantId).toBe("g1");
});

it("finds a tenant by number in any format, and remove frees the number", () => {
  const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
  expect(reg.byNumber("+1 (555) 555-0150")?.id).toBe(tenant.id);
  reg.remove(tenant.id);
  expect(reg.byNumber("+15555550150")).toBeUndefined();
  expect(() => reg.create({ label: "Court", twilioNumber: "+15555550150" })).not.toThrow();
});

it("writes lastActivityAt at most every 5 minutes", () => { /* touch, advance 4 min, touch: unchanged; advance 2 min, touch: changed */ });
```

- [ ] **Step 2: Run them and check they fail.** `npx vitest run test/cleanerHostedRegistry.test.ts` fails with a module-not-found error for `../src/cleaner-core/hosted/registry`.

- [ ] **Step 3: Add `cleanerMultiTenant` to `flag.ts`, and implement `registry.ts`.**
  - Read the file on every call and write it with `writeJsonAtomic`, like `src/install/secretStore.ts`.
  - Numbers normalize with the existing `parsePhone` that `twilioHook.ts` uses.
  - Invite hash: `hashSecret` from `src/mcp/oauth/store.ts`, over the normalized code.
  - Codes come from `randomBytes` mapped to the Crockford alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`.
  - `disconnect` and a removed primary fall back to the oldest remaining connection by `connectedAt`.

- [ ] **Step 4: Run the tests and check they pass.** `npx vitest run test/cleanerHostedRegistry.test.ts`, then `npm run typecheck`.

- [ ] **Step 5: Commit.** `git commit -m "Cleaner Core: tenant registry for the multi-tenant service"`

---

### Task 2: Per-tenant secrets and the tenant environment

**Files:**
- Create: `src/cleaner-core/hosted/tenantSecrets.ts`
- Create: `src/cleaner-core/hosted/tenantEnv.ts`
- Test: `test/cleanerHostedTenantEnv.test.ts`

**Interfaces:**
- Consumes: `Tenant`, `TenantConnection`, `TenantRegistry.primary`, `tenantFolder` (Task 1).
- Produces:
  - `class TenantSecrets`, with `constructor(dataRoot: string)`:
    - `tenant(id: string): Record<string, string>`
    - `connection(id: string, grantId: string): Record<string, string>`
    - `set(id: string, values: Record<string, string>): void`
    - `setForConnection(id: string, grantId: string, values: Record<string, string>): void`
    - `delete(id: string, names: string[]): void`, which removes those names at tenant level and from every connection
    - `deleteConnection(id: string, grantId: string): void`
    - `removeTenant(id: string): void`
    - The file is `join(tenantFolder(dataRoot, id), "secrets.json")`, holding `{ tenant: {}, connections: { [grantId]: {} } }` with mode `0o600`.
  - `PER_TENANT_NAMES: readonly string[]`, exactly: `CLEANER_CORE_ROUTINE_URL`, `CLEANER_CORE_ROUTINE_KEY`, `CLEANER_CORE_PIN_KEY`, `CLEANER_CORE_PHOTO_KEY`, `CLEANER_CORE_TWILIO_PHONE_NUMBER`, `CLEANER_CORE_ASSISTANT`, `CLEANER_CORE_PRIMARY_CONNECTION`, `CLEANER_CORE_MCP_TOKEN`, `PUBLIC_BASE_URL`.
  - `ROUTINE_NAMES = ["CLEANER_CORE_ROUTINE_URL", "CLEANER_CORE_ROUTINE_KEY"] as const`
  - `buildTenantEnv(input: { base: NodeJS.ProcessEnv; tenant: Tenant; secrets: TenantSecrets; primary: TenantConnection | undefined; origin: string }): NodeJS.ProcessEnv`

- [ ] **Step 1: Write the failing tests.**

```ts
it("strips every per-tenant name from the process env and adds this tenant's own", () => {
  const base = Object.fromEntries(PER_TENANT_NAMES.map((n) => [n, `leak-${n}`]));
  secrets.set(t.id, { CLEANER_CORE_PIN_KEY: "pin-a", CLEANER_CORE_PHOTO_KEY: "photo-a" });
  const env = buildTenantEnv({ base: { ...base, CLEANER_CORE_ENABLED: "1" }, tenant: t, secrets, primary: undefined, origin: "https://cc.example" });
  expect(Object.values(env).join("\n")).not.toContain("leak-");
  expect(env).toMatchObject({ CLEANER_CORE_ENABLED: "1", CLEANER_CORE_PIN_KEY: "pin-a", CLEANER_CORE_PHOTO_KEY: "photo-a",
    CLEANER_CORE_TWILIO_PHONE_NUMBER: "+15555550150", PUBLIC_BASE_URL: `https://cc.example/t/${t.id}` });
  expect(env.CLEANER_CORE_ASSISTANT).toBeUndefined();
});

it("carries the primary's assistant, grant id and routine, never another connection's", () => {
  secrets.setForConnection(t.id, "g1", { CLEANER_CORE_ROUTINE_URL: "https://grok.example/hook", CLEANER_CORE_ROUTINE_KEY: "key-g1-xxxx" });
  secrets.setForConnection(t.id, "g2", { CLEANER_CORE_ROUTINE_URL: "https://claude.example/fire", CLEANER_CORE_ROUTINE_KEY: "key-g2-xxxx" });
  const env = buildTenantEnv({ base: {}, tenant: t, secrets, primary: { grantId: "g2", assistant: "claude", connectedAt: NOW }, origin: "https://cc.example" });
  expect(env).toMatchObject({ CLEANER_CORE_ASSISTANT: "claude", CLEANER_CORE_PRIMARY_CONNECTION: "g2", CLEANER_CORE_ROUTINE_KEY: "key-g2-xxxx" });
});

it("delete removes a name from the tenant and every connection, and removeTenant removes the file", () => { /* … */ });
it("writes secrets.json with mode 600", () => { expect(statSync(file).mode & 0o777).toBe(0o600); });
```

- [ ] **Step 2: Run them and check they fail** (module not found).
- [ ] **Step 3: Implement both files.** Follow the `chmodSync` and `writeJsonAtomic` pattern in `src/install/secretStore.ts`.
- [ ] **Step 4: Run them and check they pass.** Then `npm run typecheck`.
- [ ] **Step 5: Commit.** `git commit -m "Cleaner Core: per-tenant secrets and environment"`

---

### Task 3: The caller's assistant and the primary's, inside the desk

**Files:**
- Create: `src/cleaner-core/callerContext.ts`
- Modify:
  - `src/cleaner-core/liveDesk.ts`: `assistant()` at line 2708, the alert sink at lines 597-612, `saveAlertRoutineNow` and `connectTask` and `connectRoutine` and `issueUpload` and `uploadAlertRoutine` at lines 621-730, and the upload builders at lines 1090-1101 and 1191-1205. Also `routineReady` and its neighbors at lines 2326-2350, `helperName` at line 2565, and the `LiveFile` type at line 344.
  - `src/cleaner-core/http.ts`: `handleCleanerMcpHttp`
- Test: `test/cleanerCallerContext.test.ts`

**Interfaces:**
- Produces:
  - `interface CleanerCaller { assistant: CleanerAssistant; connectionId?: string }`
  - `withCaller<T>(caller: CleanerCaller, run: () => T): T`
  - `currentCaller(): CleanerCaller | undefined`
  - `LiveDesk.assistant()` returns `currentCaller()?.assistant ?? this.primaryAssistant()`.
  - New `LiveDesk.primaryAssistant()` returns `cleanerAssistant(this.env())`.
  - `LiveFile` gains `routineConnections?: string[]`, and `alertUpload` gains `by?: CleanerCaller`.
  - `handleCleanerMcpHttp` input gains `caller?: CleanerCaller`. When given, the whole message is handled inside `withCaller(caller, …)`, and `caller.assistant` is passed to `handleCleanerMcpMessage` in place of `cleanerAssistant(env)`.

**What follows which assistant.** Every string that leaves as a text message (SMS or group) and every alert or routine decision uses `primaryAssistant()`. Every tool reply uses `assistant()`.
- Uses `primaryAssistant()`:
  - the sink choice at lines 607-609
  - `routineReady` at lines 2328-2329
  - `lastCheckAt` at line 2340
  - the ChatGPT silence warning at line 2348
  - `helperName` at line 2565
  - every `this.words()` field that goes into an SMS body. Add `private hostWords()`, which returns the wording for `primaryAssistant()`, and use it at those sites. Find them with `grep -n "words()" src/cleaner-core/liveDesk.ts`, and check which feed `sendLiveSms`, the outbox, or the group sender.
- Uses `assistant()`: the caller's reply wording, the setup asks at line 2317, the routine instructions at line 2335, and `saveAlertRoutineNow`'s ChatGPT and Claude branches. Those keep using the caller's.

**Routine per connection.**
- When `currentCaller()?.connectionId` is set, `connectTask` and `connectRoutine` add it to `routineConnections` (no duplicates) as well as setting `routineConnected`.
- `routineReady()` then requires, when `this.env().CLEANER_CORE_PRIMARY_CONNECTION` is set, that this id is in `routineConnections`. Without it, today's check is unchanged.
- `issueUpload` stores `by: currentCaller()`. `uploadAlertRoutine` runs its `save` inside `withCaller(pending.by, …)` when `by` is set.

**Upload links.** At the three builders, replace `new URL(base).origin` with `base`, so a tenant's `PUBLIC_BASE_URL=<origin>/t/<id>` scopes them. A single-tenant `PUBLIC_BASE_URL` is an origin, so its links don't change.

- [ ] **Step 1: Write the failing tests.** Drive a desk directly with `liveDeskFor` on a temp root and an env with `CLEANER_CORE_ASSISTANT: "grok"`, `CLEANER_CORE_PRIMARY_CONNECTION: "g1"`, `PUBLIC_BASE_URL: "https://cc.example/t/tnt_aaaaaaaaaa"`, and `CLEANER_CORE_ENABLED: "1"`.

```ts
it("a Claude caller gets Claude's reply format while texts still name the Grok primary", async () => {
  const reply = await withCaller({ assistant: "claude", connectionId: "g2" }, () => handleCleanerMcpMessage(desk, toolsCall("get_state"), undefined, false, undefined, undefined, "claude"));
  expect(JSON.stringify(reply.body)).toContain(/* a CLAUDE_DESK_WORDING string that get_state returns */);
  // drive a host text (the wiringProof setup flow) and assert its body contains GROK_HELPER, not CLAUDE_HELPER
});

it("a routine saved by a non-primary connection doesn't make alerts ready", async () => {
  await withCaller({ assistant: "chatgpt", connectionId: "g3" }, () => desk.saveAlertRoutine({}, save));
  // routineReady() is private: assert through its effect. A queued alert is still pending after drainAlerts().
  await desk.drainAlerts();
  expect(wakes).toHaveLength(0);
});

it("an upload link made by one connection saves under that connection", async () => {
  const link = await withCaller({ assistant: "grok", connectionId: "g1" }, () => desk.saveAlertRoutine({}, save));
  expect(link.result.uploadUrl).toMatch(/^https:\/\/cc\.example\/t\/tnt_aaaaaaaaaa\/cleaner-core\/alert-routine\//);
  await desk.uploadAlertRoutine(codeOf(link), { url: "https://grok.example/hook", token: "routine-key-1234" }, (v) => seen.push({ caller: currentCaller(), v }));
  expect(seen[0]!.caller).toEqual({ assistant: "grok", connectionId: "g1" });
});

it("with no caller and no primary connection, behavior is today's", () => { /* CLEANER_CORE_ASSISTANT=claude env, no withCaller: assistant() === "claude" */ });
```

- [ ] **Step 2: Run them and check they fail.** `npx vitest run test/cleanerCallerContext.test.ts`
- [ ] **Step 3: Implement `callerContext.ts`** (an `AsyncLocalStorage<CleanerCaller>`), then the `liveDesk.ts` and `http.ts` changes above.
- [ ] **Step 4: Run the new tests and the existing assistant tests.** `npx vitest run test/cleanerCallerContext.test.ts test/cleanerClaude.test.ts test/cleanerChatGpt.test.ts test/cleanerGrokDemo.test.ts test/cleanerFullSetup.test.ts test/cleanerHostTexts.test.ts` all pass, then `npm run typecheck`.
- [ ] **Step 5: Commit.** `git commit -m "Cleaner Core: tool replies follow the caller, texts and alerts follow the primary"`

---

### Task 4: The grant carries the tenant, with an invite code on the Allow page

**Files:**
- Modify:
  - `src/mcp/oauth/store.ts`: `Grant`, `addGrant`
  - `src/mcp/oauth/provider.ts`: `ProviderOptions`, `ApprovalRequest`, `CodeEntry`, `exchangeAuthorizationCode`, `verifyAccessToken`
  - `src/mcp/oauth/index.ts`: the `/oauth/requests/:id/approve` route
  - `src/mcp/oauth/pages.ts`: `cleanerConsentPage` and the Allow script
  - `src/mcp/oauth/clients.ts`: `redirectHostsFromEnv`
  - `src/cleaner-core/assistant.ts`
  - `src/web/server.ts`: the OAuth options at lines 333-395. When `cleanerMultiTenant(env)`:
    - `invites` uses a `TenantRegistry` on `installation.root`, and `connected` calls `registry.connect`.
    - `tenantPolicy` returns `{ allowed: true }` for the cleaner path.
    - `publicApproval` returns true, and `hostedClaimed` returns false.
    - `onOwnerApproved` does nothing for the cleaner path.
    - `metadataDocuments` returns true.
    - The Tour Core resource is `enabled: () => false`.
- Test: `test/cleanerHostedOauth.test.ts`. Extend `test/cleanerOauthHarness.ts` with `approve(id, code, headers, inviteCode?)`, plus a `connect` option `{ inviteCode, redirect }`.

**Interfaces:**
- Consumes: `TenantRegistry.claimInvite`, `TenantRegistry.connect`, `InviteRefusal` (Task 1).
- Produces:
  - `Grant` gains `tenantId?: string; assistant?: CleanerAssistant`. `OAuthGrantStore` gains `get(grantId: string): Grant | undefined`.
  - `assistantForRedirect(uri: string): CleanerAssistant`, in `assistant.ts`. Host `claude.ai` gives `"claude"`, `chatgpt.com` gives `"chatgpt"`, anything else gives `"grok"`.
  - `ProviderOptions` gains `invites?: { claim(code: string): { tenantId: string } | { refused: InviteRefusal }; connected(tenantId: string, grantId: string, assistant: CleanerAssistant): void }`.
  - `TourCoreOAuthProvider.approveWithInvite(id: string, matchCode: string, inviteCode: string): { ok: true } | { ok: false; message: string }`
  - `verifyAccessToken` returns `extra: { grantId: grant.id, tenantId: grant.tenantId, assistant: grant.assistant }`.
  - `INVITE_REFUSALS: Record<InviteRefusal, string>`, exported from `pages.ts`, with exact copy:
    - `invalid`: "That invite code isn't right. Check it with Saad and try again."
    - `expired`: "That invite code has expired. Ask Saad for a new one."
    - `used`: "That invite code was already used. Ask Saad for a new one."
    - `disabled`: "This Cleaner Core account is turned off. Ask Saad."

**Behavior:**
- With `invites` set, `/approve` for the Cleaner Core path reads `inviteCode` from the JSON body and calls `approveWithInvite`.
  - A refusal answers 403 with `{ ok: false, error: { message } }`, and the page shows the message under the field.
  - `approveWithInvite` checks the match code first, then claims the invite, then stores `tenantId` and `assistantForRedirect(redirectUri)` on the request.
  - `finish` copies them to the code entry. `exchangeAuthorizationCode` passes them to `addGrant` and calls `invites.connected(tenantId, grant.id, assistant)`.
- `approveFromBrowser` (no invite) is refused for the Cleaner Core path when `invites` is set.
- `cleanerConsentPage` gets `invite?: boolean`. It then renders `<label for="oauth-invite">Invite code from Saad</label><input id="oauth-invite" autocomplete="off" autocapitalize="characters" spellcheck="false">` above Allow, drops the "first connection becomes owner" line, and the Allow script posts `{ matchCode, inviteCode }`.
- `redirectHostsFromEnv`: when `cleanerMultiTenant(env)`, include both `claude.ai` and `chatgpt.com`.

- [ ] **Step 1: Write the failing tests.** Use `hostedApp({ CLEANER_CORE_MULTI_TENANT: "1" })`, with tenants created by `new TenantRegistry(app.root, now)` before connecting.

```ts
it("Allow without a valid invite creates no grant, with each refusal's copy", async () => {
  for (const [code, reason] of [["AAAA-AAAA-AAAA", "invalid"], [usedCode, "used"], [expiredCode, "expired"], [disabledCode, "disabled"]] as const) {
    const res = await app.approve(id, match, {}, code);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(INVITE_REFUSALS[reason]);
  }
  expect(registry.get(lane.id)!.connections).toHaveLength(0);
});

it("two hosts on one shared Grok client_id bind to two tenants", async () => {
  const clientId = await app.register("Grok");
  const a = await app.connect(clientId, CLEANER_RESOURCE, CLEANER_SCOPE, { inviteCode: laneCode });
  const b = await app.connect(clientId, CLEANER_RESOURCE, CLEANER_SCOPE, { inviteCode: courtCode });
  expect(grantOf(a.access).tenantId).toBe(lane.id);
  expect(grantOf(b.access).tenantId).toBe(court.id);
});

it("the callback host sets the assistant", async () => {
  // connect with redirect https://claude.ai/api/mcp/auth_callback, then https://chatgpt.com/connector/oauth/abc, then grok's
  expect(registry.get(lane.id)!.connections.map((c) => c.assistant)).toEqual(["claude", "chatgpt", "grok"]);
});

it("Allow then abandon: the invite is used and the tenant has no connection", async () => {
  await app.approve(id, match, {}, laneCode); // never call /continue or /token
  expect(registry.claimInvite(laneCode)).toEqual({ refused: "used" });
  expect(registry.get(lane.id)!.connections).toHaveLength(0);
});

it("the consent page asks for the invite and never says first-connection-owns", async () => {
  const html = consentPage({ requestId: "r", matchCode: "123456", clientName: "Grok", redirectHost: "grok.com", hosted: true, label: "Cleaner Core", invite: true });
  expect(html).toContain('id="oauth-invite"');
  expect(html).not.toContain("the owner of this Cleaner Core");
});
```

- [ ] **Step 2: Run them and check they fail.** `npx vitest run test/cleanerHostedOauth.test.ts`
- [ ] **Step 3: Implement the changes listed above.**
- [ ] **Step 4: Run the new tests and the existing OAuth tests.** `npx vitest run test/cleanerHostedOauth.test.ts test/cleanerOauth.test.ts test/hostedOauth.test.ts test/oauth.test.ts test/connectorScopes.test.ts` all pass, then `npm run typecheck`.
- [ ] **Step 5: Commit.** `git commit -m "Cleaner Core: an invite code on the Allow page binds the grant to a tenant"`

---

### Task 5: Route every request to its tenant

**Files:**
- Create: `src/cleaner-core/hosted/router.ts`
- Modify:
  - `src/web/server.ts`: the Cleaner Core routes at lines 693-865, the drain at line 920, and the Tour Core `/mcp` route
  - `src/cleaner-core/liveDesk.ts`: export `forgetLiveDesk(root: string): void`
- Test: `test/cleanerHostedRouter.test.ts`

**Interfaces:**
- Consumes:
  - `TenantRegistry` and `tenantFolder` (Task 1)
  - `TenantSecrets`, `buildTenantEnv`, and `ROUTINE_NAMES` (Task 2)
  - `CleanerCaller` (Task 3)
  - `AuthInfo.extra` and `OAuthGrantStore.get` (Task 4)
  - the existing `handleCleanerMcpHttp`, `handleCleanerTwilioWebhook`, `handleCleanerGroupWebhook`, `handleCleanerTwilioStatus`, `handleCleanerUploadPage`, `handleCleanerAlertUpload`, `handleCleanerCalendarUpload`, `handleCleanerDoorCodeUpload`, `servePhoto`, and `drainCleanerAlerts`
- Produces:
  - `interface HostedCleaner { registry: TenantRegistry; secrets: TenantSecrets; dataRoot: string; origin(): string | undefined; baseEnv(): NodeJS.ProcessEnv; grantLive(grantId: string): boolean; now(): Date; log(line: string): void }`
  - `tenantContext(h: HostedCleaner, tenant: Tenant): { root: string; env: () => NodeJS.ProcessEnv; saveSecrets: SaveSecrets; deleteSecrets: DeleteSecrets }`
    - `root` is `tenantFolder(dataRoot, tenant.id)`.
    - `env` rebuilds on each call with `primary = registry.primary(id, grantLive)`.
    - `saveSecrets` writes `ROUTINE_NAMES` to `currentCaller()?.connectionId`'s connection when set, and everything else to the tenant.
    - `deleteSecrets` is `secrets.delete`.
  - `splitTenantPath(pathname: string): { tenantId: string; rest: string } | undefined`. It matches `/t/<id>/<rest>` and returns `rest` with its leading `/`.
  - `handleHostedCleaner(req: IncomingMessage, res: ServerResponse, url: URL, h: HostedCleaner, deps: { authenticate(): Promise<AuthInfo | undefined>; readRaw(): Promise<Buffer> }): Promise<boolean>`. It returns true when it answered.
  - `drainAllTenants(h: HostedCleaner): Promise<void>`

**Routing (the flag on):**
- **`/mcp/cleaner-core`**
  - Run `authenticate()`; if it answered, stop.
  - Take `extra.tenantId`. A tenant that is missing, disabled, or removed gets 403 JSON: `{ error: { message: "This connection isn't linked to a Cleaner Core account. Reconnect with an invite code from Saad." } }`.
  - Otherwise call `handleCleanerMcpHttp` with the tenant context, `caller: { assistant: extra.assistant, connectionId: extra.grantId }`, and `oauth: { authenticate: async () => true }`, then `registry.touch(id)`.
- **POST `/webhooks/twilio/cleaner-core`** (one-to-one)
  - Read the body and find the tenant with `registry.byNumber(formParams(raw).To)`.
  - An unknown or disabled tenant gets 200 `text/xml` `<?xml version="1.0" encoding="UTF-8"?><Response></Response>` and a log line with no phone number.
  - Otherwise call `handleCleanerTwilioWebhook` with the tenant context and `url = origin + pathname + search`.
- **`/t/<id>/…`**
  - Look up the tenant. An unknown or disabled tenant gets 404.
  - Dispatch `rest` exactly as `server.ts` dispatches those paths today: the conversation hook, the status callback, the upload page GET and form POST, the three upload POSTs, and the photo GET.
  - Each is called with the tenant context. Twilio handlers are signed over the original full URL (`origin + url.pathname + url.search`).
  - Then `registry.touch(id)`.
- **Un-prefixed upload, photo, conversation, or status paths** get 404.
- **The Tour Core `/mcp` path** gets 404.
- **Drain:** in place of the single `drainCleanerAlerts(installation.root, …)` call, run `drainAllTenants`, which calls `drainCleanerAlerts(ctx.root, ctx.env, now)` for each enabled tenant, each in its own `try/catch` that logs `tnt_…` and continues.
- `grantLive(g)` is `!!new OAuthGrantStore(installation.runtime).get(g)`.
- `dataRoot` is `installation.root`, and `origin()` is `new URL(installation.publicBaseUrl()).origin`.

- [ ] **Step 1: Write the failing tests.**
  - Use `hostedApp({ CLEANER_CORE_MULTI_TENANT: "1", CLEANER_CORE_TWILIO_ACCOUNT_SID: "AC_test", CLEANER_CORE_TWILIO_AUTH_TOKEN: CLEANER_AUTH, CLEANER_CORE_LIVE_SMS: "1", CLEANER_CORE_SMS_ALLOWLIST: "*" })`.
  - Use `fakeSms` from `test/wiringProof.ts` installed with `setCleanerTwilioClient`, and `setCleanerAlertFetch` to record wake-ups.
  - Sign Twilio posts the way `test/cleanerCoreWiring.test.ts` does.

```ts
it("an MCP call reaches only its own tenant's folder", async () => { /* lane token save_property → file under tenants/<lane>/; court folder untouched */ });
it("a grant whose tenant was removed is refused with the reconnect message", async () => { /* 403 + exact message */ });
it("a one-to-one text routes by To; an unknown To gets empty TwiML and nothing is sent", async () => {
  const res = await twilioPost("/webhooks/twilio/cleaner-core", { From: "+15555550101", To: "+15555550199", Body: "YES" });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  expect(sms.sent).toHaveLength(0);
});
it("a /t/<id>/ path for an unknown or disabled tenant is 404, and an un-prefixed upload path is 404", async () => { /* … */ });
it("the primary falls back when its grant is gone, and alerts wake the new primary's routine", async () => {
  // lane: g1 grok (routine A), g2 claude (routine B). Revoke g1 in the grant store, queue an alert, drain.
  expect(wakes.map((w) => w.url)).toEqual(["https://claude.example/fire" /* B */]);
});
it("one tenant's failing drain doesn't stop the other's", async () => {
  // lane's alert fetch throws; court's routine still receives its wake-up on the same drainAllTenants call
});
it("the Tour Core /mcp is 404 in multi-tenant mode", async () => { expect((await app.rpc("/mcp", "tools/list")).status).toBe(404); });
```

- [ ] **Step 2: Run them and check they fail.** `npx vitest run test/cleanerHostedRouter.test.ts`
- [ ] **Step 3: Implement `router.ts` and the `server.ts` wiring.** In `server.ts`, run `if (cleanerMultiTenant(env) && await handleHostedCleaner(...)) return;` before the existing Cleaner Core branches.
- [ ] **Step 4: Run the new tests and the full suite.** `npx vitest run test/cleanerHostedRouter.test.ts`, then `npm test`, all green. The flag is off everywhere else, so no existing test changes.
- [ ] **Step 5: Commit.** `git commit -m "Cleaner Core: route every request to its tenant on the multi-tenant service"`

---

### Task 6: Twilio number setup and the admin page

**Files:**
- Create: `src/cleaner-core/hosted/twilioNumbers.ts`, `src/cleaner-core/hosted/admin.ts`, `src/cleaner-core/hosted/adminPages.ts`
- Modify: `src/web/server.ts`, to mount `handleAdmin` when the flag is on
- Test: `test/cleanerHostedAdmin.test.ts`

**Interfaces:**
- Consumes: `TenantRegistry` (Task 1), `TenantSecrets` (Task 2), `HostedCleaner` and `forgetLiveDesk` (Task 5), and `OAuthGrantStore.revokeGrant`.
- Produces:
  - `setTwilioNumbersFetch(fetchImpl: typeof fetch | undefined): void`
  - `findIncomingNumber(env: NodeJS.ProcessEnv, e164: string): Promise<{ sid: string } | undefined>`. It sends GET `https://api.twilio.com/2010-04-01/Accounts/{SID}/IncomingPhoneNumbers.json?PhoneNumber=<e164>` with Basic auth from `CLEANER_CORE_TWILIO_ACCOUNT_SID` and `CLEANER_CORE_TWILIO_AUTH_TOKEN`.
  - `pointSmsWebhook(env: NodeJS.ProcessEnv, numberSid: string, smsUrl: string): Promise<boolean>`. It sends POST `…/IncomingPhoneNumbers/{sid}.json` with form `SmsUrl=<smsUrl>&SmsMethod=POST`, and `smsUrl` `""` clears it.
  - `handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL, deps: { h: HostedCleaner; password(): string | undefined; revokeGrant(grantId: string): void; grantIds(): Set<string> }): Promise<boolean>`

**Routes.** All `no-store`, all HTML, and all under `/admin`. With `CLEANER_CORE_ADMIN_PASSWORD` unset, every `/admin…` path is 404.
- `GET /admin`: the login form when signed out. Signed in, it prunes connections whose grant is gone (`grantIds()`), then lists tenants: label, number, primary's assistant, connection count, last activity, disabled.
- `POST /admin/login` (form `password`)
  - Compare with `timingSafeEqual` on sha256 digests.
  - Allow 5 failures per IP per 15 minutes, then 429 "Too many tries. Wait 15 minutes."
  - On success, set `Set-Cookie: cc_admin=<32 random bytes base64url>; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`.
  - Sessions live in an in-memory `Map` with `{ csrf, expiresAt }`.
- `POST /admin/logout`
- `POST /admin/tenants`, with form `label`, `number`, `csrf`:
  - `findIncomingNumber` (not on the account: "That number isn't on the Twilio account.")
  - `registry.create`. A `RegistryError` maps to: `bad-label` "Add a label.", `bad-number` "That isn't a phone number.", `number-taken` "Another tenant already uses that number."
  - `pointSmsWebhook(sid, origin + "/webhooks/twilio/cleaner-core")`
  - Shows a page with the invite code and `origin + "/mcp/cleaner-core"`, each with a copy button, and the line "This code is shown once."
- `GET /admin/tenants/<id>`: the detail page. It never shows phones other than the tenant's Twilio number, secrets, or codes.
- `POST /admin/tenants/<id>/invite`: shows a new code once.
- `POST /admin/tenants/<id>/primary` (form `grantId`)
- `POST /admin/tenants/<id>/disconnect` (form `grantId`): `revokeGrant`, `secrets.deleteConnection`, `registry.disconnect`.
- `POST /admin/tenants/<id>/disable` and `/enable`
- `POST /admin/tenants/<id>/delete` (form `confirm` must equal the label exactly, otherwise "Type the label to delete.")
  - Revoke every grant, `pointSmsWebhook(sid, "")`, and `forgetLiveDesk(root)`.
  - `rmSync(tenantFolder, { recursive: true, force: true })`, then `registry.remove`.
- Every POST except login needs a valid session and `csrf` equal to the session's. Otherwise answer 403 with "That form expired. Reload the page."

- [ ] **Step 1: Write the failing tests.**

```ts
it("is 404 everywhere when no password is set", async () => { for (const p of ["/admin", "/admin/tenants"]) expect((await get(p)).status).toBe(404); });
it("locks out after 5 wrong passwords", async () => { /* 5× 401 then 429 */ });
it("refuses a POST without the session's CSRF token", async () => { /* 403 + exact copy */ });
it("create checks the number on Twilio, points its webhook, and shows the invite once", async () => {
  // fake fetch: GET IncomingPhoneNumbers returns { incoming_phone_numbers: [{ sid: "PN1" }] }; record the POST
  expect(posted).toEqual([{ sid: "PN1", body: `SmsUrl=${encodeURIComponent(BASE + "/webhooks/twilio/cleaner-core")}&SmsMethod=POST` }]);
  const code = /data-invite="([^"]+)"/.exec(html)![1]!;
  expect(await (await get(`/admin/tenants/${id}`)).text()).not.toContain(code);
});
it("disconnect revokes the grant and its routine secrets", async () => { /* grant gone, secrets.connection(id, g) is {} */ });
it("delete needs the typed label, clears the webhook, drops the cached desk and the folder", async () => {
  // after delete: existsSync(tenantFolder) false, posted includes SmsUrl= (empty), a later /t/<id>/… request → 404
});
it("never renders a door code, routine key, or cleaner phone", async () => { /* seed them, render list and detail, assert absent */ });
```

- [ ] **Step 2: Run them and check they fail.** `npx vitest run test/cleanerHostedAdmin.test.ts`
- [ ] **Step 3: Implement.** Follow `src/mcp/oauth/pages.ts`'s `shell` and `escape` style for the pages, and escape every value.
- [ ] **Step 4: Run them and check they pass.** Then `npm run typecheck`.
- [ ] **Step 5: Commit.** `git commit -m "Cleaner Core: admin page to add hosts, numbers and invite codes"`

---

### Task 7: The hosted tenants gate, docs, and variables

**Files:**
- Create: `test/cleanerHostedTenants.test.ts`
- Modify:
  - `docs/cleaner-core-safety-gates.md`: add a row
  - `docs/hosted-multitenancy.md`: rewrite it
  - `docs/deployment.md`: add a section
  - `.env.example`: add `CLEANER_CORE_MULTI_TENANT` and `CLEANER_CORE_ADMIN_PASSWORD`, commented, with no values

**The gate test.** Two tenants on one running server:
- **Lane:** Twilio number `+15555550150`, host `+15555550100`, cleaner `+15555550101`, the Scratch Lane pin, Grok.
- **Court:** Twilio number `+15555550151`, host `+15555550110`, cleaner `+15555550111`, the Scratch Court pin, Claude.

Each is set up through MCP to the point where the door code is sent (follow `test/cleanerFullSetup.test.ts`'s flow), then:

```ts
it("a text to Lane's number from Court's cleaner schedules nothing and sends nothing to Court", …);
it("Court's grant calling tools never reads or writes Lane's folder", …);
it("a group webhook re-signed with /t/<lane>/ swapped to /t/<court>/ fails the signature check", …);
it("a photo link and an upload link with the tenant id swapped are 404", …);
it("each door code goes once to its own approved cleaner, and neither code is in any file under the data root", () => {
  expect(pinSends.filter((s) => s.to === "+15555550101")).toHaveLength(1);
  expect(pinSends.filter((s) => s.to === "+15555550111")).toHaveLength(1);
  for (const file of filesUnder(root)) expect(readFileSync(file, "utf8")).not.toMatch(new RegExp(`${lanePin}|${courtPin}`));
});
it("the process env's per-tenant values reach neither desk", …);
it("each tenant's desk and engine store are under its own folder, and nothing is at the data root", () => {
  // Backups need no new code: the engine's store and any snapshot live under the desk root.
  for (const t of [lane, court]) expect(existsSync(join(root, "tenants", t.id, "cleaner-live.json"))).toBe(true);
  expect(existsSync(join(root, "cleaner-live.json"))).toBe(false);
});
```

**Doc copy:**
- The safety-gates row is `| Hosted tenants | Two tenants on one multi-tenant service keep their own texts, tools, links, and door codes. A text to one number, a grant, a swapped /t/<id>/ prefix, or a process env value never reaches the other. | test/cleanerHostedTenants.test.ts |`.
- `docs/hosted-multitenancy.md` describes what is built, from the spec's Parts 1-5.
- `docs/deployment.md` lists the service's variables:
  - `TOURCORE_DEPLOYMENT_MODE=HOSTED_RAILWAY_P0`, `CLEANER_CORE_MULTI_TENANT=1`, `CLEANER_CORE_ENABLED=1`
  - `CLEANER_CORE_ADMIN_PASSWORD`, `CLEANER_CORE_TWILIO_ACCOUNT_SID`, `CLEANER_CORE_TWILIO_AUTH_TOKEN`
  - `CLEANER_CORE_LIVE_SMS`, `CLEANER_CORE_SMS_ALLOWLIST`
  - and the Railpack variables from `.railway/railway.ts`
  - It also says `CLEANER_CORE_TWILIO_PHONE_NUMBER`, `CLEANER_CORE_ASSISTANT`, and `CLEANER_CORE_MCP_TOKEN` must not be set there.

- [ ] **Step 1: Write the gate test.**
- [ ] **Step 2: Run it.** `npx vitest run test/cleanerHostedTenants.test.ts` passes, given Tasks 1-6. If it fails, the bug is in an earlier task's code: fix it there and add that case to that task's test file.
- [ ] **Step 3: Write the doc and `.env.example` changes.**
- [ ] **Step 4: Run the full checks.** `npm run typecheck && npm test && scripts/ci-check.sh` all pass.
- [ ] **Step 5: Commit.** `git commit -m "Cleaner Core: hosted tenants safety gate and deployment docs"`

---

### Task 8: Templates point at the one service (blocked)

Starts only after cutover steps 1-4 in the spec: Saad has created the service, given its `*.up.railway.app` address, and the live check passed for Grok, Claude, and ChatGPT.

**Files:**
- Modify:
  - `cleaner-template/template.json`, `cleaner-template/bot-profile.md`
  - `claude-template/template.json`, `claude-template/README.md`, `claude-template/SETUP_GUIDE.md`, `claude-template/plugin/skills/cleaner-core/SKILL.md`
  - `chatgpt-template/template.json`, `chatgpt-template/README.md`, `chatgpt-template/SETUP_GUIDE.md`
  - `.cursor/skills/verify-cleanercore/SKILL.md`
  - `test/cleanerTemplate.test.ts`

**Changes:**
- Every `hostedCleanerCoreUrl` becomes the new address.
- `hostedCleanerCoreUrlNote` in the ChatGPT template is removed.
- Remove the "Deploy (the operator, once)" sections and the `CLEANER_CORE_ASSISTANT` deployment instructions from the Claude and ChatGPT READMEs.
- Each setup guide gains one step, after adding the connector: "Saad gives you an invite code. Type it in the **Invite code from Saad** box on the Cleaner Core page that opens, then click **Allow**."

- [ ] **Step 1: Update `test/cleanerTemplate.test.ts`** to expect the new address in all three templates. Run it and check it fails.
- [ ] **Step 2: Edit the files listed above.**
- [ ] **Step 3: Run `npx vitest run test/cleanerTemplate.test.ts test/grokTemplate.test.ts`, then `npm test`.** All pass.
- [ ] **Step 4: Commit.** `git commit -m "Templates: Grok, Claude and ChatGPT all connect to the one Cleaner Core service"`
