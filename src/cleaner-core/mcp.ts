import { z } from "zod";
import { DOOR_CODE_IN_CHAT, type LiveDesk, type ToolReply } from "./liveDesk";

export const CLEANER_MCP_PATH = "/mcp/cleaner-core";

const SERVER_INFO = { name: "cleaner-core", title: "Cleaning scheduler", version: "0.1.0" };

const TOOLS = [
  {
    name: "get_state",
    title: "See what's done",
    description: "Call this first and follow its next step. Ask one plain question, then call it again. Pass said only when the host just answered that question.",
    input: z.object({ said: z.string().optional() }),
  },
  {
    name: "save_property",
    title: "Save the property",
    description: "Saves the business name, the property address, and the time zone.",
    input: z.object({ business: z.string(), address: z.string(), timeZone: z.string() }),
  },
  {
    name: "save_people",
    title: "Save the people",
    description: "Saves the host, the cleaner, and the observer. Each one is a phone number.",
    input: z.object({ host: z.string(), cleaner: z.string(), observer: z.string() }),
  },
  {
    name: "save_calendar_link",
    title: "Save the calendar link",
    description: "Saves the public calendar link. The first job is read from that link.",
    input: z.object({ url: z.string() }),
  },
  {
    name: "save_door_code",
    title: "Save the door code",
    description: "Stores the door code. The reply never includes the digits. The code is not returned later.",
    input: z.object({ code: z.string() }),
  },
  {
    name: "set_up_texting",
    title: "Set up texting",
    description: "Marks texting ready. It does not ask for account secrets.",
    input: z.object({}),
  },
  {
    name: "get_turns",
    title: "See the jobs",
    description: "Lists cleaning jobs. It does not include the door code.",
    input: z.object({}),
  },
  {
    name: "confirm_times",
    title: "Confirm the times",
    description: "Saves the checkout time and the next check-in time the host just stated. It does not invent a time.",
    input: z.object({ checkout: z.string(), checkIn: z.string() }),
  },
  {
    name: "mark_guests_left",
    title: "Guests have left",
    description: "Sends the door code when the host says the guests have left. If that text did not go through, say it again to send it once more.",
    input: z.object({ said: z.string() }),
  },
  {
    name: "run_checks",
    title: "Run the checks",
    description: "Reads the calendar and checks the setup. It does not send a live text.",
    input: z.object({}),
  },
] as const;

type ToolName = (typeof TOOLS)[number]["name"];

const Request = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export async function handleCleanerMcpMessage(desk: LiveDesk, message: unknown, pinKey?: Buffer): Promise<{ status: number; body?: unknown }> {
  if (Array.isArray(message)) return rpcError(null, -32600, "Batched requests aren't supported.");
  const parsed = Request.safeParse(message);
  if (!parsed.success) return rpcError(null, -32600, "That isn't a valid request.");
  const { id, method, params } = parsed.data;
  if (id === undefined) return { status: 202 };
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: "Call get_state first and follow its next step. Ask one plain question, then call get_state again. Do not skip ahead. Do not read out a door code.",
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    return rpcResult(id, {
      tools: TOOLS.map((tool) => {
        const { $schema: _schema, ...inputSchema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
        return { name: tool.name, title: tool.title, description: tool.description, inputSchema };
      }),
    });
  }
  if (method === "tools/call") {
    const name = typeof params?.name === "string" ? params.name : "";
    const tool = TOOLS.find((item) => item.name === name);
    if (!tool) return rpcError(id, -32602, "I can't do that from this chat.");
    const args = tool.input.safeParse(params?.arguments ?? {});
    if (!args.success) return rpcResult(id, { content: [{ type: "text", text: "That was missing something I need." }], isError: true });
    if (chatCarriesDoorCode(tool.name, args.data, desk)) {
      return rpcResult(id, { content: [{ type: "text", text: DOOR_CODE_IN_CHAT }], isError: true });
    }
    let reply: ToolReply;
    try {
      reply = await callTool(desk, tool.name, args.data, pinKey);
    } catch {
      reply = { ok: false, error: "That didn't work. Try again." };
    }
    if (!reply.ok) {
      if (desk.leaks(reply.error)) reply = { ok: false, error: "That didn't work. Try again." };
      return rpcResult(id, { content: [{ type: "text", text: reply.error }], isError: true });
    }
    const text = JSON.stringify(reply.result);
    if (desk.leaks(text)) return rpcResult(id, { content: [{ type: "text", text: "That didn't work. Try again." }], isError: true });
    return rpcResult(id, { content: [{ type: "text", text }], structuredContent: reply.result, isError: false });
  }
  return rpcError(id, -32601, "I don't support that.");
}

function chatCarriesDoorCode(name: string, args: object, desk: LiveDesk): boolean {
  for (const [key, value] of Object.entries(args)) {
    if (name === "save_door_code" && key === "code") continue;
    if (typeof value === "string" && desk.chatCarriesDoorCode(value)) return true;
  }
  return false;
}

async function callTool(desk: LiveDesk, name: ToolName, args: object, pinKey: Buffer | undefined): Promise<ToolReply> {
  switch (name) {
    case "get_state":
      return desk.getState("said" in args ? (args as { said?: string }).said : undefined);
    case "save_property":
      return desk.saveProperty(args as { business: string; address: string; timeZone: string });
    case "save_people":
      return desk.savePeople(args as { host: string; cleaner: string; observer: string });
    case "save_calendar_link":
      return desk.saveCalendarLink(args as { url: string });
    case "save_door_code":
      return desk.saveDoorCode(args as { code: string }, pinKey);
    case "set_up_texting":
      return desk.setUpTexting();
    case "get_turns":
      return desk.getTurns();
    case "confirm_times":
      return desk.confirmTimes(args as { checkout: string; checkIn: string });
    case "mark_guests_left":
      return desk.markGuestsLeft(args as { said: string }, pinKey);
    case "run_checks":
      return desk.runChecks();
  }
}

function rpcError(id: string | number | null, code: number, message: string): { status: number; body: unknown } {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

function rpcResult(id: string | number | null, result: unknown): { status: number; body: unknown } {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}
