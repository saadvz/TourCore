import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { hostedResetToolVisible, HOSTED_ADMIN_TOOLS } from "../install/hostedAdminTools";
import { callOperatorTool, OPERATOR_TOOLS, UnknownToolError, type ToolContext } from "../operator/tools";

/**
 * A thin MCP bridge (Streamable HTTP, stateless, JSON responses) over Tour
 * Core's operator tool contract, for agent hosts such as Grok Bot that
 * connect to tools through a remote MCP server. Transport only: it lists the
 * tools, validates JSON-RPC, and hands every call to callOperatorTool. There
 * is no business or policy logic here.
 */

export { MCP_PATH } from "./paths";
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "tour-core", title: "Tour Core", version: "0.2.0" };

const INSTRUCTIONS =
  "Tour Core is the system of record and policy authority for self-guided tours. Use these tools to set up a property, map routes, run the readiness check and a practice tour, publish for demo (only after an explicit yes), watch active tours, work exceptions and export the audit. " +
  "For installation, get_installation_status and get_next_installation_step are the source of truth for what's set up and what comes next. Provider credentials are entered only by the operator on Tour Core's secure setup page (get_secure_setup_url); never ask for them in chat. " +
  "Speak to the operator in plain, everyday words. Never show ids, handles or codes. Never invent property facts. There is no tool to open a door: access is decided by Tour Core's policy on each visitor request and carried out by Durin.";

type JsonRpcId = string | number | null;
interface Reply {
  status: number;
  body?: unknown;
}

const Request = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const rpcError = (id: JsonRpcId, code: number, message: string): Reply => ({ status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } });
const rpcResult = (id: JsonRpcId, result: unknown): Reply => ({ status: 200, body: { jsonrpc: "2.0", id, result } });

const ANNOTATIONS = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  change: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  consequential: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
} as const;

export function mcpToolList(ctx?: ToolContext) {
  const tools = hostedResetToolVisible(ctx) ? [...OPERATOR_TOOLS, ...HOSTED_ADMIN_TOOLS] : OPERATOR_TOOLS;
  return tools.map((t) => {
    const { $schema: _s, ...inputSchema } = z.toJSONSchema(t.input) as Record<string, unknown>;
    return { name: t.name, title: t.title, description: t.description, inputSchema, annotations: { title: t.title, ...ANNOTATIONS[t.kind] } };
  });
}

/** One JSON-RPC message in, one reply out. Notifications get 202 with no body. */
export async function handleMcpMessage(ctx: ToolContext, message: unknown): Promise<Reply> {
  if (Array.isArray(message)) return rpcError(null, -32600, "Batched requests aren't supported.");
  const parsed = Request.safeParse(message);
  if (!parsed.success) return rpcError(null, -32600, "That isn't a valid JSON-RPC request.");
  const { id, method, params } = parsed.data;
  if (id === undefined) return { status: 202 };

  switch (method) {
    case "initialize": {
      const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined;
      const protocolVersion = asked && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0];
      return rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: mcpToolList(ctx) });
    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : "";
      try {
        const outcome = await callOperatorTool(ctx, name, params?.arguments ?? {});
        if (!outcome.ok) return rpcResult(id, { content: [{ type: "text", text: outcome.error }], isError: true });
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(outcome.result) }], structuredContent: outcome.result, isError: false });
      } catch (err) {
        if (err instanceof UnknownToolError) return rpcError(id, -32602, err.message);
        return rpcError(id, -32603, "Tour Core couldn't run that tool.");
      }
    }
    default:
      return rpcError(id, -32601, `Tour Core doesn't support "${method}".`);
  }
}

/** Constant-time bearer-token check. No token configured means the connector is off. */
export function authorized(header: string | undefined, token: string | undefined): boolean {
  if (!token) return false;
  const given = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]?.trim() ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
