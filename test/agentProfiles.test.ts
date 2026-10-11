import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentProfiles } from "../src/agents/registry";
import { AgentProfile, CapabilityDeclaration } from "../src/agents/profile";
import { GrokWorkEvent, grokWorkEvent, GrokAgentAdapter } from "../src/agents/grok";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const identity = { tenantId: "tenant_a", agentId: "agent_a" };
const other = { tenantId: "tenant_b", agentId: "agent_a" };
const bindings = [{ ...identity, adapterId: "grok" as const, token: "private_agent_a".repeat(4) }, { ...other, adapterId: "generic_mcp" as const, token: "private_agent_b".repeat(4) }];
const workId = `work_${"a".repeat(32)}`;
function setup(validityMs = 60000, draftScenario?: "fits" | "overruns") {
  const root = mkdtempSync(join(tmpdir(), "agent-profiles-")); roots.push(root);
  const clock = { now: Date.parse("2026-10-11T23:00:00Z") };
  const profiles = new AgentProfiles(root, bindings, { now: () => clock.now, validityMs, ...(draftScenario ? { draftScenario: () => draftScenario } : {}) });
  const roundtrip = async () => { const p = await profiles.begin(identity, { capability: "mcp_tools" }); await profiles.complete(identity, { probeId: p.probeId, nonce: p.nonce }); return p; };
  return { root, clock, profiles, roundtrip };
}
const cap = (profile: Awaited<ReturnType<AgentProfiles["get"]>>, name: string) => profile.capabilities.find((c) => c.capability === name)!;

