import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { mcpAuthModeFromEnv } from "../src/mcp/authMode";
import { OAuthGrantStore, OPERATOR_SCOPE } from "../src/mcp/oauth";
import { checkRedirectUri, DEFAULT_REDIRECT_HOSTS, strictPolicy } from "../src/mcp/oauth/clients";
import { hashSecret } from "../src/mcp/oauth/store";
import { setSendblueRuntime, type SendblueEnv } from "../src/messaging/sendblue/runtime";
import { OPERATOR_TOOLS } from "../src/operator/tools";
import { PropertyWorkspace } from "../src/setup";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import type { McpAuthMode } from "../src/mcp/authMode";
import { createSetupServer } from "../src/web/server";
import { PUBLIC, sendblueEnv } from "./fakeSendblue";
import { at } from "./grokHarness";

/**
 * OAuth for /mcp, end to end over HTTP, with requests arriving through the
 * public tunnel host exactly as Grok's would. No Grok account or network.
 */

const ISSUER = PUBLIC;
const RESOURCE = `${PUBLIC}/mcp`;
const PRM_URL = `${PUBLIC}/.well-known/oauth-protected-resource/mcp`;
const REDIRECT = "https://grok.com/connectors/oauth/callback";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** fetch() can't set Host, so requests for the public address go over raw HTTP with that Host, as cloudflared sends them. */
function tunnelFetch(port: number, extraHeaders: Record<string, string> = {}): Fetch {
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    let body: Buffer | undefined;
    if (typeof init.body === "string") body = Buffer.from(init.body);
    else if (init.body instanceof URLSearchParams) {
      body = Buffer.from(init.body.toString());
      if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    } else if (init.body) body = Buffer.from(await new Response(init.body).arrayBuffer());
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: `${url.pathname}${url.search}`, method, headers: { ...Object.fromEntries(headers), ...extraHeaders, host: url.host, ...(body ? { "content-length": String(body.length) } : {}) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : String(v));
            const status = res.statusCode ?? 0;
            resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: h }));
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  };
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function oauthApp(options: { mcpAuth?: McpAuthMode; operatorToken?: () => string | undefined; fetchClientMetadata?: (id: string) => Promise<unknown>; seed?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tourcore-oauth-"));
  let env: SendblueEnv = sendblueEnv();
  cleanups.push(setSendblueRuntime({ env: () => env }));
  const clock = { t: Date.now() };
  const logs: string[] = [];
  const opened: string[] = [];
  const ws = new PropertyWorkspace(root);
  if (options.seed) ws.save(loadConfig());
  const server: Server = createSetupServer({
    workspace: ws,
    mcpAuth: options.mcpAuth ?? (options.operatorToken ? undefined : "oauth"),
    operatorToken: options.operatorToken,
    authNow: () => clock.t,
    oauthRateLimit: false,
    fetchClientMetadata: options.fetchClientMetadata,
    onApprovalRequest: (page) => opened.push(page),
    now: () => new Date(at(7)),
    log: (line) => logs.push(line),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  cleanups.push(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const pub = tunnelFetch(port);
  const local = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
  const localPost = (path: string) => local(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

  const register = async (meta: Record<string, unknown> = {}) =>
    pub(`${PUBLIC}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Grok", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...meta }),
    });
  const registered = async (meta: Record<string, unknown> = {}) => {
    const res = await register(meta);
    expect(res.status).toBe(201);
    return (await res.json()) as { client_id: string; client_secret?: string; token_endpoint_auth_method: string };
  };

  const authorize = async (clientId: string, extra: Record<string, string> = {}, redirect = REDIRECT) => {
    const { verifier, challenge } = pkce();
    const state = randomBytes(10).toString("hex");
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, scope: OPERATOR_SCOPE, resource: RESOURCE, ...extra });
    const res = await pub(`${PUBLIC}/authorize?${q}`);
    const html = res.status === 200 ? await res.text() : "";
    return { res, html, requestId: /data-request="([^"]+)"/.exec(html)?.[1], verifier, state };
  };
  const finish = async (requestId: string) => {
    const res = await pub(`${PUBLIC}/oauth/requests/${requestId}/continue`);
    return { res, location: res.headers.get("location") ? new URL(res.headers.get("location")!) : undefined };
  };
  /** Browser opens /authorize, the owner clicks Allow on the Tour Core computer, the browser is sent back with a code. */
  const approvedCode = async (clientId: string, extra: Record<string, string> = {}) => {
    const a = await authorize(clientId, extra);
    expect(a.requestId).toBeDefined();
    expect((await localPost(`/api/grok/requests/${a.requestId}/approve`)).status).toBe(200);
    const { location } = await finish(a.requestId!);
    return { ...a, location: location!, code: location!.searchParams.get("code")! };
  };
  const token = (form: Record<string, string>, headers: Record<string, string> = {}) =>
    pub(`${PUBLIC}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form).toString() });
  const connect = async (meta: Record<string, unknown> = {}) => {
    const client = await registered(meta);
    const { code, verifier } = await approvedCode(client.client_id);
    const res = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: RESOURCE });
    expect(res.status).toBe(200);
    return { client, tokens: (await res.json()) as { access_token: string; refresh_token?: string; token_type: string; expires_in: number; scope: string } };
  };
  let rpcId = 0;
  const mcp = (accessToken: string | undefined, method = "tools/list", params?: Record<string, unknown>) =>
    pub(`${PUBLIC}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }),
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = async (accessToken: string, name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const res = await mcp(accessToken, "tools/call", { name, arguments: args });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError: boolean; structuredContent: unknown; content: Array<{ text: string }> } };
    if (body.result.isError) throw new Error(body.result.content[0]!.text);
    return body.result.structuredContent;
  };
  return {
    root, ws, port, pub, local, localPost, clock, logs, opened,
    setEnv: (next: Partial<SendblueEnv>) => (env = sendblueEnv(next)),
    register, registered, authorize, finish, approvedCode, token, connect, mcp, tool,
  };
}

describe("signed-in playbook without a session id", () => {
  it("two callers keep their own playbook when later calls omit the session id", async () => {
    const app = await oauthApp();
    const grok = await app.connect();
    const other = await app.connect({ client_name: "Example" });
    const init = async (token: string, name: string) => {
      const res = await app.mcp(token, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: { elicitation: { form: {} }, sampling: {}, roots: { listChanged: true } },
        clientInfo: { name, version: "1" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("mcp-session-id")).toBeTruthy();
      await res.text();
    };
    await init(grok.tokens.access_token, "Grok");
    await init(other.tokens.access_token, "example-client");
    const grokState = await app.tool(grok.tokens.access_token, "get_state");
    const otherState = await app.tool(other.tokens.access_token, "get_state");
    expect(grokState.playbook.id).toBe("grok");
    expect(otherState.playbook.id).toBe("baseline");
  });
});

describe("OAuth discovery", () => {
  it("answers an unauthenticated /mcp with 401 and the protected-resource metadata address", async () => {
    const app = await oauthApp();
    const res = await app.mcp(undefined);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PRM_URL}", scope="${OPERATOR_SCOPE}"`);
    expect(await res.text()).not.toMatch(/token/i);
  });

  it("publishes protected-resource metadata at the RFC 9728 path and the root", async () => {
    const app = await oauthApp();
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await app.pub(`${PUBLIC}${path}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: [OPERATOR_SCOPE], bearer_methods_supported: ["header"], resource_name: "Tour Core" });
    }
  });

  it("publishes authorization-server metadata that advertises only what Tour Core supports", async () => {
    const app = await oauthApp();
    const meta = (await (await app.pub(`${PUBLIC}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(meta).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${PUBLIC}/authorize`,
      token_endpoint: `${PUBLIC}/token`,
      registration_endpoint: `${PUBLIC}/register`,
      revocation_endpoint: `${PUBLIC}/revoke`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: [OPERATOR_SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(JSON.stringify(meta)).not.toMatch(/plain|implicit|password|client_credentials|openid|jwks/);
  });

  it("builds every URL from PUBLIC_BASE_URL, so a new tunnel address needs no code change", async () => {
    const app = await oauthApp();
    app.setEnv({ publicBaseUrl: "https://other-tunnel.example", publicBaseUrlRaw: "https://other-tunnel.example" });
    const res = await tunnelFetch(app.port)("https://other-tunnel.example/.well-known/oauth-authorization-server");
    expect(((await res.json()) as { token_endpoint: string }).token_endpoint).toBe("https://other-tunnel.example/token");
  });
});

describe("OAuth client registration", () => {
  it("registers a public client (DCR) and a confidential one whose secret is stored only as a hash", async () => {
    const app = await oauthApp();
    const pub = await app.registered();
    expect(pub.client_id).toBeTruthy();
    expect(pub.client_secret).toBeUndefined();
    const conf = await app.registered({ token_endpoint_auth_method: undefined });
    expect(conf.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(conf.client_secret).toMatch(/^[0-9a-f]{64}$/);
    const saved = readFileSync(join(app.root, "runtime", "oauth", "grok-access.json"), "utf8");
    expect(saved).not.toContain(conf.client_secret!);
    expect(saved).toContain(hashSecret(conf.client_secret!));
  });

  it("rejects unsafe redirect URIs and unsupported metadata, and says which host was refused", async () => {
    const app = await oauthApp();
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ redirect_uris: ["https://evil.example/callback"] }, "invalid_redirect_uri"],
      [{ redirect_uris: ["https://grok.com.evil.example/cb"] }, "invalid_redirect_uri"],
      [{ redirect_uris: ["http://grok.com/callback"] }, "invalid_redirect_uri"],
      [{ redirect_uris: ["https://*.grok.com/callback"] }, "invalid_redirect_uri"],
      [{ redirect_uris: ["https://grok.com/callback#frag"] }, "invalid_redirect_uri"],
      [{ redirect_uris: ["https://user:pw@grok.com/callback"] }, "invalid_redirect_uri"],
      [{ redirect_uris: ["grok://callback"] }, "invalid_redirect_uri"],
      [{ redirect_uris: [] }, "invalid_redirect_uri"],
      [{ redirect_uris: ["http://127.0.0.1:9000/cb"], application_type: "web" }, "invalid_redirect_uri"],
      [{ application_type: "desktop" }, "invalid_client_metadata"],
      [{ grant_types: ["implicit"] }, "invalid_client_metadata"],
      [{ grant_types: ["refresh_token"] }, "invalid_client_metadata"],
      [{ response_types: ["token"] }, "invalid_client_metadata"],
      [{ token_endpoint_auth_method: "private_key_jwt" }, "invalid_client_metadata"],
    ];
    for (const [meta, error] of bad) {
      const res = await app.register(meta);
      expect(res.status, JSON.stringify(meta)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    }
    expect(app.logs).toContain("  refused redirect: scheme=https host=evil.example path=/callback reason: isn't on an allowed host");
    expect(app.logs.some((l) => l.includes("TOURCORE_OAUTH_REDIRECT_HOSTS"))).toBe(true);
    // A native client's loopback redirect (RFC 8252) is fine.
    expect((await app.register({ redirect_uris: ["http://127.0.0.1:33418/callback"], application_type: "native" })).status).toBe(201);
  });

  it("allows only Grok's hosts by default, extended by TOURCORE_OAUTH_REDIRECT_HOSTS", async () => {
    expect(DEFAULT_REDIRECT_HOSTS).toEqual(["grok.com", "x.ai", "x.com"]);
    expect(checkRedirectUri("https://auth.x.ai/callback", strictPolicy())).toBeUndefined();
    expect(checkRedirectUri("https://notx.ai/callback", strictPolicy())?.reason).toBe("isn't on an allowed host");
    const app = await oauthApp();
    process.env.TOURCORE_OAUTH_REDIRECT_HOSTS = "connectors.example";
    cleanups.push(() => delete process.env.TOURCORE_OAUTH_REDIRECT_HOSTS);
    expect((await app.register({ redirect_uris: ["https://connectors.example/cb"] })).status).toBe(201);
  });

  it("accepts a Client ID Metadata Document client and validates the document", async () => {
    const docs: Record<string, unknown> = {
      "https://client.example/oauth/metadata.json": { client_id: "https://client.example/oauth/metadata.json", client_name: "CIMD Client", redirect_uris: [REDIRECT], grant_types: ["authorization_code"], token_endpoint_auth_method: "none" },
      "https://mismatch.example/meta.json": { client_id: "https://someone-else.example/meta.json", redirect_uris: [REDIRECT] },
      "https://badredirect.example/meta.json": { client_id: "https://badredirect.example/meta.json", redirect_uris: ["https://evil.example/cb"] },
    };
    const app = await oauthApp({ seed: true, fetchClientMetadata: async (id) => docs[id] });
    const good = "https://client.example/oauth/metadata.json";
    const { code, verifier, html } = await app.approvedCode(good);
    expect(html).toContain("CIMD Client");
    const res = await app.token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: good, redirect_uri: REDIRECT, resource: RESOURCE });
    const tokens = (await res.json()) as { access_token: string; refresh_token?: string };
    expect(tokens.refresh_token).toBeUndefined();
    expect(JSON.stringify(await app.tool(tokens.access_token, "list_properties"))).toContain("100 Alfred Way");
    for (const id of ["https://mismatch.example/meta.json", "https://badredirect.example/meta.json"]) {
      expect((await app.authorize(id)).res.status).toBe(400);
    }
    expect((await app.authorize("https://client.example/")).res.status).toBe(400);
  });
});

describe("OAuth authorization with owner approval", () => {
  it("shows a consent page with no secrets, opens the approval window on this computer, and waits", async () => {
    process.env.TOURCORE_OPERATOR_TOKEN = "op-token-SENTINEL-444";
    cleanups.push(() => delete process.env.TOURCORE_OPERATOR_TOKEN);
    const app = await oauthApp();
    const client = await app.registered();
    const a = await app.authorize(client.client_id);
    expect(a.res.status).toBe(200);
    expect(a.res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(a.res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(a.html).toContain("is requesting permission to manage this Tour Core installation");
    expect(a.html).toContain("directly unlock doors");
    expect(a.html).not.toContain("SENTINEL");
    expect(a.html).not.toMatch(/<script>|\son\w+="/);
    expect(app.opened).toEqual([`http://localhost:${app.port}/grok`]);
    const [pending] = ((await (await app.local("/api/grok")).json()) as { pending: Array<{ matchCode: string; clientName: string; redirectHost: string }> }).pending;
    expect(pending).toMatchObject({ clientName: "Grok", redirectHost: "grok.com" });
    expect(a.html).toContain(pending!.matchCode);
    expect(((await (await app.pub(`${PUBLIC}/oauth/requests/${a.requestId}`)).json()) as { status: string }).status).toBe("pending");
    expect((await app.finish(a.requestId!)).res.status).toBe(409);
  });

  it("can't be approved through the public address, only on the Tour Core computer", async () => {
    const app = await oauthApp();
    const client = await app.registered();
    const a = await app.authorize(client.client_id);
    const viaTunnel = (path: string, method = "POST") => app.pub(`${PUBLIC}${path}`, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    expect((await viaTunnel(`/api/grok/requests/${a.requestId}/approve`)).status).toBe(404);
    expect((await viaTunnel("/api/grok", "GET")).status).toBe(404);
    expect((await viaTunnel("/grok", "GET")).status).toBe(404);
    expect((await viaTunnel("/api/grok/disconnect")).status).toBe(404);
    // Proxied requests to the local address, a plain form post (CSRF) and unknown requests are refused too.
    const forwarded = await fetch(`http://127.0.0.1:${app.port}/api/grok/requests/${a.requestId}/approve`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9" }, body: "{}" });
    expect(forwarded.status).toBe(403);
    const form = await app.local(`/api/grok/requests/${a.requestId}/approve`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "x=1" });
    expect(form.status).toBe(415);
    expect((await app.localPost("/api/grok/requests/nope_nope_nope_nope/approve")).status).toBe(404);
    expect(((await (await app.pub(`${PUBLIC}/oauth/requests/${a.requestId}`)).json()) as { status: string }).status).toBe("pending");
  });

  it("denial sends the browser back with access_denied, the same state and the issuer", async () => {
    const app = await oauthApp();
    const client = await app.registered();
    const a = await app.authorize(client.client_id);
    expect((await app.localPost(`/api/grok/requests/${a.requestId}/deny`)).status).toBe(200);
    const { res, location } = await app.finish(a.requestId!);
    expect(res.status).toBe(302);
    expect(`${location!.origin}${location!.pathname}`).toBe(REDIRECT);
    expect(location!.searchParams.get("error")).toBe("access_denied");
    expect(location!.searchParams.get("state")).toBe(a.state);
    expect(location!.searchParams.get("iss")).toBe(ISSUER);
    expect(location!.searchParams.get("code")).toBeNull();
    // The consent page's own Deny button works the same way.
    const b = await app.authorize(client.client_id);
    await app.pub(`${PUBLIC}/oauth/requests/${b.requestId}/deny`, { method: "POST" });
    expect((await app.finish(b.requestId!)).location!.searchParams.get("error")).toBe("access_denied");
  });

  it("approval returns a single-use code with the state and issuer; the request can't be finished twice", async () => {
    const app = await oauthApp();
    const client = await app.registered();
    const a = await app.approvedCode(client.client_id);
    expect(a.code).toMatch(/^tcc_/);
    expect(a.location.searchParams.get("state")).toBe(a.state);
    expect(a.location.searchParams.get("iss")).toBe(ISSUER);
    expect([...a.location.searchParams.keys()].sort()).toEqual(["code", "iss", "state"]);
    expect((await app.finish(a.requestId!)).res.status).toBe(410);
  });

  it("refuses bad authorization requests: unknown client or redirect directly, others by redirect with iss", async () => {
    const app = await oauthApp();
    const client = await app.registered();
    expect((await app.authorize("not-a-client")).res.status).toBe(400);
    expect((await app.authorize(client.client_id, {}, "https://grok.com/other-callback")).res.status).toBe(400);
    const cases: Array<Record<string, string>> = [{ code_challenge_method: "plain" }, { code_challenge: "" }, { code_challenge: "short" }, { response_type: "token" }, { resource: "https://other.example/mcp" }];
    for (const extra of cases) {
      const { res } = await app.authorize(client.client_id, extra);
      expect(res.status, JSON.stringify(extra)).toBe(302);
      const to = new URL(res.headers.get("location")!);
      expect(to.searchParams.get("error")).toMatch(/invalid_request|invalid_target|unsupported_response_type/);
      expect(to.searchParams.get("iss")).toBe(ISSUER);
      expect(to.searchParams.get("code")).toBeNull();
    }
    expect(app.opened).toEqual([]);
  });

  it("expires approval requests that nobody answers", async () => {
    const app = await oauthApp();
    const client = await app.registered();
    const a = await app.authorize(client.client_id);
    app.clock.t += 11 * 60_000;
    expect(((await (await app.pub(`${PUBLIC}/oauth/requests/${a.requestId}`)).json()) as { status: string }).status).toBe("expired");
    expect((await app.localPost(`/api/grok/requests/${a.requestId}/approve`)).status).toBe(404);
  });
});

