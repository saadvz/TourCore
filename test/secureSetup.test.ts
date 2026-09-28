import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Installation } from "../src/install/installation";
import { setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { PropertyWorkspace } from "../src/setup";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { createSetupServer } from "../src/web/server";
import { fakeSendblue, LINE, PUBLIC } from "./fakeSendblue";
import { at } from "./grokHarness";
import { fakeNetwork, ROUTINE_KEY, ROUTINE_URL, SB_KEY, SB_SECRET } from "./installHarness";

/**
 * The secure setup page as the operator uses it in the Tour Core computer's
 * browser: credentials go in, go straight to the SecretStore, and never come
 * back out, not through the page's API, the tools Grok calls, or any file
 * other than the secret store. Sendblue and the Grok Routine are fakes.
 */

const TOKEN = "test-operator-token-abcdef";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

async function startApp() {
  const root = mkdtempSync(join(tmpdir(), "tourcore-secure-"));
  let clock = at(7);
  const net = fakeNetwork();
  const hooks: Array<{ url: string; secret?: string }> = [];
  const fake = fakeSendblue({ hooks });
  const create = fake.client.webhooks.create.bind(fake.client.webhooks);
  fake.client.webhooks.create = async (body) => {
    hooks.push(...(body.webhooks as Array<{ url: string; secret?: string }>));
    return create(body);
  };
  // Only the SDK is replaced: settings come from the real settings layer (environment + secure setup + manifest).
  cleanups.push(setSendblueRuntime({ client: () => fake.client }));
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  const installation = new Installation({ root, runtime, now: () => clock, fetch: net.fetch as never });
  installation.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
  installation.files.setPublicBaseUrl(PUBLIC, "MANUAL");
  const server = createSetupServer({ workspace: new PropertyWorkspace(root), installation, now: () => new Date(clock), realNow: () => clock, operatorToken: () => TOKEN, log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  cleanups.push(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Raw HTTP so a test can set Host and proxy headers the way a tunnel would. */
  const raw = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest(
        { host: "127.0.0.1", port, path, method, headers: { Host: `localhost:${port}`, ...(data ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)) } : {}), ...headers } },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setup = async (method: string, path: string, session: string | undefined, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await raw(method, `/api/install/${path}`, session ? { "X-TourCore-Setup-Session": session } : {}, body);
    return { status: res.status, body: JSON.parse(res.body) };
  };
  let rpc = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const grok = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; result: any }> => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
    });
    const text = await res.text();
    return { text, result: (JSON.parse(text) as { result: { structuredContent: unknown } }).result.structuredContent };
  };
  return { root, port, net, fake, hooks, installation, raw, setup, grok, setClock: (t: number) => (clock = t), now: () => clock };
}

