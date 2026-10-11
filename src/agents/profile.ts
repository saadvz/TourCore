import { z } from "zod";

export const AgentId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const CAPABILITY_MCP_SERVER_VERSION = "0.2.0";
export const CORE_AGENT_TOOLS = ["list_delegated_work", "read_delegated_work", "claim_delegated_work", "propose_cleaning_time"] as const;
export const ONBOARDING_AGENT_TOOLS = ["read_agent_profile", "declare_agent_capabilities", "begin_agent_probe", "complete_agent_probe"] as const;
export const ToolDiscoveryReport = z.strictObject({ bridgeToolCount: z.number().int().min(0).max(128),
  exposedTools: z.array(z.enum([...CORE_AGENT_TOOLS, ...ONBOARDING_AGENT_TOOLS])).max(8),
}).refine((d) => new Set(d.exposedTools).size === d.exposedTools.length, "Discovered tool names must be unique");
export const ToolDiscovery = ToolDiscoveryReport.safeExtend({ method: z.literal("operator_report"), observedAt: z.iso.datetime(),
  serverSoftwareVersion: z.literal(CAPABILITY_MCP_SERVER_VERSION), serverToolCount: z.literal(8) });
export const Capability = z.enum(["mcp_tools", "generation_reasoning", "background_runs", "scheduled_runs", "native_integrations", "files_images", "reminders_notifications"]);
export type Capability = z.infer<typeof Capability>;
export const NativePermission = z.enum(["calendar.read", "guesty.read", "files.read", "notifications.read", "native.read"]);
export const NativeExtension = z.strictObject({
  id: AgentId, kind: z.enum(["calendar", "guesty", "files", "notifications", "other"]),
  permissions: z.array(NativePermission).min(1).max(5),
}).refine((e) => {
  const allowed = { calendar: "calendar.read", guesty: "guesty.read", files: "files.read", notifications: "notifications.read", other: "native.read" };
  return new Set(e.permissions).size === e.permissions.length && e.permissions.every((p) => p === allowed[e.kind]);
}, "Extensions must request only their supported read permission");
export const CapabilityDeclaration = z.strictObject({
  capabilities: z.array(z.strictObject({ capability: Capability, availability: z.enum(["available", "unavailable", "unknown"]) })).max(7),
  nativeExtensions: z.array(NativeExtension).max(16).optional(),
}).refine((d) => new Set(d.capabilities.map((c) => c.capability)).size === d.capabilities.length
  && new Set(d.nativeExtensions?.map((e) => e.id)).size === (d.nativeExtensions?.length ?? 0), "Declarations must be unique");

