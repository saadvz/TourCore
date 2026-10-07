import { BASELINE_VERSION } from "./baseline";
import { CHATGPT_VERSION } from "./chatgpt";
import { CLAUDE_TOOLS_VERSION, CLAUDE_VERSION } from "./claude";
import { GROK_TOOLS_VERSION, GROK_VERSION } from "./grok";

export type PlaybookId = "grok" | "chatgpt" | "claude" | "baseline";
export type PlaybookMode = "full" | "tools";

export interface ReportedClient {
  name?: string;
  capabilities?: Record<string, unknown>;
}

export interface PlaybookSelection {
  id: PlaybookId;
  mode: PlaybookMode;
  version: string;
}

function named(client: ReportedClient | undefined): PlaybookId | undefined {
  const raw = client?.name?.trim().toLowerCase() ?? "";
  if (!raw) return undefined;
  if (raw.includes("grok")) return "grok";
  if (raw.includes("chatgpt") || raw.includes("openai")) return "chatgpt";
  if (raw.includes("claude") || raw.includes("anthropic")) return "claude";
  return undefined;
}

function capabilityOn(caps: Record<string, unknown> | undefined, key: string): boolean {
  if (!caps || !(key in caps)) return false;
  const value = caps[key];
  return value !== undefined && value !== false;
}

/**
 * The client name only picks a playbook. It never changes a gate.
 * Unknown names and a missing client get the baseline tools-only playbook.
 * URL elicitation is noted on the capability object and is not implemented in Phase 1.
 */
export function selectPlaybook(client?: ReportedClient): PlaybookSelection {
  const id = named(client);
  if (!id) return { id: "baseline", mode: "tools", version: BASELINE_VERSION };
  if (id === "chatgpt") return { id, mode: "tools", version: CHATGPT_VERSION };
  const full = capabilityOn(client?.capabilities, "prompts") && capabilityOn(client?.capabilities, "resources");
  if (id === "grok") return full ? { id, mode: "full", version: GROK_VERSION } : { id, mode: "tools", version: GROK_TOOLS_VERSION };
  return full ? { id, mode: "full", version: CLAUDE_VERSION } : { id, mode: "tools", version: CLAUDE_TOOLS_VERSION };
}

export function reportedClientFromInitialize(message: unknown): ReportedClient | undefined {
  if (!message || typeof message !== "object") return undefined;
  if ((message as { method?: unknown }).method !== "initialize") return undefined;
  const params = (message as { params?: unknown }).params;
  if (!params || typeof params !== "object") return {};
  const clientInfo = (params as { clientInfo?: unknown }).clientInfo;
  const capabilities = (params as { capabilities?: unknown }).capabilities;
  const name = clientInfo && typeof clientInfo === "object" && typeof (clientInfo as { name?: unknown }).name === "string" ? (clientInfo as { name: string }).name : undefined;
  const caps = capabilities && typeof capabilities === "object" && !Array.isArray(capabilities) ? (capabilities as Record<string, unknown>) : undefined;
  return { ...(name ? { name } : {}), ...(caps ? { capabilities: caps } : {}) };
}
