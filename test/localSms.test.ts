import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Installation } from "../src/install/installation";
import { LOCAL_PROVIDER_REQUIRED, LocalMessagingProvider, readLocalEnv } from "../src/messaging/local/provider";
import { localSmsOutbox, resetLocalSmsOutbox } from "../src/messaging/local/outbox";
import { MessagingLedger } from "../src/messaging/ledger";
import { handleProviderWebhook } from "../src/messaging/pipeline";
import { bindMessagingInstallation } from "../src/messaging/registry";
import { sendblueRuntime } from "../src/messaging/sendblue/runtime";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { createSetupServer } from "../src/web/server";
import { grokHarness } from "./grokHarness";
import { installHarness, SB_KEY, SB_SECRET } from "./installHarness";
import { UNKNOWN_ANSWER_WITH_PHOTO } from "../src/core/TourCore";
import { PHOTO_ALONE_REPLY, PHOTO_WITH_TEXT_REPLY } from "../src/visitor/conversation";
import { hillsideConfig, publishForVisitors } from "./liveApp";
import { LINE, PUBLIC } from "./fakeSendblue";

const VISITOR = "+15555550100";
const TOKEN = "test-operator-token-abcdef";
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((c) => c());
  resetLocalSmsOutbox();
});

function inbound(from: string, text: string, id = "in_1", to = "+15555550123") {
  return { id, from, to, text };
}

