import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetLiveDesks } from "../src/cleaner-core/liveDesk";
import { Installation } from "../src/install/installation";
import { bindHostedTenant, CLEANER_HOSTED_OWNER_RESET, resetHostedCleanerOwner } from "../src/install/tenant";
import { CLEANER_SCOPE, OPERATOR_SCOPE } from "../src/mcp/oauth/provider";
import { hashSecret, OAuthGrantStore } from "../src/mcp/oauth/store";
import { effectiveEnv } from "../src/install/settings";
import { readSendblueEnv, setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { PropertyWorkspace } from "../src/setup";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { startSetupServer } from "../src/web/server";

/**
 * A new Grok Bot connects to a hosted Cleaner Core with one Allow, over the
 * same OAuth server as Tour Core but as its own protected resource. Tokens
 * never cross between /mcp and /mcp/cleaner-core. No real phone, no network.
 */

const DOMAIN = "cleaner-demo.up.railway.app";
const BASE = `https://${DOMAIN}`;
const CLEANER_RESOURCE = `${BASE}/mcp/cleaner-core`;
const CLEANER_PRM = `${BASE}/.well-known/oauth-protected-resource/mcp/cleaner-core`;
const TOUR_PRM = `${BASE}/.well-known/oauth-protected-resource/mcp`;
const REDIRECT = "https://grok.com/connectors/oauth/callback";
const FIXED_TOKEN = "cleaner-fixed-token-for-tests-only";
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((run) => run());
  resetLiveDesks();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tourcore-cleaner-oauth-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hostedEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: DOMAIN, TOURCORE_HOME: root, PORT: "8080", CLEANER_CORE_ENABLED: "1", ...extra };
}

function installation(root: string, env: NodeJS.ProcessEnv) {
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  let inst!: Installation;
  inst = new Installation({ root, runtime, env: () => env, sendblueEnv: () => readSendblueEnv(inst.env()) });
  return inst;
}

type Reply = { status: number; headers: IncomingHttpHeaders; text: () => Promise<string>; json: () => Promise<unknown> };

function hostedFetch(port: number) {
  return (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const body = init.body ? Buffer.from(init.body) : undefined;
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: init.method ?? "GET",
          headers: { host: DOMAIN, "x-forwarded-proto": "https", ...init.headers, ...(body ? { "content-length": String(body.length) } : {}) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text: async () => raw, json: async () => (raw ? JSON.parse(raw) : {}) });
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function hostedApp(extra: NodeJS.ProcessEnv = {}, existing?: { root: string; env: NodeJS.ProcessEnv }, mcpAuth?: "static") {
  const root = existing?.root ?? tempDir();
  const env = existing?.env ?? hostedEnv(root, extra);
  const inst = installation(root, env);
  inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
  const logs: string[] = [];
  cleanups.push(setSendblueRuntime({ env: () => readSendblueEnv(effectiveEnv(env, inst.settingsSource())) }));
  const { server } = await startSetupServer({
    toolSurface: "all",
    installation: inst,
    workspace: new PropertyWorkspace(root),
    host: "127.0.0.1",
    port: 0,
    open: false,
    oauthRateLimit: false,
    ...(mcpAuth ? { mcpAuth } : {}),
    log: (line) => logs.push(line),
  });
  cleanups.push(() => server.close());
  const http = hostedFetch((server.address() as { port: number }).port);

  const register = async (name = "Grok") => {
    const res = await http("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { client_id: string }).client_id;
  };

  const authorize = (clientId: string, challenge: string, resource: string, scope: string, state = "state-1") =>
    http(`/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state, scope, resource })}`);

  const pageParts = (html: string) => ({ id: /data-request="([^"]+)"/.exec(html)![1]!, code: /class="match-code">([^<]+)/.exec(html)![1]! });

  const approve = (id: string, code: string, headers: Record<string, string> = {}) =>
    http(`/oauth/requests/${id}/approve`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ matchCode: code }) });

  /** The whole dance for one resource. Returns the access token. */
  const connect = async (clientId: string, resource: string, scope: string, tokenResource = resource) => {
    const { verifier, challenge } = pkce();
    const page = await authorize(clientId, challenge, resource, scope);
    expect(page.status).toBe(200);
    const { id, code } = pageParts(await page.text());
    expect((await approve(id, code)).status).toBe(200);
    const back = await http(`/oauth/requests/${id}/continue`);
    expect(back.status).toBe(302);
    const location = new URL(back.headers.location!);
    const token = await http("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: location.searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: tokenResource }).toString(),
    });
    expect(token.status).toBe(200);
    const body = (await token.json()) as { access_token: string; refresh_token: string; scope: string };
    return { access: body.access_token, refresh: body.refresh_token, scope: body.scope, verifier };
  };

  const refresh = (clientId: string, refreshToken: string, resource: string) =>
    http("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource }).toString(),
    });

  const rpc = (path: string, method: string, token?: string) =>
    http(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
    });

  return { inst, root, env, logs, http, register, authorize, pageParts, approve, connect, refresh, rpc };
}