describe("secure setup page", () => {
  it("is local-only: the public tunnel can't reach the page or its API, whatever the Host", async () => {
    const app = await startApp();
    const { token } = app.installation.sessions.mint();
    expect((await app.raw("GET", "/install")).status).toBe(200);
    expect((await app.raw("GET", "/install.js")).status).toBe(200);
    const publicHost = new URL(PUBLIC).host;
    expect((await app.raw("GET", "/install", { Host: publicHost })).status).toBe(404);
    expect((await app.raw("GET", "/api/install/status", { Host: publicHost, "X-TourCore-Setup-Session": token })).status).toBe(404);
    expect((await app.raw("POST", "/api/install/operator-alerts", { Host: publicHost, "X-TourCore-Setup-Session": token }, { webhookUrl: ROUTINE_URL, key: ROUTINE_KEY })).status).toBe(404);
    // A tunnel relaying a request with a local Host is still refused: it carries proxy headers.
    for (const header of ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "forwarded"]) {
      expect((await app.raw("GET", "/api/install/status", { [header]: "203.0.113.9", "X-TourCore-Setup-Session": token })).status, header).toBe(404);
    }
    expect((await app.raw("GET", "/install", { Host: "evil.example" })).status).toBe(403);
    // The public health page is reachable, and says nothing about the installation beyond a fingerprint.
    const health = await app.raw("GET", "/healthz", { Host: publicHost });
    expect(JSON.parse(health.body)).toEqual({ ok: true, service: "tour-core", installation: expect.stringMatching(/^[a-f0-9]{16}$/) });
    expect(app.installation.secrets.get("TOURCORE_GROK_ROUTINE_KEY")).toBeUndefined();
  });

  it("needs a live, short-lived session for every call; expired sessions are rejected", async () => {
    const app = await startApp();
    expect(await app.setup("GET", "status", undefined)).toMatchObject({ status: 401, body: { error: { message: expect.stringContaining("needs a secure setup link") } } });
    expect((await app.setup("GET", "status", "made-up-session-token-000000000")).status).toBe(401);
    const { token } = app.installation.sessions.mint();
    const ok = await app.setup("GET", "status", token);
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toEqual({ visitorMessaging: { apiKey: false, apiSecret: false, fromNumber: null, incomingSecret: false }, operatorAlerts: { webhookUrl: false, key: false } });
    const notJson = await app.raw("POST", "/api/install/operator-alerts", { "X-TourCore-Setup-Session": token, "Content-Type": "text/plain" });
    expect(notJson.status).toBe(415);
    app.setClock(app.now() + 31 * 60_000);
    expect(await app.setup("POST", "operator-alerts", token, { webhookUrl: ROUTINE_URL, key: ROUTINE_KEY })).toMatchObject({ status: 401, body: { error: { message: "This secure setup link has expired. Ask Grok for a new one." } } });
    expect(app.installation.secrets.get("TOURCORE_GROK_ROUTINE_KEY")).toBeUndefined();
  });

  it("Sendblue: stores the credentials, validates the account and line, registers the webhook, and never returns them", async () => {
    const app = await startApp();
    const { token } = app.installation.sessions.mint();
    expect((await app.setup("POST", "visitor-messaging", token, { apiKey: SB_KEY, apiSecret: SB_SECRET, fromNumber: "555-000-99" })).body).toMatchObject({ ok: false, error: { message: "Enter the texting number in full, like +15551234567." } });
    const out = await app.setup("POST", "visitor-messaging", token, { apiKey: SB_KEY, apiSecret: SB_SECRET, fromNumber: "(555) 000-9999" });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, saved: true, message: "Visitor texting is connected.", incomingMessages: "Registered Tour Core's incoming-message address with Sendblue." });
    expect(out.body.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);

    const incoming = app.installation.secrets.get("SENDBLUE_WEBHOOK_SECRET")!;
    expect(app.installation.secrets.get("SENDBLUE_API_API_KEY")).toBe(SB_KEY);
    expect(app.installation.secrets.get("SENDBLUE_FROM_NUMBER")).toBe(LINE);
    expect(app.hooks).toEqual([{ url: `${PUBLIC}/webhooks/sendblue`, secret: incoming, sendblue_numbers: [LINE] }]);

    // The running server uses the new values right away: Sendblue's signed deliveries are accepted, others refused.
    const hook = (secret: string) => app.raw("POST", "/webhooks/sendblue", { "sb-signing-secret": secret }, { message_handle: `h_${secret.length}`, content: "Hi", from_number: "+15550102000", to_number: LINE, is_outbound: false });
    expect((await hook("wrong-secret")).status).toBe(401);
    expect((await hook(incoming)).status).toBe(200);

    // Grok sees the result, never the values.
    const status = await app.grok("get_installation_status");
    expect(status.result.components.find((c: { component: string }) => c.component === "VISITOR_MESSAGING")).toMatchObject({ state: "READY", summary: `Visitor texting is connected and working (${LINE}).` });
    const again = await app.setup("GET", "status", token);
    expect(again.body.settings.visitorMessaging).toEqual({ apiKey: true, apiSecret: true, fromNumber: LINE, incomingSecret: true });

    const everything = [JSON.stringify(out.body), JSON.stringify(again.body), status.text, (await app.grok("test_visitor_messaging")).text].join("\n");
    for (const secret of [SB_KEY, SB_SECRET, incoming]) expect(everything).not.toContain(secret);
    // Nowhere on disk but the secret store: not the manifest, install state, runtime records, audit or exports.
    for (const f of files(app.root).filter((f) => !f.endsWith(join("install", "secrets.json")))) {
      const text = readFileSync(f, "utf8");
      for (const secret of [SB_KEY, SB_SECRET, incoming]) expect(text.includes(secret), f).toBe(false);
    }
  });

  it("Sendblue: a rejected account is reported plainly and nothing is registered", async () => {
    const app = await startApp();
    app.fake.client.webhooks.list = async () => {
      throw Object.assign(new Error('401 {"message":"nope"}'), { status: 401, name: "AuthenticationError" });
    };
    const { token } = app.installation.sessions.mint();
    const out = await app.setup("POST", "visitor-messaging", token, { apiKey: SB_KEY, apiSecret: SB_SECRET, fromNumber: LINE });
    expect(out.body).toMatchObject({ ok: false, saved: true, message: "Sendblue didn't accept those account details." });
    expect(app.hooks).toEqual([]);
    const s = await app.grok("get_installation_component", { component: "VISITOR_MESSAGING" });
    expect(s.result).toMatchObject({ state: "ERROR", next: { action: "FIX_VISITOR_MESSAGING", performedBy: "OPERATOR_IN_SECURE_SETUP" } });
  });

  it("Grok Routine: stores the webhook address and key, sends a test alert, and the key never reaches Grok", async () => {
    const app = await startApp();
    const { token } = app.installation.sessions.mint();
    expect((await app.setup("POST", "operator-alerts", token, { webhookUrl: "http://routines.example/x", key: ROUTINE_KEY })).body).toMatchObject({ ok: false, error: { message: "The webhook address must start with https://." } });
    const out = await app.setup("POST", "operator-alerts", token, { webhookUrl: ROUTINE_URL, key: ROUTINE_KEY });
    expect(out.body).toMatchObject({ ok: true, saved: true, message: "Sent a test update. The Tour Core Operator Updates routine should wake up and post a short confirmation." });
    const [call] = app.net.routineCalls();
    expect(call).toMatchObject({ url: ROUTINE_URL, method: "POST", headers: expect.objectContaining({ Authorization: `Bearer ${ROUTINE_KEY}`, "Content-Type": "application/json" }) });
    const payload = JSON.parse(call!.body!);
    expect(Object.keys(payload).sort()).toEqual(["eventId", "eventType", "occurredAt", "schemaVersion"]);
    expect(payload).toMatchObject({ schemaVersion: 1, eventType: "installation.test" });
    expect(app.installation.files.manifest()!.operatorNotificationProvider).toBe("GROK_ROUTINE");

    const alerts = await app.grok("get_installation_component", { component: "OPERATOR_ALERTS" });
    expect(alerts.result).toMatchObject({ state: "READY" });
    const test = await app.grok("test_operator_alerts");
    expect(test.result).toMatchObject({ ok: true });
    const list = await fetch(`http://127.0.0.1:${app.port}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }) }).then((r) => r.text());
    for (const text of [JSON.stringify(out.body), alerts.text, test.text, list, JSON.stringify((await app.setup("GET", "status", token)).body)]) {
      expect(text).not.toContain(ROUTINE_KEY);
      expect(text).not.toContain(ROUTINE_URL);
    }
    for (const f of files(app.root).filter((f) => !f.endsWith(join("install", "secrets.json")))) expect(readFileSync(f, "utf8").includes(ROUTINE_KEY), f).toBe(false);
  });

  it("a refused routine key is reported as an error with a secure-setup next step", async () => {
    const app = await startApp();
    app.net.state.routineStatus = 401;
    const { token } = app.installation.sessions.mint();
    const out = await app.setup("POST", "operator-alerts", token, { webhookUrl: ROUTINE_URL, key: ROUTINE_KEY });
    expect(out.body).toMatchObject({ ok: false, message: "The Grok Routine refused the connection details. Re-enter them on the secure setup page." });
    const s = await app.grok("get_installation_component", { component: "OPERATOR_ALERTS" });
    expect(s.result).toMatchObject({ state: "ERROR", next: { action: "FIX_OPERATOR_ALERTS", secureSetupStep: "operator-alerts" } });
  });
});
