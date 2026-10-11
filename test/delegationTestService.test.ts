import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createDelegationTestService } from "../src/delegation/testService";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "cleaner-test-service-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const credentials = { agentToken: randomBytes(32).toString("hex"), adminToken: randomBytes(32).toString("hex") };
  const clock = { now: Date.now() };
  const service = createDelegationTestService({ root, ...credentials, publicBaseUrl: "https://cleaner.example", now: () => clock.now, intervalMs: 10 });
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
