import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createDelegationTestService } from "../src/delegation/testService";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchWebhook } from "../src/delegation/notifications";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(webhookFetch?: FetchWebhook) {
  const root = mkdtempSync(join(tmpdir(), "cleaner-test-service-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const credentials = { agentToken: randomBytes(32).toString("hex"), adminToken: randomBytes(32).toString("hex") };
  const clock = { now: Date.now() };
  const service = createDelegationTestService({ root, ...credentials, publicBaseUrl: "https://cleaner.example", now: () => clock.now, intervalMs: 10,
    webhook: webhookFetch ? { url: "https://hooks.example/test", authorization: "Bearer private_probe_key" } : undefined, webhookFetch });
  cleanups.push(() => service.stop());
  const server: Server = await new Promise((done) => { const s = service.app.listen(0, "127.0.0.1", () => done(s)); });
  cleanups.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const event = () => fetch(`${url}/test/events`, { method: "POST", headers: { Authorization: `Bearer ${credentials.adminToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ eventId: "one" }) });
  return { ...credentials, clock, service, url, event };
}

it("separates operator fixtures from agent access and restricts public host headers", async () => {
  const h = await setup();
  const withHost = (host: string) => new Promise<number | undefined>((done, reject) => {
    get(`${h.url}/healthz`, { headers: { Host: host } }, (response) => { response.resume(); done(response.statusCode); }).on("error", reject);
  });
  expect((await fetch(`${h.url}/healthz`)).status).toBe(200);
  expect(await withHost("cleaner.example")).toBe(200);
  expect(await withHost("untrusted.example")).toBe(403);
  expect((await fetch(`${h.url}/test/events`, { method: "POST", headers: { Authorization: `Bearer ${h.agentToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ eventId: "one" }) })).status).toBe(401);
  expect((await fetch(`${h.url}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${h.adminToken}`, "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
  expect((await fetch(`${h.url}/test/events`, { method: "POST", headers: { Authorization: `Bearer ${h.adminToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ eventId: "one", recipient: "real_phone" }) })).status).toBe(400);
});

it("a webhook wakeup drives SDK MCP completion and produces correlated engine and notification evidence", async () => {
  let client: Client;
  let calls = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  const h = await setup(async (_url, init) => {
    calls++;
    const event = JSON.parse(init.body as string);
    const work = await call("read_delegated_work", { id: event.workId });
    const claimed = await call("claim_delegated_work", { id: work.id });
    await call("propose_cleaning_time", { id: work.id, leaseToken: claimed.leaseToken, expectedTurnVersion: claimed.turn.version, start: claimed.requestedStart, actionKey: `grok_${work.id}` });
    return new Response(null, { status: 200 });
  });
  client = new Client({ name: "scripted-webhook-receiver", version: "1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.agentToken}` } } }));
  cleanups.push(() => client.close());
  const { work } = await (await h.event()).json() as { work: { id: string } };
  await expect.poll(() => h.service.sink.replies().length).toBe(1);
  const evidence = await (await fetch(`${h.url}/test/evidence/${work.id}`, { headers: { Authorization: `Bearer ${h.adminToken}` } })).json() as { audit: Array<{ type: string; actor: string }> };
  expect(evidence).toMatchObject({ mode: "synthetic", work: { id: work.id, status: "completed", decisionSource: "agent", deliveryStatus: "sent" }, notification: { workId: work.id, status: "accepted", lastHttpStatus: 200 }, replies: [{ recipient: "synthetic_cleaning_service_owner" }] });
  expect(evidence.audit.map((a: { type: string }) => a.type)).toEqual(["received", "claimed", "validated_action_and_reply_saved", "send_attempt", "delivery_acknowledged_and_completed"]);
  expect(evidence.audit[1]!.actor).toBe("grok_test_agent");
  expect(calls).toBe(1);
  expect(JSON.stringify(evidence)).not.toContain("private_probe_key");
  await h.event();
  expect(h.service.sink.replies()).toHaveLength(1);
});

it("deduplicates concurrent synthetic events and completes an offline fallback independently", async () => {
  const h = await setup();
  const responses = await Promise.all([h.event(), h.event()]);
  const bodies = await Promise.all(responses.map(async (r) => await r.json() as { work: { id: string } }));
  expect(bodies[0]!.work.id).toBe(bodies[1]!.work.id);
  h.clock.now += 120_000;
  const id = bodies[0]!.work.id;
  for (let attempt = 0; attempt < 100 && h.service.sink.replies().length === 0; attempt++) await new Promise((done) => setTimeout(done, 10));
  expect(h.service.sink.replies()).toHaveLength(1);
  const evidence = await fetch(`${h.url}/test/evidence/${id}`, { headers: { Authorization: `Bearer ${h.adminToken}` } });
  expect(await evidence.json()).toMatchObject({ mode: "synthetic", work: { status: "completed", decisionSource: "fallback" }, replies: [{ recipient: "synthetic_cleaning_service_owner" }] });
  expect((await fetch(`${h.url}/test/evidence/${id}`, { headers: { Authorization: `Bearer ${h.agentToken}` } })).status).toBe(401);
});

it("refuses public addresses containing HTTP, credentials, or a non-origin path", () => {
  const options = { root: tmpdir(), agentToken: "a".repeat(32), adminToken: "b".repeat(32) };
  for (const publicBaseUrl of ["http://cleaner.example", "https://user:secret@cleaner.example", "https://cleaner.example/mcp"]) {
    expect(() => createDelegationTestService({ ...options, publicBaseUrl })).toThrow("HTTPS origin");
  }
});
