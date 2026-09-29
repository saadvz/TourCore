import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { claimFilePath, claimHostedInstallation, HOSTED_OWNER_RESET, OWNER_SESSION_SECONDS, ownerFromCookie, pendingClaimSecret, resetHostedOwner, revokeHostedOwnerSession } from "../src/install/hostedOwner";
import { Installation } from "../src/install/installation";
import { getInstallationStatus } from "../src/install/status";
import { GROK_LEGACY_REDIRECT_URIS, grokLegacyCompatEnabled, hostedCompatStartupLine, redirectPolicyFor } from "../src/mcp/oauth/clients";
import { OPERATOR_SCOPE, REQUEST_SECONDS } from "../src/mcp/oauth/provider";
import { effectiveEnv } from "../src/install/settings";
import { readSendblueEnv, setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { PropertyWorkspace } from "../src/setup";
import { collectCanonical } from "../src/storage/canonical";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { startSetupServer } from "../src/web/server";

const DOMAIN = "demo.up.railway.app";
const BASE = `https://${DOMAIN}`;
const CURSOR_APP = "cursor://anysphere.cursor-mcp/oauth/callback";
const CURSOR_WEB = "https://www.cursor.com/agents/mcp/oauth/callback";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((run) => run()));

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tourcore-hosted-oauth-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hostedEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: DOMAIN, TOURCORE_HOME: root, PORT: "8080", ...extra };
}

function installation(root: string, env: NodeJS.ProcessEnv, now = () => Date.now()) {
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  let inst!: Installation;
  inst = new Installation({ root, runtime, env: () => env, now, sendblueEnv: () => readSendblueEnv(inst.env()) });
  return inst;
}

