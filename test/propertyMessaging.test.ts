import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TourCoreConfig } from "../src/config/tourCoreConfig";
import { Installation } from "../src/install/installation";
import { LocalSecretStore } from "../src/install/secretStore";
import { DEFAULT_LOCAL_FROM_NUMBER } from "../src/messaging/local/provider";
import { resetLocalSmsOutbox } from "../src/messaging/local/outbox";
import { setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { createSetupServer } from "../src/web/server";
import { installHarness, SB_KEY, SB_SECRET } from "./installHarness";
import { hillsideConfig } from "./liveApp";
import { LINE, PUBLIC, SECRET, fakeSendblue, sendblueEnv } from "./fakeSendblue";

const VISITOR = "+15555550100";
const TOKEN = "test-operator-token-abcdef";
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((c) => c());
  resetLocalSmsOutbox();
});

function tenaflyConfig(): TourCoreConfig {
  const c = hillsideConfig();
  return {
    ...c,
    property: {
      ...c.property,
      id: "prop_144_hillside_ave_teaneck_nj",
      name: "144 Hillside Ave, Teaneck, NJ",
      address: "144 Hillside Ave, Teaneck, NJ",
    },
  };
}

function scratchConfig(): TourCoreConfig {
  const c = hillsideConfig();
  return {
    ...c,
    property: {
      ...c.property,
      id: "prop_200_scratch_way",
      name: "200 Scratch Way",
      address: "200 Scratch Way, Teaneck, NJ",
    },
  };
}

async function publish(ws: PropertyWorkspace, config: TourCoreConfig, now: Date) {
  const saved = ws.save(config);
  ws.recordReadiness(saved.config.property.id, await runReadinessCheck(saved.config, { now }));
  ws.recordDryTour(saved.config.property.id, { passed: true, ranAt: now.toISOString(), checks: [], audit: [] });
  const published = await ws.publishDemoProperty(saved.config.property.id, now);
  expect(published.published).toBe(true);
  return saved.config.property.id;
}

