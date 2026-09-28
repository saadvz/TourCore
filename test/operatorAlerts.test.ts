import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { zonedTimeToUtc } from "../src/core/timezone";
import { DeliveryError, exceptionCreatedEvent, type OperatorNotificationSink } from "../src/alerts/operatorEvents";
import { OperatorEventOutbox } from "../src/alerts/outbox";
import { Installation } from "../src/install/installation";
import { LocalSecretStore } from "../src/install/secretStore";
import { setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { FileRuntimeStore, MemoryRuntimeStore } from "../src/storage/runtimeStore";
import { createSetupServer, type TourCoreServer } from "../src/web/server";
import { fakeSendblue, inbound, SECRET, sendblueEnv } from "./fakeSendblue";
import { fakeNetwork, ROUTINE_KEY, ROUTINE_URL } from "./installHarness";

/**
 * Proactive operator alerts, end to end: a real visitor (Sendblue faked at
 * the SDK) asks something with no approved answer, gets the safe fallback
 * immediately, and Tour Core wakes the Grok Routine (faked at the network)
 * with a minimal event. Grok then reads the canonical exception over MCP.
 */

const at = (hour: number, minute = 0) => zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour, minute }, "America/New_York").getTime();
const PHONE = "+15550102000";
const TOKEN = "test-operator-token-abcdef";
const FALLBACK = "I don't have that information for this property. I've flagged it for the property team so they can get back to you.";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