function hostedFetch(port: number) {
  return (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; text: () => Promise<string>; json: () => Promise<unknown> }>((resolve, reject) => {
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

function cookieJar(headers: IncomingHttpHeaders): { cookie: string; csrf: string } {
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = list.map((line) => line.split(";")[0]).join("; ");
  const csrf = /(?:^|; )tourcore_csrf=([^;]+)/.exec(cookie)?.[1] ?? "";
  return { cookie, csrf: decodeURIComponent(csrf) };
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function hostedApp(options: { env?: NodeJS.ProcessEnv; now?: () => number; authNow?: () => number; seed?: boolean } = {}) {
  const root = tempDir();
  const env = options.env ?? hostedEnv(root);
  const inst = installation(root, env, options.now);
  inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
  const workspace = new PropertyWorkspace(root);
  if (options.seed) workspace.save(loadConfig());
  const logs: string[] = [];
  cleanups.push(setSendblueRuntime({ env: () => readSendblueEnv(effectiveEnv(env, inst.settingsSource())) }));
  const { server } = await startSetupServer({
    installation: inst,
    workspace,
    host: "127.0.0.1",
    port: 0,
    open: false,
    oauthRateLimit: false,
    authNow: options.authNow ?? options.now,
    now: options.now ? () => new Date(options.now!()) : undefined,
    log: (line) => logs.push(line),
  });
  cleanups.push(() => server.close());
  const port = (server.address() as { port: number }).port;
  return { inst, root, env, logs, http: hostedFetch(port), server, port };
}

describe("hosted Grok callback compatibility", () => {
  it("turns the narrow list on for HOSTED_RAILWAY_P0 unless it is explicitly false", () => {
    expect(grokLegacyCompatEnabled({}, "HOSTED_RAILWAY_P0")).toBe(true);
    expect(grokLegacyCompatEnabled({ TOURCORE_GROK_LEGACY_OAUTH_COMPAT: "1" }, "HOSTED_RAILWAY_P0")).toBe(true);
    expect(grokLegacyCompatEnabled({ TOURCORE_GROK_LEGACY_OAUTH_COMPAT: "false" }, "HOSTED_RAILWAY_P0")).toBe(false);
    expect(grokLegacyCompatEnabled({ TOURCORE_GROK_LEGACY_OAUTH_COMPAT: " FALSE " }, "HOSTED_RAILWAY_P0")).toBe(false);
    expect(grokLegacyCompatEnabled({ TOURCORE_GROK_LEGACY_OAUTH_COMPAT: "true" }, "LOCAL_DEVELOPER")).toBe(true);
    expect(grokLegacyCompatEnabled({}, "LOCAL_DEVELOPER")).toBe(false);
    expect(grokLegacyCompatEnabled({}, "SELF_HOSTED")).toBe(false);
    expect(grokLegacyCompatEnabled({}, "GROK_MANAGED_P0")).toBe(false);
    expect(redirectPolicyFor({}, "HOSTED_RAILWAY_P0").exact).toEqual([...GROK_LEGACY_REDIRECT_URIS]);
    expect(redirectPolicyFor({ TOURCORE_GROK_LEGACY_OAUTH_COMPAT: "false" }, "HOSTED_RAILWAY_P0").exact).toEqual([]);
    expect(hostedCompatStartupLine({}, "HOSTED_RAILWAY_P0")).toBe("Grok legacy OAuth compatibility active for HOSTED_RAILWAY_P0.");
    expect(hostedCompatStartupLine({ TOURCORE_GROK_LEGACY_OAUTH_COMPAT: "false" }, "HOSTED_RAILWAY_P0")).toMatch(/false/);
    expect(hostedCompatStartupLine({}, "LOCAL_DEVELOPER")).toBeUndefined();
  });

  it("accepts the known Grok callbacks on a hosted server without the Railway flag", async () => {
    const { http, logs } = await hostedApp();
    for (const uri of [CURSOR_WEB, CURSOR_APP]) {
      const res = await http("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Cursor", redirect_uris: [uri], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }),
      });
      expect(res.status, uri).toBe(201);
    }
    const log = logs.join("\n");
    expect(log).toContain("accepted redirect: scheme=https host=www.cursor.com path=/agents/mcp/oauth/callback reason: known Grok legacy callback");
    expect(log).toContain("accepted redirect: scheme=cursor host=anysphere.cursor-mcp path=/oauth/callback reason: known Grok legacy callback");
    expect(log).not.toContain("TOURCORE_GROK_LEGACY_OAUTH_COMPAT=true");
  });

  it("rejects lookalikes, other cursor hosts, changed paths and added queries", async () => {
    const { http, logs } = await hostedApp();
    const lookalikes = [
      "cursor://anysphere.cursor-mcp/oauth/callback2",
      "cursor://anysphere.cursor-mcp/oauth/callback?x=evil-query-secret",
      "https://www.cursor.com/agents/mcp/oauth/callback/extra",
      "https://www.cursor.com/agents/mcp/oauth/callback?next=evil-query-secret",
      "https://cursor.com/agents/mcp/oauth/callback",
      "https://evil.cursor.com/agents/mcp/oauth/callback",
      "https://api2.cursor.sh/agents/mcp/oauth/callback",
      "https://user:embedded-secret@www.cursor.com/agents/mcp/oauth/callback",
      "http://www.cursor.com/agents/mcp/oauth/callback",
      "https://www.cursor.com.evil.example/agents/mcp/oauth/callback",
    ];
    for (const uri of lookalikes) {
      const res = await http("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Cursor", redirect_uris: [uri], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }),
      });
      expect(res.status, uri).toBe(400);
    }
    const log = logs.join("\n");
    expect(log).toContain("refused redirect: scheme=cursor host=anysphere.cursor-mcp path=/oauth/callback2");
    expect(log).toContain("refused redirect: scheme=https host=cursor.com path=/agents/mcp/oauth/callback");
    expect(log).toContain("refused redirect: scheme=https host=api2.cursor.sh path=/agents/mcp/oauth/callback");
    expect(log).toContain("reason: contains credentials");
    expect(log).not.toContain("evil-query-secret");
    expect(log).not.toContain("embedded-secret");
  });

  it("lets an explicit false turn the hosted default off", async () => {
    const root = tempDir();
    const { http, logs } = await hostedApp({ env: hostedEnv(root, { TOURCORE_GROK_LEGACY_OAUTH_COMPAT: "false" }) });
    const refused = await http("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Cursor", redirect_uris: [CURSOR_WEB, CURSOR_APP], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    expect(refused.status).toBe(400);
    expect(logs.join("\n")).toContain("TOURCORE_GROK_LEGACY_OAUTH_COMPAT=false");
    const allowed = await http("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Grok", redirect_uris: ["https://grok.com/connectors/oauth/callback"], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    expect(allowed.status).toBe(201);
  });
});