async function startMixedApp() {
  const root = mkdtempSync(join(tmpdir(), "tourcore-property-msg-"));
  cleanups.push(resetLocalSmsOutbox());
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const fake = fakeSendblue();
  cleanups.push(setSendblueRuntime({ env: () => sendblueEnv(), client: () => fake.client }));
  let clock = Date.parse("2026-09-28T11:00:00.000Z");
  const ws = new PropertyWorkspace(root);
  const now = new Date(clock);
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  const env: NodeJS.ProcessEnv = {
    PUBLIC_BASE_URL: PUBLIC,
    TOURCORE_SMS_CONSENT_MODE: "keyword_confirm",
    SENDBLUE_API_API_KEY: SB_KEY,
    SENDBLUE_API_API_SECRET: SB_SECRET,
    SENDBLUE_FROM_NUMBER: LINE,
    SENDBLUE_WEBHOOK_SECRET: SECRET,
  };
  const installation = new Installation({
    root,
    runtime,
    secrets: new LocalSecretStore(join(root, "install", "secrets.json"), () => clock),
    env: () => env,
    now: () => clock,
  });
  installation.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
  installation.files.setPublicBaseUrl(PUBLIC, "MANUAL");
  installation.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: LINE, SENDBLUE_WEBHOOK_SECRET: SECRET });
  installation.files.writeState({
    ...installation.files.state(),
    messagingProviderChoice: "sendblue",
    visitorMessaging: { ok: true, at: now.toISOString(), message: "ok", problems: [], publicBaseUrl: PUBLIC, provider: "sendblue" },
  });
  installation.files.update({ messagingProvider: "SENDBLUE" });
  const server = createSetupServer({
    toolSurface: "all", workspace: ws, installation, now: () => new Date(clock), realNow: () => clock, operatorToken: () => TOKEN, log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  const tenaflyId = await publish(ws, tenaflyConfig(), now);
  const scratchId = ws.save(scratchConfig()).config.property.id;
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
  await grok("run_readiness_check", { property: tenaflyId });
  return { grok, ws, inst: installation, tenaflyId, scratchId };
}

describe("property-scoped local messaging", () => {
  it("keeps a published Sendblue property published when scratch uses local inject", async () => {
    const app = await startMixedApp();
    expect(app.ws.load(app.tenaflyId).state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(app.inst.files.manifest()?.messagingProvider).toBe("SENDBLUE");

    const chosen = await app.grok("choose_messaging_provider", { provider: "local", property: app.scratchId });
    expect(chosen.scope).toBe("property");
    expect(chosen.summary).toMatch(/this building will use local test texts/i);
    expect(chosen.summary).not.toMatch(/Sendblue|Twilio|Photon/i);
    expect(app.inst.files.manifest()?.messagingProvider).toBe("SENDBLUE");
    expect(app.inst.files.state().messagingProviderChoice).toBe("sendblue");
    expect(app.inst.files.state().visitorMessaging?.ok).toBe(true);
    expect(app.inst.secrets.get("SENDBLUE_API_API_KEY")).toBe(SB_KEY);
    expect(app.inst.secrets.get("SENDBLUE_API_API_SECRET")).toBe(SB_SECRET);
    expect(app.inst.secrets.get("SENDBLUE_FROM_NUMBER")).toBe(LINE);
    expect(app.ws.load(app.tenaflyId).state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(app.ws.load(app.scratchId).config.messagingProvider).toBe("local");
    expect(app.ws.load(app.scratchId).config.messagingMode).toBe("live");

    await app.grok("run_readiness_check", { property: app.scratchId });
    expect(app.ws.load(app.tenaflyId).state.status).toBe("PUBLISHED_FOR_DEMO");

    const injected = await app.grok("inject_local_sms", { from: VISITOR, text: "TOUR", property: app.scratchId });
    expect(injected.bubbles.length).toBeGreaterThanOrEqual(1);
    expect(typeof injected.bubbles[0].body).toBe("string");
    expect(injected.bubbles[0].body).toBe("Thanks for reaching out to 200 Scratch Way. Self-guided tours by text aren't available right now. Please contact the property team.");
    expect(injected.to).toBe(DEFAULT_LOCAL_FROM_NUMBER);
    const outbox = await app.grok("read_local_outbox", { from: VISITOR, property: app.scratchId });
    expect(outbox.bubbles.length).toBeGreaterThanOrEqual(1);
    expect(outbox.bubbles.every((b: { body: string; sentAt: string }) => typeof b.body === "string" && typeof b.sentAt === "string")).toBe(true);
    if (outbox.bubbles.length > 1) {
      expect(outbox.bubbles.map((b: { body: string }) => b.body).join("\0")).not.toEqual(outbox.bubbles.map((b: { body: string }) => b.body).join(""));
    }

    await expect(app.grok("inject_local_sms", { from: VISITOR, text: "TOUR", property: app.tenaflyId })).rejects.toThrow(
      /isn't set up for local test texts/,
    );
    expect(app.ws.load(app.tenaflyId).state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(app.inst.files.manifest()?.messagingProvider).toBe("SENDBLUE");
  });

  it("set_services local on scratch does not draft or disconnect the live Sendblue property", async () => {
    const app = await startMixedApp();
    await app.grok("set_services", { property: app.scratchId, messaging: "local" });
    expect(app.ws.load(app.scratchId).config.messagingProvider).toBe("local");
    expect(app.ws.load(app.tenaflyId).state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(app.inst.files.manifest()?.messagingProvider).toBe("SENDBLUE");
    expect(app.inst.secrets.get("SENDBLUE_API_API_KEY")).toBe(SB_KEY);
    const injected = await app.grok("inject_local_sms", { from: VISITOR, text: "HI", property: app.scratchId });
    expect(injected.bubbles.length).toBeGreaterThanOrEqual(1);
    expect(app.ws.load(app.tenaflyId).state.status).toBe("PUBLISHED_FOR_DEMO");
  });

  it("choose_messaging_provider local without a property refuses when two buildings exist", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl(PUBLIC, "MANUAL");
    await h.ok("choose_messaging_provider", { provider: "sendblue" });
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: LINE, SENDBLUE_WEBHOOK_SECRET: SECRET });
    h.inst.files.recordCheck("visitorMessaging", { ok: true, at: new Date(h.now()).toISOString(), message: "ok", problems: [], publicBaseUrl: PUBLIC, provider: "sendblue" });
    const tenaflyId = await publish(h.workspace, tenaflyConfig(), new Date(h.now()));
    h.workspace.save(scratchConfig());

    expect(await h.fails("choose_messaging_provider", { provider: "local" })).toMatch(/Say which building should use local test texts/);
    expect(h.workspace.load(tenaflyId).state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(h.inst.files.manifest()?.messagingProvider).toBe("SENDBLUE");
    expect(h.inst.files.state().visitorMessaging?.ok).toBe(true);
    expect(h.inst.secrets.get("SENDBLUE_API_API_KEY")).toBe(SB_KEY);
  });

  it("switching the scratch property back to the install provider keeps Sendblue credentials", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl(PUBLIC, "MANUAL");
    await h.ok("choose_messaging_provider", { provider: "sendblue" });
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: LINE, SENDBLUE_WEBHOOK_SECRET: SECRET });
    const { config } = h.workspace.save(hillsideConfig());
    await h.ok("choose_messaging_provider", { provider: "local", property: config.property.id });
    expect(h.workspace.load(config.property.id).config.messagingProvider).toBe("local");
    expect(h.inst.files.manifest()?.messagingProvider).toBe("SENDBLUE");
    expect(h.inst.secrets.get("SENDBLUE_API_API_KEY")).toBe(SB_KEY);

    const back = await h.ok("choose_messaging_provider", { provider: "sendblue", property: config.property.id });
    expect(back.scope).toBe("property");
    expect(h.workspace.load(config.property.id).config.messagingProvider).toBeUndefined();
    expect(h.inst.files.manifest()?.messagingProvider).toBe("SENDBLUE");
    expect(h.inst.secrets.get("SENDBLUE_API_API_KEY")).toBe(SB_KEY);
    expect(h.inst.secrets.get("SENDBLUE_FROM_NUMBER")).toBe(LINE);
  });
});

