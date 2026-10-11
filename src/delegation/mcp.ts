import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";
import { DelegationError, type AgentIdentity, type DelegationPrototype } from "./prototype";

export interface PrototypeBinding extends AgentIdentity { token: string }
export function delegationApp(engine: DelegationPrototype, bindings: PrototypeBinding[], options: { allowedHosts?: string[] } = {}) {
  if (!bindings.length || bindings.some((b) => b.token.length < 24 || !b.tenantId || !b.agentId) || new Set(bindings.map((b) => b.token)).size !== bindings.length) throw new Error("Unique prototype credentials and identities are required.");
  const app = createMcpExpressApp({ host: "127.0.0.1", ...options });
  app.post("/mcp", async (req, res) => {
    const supplied = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    const binding = bindings.find((b) => { const token = Buffer.from(b.token); return token.length === supplied.length && timingSafeEqual(token, supplied) && req.headers.authorization?.startsWith("Bearer "); });
    if (!binding) { res.status(401).json({ error: "Unauthorized" }); return; }
    const identity = { tenantId: binding.tenantId, agentId: binding.agentId };
    const server = new McpServer({ name: "cleaner-core-delegation-prototype", version: "0.1.0" });
    const result = async (action: () => Promise<unknown>) => {
      try { const value = await action(); return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
      catch (err) { return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(err instanceof DelegationError ? { code: err.code, message: err.message } : { code: "UNAVAILABLE", message: "The action could not be confirmed. Retry only with the same action key." }) }] }; }
    };
    server.registerTool("list_delegated_work", { description: "List pending cleaner requests for this authenticated tenant.", inputSchema: z.strictObject({}) }, () => result(() => engine.list(identity)));
    server.registerTool("read_delegated_work", { description: "Read current authoritative booking constraints and completion status.", inputSchema: z.strictObject({ id: z.string() }) }, (i) => result(() => engine.get(identity, i.id)));
    server.registerTool("claim_delegated_work", { description: "Claim a deadline-bounded lease before proposing a cleaning time.", inputSchema: z.strictObject({ id: z.string() }) }, (i) => result(() => engine.claim(identity, i.id)));
    server.registerTool("propose_cleaning_time", { description: "Propose a start time. The engine validates fresh booking state and composes the reply. accepted is not completed; read status to confirm delivery.", inputSchema: z.strictObject({ id: z.string(), leaseToken: z.string(), actionKey: z.string(), expectedTurnVersion: z.number().int().positive(), start: z.iso.datetime() }) }, (i) => result(() => engine.propose(identity, i)));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: "MCP request failed" }); }
  });
  app.all("/mcp", (_req, res) => { res.status(405).end(); });
  return app;
}
