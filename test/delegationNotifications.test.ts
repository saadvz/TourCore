import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DelegationPrototype, LocalReplySink } from "../src/delegation/prototype";
import { DelegationNotifications, type FetchWebhook } from "../src/delegation/notifications";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const identity = { tenantId: "synthetic_host", agentId: "grok_test_agent" };
const settings = { url: "https://hooks.example/private_receiver", authorization: "Bearer private_webhook_value" };
async function setup(fetch: FetchWebhook, options: { timeoutMs?: number; maxAttempts?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cleaner-notifications-")); roots.push(root);
  const clock = { now: Date.parse("2026-10-11T12:00:00Z") };
  const sink = new LocalReplySink(join(root, "replies.json"));
  const engine = new DelegationPrototype(root, sink, { now: () => clock.now });
  await engine.saveTurn({ tenantId: identity.tenantId, id: "turn_1", version: 1, recipient: "synthetic_owner", timeZone: "America/New_York", windowStart: "2026-10-12T12:00:00Z", windowEnd: "2026-10-12T18:00:00Z", nextArrival: "2026-10-12T19:00:00Z", minimumMinutes: 90 });
  const id = await engine.receive({ tenantId: identity.tenantId, providerEventId: "test_one", turnId: "turn_1", requestedStart: "2026-10-12T13:00:00Z" });
  const create = () => new DelegationNotifications(root, engine, identity, settings, { fetch, now: () => clock.now, ...options });
  return { root, clock, sink, engine, id, create, notifications: create() };
}

it("sends only correlation IDs, records HTTP acceptance separately, and survives restart without another wakeup", async () => {
  const requests: RequestInit[] = [];
  const h = await setup(async (url, init) => { expect(url).toBe(settings.url); requests.push(init); return new Response("private_response", { status: 200 }); });
  await h.notifications.tick();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: settings.authorization } });
  expect(JSON.parse(requests[0]!.body as string)).toEqual({ schemaVersion: 1, eventType: "cleaner.reschedule_requested", eventId: h.id, workId: h.id, deadlineAt: "2026-10-11T12:02:00.000Z" });
  expect(await h.notifications.status(h.id)).toMatchObject({ status: "accepted", attempts: 1, lastHttpStatus: 200 });
  expect((await h.engine.get(identity, h.id)).status).toBe("pending");
  await h.create().tick();
  expect(requests).toHaveLength(1);
  const saved = readFileSync(join(h.root, "notifications.json"), "utf8");
  for (const secret of [settings.url, settings.authorization, "private_response", "synthetic_owner"]) expect(saved).not.toContain(secret);
});

it("recovers durable work that was saved before a notifier existed", async () => {
  let calls = 0;
  const h = await setup(async () => { calls++; return new Response(null, { status: 204 }); });
  expect(await h.notifications.status(h.id)).toMatchObject({ status: "not_queued" });
  await h.create().tick();
  expect(calls).toBe(1);
  expect(await h.notifications.status(h.id)).toMatchObject({ status: "accepted" });
});

it("retries transient failures with backoff and the same correlation ID, bounded across restart", async () => {
  const ids: string[] = [];
  const h = await setup(async (_url, init) => { ids.push(JSON.parse(init.body as string).eventId); if (ids.length === 1) throw new Error(settings.authorization); return new Response(null, { status: 503 }); });
  await h.notifications.tick(); await h.notifications.tick();
  expect(ids).toHaveLength(1);
  h.clock.now += 1000; await h.create().tick();
  expect(ids).toHaveLength(2);
  h.clock.now += 2000; await h.create().tick();
  h.clock.now += 4000; await h.create().tick();
  expect(ids).toEqual([h.id, h.id, h.id]);
  expect(await h.notifications.status(h.id)).toMatchObject({ status: "failed", attempts: 3, lastHttpStatus: 503 });
  expect(readFileSync(join(h.root, "notifications.json"), "utf8")).not.toContain(settings.authorization);
});

it("does not retry permanent authorization failures", async () => {
  let calls = 0;
  const h = await setup(async () => { calls++; return new Response(null, { status: 401 }); });
  await h.notifications.tick(); h.clock.now += 10000; await h.create().tick();
  expect(calls).toBe(1);
  expect(await h.notifications.status(h.id)).toMatchObject({ status: "failed", attempts: 1, lastHttpStatus: 401 });
});

it("recovers an interrupted sending attempt using the same work ID", async () => {
  let calls = 0;
  const h = await setup(async () => { calls++; return new Response(null, { status: 200 }); });
  writeFileSync(join(h.root, "notifications.json"), JSON.stringify({ schemaVersion: 1, events: [{ workId: h.id, deadlineAt: "2026-10-11T12:02:00.000Z", status: "sending", attempts: 1, nextAttemptAt: h.clock.now, queuedAt: new Date(h.clock.now).toISOString(), attemptedAt: new Date(h.clock.now).toISOString() }] }));
  await h.create().tick();
  expect(calls).toBe(1);
  expect(await h.notifications.status(h.id)).toMatchObject({ status: "accepted", attempts: 2 });
});

it("stops retries at the deadline while the independent engine completes fallback", async () => {
  let calls = 0;
  const h = await setup(async () => { calls++; return new Response(null, { status: 503 }); });
  await h.notifications.tick(); h.clock.now += 120000;
  await h.notifications.tick(); await h.engine.tick();
  expect(calls).toBe(1);
  expect(await h.notifications.status(h.id)).toMatchObject({ status: "cancelled", failure: "work_closed" });
  expect((await h.engine.get(identity, h.id))).toMatchObject({ status: "completed", decisionSource: "fallback" });
  expect(h.sink.replies()).toHaveLength(1);
});

it("bounds a hung network request and aborts it", async () => {
  let signal: AbortSignal | undefined;
  const h = await setup(async (_url, init) => { signal = init.signal as AbortSignal; return new Promise(() => {}); }, { timeoutMs: 10, maxAttempts: 1 });
  await h.notifications.tick();
  expect(signal!.aborted).toBe(true);
  expect(await h.notifications.status(h.id)).toMatchObject({ status: "failed", attempts: 1, failure: "network" });
});

it("fails closed on damaged notification state without overwriting it", async () => {
  const h = await setup(async () => new Response(null, { status: 200 }));
  writeFileSync(join(h.root, "notifications.json"), "{damaged");
  expect(h.create).toThrow();
  expect(readFileSync(join(h.root, "notifications.json"), "utf8")).toBe("{damaged");
});
