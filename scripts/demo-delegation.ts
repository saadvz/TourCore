import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DelegationPrototype, LocalReplySink } from "../src/delegation/prototype";
import { delegationApp } from "../src/delegation/mcp";
import { startDelegationWorker } from "../src/delegation/worker";

const repo = fileURLToPath(new URL("../", import.meta.url));
const root = join(repo, "tourcore-data", "delegation-prototype", `run_${Date.now()}_${randomBytes(4).toString("hex")}`);
mkdirSync(root, { recursive: true });
const clock = { now: Date.parse("2026-10-11T12:00:00Z") };
const identity = { tenantId: "synthetic_host", agentId: "scripted_agent" };
const sink = new LocalReplySink(join(root, "replies.json"));
const engine = new DelegationPrototype(root, sink, { now: () => clock.now });
const constraints = { tenantId: identity.tenantId, version: 1, recipient: "synthetic_cleaning_service_owner", timeZone: "America/New_York",
  windowStart: "2026-10-11T16:00:00Z", windowEnd: "2026-10-11T21:00:00Z", nextArrival: "2026-10-11T22:00:00Z", minimumMinutes: 90 };
await engine.saveTurn({ ...constraints, id: "turn_agent" });
await engine.saveTurn({ ...constraints, id: "turn_fallback" });
const id = await engine.receive({ tenantId: identity.tenantId, providerEventId: "synthetic_sms_1", turnId: "turn_agent", requestedStart: "2026-10-11T17:30:00Z" });
const offline = await engine.receive({ tenantId: identity.tenantId, providerEventId: "synthetic_sms_2", turnId: "turn_fallback", requestedStart: "2026-10-11T17:30:00Z" });
// This local demonstration generates ephemeral authentication in memory, never prints or saves it.
const token = randomBytes(32).toString("hex");
const app = delegationApp(engine, [{ ...identity, token }]);
const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const client = new Client({ name: "scripted-delegation-demo", version: "0.1" });
let workerFailed = false;
const worker = startDelegationWorker(engine, { intervalMs: 10, onError: () => { workerFailed = true; } });
const waitForReplies = async (count: number) => {
  const limit = Date.now() + 5000;
  while (sink.replies().length < count && Date.now() < limit && !workerFailed) await new Promise((done) => setTimeout(done, 10));
  assert.equal(workerFailed, false, "Independent worker failed");
  assert.equal(sink.replies().length, count, "Expected reply was not recorded");
};
try {
  const port = (server.address() as { port: number }).port;
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await client.callTool({ name, arguments: args });
    assert.notEqual(reply.isError, true);
    const text = (reply.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")!.text!;
    return JSON.parse(text);
  };
  const claimed = await call("claim_delegated_work", { id });
  const action = { id, leaseToken: claimed.leaseToken, actionKey: "demo_confirm_1", expectedTurnVersion: claimed.turn.version, start: claimed.requestedStart };
  const accepted = await call("propose_cleaning_time", action);
  assert.equal(accepted.accepted, true);
  await waitForReplies(1);
  const completed = await call("read_delegated_work", { id });
  assert.equal(completed.status, "completed");
  assert.equal(completed.turn.confirmedStart, action.start);
  await call("propose_cleaning_time", action); // Retry the same action; there must be no second reply.
  clock.now += 120_000; // Advance the injected clock; no two-minute sleep or real-world schedule change.
  await waitForReplies(2); // Worker handles offline agent without an MCP call to this event.
  const fallback = await engine.get(identity, offline);
  assert.equal(fallback.status, "completed");
  assert.equal(fallback.decisionSource, "fallback");
  assert.equal(fallback.turn.confirmedStart, undefined);
  const report = { mode: "local_simulation", agent: "scripted MCP SDK client, not live Grok", provider: "durable local reply sink, not real SMS",
    agentCase: completed, offlineCase: fallback, replies: sink.replies(), result: "passed" };
  const path = join(root, "report.json");
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  console.log("Passed: saved request -> authenticated MCP proposal -> validated reply -> acknowledged completion.");
  console.log("Passed: repeated action produced no duplicate reply; offline agent received fallback without changing its cleaning time.");
  console.log(`Evidence: ${path}`);
} finally {
  await worker.stop();
  await client.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}