async function startLocalApp() {
  const root = mkdtempSync(join(tmpdir(), "tourcore-local-sms-"));
  cleanups.push(resetLocalSmsOutbox());
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let clock = Date.parse("2026-09-28T11:00:00.000Z"); // 7am ET
  const ws = new PropertyWorkspace(root);
  const { config } = ws.save(hillsideConfig());
  ws.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(clock) }));
  publishForVisitors(ws, config.property.id, new Date(clock));
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  const env: NodeJS.ProcessEnv = {
    TOURCORE_MESSAGING_PROVIDER: "local",
    PUBLIC_BASE_URL: PUBLIC,
    TOURCORE_SMS_CONSENT_MODE: "keyword_confirm",
  };
  cleanups.push(
    bindMessagingInstallation(() => ({
      env,
      sendblue: sendblueRuntime.env(),
      choice: "local",
      manifestProvider: "LOCAL",
    })),
  );
  const installation = new Installation({ root, runtime, env: () => env, now: () => clock });
  installation.files.ensure({ deploymentMode: "LOCAL_DEVELOPER" });
  installation.files.setPublicBaseUrl(PUBLIC, "MANUAL");
  installation.files.writeState({
    ...installation.files.state(),
    messagingProviderChoice: "local",
    visitorMessaging: { ok: true, at: new Date(clock).toISOString(), message: "ok", problems: [], publicBaseUrl: PUBLIC, provider: "local" },
  });
  installation.files.update({ messagingProvider: "LOCAL" });
  const server = createSetupServer({
    toolSurface: "all", workspace: ws, installation, now: () => new Date(clock), realNow: () => clock, operatorToken: () => TOKEN, log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  const port = (server.address() as { port: number }).port;
  let rpc = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const grok = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as { result: { isError: boolean; structuredContent: unknown; content: Array<{ text: string }> } };
    if (body.result.isError) throw new Error(body.result.content[0]!.text);
    return body.result.structuredContent;
  };
  const webhook = async (payload: object) => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/local`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  };
  const app = { grok, webhook, port, id: config.property.id, setClock: (t: number) => (clock = t) };
  await grok("run_readiness_check", { property: config.property.id });
  return app;
}

describe("local messaging provider", () => {
  it("sends each outbound SMS as its own outbox bubble and never opens a network connection", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ledger = new MessagingLedger();
    const provider = new LocalMessagingProvider({ ledger, now: () => new Date("2026-09-28T12:00:00.000Z") });
    expect(provider.validateConfiguration().ok).toBe(true);
    expect(provider.id).toBe("local");
    expect(readLocalEnv({}).fromNumber).toBe("+15555550123");

    const first = await provider.send({ to: VISITOR, body: "Hello", audience: "PROSPECT", idempotencyKey: "once" });
    const again = await provider.send({ to: VISITOR, body: "Hello", audience: "PROSPECT", idempotencyKey: "once" });
    const second = await provider.send({ to: VISITOR, body: "Which unit?", audience: "PROSPECT", idempotencyKey: "two" });
    expect(first.provider).toBe("local");
    expect(first.providerMessageId).toBeTruthy();
    expect(again.providerMessageId).toBe(first.providerMessageId);
    expect(second.providerMessageId).not.toBe(first.providerMessageId);

    const bubbles = localSmsOutbox().forVisitor(VISITOR);
    expect(bubbles.map((b) => b.body)).toEqual(["Hello", "Which unit?"]);
    expect(bubbles[0]!.body).not.toContain("Which unit?");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("parses POST /webhooks/local JSON into the shared inbound shape", () => {
    const provider = new LocalMessagingProvider();
    const parsed = provider.parseInbound(Buffer.from(JSON.stringify(inbound(VISITOR, "TOUR", "msg_1")), "utf8"), new Date("2026-09-28T12:00:00.000Z"));
    expect(parsed).toEqual({
      message: {
        provider: "local",
        providerMessageId: "msg_1",
        from: VISITOR,
        to: "+15555550123",
        text: "TOUR",
        channel: "SMS",
        receivedAt: "2026-09-28T12:00:00.000Z",
      },
    });
    expect(provider.verifyWebhook({ rawBody: Buffer.from("{}"), headers: {} })).toEqual({ ok: true, signed: false });
  });

  it("connects without HTTP and reports a loopback check", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new LocalMessagingProvider({ env: () => readLocalEnv({ PUBLIC_BASE_URL: PUBLIC }) });
    const result = await provider.connect({ saveSecret: () => {} });
    expect(result.ok).toBe(true);
    expect(result.webhook).toBe("already-registered");
    expect(result.checks[0]).toMatchObject({ ok: true, message: "Local loopback is ready. No real texts are sent." });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("inject_local_sms and read_local_outbox", () => {
  it("injects a visitor text and returns each outbound reply as its own bubble", async () => {
    const app = await startLocalApp();
    const first = await app.grok("inject_local_sms", { from: VISITOR, text: "TOUR", property: app.id });
    expect(first.bubbles.length).toBeGreaterThanOrEqual(1);
    expect(first.bubbles.every((b: { body: string }) => typeof b.body === "string")).toBe(true);
    expect(Array.isArray(first.bubbles)).toBe(true);
    expect(typeof first.bubbles[0].body).toBe("string");
    expect(first.bubbles[0].body).toMatch(/TOUR|privacy|self-guided/i);
    expect(first.bubbles[0].body).not.toMatch(/aren't available right now/);

    const yes = await app.grok("inject_local_sms", { from: VISITOR, text: "YES", property: app.id });
    expect(yes.bubbles.length).toBeGreaterThan(1);
    expect(yes.bubbles.map((b: { body: string }) => b.body).join("||")).not.toBe(yes.bubbles.map((b: { body: string }) => b.body).join(""));
    for (const bubble of yes.bubbles) {
      expect(bubble.body).not.toMatch(/\n\nHello/);
      expect(typeof bubble.sentAt).toBe("string");
    }

    const outbox = await app.grok("read_local_outbox", { from: VISITOR, property: app.id });
    expect(outbox.bubbles.length).toBeGreaterThan(yes.bubbles.length);
    expect(outbox.bubbles.every((b: { templateId?: string }) => typeof b.templateId === "string" && b.templateId.length > 0)).toBe(true);
    expect(outbox.bubbles.map((b: { body: string }) => b.body).join("\0")).not.toEqual(outbox.bubbles.map((b: { body: string }) => b.body).join(""));
    expect(outbox.bubbles.some((b: { body: string }) => b.body.includes("Which unit"))).toBe(true);

    const unit = await app.grok("inject_local_sms", { from: VISITOR, text: "1", property: app.id });
    expect(unit.bubbles.length).toBeGreaterThanOrEqual(1);
    expect(unit.bubbles[0].body).toMatch(/day|unit|tour/i);

    const tours = await app.grok("list_active_tours");
    expect(tours.tours.length).toBeGreaterThanOrEqual(1);
    const inspected = await app.grok("inspect_tour", { tourRef: tours.tours[0].tourRef });
    expect(inspected.tour.visitorPhone ?? inspected.summary).toBeTruthy();
  });

  it("injects a photo inbound and returns the honesty reply once", async () => {
    const app = await startLocalApp();
    await app.grok("inject_local_sms", { from: VISITOR, text: "TOUR", property: app.id });
    await app.grok("inject_local_sms", { from: VISITOR, text: "YES", property: app.id });
    const photo = await app.grok("inject_local_sms", { from: VISITOR, hasMedia: true, property: app.id, id: "photo_once" });
    expect(photo.bubbles.map((b: { body: string }) => b.body)).toEqual([PHOTO_ALONE_REPLY]);
    const again = await app.grok("inject_local_sms", { from: VISITOR, hasMedia: true, property: app.id, id: "photo_once" });
    expect(again.duplicate).toBe(true);
    expect(again.bubbles).toEqual([]);
    const caption = await app.grok("inject_local_sms", { from: VISITOR, text: "Is there a gym?", hasMedia: true, property: app.id });
    expect(caption.bubbles[0].body).toBe(UNKNOWN_ANSWER_WITH_PHOTO);
    expect(caption.bubbles.filter((b: { body: string }) => b.body === PHOTO_WITH_TEXT_REPLY)).toHaveLength(0);
    expect(caption.bubbles.some((b: { body: string }) => b.body.includes("Text your question"))).toBe(false);
    expect(caption.bubbles.some((b: { body: string }) => b.body === UNKNOWN_ANSWER_WITH_PHOTO)).toBe(true);
  });

  it("feeds POST /webhooks/local through the same visitor pipeline", async () => {
    const app = await startLocalApp();
    const posted = await app.webhook(inbound(VISITOR, "TOUR", "hook_1"));
    expect(posted).toEqual({ status: 200, body: { ok: true } });
    const outbox = await app.grok("read_local_outbox", { from: VISITOR });
    expect(outbox.bubbles.length).toBeGreaterThanOrEqual(1);
    expect(outbox.bubbles[0].body).toMatch(/TOUR|privacy|self-guided/i);
    expect(outbox.bubbles[0].body).not.toMatch(/aren't available right now/);
  });

  it("refuses inject on a Sendblue property", async () => {
    expect(LOCAL_PROVIDER_REQUIRED).toBe("This property isn't set up for local test texts. Switch it to local messaging first.");
    const h = installHarness();
    cleanups.push(h.cleanup);
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl(PUBLIC, "MANUAL");
    await h.ok("choose_messaging_provider", { provider: "sendblue" });
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: LINE });
    h.workspace.save(hillsideConfig());
    expect(await h.fails("inject_local_sms", { from: VISITOR, text: "TOUR" })).toBe("This property isn't set up for local test texts. Switch it to local messaging first.");
    expect(await h.fails("read_local_outbox", { from: VISITOR })).toBe("This property isn't set up for local test texts. Switch it to local messaging first.");
  });

  it("refuses inject on a practice-text property", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    await h.setUpAlfredWay();
    expect(await h.fails("inject_local_sms", { from: VISITOR, text: "HI" })).toBe("This property isn't set up for local test texts. Switch it to local messaging first.");
  });

  it("switching a scratch property to local and back to Sendblue keeps the stored credentials", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl(PUBLIC, "MANUAL");
    await h.ok("choose_messaging_provider", { provider: "sendblue" });
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: LINE });
    h.workspace.save(hillsideConfig());
    await h.ok("set_services", { messaging: "live" });

    const toLocal = await h.ok("choose_messaging_provider", { provider: "local", property: hillsideConfig().property.id });
    expect(toLocal.scope).toBe("property");
    expect(h.inst.files.manifest()?.messagingProvider).toBe("SENDBLUE");
    expect(h.inst.secrets.get("SENDBLUE_API_API_KEY")).toBe(SB_KEY);
    expect(h.inst.secrets.get("SENDBLUE_API_API_SECRET")).toBe(SB_SECRET);
    expect(h.inst.secrets.get("SENDBLUE_FROM_NUMBER")).toBe(LINE);

    const back = await h.ok("choose_messaging_provider", { provider: "sendblue", property: hillsideConfig().property.id });
    expect(back.scope).toBe("property");
    expect(h.inst.secrets.get("SENDBLUE_API_API_KEY")).toBe(SB_KEY);
    expect(h.inst.secrets.get("SENDBLUE_FROM_NUMBER")).toBe(LINE);
    expect(h.inst.files.manifest()?.messagingProvider).toBe("SENDBLUE");
    expect((await h.status()).components.find((c) => c.component === "VISITOR_MESSAGING")?.next).toMatchObject({ action: "TEST_VISITOR_MESSAGING" });
  });

  it("choose_messaging_provider local needs no credentials and no network test", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const h = installHarness();
    cleanups.push(h.cleanup);
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl(PUBLIC, "MANUAL");
    const chosen = await h.ok("choose_messaging_provider", { provider: "local" });
    expect(chosen.summary).toMatch(/local loopback/i);
    const tested = await h.ok("test_visitor_messaging");
    expect(tested.ok).toBe(true);
    expect(tested.summary).toBe("Texting is in test mode, so texts don't reach real phones. Real visitors won't get anything until live texting is turned on.");
    expect(h.inst.files.manifest()?.messagingProvider).toBe("LOCAL");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("handleProviderWebhook for local", () => {
  it("de-duplicates by inbound id without sending on the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ledger = new MessagingLedger();
    const provider = new LocalMessagingProvider({ ledger });
    const received: string[] = [];
    const request = { rawBody: Buffer.from(JSON.stringify(inbound(VISITOR, "HI", "dup_1")), "utf8"), headers: {} };
    const first = await handleProviderWebhook(provider, request, { ledger, receive: async (m) => { received.push(m.text); } });
    const second = await handleProviderWebhook(provider, request, { ledger, receive: async (m) => { received.push(m.text); } });
    expect(first.body).toEqual({ ok: true });
    expect(second.body).toEqual({ duplicate: true });
    expect(received).toEqual(["HI"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
