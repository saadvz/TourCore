/**
 * How /mcp is protected. "oauth" (the default): OAuth 2.1 with owner
 * approval on the Tour Core computer. "static": one bearer token, for
 * development. Exactly one is active; there's no unauthenticated mode.
 */
export type McpAuthMode = "oauth" | "static";

/** TOURCORE_MCP_AUTH_MODE: oauth (default) or static. Anything else turns the connector off rather than guessing. */
export function mcpAuthModeFromEnv(env: NodeJS.ProcessEnv = process.env): McpAuthMode | { invalid: string } {
  const raw = env.TOURCORE_MCP_AUTH_MODE?.trim().toLowerCase();
  if (!raw || raw === "oauth") return "oauth";
  if (raw === "static") return "static";
  return { invalid: raw };
}
