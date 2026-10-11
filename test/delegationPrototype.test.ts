import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { delegationApp } from "../src/delegation/mcp";
import { startDelegationWorker } from "../src/delegation/worker";
import { DelegationPrototype, LocalReplySink, type PrototypeTurn, type ReplySink } from "../src/delegation/prototype";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const identity = { tenantId: "tenant_a", agentId: "agent_a" };
const turn: PrototypeTurn = { tenantId: identity.tenantId, id: "turn_1", version: 1, recipient: "synthetic_cleaner_owner", timeZone: "America/New_York",
  windowStart: "2026-10-11T16:00:00Z", windowEnd: "2026-10-11T21:00:00Z", nextArrival: "2026-10-11T22:00:00Z", minimumMinutes: 90 };
const validStart = "2026-10-11T17:30:00Z";
async function setup(sinkOverride?: ReplySink, options: { leaseMs?: number; maxSendAttempts?: number; sendTimeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "delegation-prototype-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const clock = { t: Date.parse("2026-10-11T12:00:00Z") };
  const sink = new LocalReplySink(join(root, "replies.json"));
  const engine = new DelegationPrototype(root, sinkOverride ?? sink, { now: () => clock.t, ...options });
  await engine.saveTurn(turn);
  const request = { tenantId: identity.tenantId, providerEventId: "inbound_1", turnId: turn.id, requestedStart: validStart };
  const id = await engine.receive(request);
  const state = () => JSON.parse(readFileSync(join(root, "delegation.json"), "utf8"));
  const proposal = async (actionKey = "action_1") => {
    const work = await engine.claim(identity, id);
    return { id, leaseToken: work.leaseToken, actionKey, expectedTurnVersion: work.turn.version, start: validStart };
  };
  return { root, clock, sink, engine, request, id, state, proposal };
}
async function connect(engine: DelegationPrototype, bindings = [{ ...identity, token: randomBytes(32).toString("hex") }]) {
  const app = delegationApp(engine, bindings);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const clients: Client[] = [];
  for (const binding of bindings) {
    const client = new Client({ name: "simulated-agent", version: "1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${binding.token}` } } }));
    clients.push(client); cleanups.push(() => client.close());
  }
  const call = async (name: string, args: Record<string, unknown> = {}, index = 0) => {
    const result = await clients[index]!.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    return { isError: result.isError, value: JSON.parse(content.find((c) => c.type === "text")!.text!) };
  };
  return { call, url, clients };
}

describe("cleaner delegation prototype", () => {
  it("completes a durable event -> SDK MCP claim/proposal -> validated local reply, then acknowledges completion", async () => {
    const h = await setup();
    const mcp = await connect(h.engine);
    expect((await mcp.clients[0]!.listTools()).tools.map((t) => t.name)).toEqual(["list_delegated_work", "read_delegated_work", "claim_delegated_work", "propose_cleaning_time"]);
    const listed = (await mcp.call("list_delegated_work")).value;
    expect(listed).toHaveLength(1);
    expect(listed[0].turn).not.toHaveProperty("recipient");
    const claimed = (await mcp.call("claim_delegated_work", { id: h.id })).value;
    const action = { id: h.id, leaseToken: claimed.leaseToken, actionKey: "mcp_action_1", expectedTurnVersion: claimed.turn.version, start: validStart };
    expect((await mcp.call("propose_cleaning_time", action)).value).toMatchObject({ accepted: true, completed: false, deliveryStatus: "pending" });
    expect(h.sink.replies()).toHaveLength(0);
    expect(h.state().turns[0]).toMatchObject({ confirmedStart: validStart, version: 2 });
    await h.engine.tick();
    expect((await mcp.call("read_delegated_work", { id: h.id })).value).toMatchObject({ status: "completed", decisionSource: "agent", deliveryStatus: "sent" });
    expect(h.sink.replies()).toHaveLength(1);
    expect(h.sink.replies()[0]).toMatchObject({ recipient: turn.recipient, tenantId: identity.tenantId });
    expect(h.sink.replies()[0]!.text).toContain("1:30 PM");
    expect(h.sink.replies()[0]!.text).toContain("Entry requires host clearance");
    expect((await mcp.call("propose_cleaning_time", action)).value.completed).toBe(true);
    await h.engine.tick();
    expect(h.sink.replies()).toHaveLength(1);
    expect(h.state().work[0].audit.at(-1).type).toBe("delivery_acknowledged_and_completed");
  });

  it("persists an inbound event once and rejects a source ID reused for different contents", async () => {
    const h = await setup();
    expect(await h.engine.receive(h.request)).toBe(h.id);
    await expect(h.engine.receive({ ...h.request, requestedStart: "2026-10-11T18:00:00Z" })).rejects.toMatchObject({ code: "SOURCE_CONFLICT" });
    expect(h.state().work).toHaveLength(1);
  });

  it("rejects an invalid slot without changing the turn, sending, or closing the request", async () => {
    const h = await setup();
    const action = await h.proposal();
    await expect(h.engine.propose(identity, { ...action, start: "2026-10-11T20:00:00Z" })).rejects.toMatchObject({ code: "SLOT_INVALID" });
    expect(h.state().turns[0]).toEqual(turn);
    expect(h.sink.replies()).toHaveLength(0);
    expect((await h.engine.get(identity, h.id)).status).toBe("leased");
  });

  it("refuses a future trusted receipt without creating a work item", async () => {
    const h = await setup();
    await expect(h.engine.receive({ ...h.request, providerEventId: "future_receipt", receivedAt: new Date(h.clock.t + 1000).toISOString() })).rejects.toMatchObject({ code: "INVALID_RECEIPT" });
    expect(h.state().work).toHaveLength(1);
  });

  it("rejects stale booking versions and proposals violating the revised next-arrival window", async () => {
    const h = await setup();
    const action = await h.proposal();
    await h.engine.saveTurn({ ...turn, version: 2, windowEnd: "2026-10-11T18:00:00Z", nextArrival: "2026-10-11T18:00:00Z" });
    await expect(h.engine.propose(identity, action)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(h.engine.propose(identity, { ...action, expectedTurnVersion: 2 })).rejects.toMatchObject({ code: "SLOT_INVALID" });
    expect(h.sink.replies()).toHaveLength(0);
  });

  it("routes a booking changed after proposal but before sending to review, instead of confirming stale work", async () => {
    const h = await setup();
    await h.engine.propose(identity, await h.proposal());
    await h.engine.saveTurn({ ...turn, version: 3, recipient: "another_contact" });
    await h.engine.tick();
    expect((await h.engine.get(identity, h.id)).status).toBe("review_required");
    expect(h.sink.replies()).toHaveLength(0);
  });

  it("rejects proposals without a lease and conflicting action-key reuse", async () => {
    const h = await setup();
    await expect(h.engine.propose(identity, { id: h.id, leaseToken: "fake", actionKey: "action_1", expectedTurnVersion: 1, start: validStart })).rejects.toMatchObject({ code: "LEASE_INVALID" });
    const action = await h.proposal();
    await h.engine.propose(identity, action);
    await expect(h.engine.propose(identity, { ...action, start: "2026-10-11T18:00:00Z" })).rejects.toMatchObject({ code: "ACTION_CONFLICT" });
  });

  it("expires a lease, permits another agent to recover it, and refuses the old lease token", async () => {
    const h = await setup(undefined, { leaseMs: 1000 });
    const old = await h.proposal();
    const next = { ...identity, agentId: "agent_b" };
    await expect(h.engine.claim(next, h.id)).rejects.toMatchObject({ code: "LEASE_BUSY" });
    h.clock.t += 1000;
    const claimed = await h.engine.claim(next, h.id);
    expect(claimed.leaseToken).not.toBe(old.leaseToken);
    await expect(h.engine.propose(identity, old)).rejects.toMatchObject({ code: "LEASE_INVALID" });
    await h.engine.propose(next, { ...old, leaseToken: claimed.leaseToken });
  });

  it("at the exact agent deadline, selects fallback and refuses a late action without changing the booking", async () => {
    const h = await setup();
    const action = await h.proposal();
    h.clock.t += 120_000;
    await expect(h.engine.propose(identity, action)).rejects.toMatchObject({ code: "LEASE_INVALID" });
    await Promise.all([h.engine.tick(), h.engine.tick()]);
    expect(h.sink.replies()).toHaveLength(1);
    expect(h.sink.replies()[0]!.text).toContain("awaiting host review");
    expect(h.state().turns[0]).toEqual(turn);
    expect((await h.engine.get(identity, h.id)).decisionSource).toBe("fallback");
  });

  it("a pending event survives restart and the worker sends fallback without any agent call", async () => {
    const h = await setup();
    h.clock.t += 120_000;
    const restarted = new DelegationPrototype(h.root, new LocalReplySink(join(h.root, "replies.json")), { now: () => h.clock.t });
    await restarted.tick();
    expect((await restarted.get(identity, h.id)).status).toBe("completed");
    expect(h.sink.replies()).toHaveLength(1);
    expect(h.state().turns[0]).toEqual(turn);
  });

  it("the independent worker handles an offline agent without MCP traffic or a manual tick", async () => {
    const h = await setup();
    h.clock.t += 120_000;
    let failed = false;
    const worker = startDelegationWorker(h.engine, { intervalMs: 5, onError: () => { failed = true; } });
    cleanups.push(() => worker.stop());
    await expect.poll(() => h.sink.replies().length).toBe(1);
    expect(failed).toBe(false);
    expect(h.state().turns[0]).toEqual(turn);
    expect(h.state().work[0].status).toBe("completed");
  });

  it("an accepted proposal survives restart and is sent exactly once by the idempotent local provider", async () => {
    const h = await setup();
    await h.engine.propose(identity, await h.proposal());
    const restarted = new DelegationPrototype(h.root, new LocalReplySink(join(h.root, "replies.json")), { now: () => h.clock.t });
    await Promise.all([restarted.tick(), restarted.tick()]);
    expect(h.sink.replies()).toHaveLength(1);
    expect((await restarted.get(identity, h.id)).status).toBe("completed");
  });

  it("recovers a lost provider acknowledgment across restart without a duplicate reply", async () => {
    const h = await setup();
    const lostAck: ReplySink = { idempotent: true, send: async (reply) => { await h.sink.send(reply); throw new Error("Connection lost after provider accepted"); } };
    const engine = new DelegationPrototype(h.root, lostAck, { now: () => h.clock.t });
    await engine.propose(identity, await engine.claim(identity, h.id).then((w) => ({ id: h.id, leaseToken: w.leaseToken, actionKey: "action_1", expectedTurnVersion: 1, start: validStart })));
    await engine.tick();
    expect(h.sink.replies()).toHaveLength(1);
    expect((await engine.get(identity, h.id)).status).toBe("reply_pending");
    const restarted = new DelegationPrototype(h.root, h.sink, { now: () => h.clock.t });
    await restarted.tick(); // Backoff still applies.
    expect((await restarted.get(identity, h.id)).status).toBe("reply_pending");
    h.clock.t += 1000;
    await restarted.tick();
    expect((await restarted.get(identity, h.id)).status).toBe("completed");
    expect(h.sink.replies()).toHaveLength(1);
  });

  it("does not retry an uncertain send when the provider cannot guarantee idempotency", async () => {
    let calls = 0;
    const h = await setup({ idempotent: false, send: async () => { calls++; throw new Error("Unknown outcome"); } });
    await h.engine.propose(identity, await h.proposal());
    await h.engine.tick();
    h.clock.t += 200_000;
    await h.engine.tick();
    expect(calls).toBe(1);
    expect((await h.engine.get(identity, h.id)).status).toBe("review_required");
  });

  it("bounds idempotent-provider retries and marks exhaustion for review", async () => {
    let calls = 0;
    const h = await setup({ idempotent: true, send: async () => { calls++; throw new Error("Down"); } }, { maxSendAttempts: 2 });
    await h.engine.propose(identity, await h.proposal());
    await h.engine.tick(); h.clock.t += 1000;
    await h.engine.tick(); h.clock.t += 2000;
    await h.engine.tick();
    expect(calls).toBe(2);
    expect((await h.engine.get(identity, h.id)).status).toBe("review_required");
  });

  it("bounds a hung non-idempotent provider and reports uncertain delivery for review", async () => {
    const h = await setup({ idempotent: false, send: async () => new Promise(() => {}) }, { sendTimeoutMs: 10 });
    await h.engine.propose(identity, await h.proposal());
    await h.engine.tick();
    expect((await h.engine.get(identity, h.id)).status).toBe("review_required");
  });

  it("binds tenant scope to credentials and rejects unauthenticated calls and cross-tenant work", async () => {
    const h = await setup();
    const other = { tenantId: "tenant_b", agentId: "agent_b", token: randomBytes(32).toString("hex") };
    const mcp = await connect(h.engine, [{ ...identity, token: randomBytes(32).toString("hex") }, other]);
    const res = await fetch(mcp.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect((await mcp.call("list_delegated_work", {}, 1)).value).toEqual([]);
    expect((await mcp.call("read_delegated_work", { id: h.id }, 1)).value.code).toBe("NOT_FOUND");
    expect((await mcp.call("claim_delegated_work", { id: h.id }, 1)).value.code).toBe("NOT_FOUND");
    const claimed = (await mcp.call("claim_delegated_work", { id: h.id })).value;
    expect((await mcp.call("propose_cleaning_time", { id: h.id, leaseToken: claimed.leaseToken, actionKey: "a", expectedTurnVersion: 1, start: validStart }, 1)).value.code).toBe("NOT_FOUND");
    const extra = await mcp.clients[0]!.callTool({ name: "propose_cleaning_time", arguments: { id: h.id, leaseToken: claimed.leaseToken, actionKey: "a", expectedTurnVersion: 1, start: validStart, recipient: "different_destination", tenantId: "tenant_b" } });
    expect(extra.isError).toBe(true);
    expect(h.sink.replies()).toHaveLength(0);
  });

  it("fails closed on damaged durable state", async () => {
    const h = await setup();
    writeFileSync(join(h.root, "delegation.json"), "{broken");
    expect(() => new DelegationPrototype(h.root, h.sink)).toThrow();
    expect(readFileSync(join(h.root, "delegation.json"), "utf8")).toBe("{broken");
  });
});