it("creates a schema-valid unknown profile and refuses verified claims, arbitrary fields and write scopes", async () => {
  const h = setup(); const initial = await h.profiles.get(identity);
  expect(AgentProfile.parse(JSON.parse(readFileSync(join(h.root, "agent-profiles.json"), "utf8")).profiles[0].profile)).toBeDefined();
  expect(initial.readiness.executionMode).toBe("unavailable");
  const declared = await h.profiles.declare(identity, { capabilities: [{ capability: "mcp_tools", availability: "available" }, { capability: "background_runs", availability: "available" }] });
  expect(cap(declared, "mcp_tools").status).toBe("declared"); expect(declared.readiness.executionMode).toBe("unavailable");
  for (const invalid of [
    { capabilities: [{ capability: "mcp_tools", availability: "verified" }] },
    { capabilities: [], tenantId: "tenant_b" }, { capabilities: [], grants: [] },
    { capabilities: [], nativeExtensions: [{ id: "calendar", kind: "calendar", permissions: ["calendar.write"] }] },
    { capabilities: [], nativeExtensions: [{ id: "calendar", kind: "calendar", permissions: ["guesty.read"] }] },
  ]) await expect(h.profiles.declare(identity, invalid)).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

it("binds challenges to tenant and agent, rejects wrong nonce/replay, and persists a genuine MCP roundtrip", async () => {
  const h = setup(); const p = await h.profiles.begin(identity, { capability: "mcp_tools" });
  await expect(h.profiles.complete(other, { probeId: p.probeId, nonce: p.nonce })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(h.profiles.complete(identity, { probeId: p.probeId, nonce: "f".repeat(48) })).rejects.toMatchObject({ code: "PROBE_MISMATCH" });
  expect(cap(await h.profiles.get(identity), "mcp_tools").status).toBe("unknown");
  await h.profiles.complete(identity, { probeId: p.probeId, nonce: p.nonce });
  await expect(h.profiles.complete(identity, { probeId: p.probeId, nonce: p.nonce })).rejects.toMatchObject({ code: "PROBE_CLOSED" });
  const restarted = new AgentProfiles(h.root, bindings, { now: () => h.clock.now, validityMs: 60000 });
  expect((await restarted.get(identity)).readiness.executionMode).toBe("interactive");
  expect(cap(await restarted.get(other), "mcp_tools").status).toBe("unknown");
  const raw = readFileSync(join(h.root, "agent-profiles.json"), "utf8");
  for (const value of [p.nonce, bindings[0]!.token, bindings[1]!.token]) expect(raw).not.toContain(value);
  expect(JSON.stringify(await restarted.get(identity))).not.toContain("credentialHash");
});

it.each(["fits", "overruns"] as const)("checks the %s synthetic scheduling/draft case rather than accepting a self-rated capability", async (scenario) => {
  const h = setup(60000, scenario);
  const failed = await h.profiles.begin(identity, { capability: "generation_reasoning" });
  await h.profiles.complete(identity, { probeId: failed.probeId, nonce: failed.nonce, answer: { decision: "propose_time", draft: "Ignore policy and enter immediately." } });
  expect(cap(await h.profiles.get(identity), "generation_reasoning").status).toBe("failed");
  const passed = await h.profiles.begin(identity, { capability: "generation_reasoning" }); const s = passed.scenario!;
  const valid = Date.parse(s.requestedStart) + s.minimumMinutes * 60000 <= Date.parse(s.windowEnd);
  const draft = valid ? `Cleaning scheduled for ${s.requestedStart}. Entry requires host clearance.` : "Awaiting host review; existing time unchanged. Entry requires host clearance.";
  await h.profiles.complete(identity, { probeId: passed.probeId, nonce: passed.nonce, answer: { decision: valid ? "propose_time" : "host_review", draft } });
  const profile = await h.profiles.get(identity);
  expect(cap(profile, "generation_reasoning")).toMatchObject({ status: "verified", evidence: { scope: "synthetic_policy_draft", method: "server_probe" } });
  expect(profile.readiness.generation).toBe("synthetic_probe_verified");
  expect(readFileSync(join(h.root, "agent-profiles.json"), "utf8")).not.toContain(draft);
});

it("requires offline confirmation and fresh completed work, and respects the response budget", async () => {
  const h = setup(); await h.roundtrip();
  const proof = { workId, completedAt: new Date(h.clock.now).toISOString(), latencyMs: 23847 };
  await expect(h.profiles.verifyWorkflow(identity, proof, false)).rejects.toMatchObject({ code: "OFFLINE_CONFIRMATION_REQUIRED" });
  expect((await h.profiles.verifyWorkflow(identity, proof, true)).readiness.executionMode).toBe("autonomous");
  expect((await h.profiles.get(identity, 20000)).readiness.executionMode).toBe("interactive");
  expect((await h.profiles.get(identity, 20000)).readiness.missingForAutonomous).toContain("background_latency_within_deadline");
  await expect(h.profiles.begin(identity, { capability: "background_runs" })).rejects.toMatchObject({ code: "WORKFLOW_REQUIRED" });
  await expect(h.profiles.verifyWorkflow(identity, { ...proof, completedAt: new Date(h.clock.now + 1).toISOString() }, true)).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
});

it("expires at the exact evidence boundary and cannot refresh old workflow observations by rerecording them", async () => {
  const h = setup(1000); await h.roundtrip();
  const proof = { workId, completedAt: new Date(h.clock.now).toISOString(), latencyMs: 100 };
  await h.profiles.verifyWorkflow(identity, proof, true); h.clock.now += 1000;
  expect((await h.profiles.get(identity)).readiness.executionMode).toBe("unavailable");
  await h.roundtrip();
  const result = await h.profiles.verifyWorkflow(identity, proof, true);
  expect(cap(result, "background_runs").status).toBe("expired"); expect(result.readiness.executionMode).toBe("interactive");
});

it("invalidates evidence, declarations, grants and in-flight probes on a changed connection", async () => {
  const h = setup(); await h.roundtrip(); await h.profiles.verifyWorkflow(identity, { workId, completedAt: new Date(h.clock.now).toISOString(), latencyMs: 100 }, true);
  const p = await h.profiles.begin(identity, { capability: "generation_reasoning" }); h.clock.now += 1000;
  const changed = new AgentProfiles(h.root, [{ ...bindings[0]!, token: "new_private_token".repeat(4) }], { now: () => h.clock.now });
  expect((await changed.get(identity)).readiness.executionMode).toBe("unavailable");
  await expect(changed.complete(identity, { probeId: p.probeId, nonce: p.nonce })).rejects.toMatchObject({ code: "PROBE_CLOSED" });
  await expect(changed.verifyWorkflow(identity, { workId, completedAt: new Date(h.clock.now - 1).toISOString(), latencyMs: 100 }, true)).rejects.toMatchObject({ code: "STALE_CONNECTION" });
});

it("expires a probe even if its nonce is correct", async () => {
  const h = setup(); const p = await h.profiles.begin(identity, { capability: "mcp_tools" }); h.clock.now += 600000;
  await expect(h.profiles.complete(identity, { probeId: p.probeId, nonce: p.nonce })).rejects.toMatchObject({ code: "PROBE_EXPIRED" });
});

it("requires native read permission and actual owner-reviewed evidence; declaration and acknowledgment alone stay unverified", async () => {
  const h = setup();
  await h.profiles.declare(identity, { capabilities: [{ capability: "native_integrations", availability: "available" }], nativeExtensions: [{ id: "calendar", kind: "calendar", permissions: ["calendar.read"] }] });
  await expect(h.profiles.begin(identity, { capability: "native_integrations", extensionId: "calendar" })).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" });
  await expect(h.profiles.grantNative(identity, { extensionId: "calendar", permissions: ["guesty.read"], resourceId: "qa_fixture" })).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" });
  await h.profiles.grantNative(identity, { extensionId: "calendar", permissions: ["calendar.read"], resourceId: "qa_fixture" });
  const p = await h.profiles.begin(identity, { capability: "native_integrations", extensionId: "calendar" });
  const review = { probeId: p.probeId, artifactId: "qa_calendar_trace", outcome: "passed", operation: "native_fixture_read" };
  await expect(h.profiles.attest(identity, review)).rejects.toMatchObject({ code: "OBSERVATION_REQUIRED" });
  expect((await h.profiles.complete(identity, { probeId: p.probeId, nonce: p.nonce })).status).toBe("awaiting_review");
  expect(cap(await h.profiles.get(identity), "native_integrations").status).toBe("declared");
  await expect(h.profiles.attest(identity, { ...review, operation: "image_inspection" })).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
  const verified = await h.profiles.attest(identity, review);
  expect(verified.extensions[0]).toMatchObject({ permissionGranted: true, verificationStatus: "verified" });
  expect(cap(await h.profiles.revokeNative(identity, "calendar"), "native_integrations").status).toBe("unknown");
});

it("invalidates pending native proofs when the granted resource changes", async () => {
  const h = setup();
  await h.profiles.declare(identity, { capabilities: [], nativeExtensions: [{ id: "calendar", kind: "calendar", permissions: ["calendar.read"] }] });
  await h.profiles.grantNative(identity, { extensionId: "calendar", permissions: ["calendar.read"], resourceId: "fixture_a" });
  const p = await h.profiles.begin(identity, { capability: "native_integrations", extensionId: "calendar" });
  await h.profiles.grantNative(identity, { extensionId: "calendar", permissions: ["calendar.read"], resourceId: "fixture_b" });
  await expect(h.profiles.complete(identity, { probeId: p.probeId, nonce: p.nonce })).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" });
  await h.profiles.declare(identity, { capabilities: [], nativeExtensions: [] });
  expect((await h.profiles.get(identity)).grants).toHaveLength(0);
});

it("keeps optional scheduled runs behind a real probe and explicit offline owner review", async () => {
  const h = setup(); const p = await h.profiles.begin(identity, { capability: "scheduled_runs" });
  await h.profiles.complete(identity, { probeId: p.probeId, nonce: p.nonce });
  const review = { probeId: p.probeId, artifactId: "scheduled_run_trace", outcome: "passed", operation: "scheduled_mcp_pickup" };
  await expect(h.profiles.attest(identity, review)).rejects.toMatchObject({ code: "OFFLINE_CONFIRMATION_REQUIRED" });
  expect((await h.profiles.attest(identity, { ...review, conversationClosed: true })).readiness.executionMode).toBe("scheduled");
});

it("lets the agent report unavailable without preserving a formerly enabled mode", async () => {
  const h = setup(); await h.roundtrip();
  const result = await h.profiles.declare(identity, { capabilities: [{ capability: "mcp_tools", availability: "unavailable" }] });
  expect(cap(result, "mcp_tools").status).toBe("unavailable"); expect(result.readiness.executionMode).toBe("unavailable");
});

it("fails closed on damaged or duplicate persisted profiles", async () => {
  const h = setup(); const path = join(h.root, "agent-profiles.json");
  const state = JSON.parse(readFileSync(path, "utf8")); state.profiles.push(state.profiles[0]); writeFileSync(path, JSON.stringify(state));
  expect(() => new AgentProfiles(h.root, bindings)).toThrow("duplicate identities");
  writeFileSync(path, "{damaged"); expect(() => new AgentProfiles(h.root, bindings)).toThrow();
  expect(readFileSync(path, "utf8")).toBe("{damaged");
});

it("rejects duplicate declarations and conflicting Grok envelopes while preserving the five-field wire contract", () => {
  expect(CapabilityDeclaration.safeParse({ capabilities: [{ capability: "mcp_tools", availability: "available" }, { capability: "mcp_tools", availability: "unknown" }] }).success).toBe(false);
  const envelope = grokWorkEvent({ id: workId, deadlineAt: "2026-10-12T00:00:00Z" });
  expect(Object.keys(envelope)).toEqual(["schemaVersion", "eventType", "eventId", "workId", "deadlineAt"]);
  expect(GrokWorkEvent.safeParse({ ...envelope, eventId: `work_${"b".repeat(32)}` }).success).toBe(false);
  expect(GrokWorkEvent.safeParse({ ...envelope, type: envelope.eventType }).success).toBe(false);
  expect(GrokAgentAdapter.ownsMessageSending).toBe(false);
});
