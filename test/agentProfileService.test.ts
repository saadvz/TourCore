import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDelegationTestService } from "../src/delegation/testService";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const agentToken = "private_agent_token".repeat(3), adminToken = "private_admin_token".repeat(3);
async function setup(receiver?: (id: string, call: (name: string, args: Record<string, unknown>) => Promise<any>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "agent-profile-service-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const clock = { now: Date.parse("2026-10-11T23:00:00Z") };
  const service = createDelegationTestService({ root, agentToken, adminToken, now: () => clock.now, intervalMs: 10,
    webhook: { url: "https://hooks.example/private_receiver", authorization: "Bearer private_receiver_key" },
    webhookFetch: async (_url, init) => { if (receiver) await receiver(JSON.parse(init.body as string).workId, call); return new Response(null, { status: 200 }); } });
  cleanups.push(() => service.stop());
  const server: Server = await new Promise((done) => { const s = service.app.listen(0, "127.0.0.1", () => done(s)); });
  cleanups.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new Client({ name: "capability-probe-agent", version: "1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${agentToken}` } } }));
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  const admin = (path: string, body?: unknown, token = adminToken) => fetch(url + path, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { root, clock, service, client, url, call, admin };
}

it("discovers and completes read-only profile probes over the real SDK without creating work or replies", async () => {
  const h = await setup();
  expect((await h.client.listTools()).tools.map((t) => t.name)).toEqual(["list_delegated_work", "read_delegated_work", "claim_delegated_work", "propose_cleaning_time", "read_agent_profile", "declare_agent_capabilities", "begin_agent_probe", "complete_agent_probe"]);
  await h.call("declare_agent_capabilities", { capabilities: [{ capability: "mcp_tools", availability: "available" }, { capability: "generation_reasoning", availability: "available" }, { capability: "background_runs", availability: "available" }] });
  const p = await h.call("begin_agent_probe", { capability: "mcp_tools" });
  expect(await h.call("complete_agent_probe", { probeId: p.probeId, nonce: p.nonce })).toMatchObject({ status: "verified", sendsMessages: false });
  const language = await h.call("begin_agent_probe", { capability: "generation_reasoning" }); const s = language.scenario;
  const valid = Date.parse(s.requestedStart) + s.minimumMinutes * 60000 <= Date.parse(s.windowEnd);
  await h.call("complete_agent_probe", { probeId: language.probeId, nonce: language.nonce, answer: {
    decision: valid ? "propose_time" : "host_review", draft: valid ? `Scheduled ${s.requestedStart}; entry requires host clearance.` : "Host review needed; existing time unchanged. Entry requires host clearance." } });
  const profile = await h.call("read_agent_profile", {});
  expect(profile.readiness).toMatchObject({ executionMode: "interactive", generation: "synthetic_probe_verified", fallback: "engine_owned" });
  expect(profile.capabilities.find((c: { capability: string }) => c.capability === "background_runs").status).toBe("declared");
  expect(await h.call("list_delegated_work", {})).toEqual([]);
  expect(h.service.sink.replies()).toEqual([]);
  expect(JSON.stringify(profile)).not.toContain(agentToken);
});

it("requires owner auth and server-owned workflow evidence, then enables the scoped autonomous profile", async () => {
  const h = await setup(async (id, call) => { const work = await call("claim_delegated_work", { id }); await call("propose_cleaning_time", { id, leaseToken: work.leaseToken, expectedTurnVersion: work.turn.version, actionKey: `grok_${id}`, start: work.requestedStart }); });
  const p = await h.call("begin_agent_probe", { capability: "mcp_tools" }); await h.call("complete_agent_probe", { probeId: p.probeId, nonce: p.nonce });
  expect((await h.admin("/test/agent/profile", undefined, agentToken)).status).toBe(401);
  const { work } = await (await h.admin("/test/events", { eventId: "profile_workflow" })).json() as { work: { id: string } };
  await expect.poll(() => h.service.sink.replies().length).toBe(1);
  await expect.poll(async () => (await h.service.notifications!.status(work.id)).status).toBe("accepted");
  const body = { workId: work.id, conversationClosed: true };
  expect((await h.admin("/test/agent/profile/verify-workflow", body, agentToken)).status).toBe(401);
  expect((await h.admin("/test/agent/profile/verify-workflow", { ...body, latencyMs: 1 })).status).toBe(400);
  expect((await h.admin("/test/agent/profile/verify-workflow", { ...body, conversationClosed: false })).status).toBe(400);
  const response = await h.admin("/test/agent/profile/verify-workflow", body); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ readiness: { executionMode: "autonomous", autonomousScopes: ["cleaner.reschedule_requested"], productionReady: false },
    capabilities: expect.arrayContaining([expect.objectContaining({ capability: "background_runs", evidence: expect.objectContaining({ method: "engine_workflow", ownerConfirmedConversationClosed: true }) })]) });
  const ownerView = await (await h.admin("/test/agent/profile")).json() as { adapter: unknown };
  expect(ownerView.adapter).toMatchObject({ id: "grok", ownsMessageSending: false });
  expect(JSON.stringify(ownerView)).not.toContain("private_receiver_key");
});

it("rejects fallback, pending work and a manually completed work item with no webhook", async () => {
  const h = await setup();
  const { work } = await (await h.admin("/test/events", { eventId: "offline_profile" })).json() as { work: { id: string } };
  const input = { workId: work.id, conversationClosed: true };
  expect((await h.admin("/test/agent/profile/verify-workflow", input)).status).toBe(409);
  h.clock.now += 120000; await h.service.engine.tick();
  expect((await h.admin("/test/agent/profile/verify-workflow", input)).status).toBe(409);
  await h.service.stop();
  const second = await (await h.admin("/test/events", { eventId: "manual_profile" })).json() as { work: { id: string } };
  const lease = await h.call("claim_delegated_work", { id: second.work.id });
  await h.call("propose_cleaning_time", { id: second.work.id, leaseToken: lease.leaseToken, expectedTurnVersion: lease.turn.version, actionKey: "manual_action", start: lease.requestedStart });
  await h.service.engine.tick();
  // A completed proposal alone must not stand in for an accepted external wakeup.
  expect((await h.admin("/test/agent/profile/verify-workflow", { workId: second.work.id, conversationClosed: true })).status).toBe(409);
});

it("refuses agent-side tenant injection, owner grant promotion and unrecognized tools", async () => {
  const h = await setup();
  for (const [name, args] of [
    ["read_agent_profile", { tenantId: "another_tenant" }],
    ["declare_agent_capabilities", { capabilities: [], grants: [{ permissions: ["calendar.read"] }] }],
    ["grant_native_permission", { extensionId: "calendar" }],
    ["attest_agent_probe", { outcome: "passed" }],
  ] as Array<[string, Record<string, unknown>]>) expect((await h.client.callTool({ name, arguments: args })).isError).toBe(true);
  expect((await h.call("read_agent_profile", {})).readiness.executionMode).toBe("unavailable");
});

it("fails closed on profile corruption without exposing stored content in MCP errors", async () => {
  const h = await setup(); writeFileSync(join(h.root, "agent-profiles.json"), "private_corrupt_contents");
  const result = await h.client.callTool({ name: "read_agent_profile", arguments: {} });
  expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain("private_corrupt_contents");
  expect((await h.admin("/test/agent/profile")).status).toBe(503);
});

it("completes compatible onboarding through a real original connector tool, without confusing admin HTTP reads with MCP proof", async () => {
  const h = await setup(async (id, call) => { const work = await call("claim_delegated_work", { id }); await call("propose_cleaning_time", { id, leaseToken: work.leaseToken, expectedTurnVersion: work.turn.version, actionKey: `grok_${id}`, start: work.requestedStart }); });
  const { work } = await (await h.admin("/test/events", { eventId: "already_completed_for_compatibility" })).json() as { work: { id: string } };
  await expect.poll(() => h.service.sink.replies().length).toBe(1);
  const baseline = await (await h.admin(`/test/evidence/${work.id}`)).json();
  expect((await h.admin(`/test/agent/onboarding?workId=${work.id}`, undefined, agentToken)).status).toBe(401);
  expect((await h.admin(`/test/agent/onboarding?workId=${work.id}`)).status).toBe(200);
  expect((await h.admin("/test/agent/onboarding?workId=bad")).status).toBe(400);
  expect((await h.admin("/test/agent/profile/discovery", { bridgeToolCount: 8, exposedTools: ["claim_delegated_work", "list_delegated_work", "propose_cleaning_time", "read_delegated_work"] })).status).toBe(200);
  expect((await h.admin("/test/agent/profile/declarations", { capabilities: [{ capability: "mcp_tools", availability: "available" }] })).status).toBe(200);
  const body = { workId: work.id };
  expect((await h.admin("/test/agent/probes/core-mcp", body, agentToken)).status).toBe(401);
  expect((await h.admin("/test/agent/probes/core-mcp", { ...body, verified: true })).status).toBe(400);
  const probeResponse = await h.admin("/test/agent/probes/core-mcp", body); expect(probeResponse.status).toBe(200);
  const probe = await probeResponse.json() as { probeId: string };
  await h.admin(`/test/evidence/${work.id}`);
  const before = await (await h.admin("/test/agent/profile")).json() as { profile: { readiness: { executionMode: string } } };
  expect(before.profile.readiness.executionMode).toBe("unavailable");
  await h.call("read_delegated_work", { id: work.id });
  const after = await (await h.admin("/test/agent/profile")).json() as { profile: { capabilities: unknown[]; readiness: unknown } };
  expect(after.profile.capabilities).toEqual(expect.arrayContaining([expect.objectContaining({ capability: "mcp_tools", status: "verified", evidence: expect.objectContaining({ evidenceId: probe.probeId, scope: "authenticated_core_work_read" }) })]));
  const g = await (await h.admin("/test/agent/probes", { capability: "generation_reasoning" })).json() as { probeId: string; nonce: string; scenario: { requestedStart: string; windowEnd: string; minimumMinutes: number } };
  const valid = Date.parse(g.scenario.requestedStart) + g.scenario.minimumMinutes * 60000 <= Date.parse(g.scenario.windowEnd);
  const answer = { probeId: g.probeId, nonce: g.nonce, answer: { decision: valid ? "propose_time" : "host_review", draft: valid ? `Scheduled ${g.scenario.requestedStart}; entry requires host clearance.` : "Host review required; existing time unchanged. Entry requires host clearance." } };
  expect((await h.admin("/test/agent/probes/draft", answer, agentToken)).status).toBe(401);
  expect((await h.admin("/test/agent/probes/draft", answer)).status).toBe(200);
  await expect.poll(async () => (await h.service.notifications!.status(work.id)).status).toBe("accepted");
  const verified = await (await h.admin("/test/agent/profile/verify-workflow", { workId: work.id, conversationClosed: true })).json();
  expect(verified).toMatchObject({ readiness: { executionMode: "autonomous", appToolDiscovery: "partial", onboardingTransport: "core_mcp_owner_http", generation: "synthetic_probe_verified" } });
  const final = await (await h.admin(`/test/evidence/${work.id}`)).json();
  expect(final).toEqual(baseline); expect(h.service.sink.replies()).toHaveLength(1);
});

it("refuses an unfinished work item as a compatibility fixture and preserves ordinary reads when profile storage fails", async () => {
  const h = await setup();
  const { work } = await (await h.admin("/test/events", { eventId: "pending_not_a_probe_fixture" })).json() as { work: { id: string } };
  expect((await h.admin("/test/agent/probes/core-mcp", { workId: work.id })).status).toBe(409);
  expect((await h.admin(`/test/agent/onboarding?workId=${work.id}`)).status).toBe(409);
  writeFileSync(join(h.root, "agent-profiles.json"), "{corrupt");
  expect(await h.call("read_delegated_work", { id: work.id })).toMatchObject({ status: "pending" });
  expect((await h.admin("/test/agent/profile")).status).toBe(503);
});