describe("hosted owner claim", () => {
  it("starts unclaimed, rejects a bad claim, accepts one claim, and keeps the owner across a restart", async () => {
    const app = await hostedApp();
    const secret = readFileSync(claimFilePath(app.root), "utf8").trim();
    expect(app.inst.secrets.hostedOwner()?.claimed).toBe(false);
    expect(pendingClaimSecret(app.inst)).toBe(secret);
    const status = JSON.stringify(getInstallationStatus(app.inst, { workspace: new PropertyWorkspace(app.root) }));
    expect(status).not.toContain(secret);
    expect(app.logs.join("\n")).not.toContain(secret);
    expect(readFileSync(join(app.root, "install", "secrets.json"), "utf8")).not.toContain(secret);
    expect(JSON.stringify(collectCanonical(app.root))).not.toContain(secret);

    const anon = await app.http("/api/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "not-the-claim-code-000000000000" }) });
    expect(anon.status).toBe(401);
    expect(anon.headers["set-cookie"]).toBeUndefined();
    expect(app.inst.secrets.hostedOwner()?.claimed).toBe(false);

    const claimed = await app.http("/api/claim", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ code: secret }) });
    expect(claimed.status).toBe(200);
    const setCookie = (Array.isArray(claimed.headers["set-cookie"]) ? claimed.headers["set-cookie"] : [claimed.headers["set-cookie"]]).join("\n");
    expect(setCookie).toMatch(/tourcore_owner=[^;]+; HttpOnly; Path=\/; Secure; SameSite=Lax; Max-Age=604800/);
    expect(setCookie).toMatch(/tourcore_csrf=[^;]+; Path=\/; Secure; SameSite=Lax/);
    expect(setCookie).not.toMatch(/tourcore_csrf=[^;]+; HttpOnly/);
    const session = cookieJar(claimed.headers);
    expect(app.inst.secrets.hostedOwner()?.claimed).toBe(true);
    expect(app.inst.secrets.hostedOwner()?.ownerId).toMatch(/^own_/);
    const ownerId = app.inst.secrets.hostedOwner()!.ownerId;
    expect(readFileSync(join(app.root, "install", "secrets.json"), "utf8")).not.toContain(secret);
    expect(pendingClaimSecret(app.inst)).toBeUndefined();

    const again = await app.http("/api/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: secret }) });
    expect(again.status).toBe(401);
    expect(await again.text()).toMatch(/already claimed/);

    app.inst.secrets.set({ SENDBLUE_API_API_KEY: "sb-api-key-SECRETVALUE-11111111" });
    expect(app.inst.secrets.hostedOwner()?.ownerId).toBe(ownerId);

    const restarted = installation(app.root, app.env);
    expect(restarted.secrets.hostedOwner()?.ownerId).toBe(ownerId);
    expect(ownerFromCookie(restarted, session.cookie).ok).toBe(true);
    const { server } = await startSetupServer({ installation: restarted, workspace: new PropertyWorkspace(app.root), host: "127.0.0.1", port: 0, open: false, oauthRateLimit: false, log: (line) => app.logs.push(line) });
    cleanups.push(() => server.close());
    const http = hostedFetch((server.address() as { port: number }).port);
    const still = await http("/api/connect?request=not-a-real-request-id", { headers: { cookie: session.cookie } });
    expect(still.status).toBe(404);
    expect(app.logs.join("\n")).not.toContain(secret);

    expect(revokeHostedOwnerSession(restarted)).toBe(true);
    expect((await http("/api/connect?request=not-a-real-request-id", { headers: { cookie: session.cookie } })).status).toBe(401);
    expect((await http("/api/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: secret }) })).status).toBe(401);

    resetHostedOwner(restarted);
    expect(restarted.secrets.hostedOwner()?.claimed).toBe(false);
    const replacement = pendingClaimSecret(restarted)!;
    expect(replacement).not.toBe(secret);
    expect((await http("/api/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: secret }) })).status).toBe(401);
    expect((await http("/api/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: replacement }) })).status).toBe(200);
    expect(HOSTED_OWNER_RESET).toBe("reset-hosted-owner");
  });

  it("expires the owner session", async () => {
    const clock = { t: Date.parse("2026-09-28T15:00:00.000Z") };
    const app = await hostedApp({ now: () => clock.t, authNow: () => clock.t });
    const secret = pendingClaimSecret(app.inst)!;
    const claimed = claimHostedInstallation(app.inst, secret);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const cookie = `tourcore_owner=${claimed.token}`;
    expect(ownerFromCookie(app.inst, cookie).ok).toBe(true);
    clock.t += OWNER_SESSION_SECONDS * 1000 + 1;
    expect(ownerFromCookie(app.inst, cookie)).toEqual({ ok: false, reason: "expired" });
    expect(app.inst.secrets.hostedOwner()?.ownerId).toBe(claimed.ownerId);
  });
});

describe("hosted OAuth approval handoff", () => {
  it("runs Grok authorize, owner approval, and token exchange for the same request", async () => {
    const app = await hostedApp({ seed: true });
    const { verifier, challenge } = pkce();
    const state = "state-preserve-xyz";
    const registered = await app.http("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Cursor", redirect_uris: [CURSOR_WEB, CURSOR_APP, "http://localhost:8787/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string };
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: CURSOR_WEB,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: OPERATOR_SCOPE,
      resource: `${BASE}/mcp`,
    });
    const authorize = await app.http(`/authorize?${query}`);
    expect(authorize.status).toBe(200);
    const html = await authorize.text();
    const requestId = /data-request="([^"]+)"/.exec(html)?.[1];
    const matchCode = /class="match-code">([^<]+)/.exec(html)?.[1];
    expect(requestId).toBeTruthy();
    expect(matchCode).toMatch(/^\d{3} \d{3}$/);
    expect(html).toContain("Tour Core needs you to confirm ownership of this hosted installation before you can approve connections.");
    expect(html).toContain(`/claim?request=${requestId}`);
    expect(html).not.toMatch(/>\s*Allow\s*</);
    expect(html).not.toContain("Continue to approval");

    const bare = await app.http("/connect");
    expect(bare.status).toBe(400);
    expect(await bare.text()).toContain("This approval link is missing or was opened without its code.");
    expect((await app.http(`/api/connect?request=${requestId}`)).status).toBe(401);
    expect((await app.http("/api/connect/approve", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer grok-mcp-token" }, body: JSON.stringify({ requestId, matchCode }) })).status).toBe(401);

    const secret = pendingClaimSecret(app.inst)!;
    const claimed = await app.http("/api/claim", {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ code: secret, requestId }),
    });
    expect(claimed.status).toBe(200);
    expect((await claimed.json()) as { next?: string }).toEqual({ ok: true, next: `/connect?request=${requestId}` });
    const session = cookieJar(claimed.headers);
    expect(app.logs.join("\n")).not.toContain(secret);
    expect(app.logs.join("\n")).not.toContain(verifier);

    const ownerPage = await app.http(`/authorize?${query}`, { headers: { cookie: session.cookie } });
    const ownerHtml = await ownerPage.text();
    expect(ownerHtml).toContain("Continue to approval");
    expect(ownerHtml).toContain(`/connect?request=`);
    expect(ownerHtml).not.toMatch(/>\s*Allow\s*</);

    const pending = await app.http(`/api/connect?request=${requestId}`, { headers: { cookie: session.cookie } });
    expect(pending.status).toBe(200);
    expect((await pending.json()) as { request: { matchCode: string } }).toMatchObject({ request: { id: requestId, matchCode } });
    expect((await app.http("/api/connect", { headers: { cookie: session.cookie } })).status).toBe(400);
    expect((await app.http("/api/connect?request=not-a-real-request-id", { headers: { cookie: session.cookie } })).status).toBe(404);
    expect((await app.http("/api/connect/approve", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session.cookie, "x-tourcore-csrf": session.csrf, origin: BASE, authorization: "Bearer grok-mcp-token" },
      body: JSON.stringify({ requestId, matchCode }),
    })).status).toBe(401);
    expect((await app.http("/api/connect/approve", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session.cookie, origin: BASE },
      body: JSON.stringify({ requestId, matchCode }),
    })).status).toBe(403);
    expect((await app.http("/api/connect/approve", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session.cookie, "x-tourcore-csrf": session.csrf, origin: "https://evil.example" },
      body: JSON.stringify({ requestId, matchCode }),
    })).status).toBe(403);

    const allowed = await app.http("/api/connect/approve", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session.cookie, "x-tourcore-csrf": session.csrf, origin: BASE },
      body: JSON.stringify({ requestId, matchCode }),
    });
    expect(allowed.status).toBe(200);
    expect((await app.http("/api/connect/approve", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session.cookie, "x-tourcore-csrf": session.csrf, origin: BASE },
      body: JSON.stringify({ requestId, matchCode }),
    })).status).toBe(404);

    const back = await app.http(`/oauth/requests/${requestId}/continue`);
    expect(back.status).toBe(302);
    const location = new URL(back.headers.location!);
    expect(location.origin + location.pathname).toBe(CURSOR_WEB);
    expect(location.searchParams.get("state")).toBe(state);
    expect(location.searchParams.get("iss")).toBe(BASE);
    const code = location.searchParams.get("code")!;
    expect(code).toMatch(/^tcc_/);

    const wrong = await app.http("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: client.client_id, redirect_uri: CURSOR_WEB, resource: `${BASE}/mcp` }).toString(),
    });
    expect(((await wrong.json()) as { error: string }).error).toBe("invalid_grant");
    const token = await app.http("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CURSOR_WEB, resource: `${BASE}/mcp` }).toString(),
    });
    expect(token.status).toBe(200);
    const access = ((await token.json()) as { access_token: string }).access_token;
    expect(access).toMatch(/^tca_/);
    const listed = await app.http("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_properties", arguments: {} } }),
    });
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain("100 Alfred Way");
    const spoken = app.logs.join("\n") + (await listed.text());
    for (const hidden of [secret, verifier, code, access]) expect(spoken).not.toContain(hidden);
    expect(readFileSync(new URL("../src/web/public/connect.js", import.meta.url), "utf8")).toContain("Make sure this matches the sign-in page:");
  });

  it("denies, expires, and keeps a cursor:// callback's state", async () => {
    const clock = { t: Date.parse("2026-09-28T15:00:00.000Z") };
    const app = await hostedApp({ now: () => clock.t, authNow: () => clock.t, seed: true });
    const secret = pendingClaimSecret(app.inst)!;
    const claimed = await app.http("/api/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: secret }) });
    const session = cookieJar(claimed.headers);
    const registered = await app.http("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Cursor", redirect_uris: [CURSOR_APP], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    const client = (await registered.json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const state = "cursor-state-1";
    const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CURSOR_APP, code_challenge: challenge, code_challenge_method: "S256", state, scope: OPERATOR_SCOPE, resource: `${BASE}/mcp` });
    const opened = await app.http(`/authorize?${query}`, { headers: { cookie: session.cookie } });
    const html = await opened.text();
    const requestId = /data-request="([^"]+)"/.exec(html)![1]!;
    const matchCode = /class="match-code">([^<]+)/.exec(html)![1]!;
    expect(html).toContain("Continue to approval");
    expect(html).toContain(`/connect?request=${requestId}`);

    clock.t += REQUEST_SECONDS * 1000 + 1;
    const expired = await app.http(`/api/connect?request=${requestId}`, { headers: { cookie: session.cookie } });
    expect(expired.status).toBe(404);
    expect(await expired.text()).toMatch(/expired/);

    clock.t += 1000;
    const again = await app.http(`/authorize?${query}`, { headers: { cookie: session.cookie } });
    const secondHtml = await again.text();
    const secondId = /data-request="([^"]+)"/.exec(secondHtml)![1]!;
    const secondCode = /class="match-code">([^<]+)/.exec(secondHtml)![1]!;
    const denied = await app.http("/api/connect/deny", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session.cookie, "x-tourcore-csrf": session.csrf, origin: BASE },
      body: JSON.stringify({ requestId: secondId, matchCode: secondCode }),
    });
    expect(denied.status).toBe(200);
    const back = await app.http(`/oauth/requests/${secondId}/continue`);
    const location = new URL(back.headers.location!);
    expect(location.protocol).toBe("cursor:");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe(state);
    expect(location.searchParams.get("code")).toBeNull();
    expect(verifier).toBeTruthy();
  });
});
