import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../storage/atomicWrite";
import type { AgentIdentity } from "../delegation/prototype";
import { AgentId, AgentProfile, Capability, CapabilityDeclaration, NativeGrant, agentReadiness, type CapabilityEvidence } from "./profile";

const Instant = z.iso.datetime();
const Probe = z.strictObject({
  id: AgentId, tenantId: AgentId, agentId: AgentId, capability: Capability, nonceHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: Instant, deadlineAt: Instant, status: z.enum(["pending", "awaiting_review", "verified", "failed", "cancelled"]),
  observedAt: Instant.optional(), extensionId: AgentId.optional(), grantFingerprint: z.string().optional(),
  scenario: z.strictObject({ requestedStart: Instant, windowStart: Instant, windowEnd: Instant, minimumMinutes: z.number().int().positive() }).optional(),
});
const StoredProfile = z.strictObject({ profile: AgentProfile, credentialHash: z.string().regex(/^[a-f0-9]{64}$/) });
const Ledger = z.strictObject({ schemaVersion: z.literal(1), profiles: z.array(StoredProfile).max(64), probes: z.array(Probe).max(256) });
type Ledger = z.infer<typeof Ledger>;
export interface AgentBinding extends AgentIdentity { adapterId: "grok" | "generic_mcp"; token: string }
export class AgentProfileError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new AgentProfileError("INVALID_INPUT", "The capability request does not match its schema.");
  return result.data;
};