async function alertApp(options: { root?: string; clock?: { t: number }; net?: ReturnType<typeof fakeNetwork>; fake?: ReturnType<typeof fakeSendblue> } = {}) {
  const fresh = !options.root;
  const root = options.root ?? mkdtempSync(join(tmpdir(), "tourcore-alerts-"));
  const clock = options.clock ?? { t: at(7) };
  const net = options.net ?? fakeNetwork();
  const fake = options.fake ?? fakeSendblue();
  cleanups.push(setSendblueRuntime({ env: () => sendblueEnv(), client: () => fake.client }));
  const ws = new PropertyWorkspace(root);
  if (fresh) {
    const config = loadConfig();
    const { config: saved } = ws.save({ ...config, messagingMode: "sendblue", property: { ...config.property, facts: ["Street parking only."] } });
    ws.recordReadiness(saved.property.id, await runReadinessCheck(saved, { now: new Date(clock.t) }));
  }
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  const installation = new Installation({ root, runtime, secrets: new LocalSecretStore(join(root, "install", "secrets.json")), now: () => clock.t, fetch: net.fetch as never, outbox: { baseDelayMs: 1000 } });
  if (fresh) installation.secrets.set({ TOURCORE_GROK_ROUTINE_URL: ROUTINE_URL, TOURCORE_GROK_ROUTINE_KEY: ROUTINE_KEY });
  const server: TourCoreServer = createSetupServer({ workspace: ws, installation, now: () => new Date(clock.t), realNow: () => clock.t, operatorToken: () => TOKEN, log: () => {}, alertRetryMs: 3_600_000 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
  };
  cleanups.push(close);
  if (fresh) cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  await server.tourCore.settled();

  let n = 0;
  const text = async (content: string) => {
    const before = fake.sent.length;
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/sendblue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "sb-signing-secret": SECRET },
      body: JSON.stringify(inbound(PHONE, content, `in_${root.slice(-6)}_${++n}_${clock.t}`)),
    });
    expect(res.status).toBe(200);
    return fake.sent.slice(before).filter((s) => s.number === PHONE).map((s) => s.content);
  };
  let rpc = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const grok = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; result: any }> => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = await res.text();
    return { text: body, result: (JSON.parse(body) as { result: { structuredContent: unknown } }).result.structuredContent };
  };
  /** Books, verifies and brings the visitor inside Unit 101, by text. */
  const touring = async () => {
    await text("Hi");
    await text("1");
    await text("1");
    const consent = await text("YES");
    const token = /\/verify\/([A-Za-z0-9_-]+)/.exec(consent.join("\n"))![1]!;
    const form = await fetch(`http://127.0.0.1:${port}/api/verify/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: PHONE }) });
    expect(((await form.json()) as { ok: boolean }).ok).toBe(true);
    clock.t = at(13, 58);
    await text("I'm here");
    await text("at unit 101");
  };
  const events = () => installation.outbox.records().filter((r) => r.event.eventType === "exception.created");
  return { root, clock, net, fake, installation, server, text, grok, touring, events, close };
}

describe("proactive operator alerts", () => {
  it('"Is there a pool?": the visitor gets the safe fallback at once, and Tour Core wakes the Grok Routine with one minimal event', async () => {
    const app = await alertApp();
    await app.touring();
    await app.server.tourCore.settled();
    expect(app.net.routineCalls()).toHaveLength(0);

    const reply = await app.text("Is there a pool?");
    expect(reply).toEqual([FALLBACK]);
    await app.server.tourCore.settled();

    const calls = app.net.routineCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${ROUTINE_KEY}` });
    const event = JSON.parse(calls[0]!.body!);
    expect(Object.keys(event).sort()).toEqual(["eventId", "eventType", "exceptionId", "occurredAt", "propertyId", "schemaVersion"]);
    expect(event).toMatchObject({ schemaVersion: 1, eventType: "exception.created", propertyId: "prop_100_alfred_way", eventId: expect.stringMatching(/^evt_[a-f0-9]{24}$/), exceptionId: expect.stringMatching(/^exc_[a-f0-9]{12}$/) });
    // No visitor PII or message text, and no credentials.
    for (const leak of ["pool", "Pat", "Smith", "5550102000", "pat@example.com", ROUTINE_KEY]) expect(calls[0]!.body).not.toContain(leak);
    expect(app.events().map((r) => r.status)).toEqual(["delivered"]);

    // Grok wakes and reads the canonical exception.
    const issue = await app.grok("inspect_exception", { exceptionId: event.exceptionId });
    expect(issue.result.issue).toMatchObject({ unitName: "Unit 101", what: "Question with no approved answer", question: "Is there a pool?", tourStatus: "Tour still active" });
    expect(issue.text).not.toContain(ROUTINE_KEY);

    // More texts and re-scans never announce the same exception twice.
    await app.text("ok thanks");
    await app.server.tourCore.settled();
    expect(await app.server.tourCore.alerts.scan()).toBe(0);
    await app.installation.outbox.drain();
    expect(app.net.routineCalls()).toHaveLength(1);
  });

  it("an alert outage doesn't touch the visitor; the event stays pending and is retried with the same eventId", async () => {
    const app = await alertApp();
    await app.touring();
    app.net.state.routineDown = true;
    expect(await app.text("Is there a pool?")).toEqual([FALLBACK]);
    await app.server.tourCore.settled();
    const [pending] = app.events();
    expect(pending).toMatchObject({ status: "pending", attempts: 1, lastError: "Couldn't reach the Grok Routine right now." });
    // The visitor carries on normally while alerts are down.
    expect((await app.text("how many bedrooms?"))[0]).toContain("Two-bedroom, first floor, south-facing.");
    // Not due yet: nothing is re-sent before the backoff.
    await app.installation.outbox.drain();
    expect(app.net.routineCalls()).toHaveLength(1);
    const status = await app.grok("get_installation_component", { component: "OPERATOR_ALERTS" });
    expect(status.result.state).not.toBe("READY");

    app.net.state.routineDown = false;
    app.clock.t += 5_000;
    await app.installation.outbox.drain();
    const calls = app.net.routineCalls();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]!.body!).eventId).toBe(JSON.parse(calls[0]!.body!).eventId);
    expect(app.events()).toEqual([expect.objectContaining({ status: "delivered", attempts: 2 })]);
    await app.installation.outbox.drain();
    expect(app.net.routineCalls()).toHaveLength(2);
  });

  it("a pending alert survives a restart and is delivered by the next Tour Core, once", async () => {
    const first = await alertApp();
    await first.touring();
    first.net.state.routineDown = true;
    await first.text("Is there a pool?");
    await first.server.tourCore.settled();
    expect(first.events().map((r) => r.status)).toEqual(["pending"]);
    const eventId = first.events()[0]!.event.eventId;
    first.close();

    const net = fakeNetwork();
    first.clock.t += 60_000;
    const second = await alertApp({ root: first.root, clock: first.clock, net, fake: first.fake });
    await second.server.tourCore.settled();
    expect(net.routineCalls().map((c) => JSON.parse(c.body!).eventId)).toEqual([eventId]);
    expect(second.events().map((r) => r.status)).toEqual(["delivered"]);
    await second.installation.outbox.drain();
    expect(net.routineCalls()).toHaveLength(1);
  });

  it("with no routine connected, events wait; an issue handled meanwhile is never announced late", async () => {
    const app = await alertApp();
    app.installation.secrets.delete(["TOURCORE_GROK_ROUTINE_URL", "TOURCORE_GROK_ROUTINE_KEY"]);
    await app.touring();
    await app.text("Is there a pool?");
    await app.server.tourCore.settled();
    expect(app.events()).toEqual([expect.objectContaining({ status: "pending", attempts: 0 })]);
    expect(app.net.routineCalls()).toHaveLength(0);
    await app.grok("resolve_exception", { exceptionId: app.events()[0]!.event.exceptionId, resolutionNote: "Told them in person." });
    app.installation.secrets.set({ TOURCORE_GROK_ROUTINE_URL: ROUTINE_URL, TOURCORE_GROK_ROUTINE_KEY: ROUTINE_KEY });
    await app.installation.outbox.drain();
    expect(app.events()).toEqual([expect.objectContaining({ status: "suppressed" })]);
    expect(app.net.routineCalls()).toHaveLength(0);
  });
});