export const CapabilityEvidence = z.strictObject({
  status: z.enum(["verified", "failed"]), method: z.enum(["server_probe", "server_fixture", "engine_workflow", "operator_review"]),
  evidenceId: AgentId, scope: AgentId, observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  latencyMs: z.number().int().nonnegative().optional(), extensionId: AgentId.optional(), grantFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  ownerConfirmedConversationClosed: z.literal(true).optional(),
}).refine((e) => Date.parse(e.expiresAt) > Date.parse(e.observedAt), "Evidence validity must follow observation");
export type CapabilityEvidence = z.infer<typeof CapabilityEvidence>;
export const CapabilityRecord = z.strictObject({
  capability: Capability, declared: z.enum(["available", "unavailable", "unknown"]),
  evidence: CapabilityEvidence.optional(),
});
export const NativeGrant = z.strictObject({ extensionId: AgentId, permissions: z.array(NativePermission).min(1).max(5),
  resourceId: AgentId, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
export const AgentProfile = z.strictObject({
  schemaVersion: z.literal(1), tenantId: AgentId, agentId: AgentId, adapterId: z.enum(["grok", "generic_mcp"]),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), connectionChangedAt: z.iso.datetime().optional(),
  toolDiscovery: ToolDiscovery.optional(),
  capabilities: z.array(CapabilityRecord).length(7), nativeExtensions: z.array(NativeExtension).max(16), grants: z.array(NativeGrant).max(16),
}).refine((p) => new Set(p.capabilities.map((c) => c.capability)).size === 7
  && new Set(p.nativeExtensions.map((e) => e.id)).size === p.nativeExtensions.length
  && new Set(p.grants.map((g) => g.extensionId)).size === p.grants.length
  && p.grants.every((g) => p.nativeExtensions.some((e) => e.id === g.extensionId && g.permissions.every((permission) => e.permissions.includes(permission)))), "Profile entries and declared grant scopes must be valid");
export type AgentProfile = z.infer<typeof AgentProfile>;
export const CapabilityStatus = z.enum(["unknown", "declared", "unavailable", "verified", "failed", "expired"]);
export const AgentProfileView = AgentProfile.safeExtend({
  capabilities: z.array(CapabilityRecord.extend({ status: CapabilityStatus })).length(7),
  readiness: z.strictObject({ executionMode: z.enum(["unavailable", "interactive", "scheduled", "autonomous"]),
    deadlineMs: z.number().int().positive(), fallback: z.literal("engine_owned"), productionReady: z.literal(false),
    autonomousScopes: z.array(z.literal("cleaner.reschedule_requested")).max(1),
    generation: z.enum(["synthetic_probe_verified", "unverified"]),
    appToolDiscovery: z.enum(["unknown", "complete", "partial"]), onboardingTransport: z.enum(["unverified", "mcp", "core_mcp_owner_http"]),
    missingForAutonomous: z.array(z.enum(["verified_mcp_tools", "verified_background_runs", "background_latency_within_deadline", "delegation_tools_unavailable"])),
  }),
  extensions: z.array(NativeExtension.safeExtend({ permissionGranted: z.boolean(), verificationStatus: CapabilityStatus })).max(16),
});

/** Verification affects eligibility, never authorization to mutate external resources. */
export function agentReadiness(profile: AgentProfile, now = Date.now(), deadlineMs = 120000) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error("A positive response deadline is required.");
  const capabilities = profile.capabilities.map((record) => {
    let status: "unknown" | "declared" | "unavailable" | "verified" | "failed" | "expired" = record.declared === "available" ? "declared" : record.declared === "unavailable" ? "unavailable" : "unknown";
    if (record.evidence) {
      status = now >= Date.parse(record.evidence.expiresAt) ? "expired" : record.evidence.status;
      if (record.evidence.extensionId && !profile.grants.some((g) => g.extensionId === record.evidence!.extensionId && g.fingerprint === record.evidence!.grantFingerprint)) status = "unknown";
    }
    return { ...record, status };
  });
  const verified = (name: Capability) => capabilities.find((c) => c.capability === name)?.status === "verified";
  const background = capabilities.find((c) => c.capability === "background_runs");
  const coreToolsAvailable = !profile.toolDiscovery || CORE_AGENT_TOOLS.every((name) => profile.toolDiscovery!.exposedTools.includes(name));
  const profileToolsAvailable = profile.toolDiscovery && ONBOARDING_AGENT_TOOLS.every((name) => profile.toolDiscovery!.exposedTools.includes(name));
  const backgroundWithinDeadline = verified("background_runs") && background?.evidence?.latencyMs !== undefined && background.evidence.latencyMs <= deadlineMs;
  const executionMode = !verified("mcp_tools") ? "unavailable" : backgroundWithinDeadline && coreToolsAvailable ? "autonomous" : verified("scheduled_runs") ? "scheduled" : "interactive";
  return AgentProfileView.parse({ ...profile, capabilities, readiness: {
    executionMode, deadlineMs, fallback: "engine_owned", productionReady: false,
    autonomousScopes: executionMode === "autonomous" ? ["cleaner.reschedule_requested"] : [],
    generation: verified("generation_reasoning") ? "synthetic_probe_verified" : "unverified",
    appToolDiscovery: !profile.toolDiscovery ? "unknown" : profileToolsAvailable && coreToolsAvailable ? "complete" : "partial",
    onboardingTransport: !profile.toolDiscovery ? "unverified" : profileToolsAvailable ? "mcp" : "core_mcp_owner_http",
    missingForAutonomous: [!verified("mcp_tools") && "verified_mcp_tools", !verified("background_runs") && "verified_background_runs",
      verified("background_runs") && !backgroundWithinDeadline && "background_latency_within_deadline", !coreToolsAvailable && "delegation_tools_unavailable"].filter((value) => value !== false),
  }, extensions: profile.nativeExtensions.map((extension) => ({ ...extension,
    permissionGranted: profile.grants.some((g) => g.extensionId === extension.id),
    verificationStatus: capabilities.find((c) => c.capability === "native_integrations" && c.evidence?.extensionId === extension.id)?.status ?? "declared",
  })) });
}