/** Single-writer prototype. Agent declarations never write verified evidence or grants. */
export class AgentProfiles {
  private readonly path: string;
  private readonly now: () => number;
  private readonly validityMs: number;
  private readonly draftScenario: () => "fits" | "overruns";
  private serial: Promise<unknown> = Promise.resolve();
  constructor(root: string, bindings: AgentBinding[], options: { now?: () => number; validityMs?: number; draftScenario?: () => "fits" | "overruns" } = {}) {
    this.path = join(root, "agent-profiles.json"); this.now = options.now ?? Date.now; this.validityMs = options.validityMs ?? 7 * 86400000;
    this.draftScenario = options.draftScenario ?? (() => randomInt(2) ? "fits" : "overruns");
    if (!Number.isSafeInteger(this.validityMs) || this.validityMs <= 0 || this.validityMs > 30 * 86400000) throw new Error("Profile evidence validity must be positive and at most 30 days.");
    if (!bindings.length || new Set(bindings.map((b) => hash([b.tenantId, b.agentId]))).size !== bindings.length) throw new Error("Unique agent bindings are required.");
    const state = this.read();
    for (const binding of bindings) {
      parse(z.strictObject({ tenantId: AgentId, agentId: AgentId, adapterId: z.enum(["grok", "generic_mcp"]), token: z.string().min(24) }), binding);
      const credentialHash = hash([binding.adapterId, binding.token]);
      let saved = state.profiles.find((p) => p.profile.tenantId === binding.tenantId && p.profile.agentId === binding.agentId);
      if (!saved) {
        const at = this.iso();
        saved = { credentialHash, profile: { schemaVersion: 1, tenantId: binding.tenantId, agentId: binding.agentId, adapterId: binding.adapterId,
          createdAt: at, updatedAt: at, capabilities: Capability.options.map((capability) => ({ capability, declared: "unknown" })), nativeExtensions: [], grants: [] } };
        state.profiles.push(saved);
      } else if (saved.credentialHash !== credentialHash) {
        saved.credentialHash = credentialHash; saved.profile.adapterId = binding.adapterId;
        saved.profile.connectionChangedAt = saved.profile.updatedAt = this.iso();
        for (const capability of saved.profile.capabilities) { delete capability.evidence; capability.declared = "unknown"; }
        saved.profile.grants = []; saved.profile.nativeExtensions = [];
        for (const probe of state.probes.filter((p) => p.tenantId === binding.tenantId && p.agentId === binding.agentId)) probe.status = "cancelled";
      }
    }
    this.save(state);
  }
  private iso() { return new Date(this.now()).toISOString(); }
  private read(): Ledger {
    const state = existsSync(this.path) ? Ledger.parse(JSON.parse(readFileSync(this.path, "utf8"))) : { schemaVersion: 1 as const, profiles: [], probes: [] };
    if (new Set(state.profiles.map((p) => hash([p.profile.tenantId, p.profile.agentId]))).size !== state.profiles.length
      || new Set(state.probes.map((p) => p.id)).size !== state.probes.length) throw new Error("Agent profile storage has duplicate identities.");
    return state;
  }
  private save(state: Ledger) { writeJsonAtomic(this.path, Ledger.parse(state)); chmodSync(this.path, 0o600); }
  private exclusive<T>(action: () => T | Promise<T>): Promise<T> { const next = this.serial.then(action); this.serial = next.catch(() => {}); return next; }
  async drain() { await this.serial; }
  private find(state: Ledger, identity: AgentIdentity) {
    const saved = state.profiles.find((p) => p.profile.tenantId === identity.tenantId && p.profile.agentId === identity.agentId);
    if (!saved) throw new AgentProfileError("NOT_FOUND", "No profile is available to this authenticated agent.");
    return saved.profile;
  }
  private findProbe(state: Ledger, identity: AgentIdentity, id: string) {
    const probe = state.probes.find((p) => p.id === id && p.tenantId === identity.tenantId && p.agentId === identity.agentId);
    if (!probe) throw new AgentProfileError("NOT_FOUND", "No probe is available to this authenticated agent.");
    if (this.now() >= Date.parse(probe.deadlineAt)) throw new AgentProfileError("PROBE_EXPIRED", "This probe has expired; start a new one.");
    return probe;
  }
  private record(profile: AgentProfile, capability: Capability, evidence: Omit<CapabilityEvidence, "expiresAt">) {
    if (Date.parse(evidence.observedAt) > this.now()) throw new AgentProfileError("INVALID_EVIDENCE", "Evidence cannot be from the future.");
    profile.capabilities.find((c) => c.capability === capability)!.evidence = { ...evidence, expiresAt: new Date(Date.parse(evidence.observedAt) + this.validityMs).toISOString() };
    profile.updatedAt = this.iso();
  }
  get(identity: AgentIdentity, deadlineMs = 120000) { return this.exclusive(() => agentReadiness(this.find(this.read(), identity), this.now(), deadlineMs)); }
  declare(identity: AgentIdentity, input: unknown) {
    return this.exclusive(() => {
      const declaration = parse(CapabilityDeclaration, input); const state = this.read(); const profile = this.find(state, identity);
      for (const claim of declaration.capabilities) {
        const record = profile.capabilities.find((c) => c.capability === claim.capability)!; record.declared = claim.availability;
        if (claim.availability === "unavailable") delete record.evidence;
      }
      if (declaration.nativeExtensions !== undefined) {
        const previous = profile.nativeExtensions; profile.nativeExtensions = declaration.nativeExtensions;
        profile.grants = profile.grants.filter((g) => {
          const before = previous.find((e) => e.id === g.extensionId); const after = profile.nativeExtensions.find((e) => e.id === g.extensionId);
          return before && after && hash(before) === hash(after);
        });
      }
      profile.updatedAt = this.iso(); this.save(state); return agentReadiness(profile, this.now());
    });
  }
  /** Trusted owner API only; does not confer verified capability or execute a connector. */
  grantNative(identity: AgentIdentity, input: unknown) {
    return this.exclusive(() => {
      const grant = parse(NativeGrant.omit({ fingerprint: true }), input); const state = this.read(); const profile = this.find(state, identity);
      const extension = profile.nativeExtensions.find((e) => e.id === grant.extensionId);
      if (!extension || new Set(grant.permissions).size !== grant.permissions.length || grant.permissions.some((p) => !extension.permissions.includes(p))) throw new AgentProfileError("PERMISSION_REQUIRED", "Grant only declared read permissions for an existing extension.");
      profile.grants = profile.grants.filter((g) => g.extensionId !== grant.extensionId);
      const saved = { ...grant, fingerprint: hash([extension, grant.permissions, grant.resourceId]) };
      profile.grants.push(saved); profile.updatedAt = this.iso(); this.save(state); return saved;
    });
  }
  revokeNative(identity: AgentIdentity, extensionId: string) {
    return this.exclusive(() => {
      parse(AgentId, extensionId); const state = this.read(); const profile = this.find(state, identity);
      profile.grants = profile.grants.filter((g) => g.extensionId !== extensionId);
      profile.updatedAt = this.iso(); this.save(state); return agentReadiness(profile, this.now());
    });
  }
  /** Read-only challenges. No probe creates delegated work or sends messages. */
  begin(identity: AgentIdentity, input: unknown) {
    return this.exclusive(() => {
      const request = parse(z.strictObject({ capability: Capability, extensionId: AgentId.optional() }), input);
      if (request.capability === "background_runs") throw new AgentProfileError("WORKFLOW_REQUIRED", "Verify background execution using a completed, correlated work item and owner confirmation.");
      const state = this.read(); const profile = this.find(state, identity);
      let grant: z.infer<typeof NativeGrant> | undefined;
      if (request.capability === "native_integrations") {
        grant = profile.grants.find((g) => g.extensionId === request.extensionId);
        if (!grant) throw new AgentProfileError("PERMISSION_REQUIRED", "A declared native extension needs an owner-granted read-only fixture scope first.");
      } else if (request.extensionId) throw new AgentProfileError("INVALID_INPUT", "Extension IDs apply only to native integration probes.");
      state.probes = state.probes.filter((p) => Date.parse(p.deadlineAt) > this.now() && (p.status === "pending" || p.status === "awaiting_review"));
      if (state.probes.length >= 256) throw new AgentProfileError("PROBE_LIMIT", "Too many active probes; finish existing probes first.");
      const nonce = randomBytes(24).toString("hex");
      const probe: z.infer<typeof Probe> = { id: `probe_${randomUUID().replaceAll("-", "")}`, ...identity, capability: request.capability,
        nonceHash: hash(nonce), issuedAt: this.iso(), deadlineAt: new Date(this.now() + 10 * 60000).toISOString(), status: "pending",
        ...(grant ? { extensionId: grant.extensionId, grantFingerprint: grant.fingerprint } : {}) };
      if (request.capability === "generation_reasoning") {
        const iso = (hours: number) => new Date(this.now() + hours * 3600000).toISOString();
        probe.scenario = { requestedStart: iso(this.draftScenario() === "fits" ? 25 : 29), windowStart: iso(24), windowEnd: iso(30), minimumMinutes: 90 };
      }
      state.probes.push(probe); this.save(state);
      return { probeId: probe.id, capability: probe.capability, nonce, deadlineAt: probe.deadlineAt,
        ...(probe.scenario ? { scenario: probe.scenario, task: "Choose propose_time only if requestedStart plus minimumMinutes fits the window; otherwise choose host_review. Return decision and a short draft. Always mention host clearance. For propose_time include requestedStart verbatim; for host_review mention review and that the existing time is unchanged. This is a synthetic exercise; send nothing." } : {}),
        ...(grant ? { readScope: { extensionId: grant.extensionId, permissions: grant.permissions, resourceId: grant.resourceId } } : {}),
        ...(!["mcp_tools", "generation_reasoning"].includes(request.capability) ? { task: request.capability === "scheduled_runs"
          ? "Schedule one read-only call to complete_agent_probe while the conversation is closed. Record supported trigger and tool trace for owner review. Send no messages and change no existing routines."
          : "Exercise the actual read-only capability on an owner-controlled fixture, preserve a sanitized native tool trace/artifact for owner review, then acknowledge with complete_agent_probe. The acknowledgment alone does not verify the capability." } : {}),
        requiresOwnerReview: !["mcp_tools", "generation_reasoning"].includes(request.capability) };
    });
  }
  complete(identity: AgentIdentity, input: unknown) {
    return this.exclusive(() => {
      const answer = parse(z.strictObject({ probeId: AgentId, nonce: z.string().regex(/^[a-f0-9]{48}$/), answer: z.strictObject({ decision: z.enum(["propose_time", "host_review"]), draft: z.string().min(10).max(500) }).optional() }), input);
      const state = this.read(); const profile = this.find(state, identity); const probe = this.findProbe(state, identity, answer.probeId);
      if (hash(answer.nonce) !== probe.nonceHash) throw new AgentProfileError("PROBE_MISMATCH", "The challenge response does not match this probe.");
      if (probe.status !== "pending") throw new AgentProfileError("PROBE_CLOSED", "This probe no longer accepts a response.");
      if (probe.grantFingerprint && !profile.grants.some((g) => g.extensionId === probe.extensionId && g.fingerprint === probe.grantFingerprint)) throw new AgentProfileError("PERMISSION_REQUIRED", "The native fixture grant changed; start a new probe.");
      const at = this.iso(); probe.observedAt = at;
      this.record(profile, "mcp_tools", { status: "verified", method: "server_probe", evidenceId: probe.id, scope: "authenticated_read_only_roundtrip", observedAt: at });
      if (probe.capability === "generation_reasoning") {
        const scenario = probe.scenario!;
        const valid = Date.parse(scenario.requestedStart) >= Date.parse(scenario.windowStart)
          && Date.parse(scenario.requestedStart) + scenario.minimumMinutes * 60000 <= Date.parse(scenario.windowEnd);
        const text = answer.answer?.draft.toLowerCase() ?? "";
        const passed = answer.answer?.decision === (valid ? "propose_time" : "host_review") && text.includes("host clearance")
          && (valid ? text.includes(scenario.requestedStart.toLowerCase()) : text.includes("review") && text.includes("unchanged"));
        probe.status = passed ? "verified" : "failed";
        this.record(profile, probe.capability, { status: probe.status, method: "server_probe", evidenceId: probe.id, scope: "synthetic_policy_draft", observedAt: at });
      } else if (probe.capability === "mcp_tools") probe.status = "verified";
      else probe.status = "awaiting_review";
      this.save(state); return { probeId: probe.id, status: probe.status, sendsMessages: false };
    });
  }
  /** Trusted owner reviews actual external fixture evidence; an agent acknowledgment alone cannot pass. */
  attest(identity: AgentIdentity, input: unknown) {
    return this.exclusive(() => {
      const review = parse(z.strictObject({ probeId: AgentId, artifactId: AgentId, outcome: z.enum(["passed", "failed"]),
        operation: z.enum(["scheduled_mcp_pickup", "native_fixture_read", "file_read", "image_inspection", "reminders_read"]), conversationClosed: z.boolean().optional() }), input);
      const state = this.read(); const profile = this.find(state, identity); const probe = this.findProbe(state, identity, review.probeId);
      if (probe.status !== "awaiting_review" || !probe.observedAt) throw new AgentProfileError("OBSERVATION_REQUIRED", "Complete the authenticated probe before owner review.");
      const allowed: Partial<Record<Capability, string[]>> = { scheduled_runs: ["scheduled_mcp_pickup"], native_integrations: ["native_fixture_read"], files_images: ["file_read", "image_inspection"], reminders_notifications: ["reminders_read"] };
      if (!allowed[probe.capability]?.includes(review.operation)) throw new AgentProfileError("INVALID_EVIDENCE", "The reviewed operation must match the issued capability probe.");
      if (probe.capability === "scheduled_runs" && review.conversationClosed !== true) throw new AgentProfileError("OFFLINE_CONFIRMATION_REQUIRED", "A scheduled probe needs explicit closed-conversation confirmation.");
      if (probe.grantFingerprint && !profile.grants.some((g) => g.extensionId === probe.extensionId && g.fingerprint === probe.grantFingerprint)) throw new AgentProfileError("PERMISSION_REQUIRED", "The native fixture grant changed; reverify its scope.");
      probe.status = review.outcome === "passed" ? "verified" : "failed";
      this.record(profile, probe.capability, { status: probe.status, method: "operator_review", evidenceId: review.artifactId,
        scope: review.operation, observedAt: probe.observedAt,
        ...(probe.capability === "scheduled_runs" ? { ownerConfirmedConversationClosed: true } : {}),
        ...(probe.extensionId ? { extensionId: probe.extensionId, grantFingerprint: probe.grantFingerprint } : {}) });
      this.save(state); return agentReadiness(profile, this.now());
    });
  }
  /** Caller must obtain this observation from engine/notification records, not request JSON. */
  verifyWorkflow(identity: AgentIdentity, observation: { workId: string; completedAt: string; latencyMs: number }, conversationClosed: boolean) {
    return this.exclusive(() => {
      const proof = parse(z.strictObject({ workId: z.string().regex(/^work_[a-f0-9]{32}$/), completedAt: Instant, latencyMs: z.number().int().nonnegative() }), observation);
      if (!conversationClosed) throw new AgentProfileError("OFFLINE_CONFIRMATION_REQUIRED", "Background verification needs explicit closed-conversation confirmation.");
      const state = this.read(); const profile = this.find(state, identity);
      if (profile.connectionChangedAt && Date.parse(proof.completedAt) < Date.parse(profile.connectionChangedAt)) throw new AgentProfileError("STALE_CONNECTION", "Use workflow evidence from the current connection.");
      this.record(profile, "background_runs", { status: "verified", method: "engine_workflow", evidenceId: proof.workId,
        scope: "webhook_cleaner_reschedule", observedAt: proof.completedAt, latencyMs: proof.latencyMs, ownerConfirmedConversationClosed: true });
      this.save(state); return agentReadiness(profile, this.now());
    });
  }
}