describe("OAuth tokens", () => {
  it("issues a scoped, expiring bearer token (and a refresh token when registered for one)", async () => {
    const app = await oauthApp();
    const { tokens } = await app.connect();
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: OPERATOR_SCOPE });
    expect(tokens.access_token).toMatch(/^tca_/);
    expect(tokens.refresh_token).toMatch(/^tcr_/);
    const noRefresh = await app.connect({ grant_types: ["authorization_code"] });
    expect(noRefresh.tokens.refresh_token).toBeUndefined();
    const saved = readFileSync(join(app.root, "runtime", "oauth", "grok-access.json"), "utf8");
    for (const secret of [tokens.access_token, tokens.refresh_token!, noRefresh.tokens.access_token]) expect(saved).not.toContain(secret);
  });

  it("checks the PKCE verifier", async () => {
    const app = await oauthApp();
    const client = await app.registered();
    const { code, verifier } = await app.approvedCode(client.client_id);
    const wrong = await app.token({ grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: client.client_id, redirect_uri: REDIRECT });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe("invalid_grant");
    const missing = await app.token({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT });
    expect(((await missing.json()) as { error: string }).error).toBe("invalid_request");
    expect((await app.token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT })).status).toBe(200);
  });

  it("binds the code to its client, redirect URI and resource", async () => {
    const app = await oauthApp();
    const client = await app.registered();
    const other = await app.registered();
    const a = await app.approvedCode(client.client_id);
    expect(((await (await app.token({ grant_type: "authorization_code", code: a.code, code_verifier: a.verifier, client_id: other.client_id })).json()) as { error: string }).error).toBe("invalid_grant");
    const b = await app.approvedCode(client.client_id);
    expect(((await (await app.token({ grant_type: "authorization_code", code: b.code, code_verifier: b.verifier, client_id: client.client_id, redirect_uri: "https://grok.com/elsewhere" })).json()) as { error: string }).error).toBe("invalid_grant");
    const c = await app.approvedCode(client.client_id);
    expect(((await (await app.token({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, client_id: client.client_id, resource: "https://other.example/mcp" })).json()) as { error: string }).error).toBe("invalid_target");
  });

  it("expires authorization codes after five minutes", async () => {
    const app = await oauthApp();
    const client = await app.registered();
    const { code, verifier } = await app.approvedCode(client.client_id);
    app.clock.t += 5 * 60_000 + 1;
    const res = await app.token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT });
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("treats a replayed code as stolen: refused, and the tokens it produced stop working", async () => {
    const app = await oauthApp();
    const client = await app.registered();
    const { code, verifier } = await app.approvedCode(client.client_id);
    const form = { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT };
    const first = (await (await app.token(form)).json()) as { access_token: string };
    expect((await app.mcp(first.access_token)).status).toBe(200);
    const again = await app.token(form);
    expect(((await again.json()) as { error: string }).error).toBe("invalid_grant");
    expect((await app.mcp(first.access_token)).status).toBe(401);
  });

  it("lets a valid token call the operator tools and rejects invalid, expired and wrong-audience tokens with 401", async () => {
    const app = await oauthApp({ seed: true });
    const { tokens } = await app.connect();
    const list = await app.mcp(tokens.access_token);
    expect(((await list.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(OPERATOR_TOOLS.length);
    expect(JSON.stringify(await app.tool(tokens.access_token, "list_properties"))).toContain("100 Alfred Way");

    const invalid = await app.mcp("tca_not-a-real-token");
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(invalid.headers.get("www-authenticate")).toContain(`resource_metadata="${PRM_URL}"`);
    expect((await app.pub(`${PUBLIC}/mcp`, { method: "POST", headers: { Authorization: "Basic abc", "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
    // Access tokens only in the Authorization header, never the query string.
    expect((await app.pub(`${PUBLIC}/mcp?access_token=${tokens.access_token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);

    app.setEnv({ publicBaseUrl: "https://new-tunnel.example", publicBaseUrlRaw: "https://new-tunnel.example" });
    const moved = await tunnelFetch(app.port)("https://new-tunnel.example/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(moved.status).toBe(401);
    app.setEnv({});

    app.clock.t += 61 * 60_000;
    const expired = await app.mcp(tokens.access_token);
    expect(expired.status).toBe(401);
    expect(expired.headers.get("www-authenticate")).toContain("expired");
  });

  it("requires the tourcore.operator scope (403 insufficient_scope otherwise)", async () => {
    const app = await oauthApp();
    const client = await app.registered();
    const store = new OAuthGrantStore(new FileRuntimeStore(join(app.root, "runtime")));
    const access = "tca_scopeless-test-token";
    store.addGrant({ clientId: client.client_id, issuer: ISSUER, resource: RESOURCE, scopes: [], createdAt: Date.now(), expiresAt: Date.now() + 3_600_000, accessHash: hashSecret(access), accessExpiresAt: Date.now() + 3_600_000 });
    const res = await app.mcp(access);
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });

  it("refreshes with rotation, and a reused refresh token revokes the whole approval", async () => {
    const app = await oauthApp();
    const { client, tokens } = await app.connect();
    app.clock.t += 30 * 60_000;
    const res = await app.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: client.client_id, resource: RESOURCE });
    expect(res.status).toBe(200);
    const next = (await res.json()) as { access_token: string; refresh_token: string; scope: string };
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.scope).toBe(OPERATOR_SCOPE);
    expect((await app.mcp(next.access_token)).status).toBe(200);
    expect((await app.mcp(tokens.access_token)).status).toBe(401);
    // A refresh can't widen scope.
    expect(((await (await app.token({ grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: client.client_id, scope: "admin" })).json()) as { error: string }).error).toBe("invalid_scope");
    // Replaying the old refresh token: refused, and the current tokens die with it.
    const replay = await app.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: client.client_id });
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");
    expect((await app.mcp(next.access_token)).status).toBe(401);
    expect(((await (await app.token({ grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: client.client_id })).json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("stops refreshing after the refresh token's lifetime", async () => {
    const app = await oauthApp();
    const { client, tokens } = await app.connect();
    app.clock.t += 31 * 24 * 60 * 60_000;
    const res = await app.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: client.client_id });
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("supports confidential clients with client_secret_basic and client_secret_post", async () => {
    const app = await oauthApp();
    const client = await app.registered({ token_endpoint_auth_method: "client_secret_basic" });
    const a = await app.approvedCode(client.client_id);
    const basic = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret!)}`).toString("base64")}`;
    const noSecret = await app.token({ grant_type: "authorization_code", code: a.code, code_verifier: a.verifier, client_id: client.client_id });
    expect(((await noSecret.json()) as { error: string }).error).toBe("invalid_client");
    const badSecret = `Basic ${Buffer.from(`${client.client_id}:wrong`).toString("base64")}`;
    expect(((await (await app.token({ grant_type: "authorization_code", code: a.code, code_verifier: a.verifier }, { Authorization: badSecret })).json()) as { error: string }).error).toBe("invalid_client");
    const ok = await app.token({ grant_type: "authorization_code", code: a.code, code_verifier: a.verifier }, { Authorization: basic });
    expect(ok.status).toBe(200);
    const post = await app.registered({ token_endpoint_auth_method: "client_secret_post" });
    const b = await app.approvedCode(post.client_id);
    expect((await app.token({ grant_type: "authorization_code", code: b.code, code_verifier: b.verifier, client_id: post.client_id, client_secret: post.client_secret! })).status).toBe(200);
  });
});

describe("revoking Grok's access", () => {
  it("revokes through the RFC 7009 endpoint", async () => {
    const app = await oauthApp();
    const { client, tokens } = await app.connect();
    const res = await app.pub(`${PUBLIC}/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tokens.access_token, client_id: client.client_id }).toString() });
    expect(res.status).toBe(200);
    expect((await app.mcp(tokens.access_token)).status).toBe(401);
    expect(((await (await app.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: client.client_id })).json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("Disconnect Grok (local page or npm run grok:disconnect) ends every approval and changes nothing else", async () => {
    const app = await oauthApp({ seed: true });
    const one = await app.connect();
    const two = await app.connect();
    const before = JSON.stringify(app.ws.list());
    const connected = (await (await app.local("/api/grok")).json()) as { connections: unknown[] };
    expect(connected.connections).toHaveLength(2);
    expect(JSON.stringify(connected)).not.toMatch(/tca_|tcr_/);

    const out = (await (await app.localPost("/api/grok/disconnect")).json()) as { removed: { grants: number } };
    expect(out.removed.grants).toBe(2);
    expect((await app.mcp(one.tokens.access_token)).status).toBe(401);
    expect(((await (await app.token({ grant_type: "refresh_token", refresh_token: two.tokens.refresh_token!, client_id: two.client.client_id })).json()) as { error: string }).error).toBe("invalid_client");

    // The CLI edits the same file; the running server sees it on the next request.
    const three = await app.connect();
    expect((await app.mcp(three.tokens.access_token)).status).toBe(200);
    new OAuthGrantStore(new FileRuntimeStore(join(app.root, "runtime"))).revokeAll();
    expect((await app.mcp(three.tokens.access_token)).status).toBe(401);

    expect(JSON.stringify(app.ws.list())).toBe(before);
    expect(readdirSync(join(app.root, "runtime")).sort()).toEqual(["oauth"]);
  });
});

describe("OAuth and Tour Core's own boundaries", () => {
  it("never exposes OAuth tokens, client secrets or the operator token through the MCP tools", async () => {
    process.env.TOURCORE_OPERATOR_TOKEN = "op-token-SENTINEL-444";
    cleanups.push(() => delete process.env.TOURCORE_OPERATOR_TOKEN);
    const app = await oauthApp({ seed: true });
    const { tokens } = await app.connect();
    const conf = await app.registered({ token_endpoint_auth_method: "client_secret_post" });
    const outputs: string[] = [await (await app.mcp(tokens.access_token)).text()];
    for (const t of OPERATOR_TOOLS.filter((t) => t.kind === "read")) outputs.push(await (await app.mcp(tokens.access_token, "tools/call", { name: t.name, arguments: {} })).text());
    const all = outputs.join("\n");
    for (const secret of [tokens.access_token, tokens.refresh_token!, conf.client_secret!, "op-token-SENTINEL-444", "grok-access"]) expect(all).not.toContain(secret);
    expect(all).not.toMatch(/tca_|tcr_|tcc_/);
  });

  it("doesn't bypass Tour Core's confirmation codes for consequential actions", async () => {
    const app = await oauthApp({ seed: true });
    const { tokens } = await app.connect();
    await app.tool(tokens.access_token, "run_readiness_check");
    await app.tool(tokens.access_token, "run_dry_tour");
    const asked = await app.tool(tokens.access_token, "publish_demo_property");
    expect(asked.status).toBe("needs-confirmation");
    const status = async () => (await app.tool(tokens.access_token, "get_property_setup")).setup.status as string;
    expect(await status()).toBe("Ready to publish for demo");
    await expect(app.tool(tokens.access_token, "publish_demo_property", { confirmationCode: "000000" })).rejects.toThrow();
    expect(await status()).toBe("Ready to publish for demo");
    const done = await app.tool(tokens.access_token, "publish_demo_property", { confirmationCode: asked.confirmation.code });
    expect(done.status).not.toBe("needs-confirmation");
    expect(await status()).toBe("Published for demo");
  });
});

describe("auth modes", () => {
  it("static development mode still works, and then OAuth isn't offered or accepted", async () => {
    const app = await oauthApp({ operatorToken: () => "static-dev-token-123456" });
    expect((await app.mcp("static-dev-token-123456")).status).toBe(200);
    expect((await app.mcp(undefined)).status).toBe(401);
    expect((await app.pub(`${PUBLIC}/.well-known/oauth-authorization-server`)).status).toBe(404);
    expect((await app.register()).status).toBe(404);
    expect(((await (await app.local("/api/grok")).json()) as { mode: string }).mode).toBe("static");
  });

  it("in OAuth mode the static token is not accepted", async () => {
    process.env.TOURCORE_OPERATOR_TOKEN = "static-dev-token-123456";
    cleanups.push(() => delete process.env.TOURCORE_OPERATOR_TOKEN);
    const app = await oauthApp();
    expect((await app.mcp("static-dev-token-123456")).status).toBe(401);
  });

  it("defaults to OAuth, and an unknown TOURCORE_MCP_AUTH_MODE turns the connector off", async () => {
    expect(mcpAuthModeFromEnv({})).toBe("oauth");
    expect(mcpAuthModeFromEnv({ TOURCORE_MCP_AUTH_MODE: " Static " })).toBe("static");
    expect(mcpAuthModeFromEnv({ TOURCORE_MCP_AUTH_MODE: "none" })).toEqual({ invalid: "none" });
    process.env.TOURCORE_MCP_AUTH_MODE = "none";
    cleanups.push(() => delete process.env.TOURCORE_MCP_AUTH_MODE);
    const app = await oauthApp({ mcpAuth: undefined as never });
    const server = createSetupServer({ workspace: app.ws, log: () => {} });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => server.close());
    const res = await tunnelFetch((server.address() as { port: number }).port)(`${PUBLIC}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer anything" }, body: "{}" });
    expect(res.status).toBe(503);
  });

  it("without PUBLIC_BASE_URL OAuth is off rather than guessing an address", async () => {
    const app = await oauthApp();
    app.setEnv({ publicBaseUrl: undefined, publicBaseUrlRaw: undefined });
    const res = await app.local("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(503);
    expect((await app.local("/.well-known/oauth-authorization-server")).status).toBe(404);
  });
});

describe("integration: an MCP client connects the way Grok does", () => {
  it("unauthenticated /mcp -> discovery -> registration -> authorize -> token -> authenticated list_properties", async () => {
    const app = await oauthApp({ seed: true });

    const challenge = await app.mcp(undefined);
    expect(challenge.status).toBe(401);
    const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get("www-authenticate")!)![1]!;
    const prm = (await (await app.pub(prmUrl)).json()) as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
    const as = (await (await app.pub(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;
    expect(as.issuer).toBe(prm.authorization_servers[0]);

    const reg = await app.pub(as.registration_endpoint!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Grok", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" }) });
    const client = (await reg.json()) as { client_id: string };

    const { verifier, challenge: codeChallenge } = pkce();
    const state = randomBytes(12).toString("hex");
    const authUrl = new URL(as.authorization_endpoint!);
    Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: codeChallenge, code_challenge_method: "S256", state, scope: prm.scopes_supported.join(" "), resource: prm.resource }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
    const page = await (await app.pub(authUrl.href)).text();
    const requestId = /data-request="([^"]+)"/.exec(page)![1]!;

    // The owner, at the Tour Core computer, clicks Allow.
    const [pending] = ((await (await app.local("/api/grok")).json()) as { pending: Array<{ id: string }> }).pending;
    await app.localPost(`/api/grok/requests/${pending!.id}/approve`);
    expect(((await (await app.pub(`${PUBLIC}/oauth/requests/${requestId}`)).json()) as { status: string }).status).toBe("approved");
    const back = new URL((await app.pub(`${PUBLIC}/oauth/requests/${requestId}/continue`)).headers.get("location")!);
    expect(back.searchParams.get("state")).toBe(state);
    expect(back.searchParams.get("iss")).toBe(as.issuer);

    const tokenRes = await app.pub(as.token_endpoint!, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: prm.resource }).toString() });
    const { access_token } = (await tokenRes.json()) as { access_token: string };

    const init = await app.mcp(access_token, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "grok", version: "1" } });
    expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("tour-core");
    const properties = await app.tool(access_token, "list_properties");
    expect(JSON.stringify(properties)).toContain("100 Alfred Way");
  });

  it("works with the official MCP SDK client's OAuth flow", async () => {
    const app = await oauthApp({ seed: true });
    const state = randomBytes(12).toString("hex");
    let authorizationUrl: URL | undefined;
    const saved: { info?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier: string } = { verifier: "" };
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return REDIRECT;
      },
      get clientMetadata(): OAuthClientMetadata {
        return { client_name: "Grok (SDK test)", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
      },
      state: () => state,
      clientInformation: () => saved.info,
      saveClientInformation: (info) => void (saved.info = info),
      tokens: () => saved.tokens,
      saveTokens: (t) => void (saved.tokens = t),
      redirectToAuthorization: (url) => void (authorizationUrl = url),
      saveCodeVerifier: (v) => void (saved.verifier = v),
      codeVerifier: () => saved.verifier,
    };
    const url = new URL(RESOURCE);
    const first = new StreamableHTTPClientTransport(url, { authProvider: provider, fetch: app.pub });
    await expect(new Client({ name: "grok-sim", version: "1" }).connect(first)).rejects.toThrow(UnauthorizedError);
    expect(saved.info?.client_id).toBeTruthy();
    expect(authorizationUrl!.searchParams.get("resource")).toBe(RESOURCE);
    expect(authorizationUrl!.searchParams.get("code_challenge_method")).toBe("S256");

    // The browser: consent page, the owner's Allow on this computer, back to the client.
    const page = await (await app.pub(authorizationUrl!.href)).text();
    const requestId = /data-request="([^"]+)"/.exec(page)![1]!;
    const [pending] = ((await (await app.local("/api/grok")).json()) as { pending: Array<{ id: string }> }).pending;
    await app.localPost(`/api/grok/requests/${pending!.id}/approve`);
    const back = new URL((await app.pub(`${PUBLIC}/oauth/requests/${requestId}/continue`)).headers.get("location")!);
    expect(back.searchParams.get("state")).toBe(state);
    expect(back.searchParams.get("iss")).toBe(ISSUER);
    await first.finishAuth(back.searchParams.get("code")!);
    expect(saved.tokens?.access_token).toMatch(/^tca_/);

    const client = new Client({ name: "grok-sim", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider, fetch: app.pub }));
    expect((await client.listTools()).tools).toHaveLength(OPERATOR_TOOLS.length);
    const out = await client.callTool({ name: "list_properties", arguments: {} });
    expect(JSON.stringify(out.structuredContent)).toContain("100 Alfred Way");
    await client.close();
  });
});

describe("Grok legacy OAuth compatibility (TOURCORE_GROK_LEGACY_OAUTH_COMPAT)", () => {
  const CURSOR_APP = "cursor://anysphere.cursor-mcp/oauth/callback";
  const CURSOR_WEB = "https://www.cursor.com/agents/mcp/oauth/callback";
  const CURSOR_LOOPBACK = "http://localhost:8787/callback";
  const CURSOR_SET = [CURSOR_APP, CURSOR_WEB, CURSOR_LOOPBACK];
  const compat = () => {
    process.env.TOURCORE_GROK_LEGACY_OAUTH_COMPAT = "true";
    cleanups.push(() => delete process.env.TOURCORE_GROK_LEGACY_OAUTH_COMPAT);
  };
  const cursorClient = (redirect_uris: string[] = CURSOR_SET) => ({ client_name: "Cursor", redirect_uris });
  type App = Awaited<ReturnType<typeof oauthApp>>;
  /** Owner approves; the browser is sent back to the given callback with a code. */
  const codeFor = async (app: App, clientId: string, redirect: string) => {
    const a = await app.authorize(clientId, {}, redirect);
    expect(a.requestId).toBeDefined();
    await app.localPost(`/api/grok/requests/${a.requestId}/approve`);
    const res = await app.pub(`${PUBLIC}/oauth/requests/${a.requestId}/continue`);
    const location = res.headers.get("location")!;
    return { ...a, location, code: new URL(location).searchParams.get("code")! };
  };

  describe("strict (default)", () => {
    it("is off unless set to exactly true", async () => {
      const { grokLegacyCompatFromEnv, redirectPolicyFromEnv } = await import("../src/mcp/oauth/clients");
      expect(grokLegacyCompatFromEnv({})).toBe(false);
      expect(grokLegacyCompatFromEnv({ TOURCORE_GROK_LEGACY_OAUTH_COMPAT: "1" })).toBe(false);
      expect(grokLegacyCompatFromEnv({ TOURCORE_GROK_LEGACY_OAUTH_COMPAT: "yes" })).toBe(false);
      expect(grokLegacyCompatFromEnv({ TOURCORE_GROK_LEGACY_OAUTH_COMPAT: " TRUE " })).toBe(true);
      expect(redirectPolicyFromEnv({}).exact).toEqual([]);
    });

    it("rejects the legacy cursor:// callback, other custom schemes and unsafe https hosts", async () => {
      const app = await oauthApp();
      for (const uris of [[CURSOR_APP], [CURSOR_WEB], CURSOR_SET, ["myapp://callback"], ["https://evil.example/cb"]]) {
        const res = await app.register(cursorClient(uris));
        expect(res.status, uris.join(" ")).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("invalid_redirect_uri");
      }
      expect((await app.register(cursorClient([CURSOR_LOOPBACK]))).status).toBe(201);
      expect(((await (await app.local("/api/grok")).json()) as { legacyCompat: boolean }).legacyCompat).toBe(false);
    });

    it("logs every refused redirect with scheme, host, path and reason, and points at the compat flag", async () => {
      const app = await oauthApp();
      await app.register({ ...cursorClient([...CURSOR_SET, "https://api2.cursor.sh/some/callback?x=secret-looking"]), client_secret: "should-never-be-logged" });
      const log = app.logs.join("\n");
      expect(log).toContain('Refused an MCP client registration from "Cursor": 3 of 4 redirect URIs not allowed');
      expect(log).toContain("refused redirect: scheme=cursor host=anysphere.cursor-mcp path=/oauth/callback reason: uses a custom scheme (cursor://)");
      expect(log).toContain("refused redirect: scheme=https host=www.cursor.com path=/agents/mcp/oauth/callback reason: isn't on an allowed host");
      expect(log).toContain("refused redirect: scheme=https host=api2.cursor.sh path=/some/callback reason: isn't on an allowed host");
      expect(log).toContain("TOURCORE_GROK_LEGACY_OAUTH_COMPAT=true");
      expect(log).not.toContain("secret-looking");
      expect(log).not.toContain("should-never-be-logged");
    });
  });

  describe("compat mode", () => {
    it("accepts Cursor's exact callback set and returns it exactly as registered", async () => {
      compat();
      const app = await oauthApp();
      const res = await app.register(cursorClient());
      expect(res.status).toBe(201);
      expect(((await res.json()) as { redirect_uris: string[] }).redirect_uris).toEqual(CURSOR_SET);
      for (const one of CURSOR_SET) expect((await app.register(cursorClient([one]))).status, one).toBe(201);
      expect(((await (await app.local("/api/grok")).json()) as { legacyCompat: boolean }).legacyCompat).toBe(true);
    });

    it("still rejects look-alikes, other custom schemes and other Cursor hosts, and refuses the whole registration", async () => {
      compat();
      const app = await oauthApp();
      const lookalikes = [
        "cursor://anysphere.cursor-mcp/oauth/callback2",
        "cursor://anysphere.cursor-mcp/oauth/callback?x=1",
        "cursor://anysphere.cursor-mcp/oauth/callback/",
        "cursor://anysphere.cursor-mcp/other",
        "cursor://evil.cursor-mcp/oauth/callback",
        "CURSOR://anysphere.cursor-mcp/oauth/callback",
        "cursor://*/oauth/callback",
        "vscode://anysphere.cursor-mcp/oauth/callback",
        "https://cursor.com/agents/mcp/oauth/callback",
        "https://www.cursor.com/agents/mcp/oauth/callback/extra",
        "https://www.cursor.com/agents/mcp/oauth/callback?next=https://evil.example",
        "https://www.cursor.com/other",
        "https://evil.cursor.com/agents/mcp/oauth/callback",
        "https://api2.cursor.sh/agents/mcp/oauth/callback",
        "https://www.cursor.com.evil.example/agents/mcp/oauth/callback",
        "http://www.cursor.com/agents/mcp/oauth/callback",
      ];
      for (const uri of lookalikes) expect((await app.register(cursorClient([uri]))).status, uri).toBe(400);
      // One bad URI refuses the whole set; nothing is silently dropped.
      expect((await app.register(cursorClient([...CURSOR_SET, "https://evil.example/cb"]))).status).toBe(400);
    });

    it("completes the flow through the cursor:// and www.cursor.com callbacks: approval, code, token, list_properties", async () => {
      compat();
      const app = await oauthApp({ seed: true });
      const client = await app.registered({ ...cursorClient(), grant_types: ["authorization_code", "refresh_token"] });
      for (const redirect of [CURSOR_APP, CURSOR_WEB, CURSOR_LOOPBACK]) {
        const got = await codeFor(app, client.client_id, redirect);
        expect(got.location.startsWith(`${redirect}?`)).toBe(true);
        const back = new URL(got.location);
        expect(back.searchParams.get("state")).toBe(got.state);
        expect(back.searchParams.get("iss")).toBe(ISSUER);
        const res = await app.token({ grant_type: "authorization_code", code: got.code, code_verifier: got.verifier, client_id: client.client_id, redirect_uri: redirect, resource: RESOURCE });
        expect(res.status, redirect).toBe(200);
        const tokens = (await res.json()) as { access_token: string; scope: string };
        expect(tokens.scope).toBe(OPERATOR_SCOPE);
        expect(JSON.stringify(await app.tool(tokens.access_token, "list_properties"))).toContain("100 Alfred Way");
      }
      expect(app.logs.join("\n")).toContain("will return to cursor://anysphere.cursor-mcp/oauth/callback.");
      expect(app.logs.join("\n")).not.toMatch(/tcc_|tca_|tcr_/);
    });

    it("stops honouring the legacy callback as soon as the flag is turned off", async () => {
      compat();
      const app = await oauthApp();
      const client = await app.registered(cursorClient());
      delete process.env.TOURCORE_GROK_LEGACY_OAUTH_COMPAT;
      const a = await app.authorize(client.client_id, {}, CURSOR_APP);
      expect(a.res.status).toBe(400);
      expect(a.requestId).toBeUndefined();
      expect((await app.authorize(client.client_id, {}, CURSOR_LOOPBACK)).res.status).toBe(200);
    });
  });

  describe("security boundaries are unchanged in compat mode", () => {
    it("still requires PKCE S256", async () => {
      compat();
      const app = await oauthApp();
      const client = await app.registered(cursorClient());
      const cases: Array<Record<string, string>> = [{ code_challenge_method: "plain" }, { code_challenge: "" }];
      for (const extra of cases) {
        const { res } = await app.authorize(client.client_id, extra, CURSOR_APP);
        expect(res.status).toBe(302);
        const to = new URL(res.headers.get("location")!);
        expect(to.searchParams.get("error")).toBe("invalid_request");
        expect(to.searchParams.get("code")).toBeNull();
      }
      const got = await codeFor(app, client.client_id, CURSOR_APP);
      const noVerifier = await app.token({ grant_type: "authorization_code", code: got.code, client_id: client.client_id, redirect_uri: CURSOR_APP });
      expect(((await noVerifier.json()) as { error: string }).error).toBe("invalid_request");
      const wrongVerifier = await app.token({ grant_type: "authorization_code", code: got.code, code_verifier: pkce().verifier, client_id: client.client_id, redirect_uri: CURSOR_APP });
      expect(((await wrongVerifier.json()) as { error: string }).error).toBe("invalid_grant");
    });

    it("still needs the owner's Allow on this computer, with the matching code", async () => {
      compat();
      const app = await oauthApp();
      const client = await app.registered(cursorClient());
      const a = await app.authorize(client.client_id, {}, CURSOR_APP);
      const [pending] = ((await (await app.local("/api/grok")).json()) as { pending: Array<{ matchCode: string; redirectHost: string }> }).pending;
      expect(a.html).toContain(pending!.matchCode);
      expect(pending!.redirectHost).toBe("cursor://anysphere.cursor-mcp");
      expect(a.html).toContain("sent back to cursor://anysphere.cursor-mcp");
      expect((await app.pub(`${PUBLIC}/oauth/requests/${a.requestId}/continue`)).status).toBe(409);
      expect((await app.pub(`${PUBLIC}/api/grok/requests/${a.requestId}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(404);
      expect(((await (await app.pub(`${PUBLIC}/oauth/requests/${a.requestId}`)).json()) as { status: string }).status).toBe("pending");
    });

    it("echoes each request's own state only, so a client comparing state rejects a mismatch", async () => {
      compat();
      const app = await oauthApp();
      const client = await app.registered(cursorClient());
      const one = await codeFor(app, client.client_id, CURSOR_APP);
      const two = await codeFor(app, client.client_id, CURSOR_APP);
      expect(one.state).not.toBe(two.state);
      expect(new URL(one.location).searchParams.get("state")).toBe(one.state);
      expect(new URL(two.location).searchParams.get("state")).toBe(two.state);
      expect(new URL(one.location).searchParams.getAll("state")).toHaveLength(1);
    });

    it("rejects a redirect URI that wasn't registered, at authorize and at token", async () => {
      compat();
      const app = await oauthApp();
      const client = await app.registered(cursorClient([CURSOR_APP]));
      expect((await app.authorize(client.client_id, {}, CURSOR_WEB)).res.status).toBe(400);
      expect((await app.authorize(client.client_id, {}, "cursor://anysphere.cursor-mcp/oauth/callback2")).res.status).toBe(400);
      const got = await codeFor(app, client.client_id, CURSOR_APP);
      const res = await app.token({ grant_type: "authorization_code", code: got.code, code_verifier: got.verifier, client_id: client.client_id, redirect_uri: CURSOR_WEB });
      expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    });

    it("keeps tokens scoped, single-use codes and revocation", async () => {
      compat();
      const app = await oauthApp();
      const client = await app.registered(cursorClient());
      const got = await codeFor(app, client.client_id, CURSOR_APP);
      const form = { grant_type: "authorization_code", code: got.code, code_verifier: got.verifier, client_id: client.client_id, redirect_uri: CURSOR_APP };
      const tokens = (await (await app.token(form)).json()) as { access_token: string; scope: string };
      expect(tokens.scope).toBe(OPERATOR_SCOPE);
      expect((await app.token(form)).status).toBe(400);
      expect((await app.mcp(tokens.access_token)).status).toBe(401);
      const again = await codeFor(app, client.client_id, CURSOR_APP);
      const fresh = (await (await app.token({ ...form, code: again.code, code_verifier: again.verifier })).json()) as { access_token: string };
      expect((await app.mcp(fresh.access_token)).status).toBe(200);
      await app.localPost("/api/grok/disconnect");
      expect((await app.mcp(fresh.access_token)).status).toBe(401);
    });

    it("doesn't bypass Tour Core's confirmation codes", async () => {
      compat();
      const app = await oauthApp({ seed: true });
      const client = await app.registered(cursorClient());
      const got = await codeFor(app, client.client_id, CURSOR_APP);
      const { access_token } = (await (await app.token({ grant_type: "authorization_code", code: got.code, code_verifier: got.verifier, client_id: client.client_id, redirect_uri: CURSOR_APP })).json()) as { access_token: string };
      await app.tool(access_token, "run_readiness_check");
      await app.tool(access_token, "run_dry_tour");
      const asked = await app.tool(access_token, "publish_demo_property");
      expect(asked.status).toBe("needs-confirmation");
      await expect(app.tool(access_token, "publish_demo_property", { confirmationCode: "000000" })).rejects.toThrow();
      expect((await app.tool(access_token, "get_property_setup")).setup.status).toBe("Ready to publish for demo");
      expect(OPERATOR_TOOLS.some((t) => /unlock|open_door|grant_access/.test(t.name))).toBe(false);
    });
  });
});