describe("Cleaner Core OAuth", () => {
  it("a new Grok Bot connects to Cleaner Core with one Allow", async () => {
    const app = await hostedApp();

    // Discovery: an unauthenticated call points at the cleaner's own metadata.
    const first = await app.rpc("/mcp/cleaner-core", "tools/list");
    expect(first.status).toBe(401);
    expect(first.headers["www-authenticate"]).toBe(`Bearer resource_metadata="${CLEANER_PRM}", scope="${CLEANER_SCOPE}"`);
    const prm = await app.http("/.well-known/oauth-protected-resource/mcp/cleaner-core");
    expect(prm.status).toBe(200);
    expect(await prm.json()).toEqual({ resource: CLEANER_RESOURCE, authorization_servers: [BASE], scopes_supported: [CLEANER_SCOPE], bearer_methods_supported: ["header"], resource_name: "Cleaner Core" });
    const asMeta = (await (await app.http("/.well-known/oauth-authorization-server")).json()) as { scopes_supported: string[] };
    expect(asMeta.scopes_supported).toEqual([OPERATOR_SCOPE, CLEANER_SCOPE]);

    const clientId = await app.register("Grok");
    const { challenge } = pkce();
    const page = await app.authorize(clientId, challenge, CLEANER_RESOURCE, CLEANER_SCOPE);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Connect your Grok Bot to Cleaner Core");
    expect(html).toContain(">Allow</button>");
    expect(html).not.toContain("Tour Core demo");

    // Grok can't approve itself: a request carrying Authorization is refused.
    const { id, code } = app.pageParts(html);
    expect((await app.approve(id, code, { authorization: "Bearer grok-mcp-token" })).status).toBe(401);
    expect(app.inst.files.state().hostedCleanerTenant).toBeUndefined();
    await app.http(`/oauth/requests/${id}/deny`, { method: "POST" });

    const { access, scope, verifier } = await app.connect(clientId, CLEANER_RESOURCE, CLEANER_SCOPE);
    expect(scope).toBe(CLEANER_SCOPE);
    expect(app.inst.files.state().hostedCleanerTenant?.clientId).toBe(clientId);
    expect(app.inst.files.state().hostedTenant).toBeUndefined();

    const listed = await app.rpc("/mcp/cleaner-core", "tools/list", access);
    expect(listed.status).toBe(200);
    const tools = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(tools).toContain("get_state");

    const log = app.logs.join("\n");
    expect(log).not.toContain(access);
    expect(log).not.toContain(verifier);
  });

  it("a request whose resource is the bare origin stays Tour Core", async () => {
    const app = await hostedApp();
    const clientId = await app.register("Grok");
    const page = await app.authorize(clientId, pkce().challenge, BASE, OPERATOR_SCOPE);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<title>Connect to Tour Core</title>");
    expect(html).not.toContain("Cleaner Core");
  });

  it("Tour Core still exchanges and refreshes with the bare origin", async () => {
    const app = await hostedApp();
    const clientId = await app.register("Grok");
    const tour = await app.connect(clientId, BASE, OPERATOR_SCOPE, BASE);
    expect(tour.scope).toBe(OPERATOR_SCOPE);
    expect((await app.rpc("/mcp", "tools/list", tour.access)).status).toBe(200);
    const refreshed = await app.refresh(clientId, tour.refresh, BASE);
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string };
    expect((await app.rpc("/mcp", "tools/list", next.access_token)).status).toBe(200);
    expect((await app.rpc("/mcp/cleaner-core", "tools/list", next.access_token)).status).toBe(401);
  });

  it("a cleaner refresh can't name Tour Core", async () => {
    const app = await hostedApp();
    const clientId = await app.register("Grok");
    const cleaner = await app.connect(clientId, CLEANER_RESOURCE, CLEANER_SCOPE);
    for (const resource of [BASE, `${BASE}/mcp`]) {
      const res = await app.refresh(clientId, cleaner.refresh, resource);
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain("access_token");
    }
  });

  it("tokens do not cross", async () => {
    const app = await hostedApp();
    const cleanerClient = await app.register("Grok cleaner");
    const tourClient = await app.register("Grok tours");
    const cleaner = await app.connect(cleanerClient, CLEANER_RESOURCE, CLEANER_SCOPE);
    const tour = await app.connect(tourClient, `${BASE}/mcp`, OPERATOR_SCOPE);
    expect(tour.scope).toBe(OPERATOR_SCOPE);
    expect(app.inst.files.state().hostedTenant?.clientId).toBe(tourClient);
    expect(app.inst.files.state().hostedCleanerTenant?.clientId).toBe(cleanerClient);

    const cleanerOnTour = await app.rpc("/mcp", "tools/list", cleaner.access);
    expect(cleanerOnTour.status).toBe(401);
    expect(String(cleanerOnTour.headers["www-authenticate"])).toContain(`resource_metadata="${TOUR_PRM}"`);
    expect(await cleanerOnTour.text()).not.toContain("tools");

    const tourOnCleaner = await app.rpc("/mcp/cleaner-core", "tools/list", tour.access);
    expect(tourOnCleaner.status).toBe(401);
    expect(String(tourOnCleaner.headers["www-authenticate"])).toContain(`resource_metadata="${CLEANER_PRM}"`);
    expect(await tourOnCleaner.text()).not.toContain("get_state");

    // Each still opens its own door.
    expect((await app.rpc("/mcp/cleaner-core", "tools/list", cleaner.access)).status).toBe(200);
    expect((await app.rpc("/mcp", "tools/list", tour.access)).status).toBe(200);
  });

  it("a cleaner grant needs the cleaner scope", async () => {
    const app = await hostedApp();
    const clientId = await app.register("Grok");
    const store = new OAuthGrantStore(new FileRuntimeStore(join(app.root, "runtime")));
    const t = Date.now();
    for (const [access, scopes] of [["tca_cleaner-no-scope-test", []], ["tca_cleaner-tour-scope-test", [OPERATOR_SCOPE]]] as const) {
      store.addGrant({ clientId, issuer: BASE, resource: CLEANER_RESOURCE, scopes: [...scopes], createdAt: t, expiresAt: t + 3_600_000, accessHash: hashSecret(access), accessExpiresAt: t + 3_600_000 });
      const res = await app.rpc("/mcp/cleaner-core", "tools/list", access);
      expect(res.status).toBe(403);
      expect(String(res.headers["www-authenticate"])).toContain('error="insufficient_scope"');
      expect(await res.text()).not.toContain("get_state");
    }
  });

  it("a cleaner code can't be redeemed for Tour Core", async () => {
    const app = await hostedApp();
    const clientId = await app.register("Grok");
    const { verifier, challenge } = pkce();
    const { id, code } = app.pageParts(await (await app.authorize(clientId, challenge, CLEANER_RESOURCE, CLEANER_SCOPE)).text());
    expect((await app.approve(id, code)).status).toBe(200);
    const location = new URL((await app.http(`/oauth/requests/${id}/continue`)).headers.location!);
    for (const resource of [`${BASE}/mcp`, BASE]) {
      const token = await app.http("/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: location.searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource }).toString(),
      });
      expect(token.status).toBe(400);
      expect(await token.text()).not.toContain("access_token");
    }
  });

  it("a second Grok Bot is refused", async () => {
    const app = await hostedApp();
    const owner = await app.register("Grok");
    await app.connect(owner, CLEANER_RESOURCE, CLEANER_SCOPE);
    expect(app.inst.files.state().hostedCleanerTenant?.clientId).toBe(owner);
    expect(app.inst.files.state().hostedTenant).toBeUndefined();

    const other = await app.register("Other Grok");
    const refused = await app.authorize(other, pkce().challenge, CLEANER_RESOURCE, CLEANER_SCOPE);
    expect(refused.status).toBe(403);
    const html = await refused.text();
    expect(html).toContain("Cleaner Core");
    expect(html).not.toContain(">Allow</button>");
    expect(app.inst.files.state().hostedCleanerTenant?.clientId).toBe(owner);

    // The owner reconnects without the first-claim line.
    const again = await app.authorize(owner, pkce().challenge, CLEANER_RESOURCE, CLEANER_SCOPE);
    expect(again.status).toBe(200);
    expect(await again.text()).not.toContain("the owner of this Cleaner Core");

    // The cleaner binding is separate: the other client can still claim Tour Core on a shared host.
    await app.connect(other, `${BASE}/mcp`, OPERATOR_SCOPE);
    expect(app.inst.files.state().hostedTenant?.clientId).toBe(other);
    expect(app.inst.files.state().hostedCleanerTenant?.clientId).toBe(owner);
  });

  it("a Tour Core owner doesn't claim Cleaner Core", async () => {
    const app = await hostedApp();
    bindHostedTenant(app.inst.files, "someone-else", new Date());
    const clientId = await app.register("Grok");
    const page = await app.authorize(clientId, pkce().challenge, CLEANER_RESOURCE, CLEANER_SCOPE);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("the owner of this Cleaner Core");
  });

  it("reset clears the cleaner owner", async () => {
    const app = await hostedApp();
    const owner = await app.register("Grok");
    const cleaner = await app.connect(owner, CLEANER_RESOURCE, CLEANER_SCOPE);
    const tourClient = await app.register("Grok tours");
    const tour = await app.connect(tourClient, `${BASE}/mcp`, OPERATOR_SCOPE);
    expect(app.inst.files.state().hostedTenant?.clientId).toBe(tourClient);
    expect(CLEANER_HOSTED_OWNER_RESET).toBe("reset-cleaner-owner");
    const revoke = () => new OAuthGrantStore(new FileRuntimeStore(join(app.root, "runtime"))).revokeForPath("/mcp/cleaner-core");

    expect(resetHostedCleanerOwner({ CLEANER_CORE_HOSTED_OWNER_RESET: "yes" }, app.inst.files, revoke)).toBe(false);
    expect(resetHostedCleanerOwner({}, app.inst.files, revoke)).toBe(false);
    expect(app.inst.files.state().hostedCleanerTenant?.clientId).toBe(owner);
    expect((await app.rpc("/mcp/cleaner-core", "tools/list", cleaner.access)).status).toBe(200);

    expect(resetHostedCleanerOwner({ CLEANER_CORE_HOSTED_OWNER_RESET: "reset-cleaner-owner" }, app.inst.files, revoke)).toBe(true);
    expect(app.inst.files.state().hostedCleanerTenant).toBeUndefined();
    expect(app.inst.files.state().hostedTenant?.clientId).toBe(tourClient);
    expect(resetHostedCleanerOwner({ CLEANER_CORE_HOSTED_OWNER_RESET: "reset-cleaner-owner" }, app.inst.files, revoke)).toBe(false);

    // The previous owner's cleaner access ends now: its access token and its refresh token.
    expect((await app.rpc("/mcp/cleaner-core", "tools/list", cleaner.access)).status).toBe(401);
    const refused = await app.refresh(owner, cleaner.refresh, CLEANER_RESOURCE);
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain("access_token");

    // Tour Core's grant is untouched.
    expect((await app.rpc("/mcp", "tools/list", tour.access)).status).toBe(200);
    expect((await app.refresh(tourClient, tour.refresh, `${BASE}/mcp`)).status).toBe(200);

    const next = await app.register("Next Grok");
    const page = await app.authorize(next, pkce().challenge, CLEANER_RESOURCE, CLEANER_SCOPE);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("the owner of this Cleaner Core");
  });

  it("the fixed token still works", async () => {
    const app = await hostedApp({ CLEANER_CORE_MCP_TOKEN: FIXED_TOKEN });
    const listed = await app.rpc("/mcp/cleaner-core", "tools/list", FIXED_TOKEN);
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain("get_state");
    const wrong = await app.rpc("/mcp/cleaner-core", "tools/list", "not-the-fixed-token");
    expect(wrong.status).toBe(401);
    // The fixed token never opens Tour Core.
    expect((await app.rpc("/mcp", "tools/list", FIXED_TOKEN)).status).toBe(401);
  });

  it("stays off without a fixed token or OAuth", async () => {
    const root = tempDir();
    const app = await hostedApp({}, { root, env: hostedEnv(root) }, "static");
    const off = await app.rpc("/mcp/cleaner-core", "tools/list", "anything");
    expect(off.status).toBe(503);
  });

  it("publishes no cleaner resource when Cleaner Core is off", async () => {
    const root = tempDir();
    const app = await hostedApp({}, { root, env: hostedEnv(root, { CLEANER_CORE_ENABLED: "0" }) });
    const asMeta = (await (await app.http("/.well-known/oauth-authorization-server")).json()) as { scopes_supported: string[] };
    expect(asMeta.scopes_supported).toEqual([OPERATOR_SCOPE]);
    expect((await app.http("/.well-known/oauth-protected-resource/mcp/cleaner-core")).status).toBe(404);
    const clientId = await app.register("Grok");
    const page = await app.authorize(clientId, pkce().challenge, CLEANER_RESOURCE, CLEANER_SCOPE);
    expect(page.status).not.toBe(200);
  });
});