describe("operator event outbox", () => {
  const event = exceptionCreatedEvent({ propertyId: "prop_x", exceptionId: "exc_0123456789ab", occurredAt: "2026-09-28T13:00:00.000Z" });

  function sink(behavior: () => Promise<void>): OperatorNotificationSink & { calls: number } {
    const s = { kind: "GROK_ROUTINE" as const, calls: 0, configured: () => true, deliver: async () => (s.calls++, behavior()) };
    return s;
  }

  it("queues an event once, with a stable id", () => {
    const outbox = new OperatorEventOutbox(new MemoryRuntimeStore(), () => sink(async () => {}));
    expect(outbox.enqueue(event).created).toBe(true);
    expect(outbox.enqueue(exceptionCreatedEvent({ propertyId: "prop_x", exceptionId: "exc_0123456789ab", occurredAt: "later" })).created).toBe(false);
    expect(outbox.records()).toHaveLength(1);
  });

  it("backs off exponentially, stays bounded, and gives up after the attempt limit", async () => {
    let t = 0;
    const s = sink(async () => {
      throw new DeliveryError("down", true);
    });
    const outbox = new OperatorEventOutbox(new MemoryRuntimeStore(), () => s, { now: () => t, baseDelayMs: 1000, maxDelayMs: 4000, maxAttempts: 4 });
    outbox.enqueue(event);
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      await outbox.drain();
      const r = outbox.get(event.eventId)!;
      delays.push(Date.parse(r.nextAttemptAt) - t);
      t = Date.parse(r.nextAttemptAt);
    }
    expect(delays).toEqual([1000, 2000, 4000, 4000]);
    expect(outbox.get(event.eventId)).toMatchObject({ status: "failed", attempts: 4 });
    await outbox.drain();
    expect(s.calls).toBe(4);
  });

  it("concurrent drains never deliver the same event twice", async () => {
    let release!: () => void;
    const s = sink(() => new Promise<void>((r) => (release = r)));
    const outbox = new OperatorEventOutbox(new MemoryRuntimeStore(), () => s);
    outbox.enqueue(event);
    const a = outbox.drain();
    const b = outbox.drain();
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([a, b]);
    expect(s.calls).toBe(1);
    expect(outbox.get(event.eventId)!.status).toBe("delivered");
  });
});
