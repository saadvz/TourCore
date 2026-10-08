import { BASELINE_VERSION } from "./baseline";
import { CHATGPT_VERSION } from "./chatgpt";
import { CLAUDE_TOOLS_VERSION, CLAUDE_VERSION } from "./claude";
import { GROK_VERSION } from "./grok";

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

/**
 * clientInfo.name values this repository already uses for Grok.
 * Matching is case-insensitive. A name containing "grok" is Grok. Grok Bot
 * connects through Cursor's MCP client, so a name containing "cursor"
 * (OAuth client_name "Cursor", and initialize names such as "cursor-vscode")
 * is the same wording. Also included: "grok" (MCP initialize in the connector
 * test), "grok-bot" (the bridge test), "grok-sim" (the official MCP SDK client
 * in the connector test), and "Grok (SDK test)".
 * prompts and resources are server capabilities. They never pick a playbook.
 * The name never changes a tool or a gate.
 */
export const GROK_CLIENT_NAMES = ["Grok", "grok", "grok-bot", "grok-sim", "Grok (SDK test)", "Cursor"] as const;

/** Client capabilities from the MCP spec. Not prompts or resources. */
const FULL_CLIENT_CAPABILITIES = ["elicitation", "sampling", "roots"] as const;

function named(client: ReportedClient | undefined): PlaybookId | undefined {
  const raw = client?.name?.trim().toLowerCase() ?? "";
  if (!raw) return undefined;
  if (raw.includes("grok")) return "grok";
  if (raw.includes("chatgpt") || raw.includes("openai")) return "chatgpt";
  if (raw.includes("claude") || raw.includes("anthropic")) return "claude";
  if (raw.includes("cursor")) return "grok";
  return undefined;
}

/**
 * The first client whose name selects a playbook. A nameless or baseline
 * entry never hides a later known name (a stored OAuth name, or a name on
 * a later call).
 */
export function preferPlaybookClient(...candidates: Array<ReportedClient | undefined>): ReportedClient | undefined {
  const namedClients = candidates.filter((client): client is ReportedClient => !!client?.name?.trim());
  return namedClients.find((client) => selectPlaybook(client).id !== "baseline") ?? namedClients[0];
}

function capabilityOn(caps: Record<string, unknown> | undefined, key: string): boolean {
  if (!caps || !(key in caps)) return false;
  const value = caps[key];
  return value !== undefined && value !== false;
}

/** True when the client reports elicitation, sampling, or roots. */
export function clientOffersFullPlaybook(caps: Record<string, unknown> | undefined): boolean {
  return FULL_CLIENT_CAPABILITIES.some((key) => capabilityOn(caps, key));
}

/**
 * The client name only picks a playbook. It never changes a gate.
 * Unknown names and a missing client get the baseline tools-only playbook.
 * Grok defaults to the full playbook, including when no capabilities are sent.
 * Claude is full only when it reports elicitation, sampling, or roots.
 * ChatGPT stays tools-only. URL elicitation is not implemented in Phase 1.
 */
export function selectPlaybook(client?: ReportedClient): PlaybookSelection {
  const id = named(client);
  if (!id) return { id: "baseline", mode: "tools", version: BASELINE_VERSION };
  if (id === "chatgpt") return { id, mode: "tools", version: CHATGPT_VERSION };
  if (id === "grok") return { id, mode: "full", version: GROK_VERSION };
  if (clientOffersFullPlaybook(client?.capabilities)) return { id, mode: "full", version: CLAUDE_VERSION };
  return { id, mode: "tools", version: CLAUDE_TOOLS_VERSION };
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
