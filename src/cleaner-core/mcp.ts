import { z } from "zod";
import type { SettingName } from "../install/secretStore";
import { DOOR_CODE_IN_CHAT, type LiveDesk, type ToolReply } from "./liveDesk";
import type { GoogleEventList } from "./sources";
import { DELIVERY_REPORTS, SCRATCH_TOOLS } from "./scratchQa";

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
    description: "Saves the host and the cleaner. Each one is a phone number. An observer is optional.",
    input: z.object({ host: z.string(), cleaner: z.string(), observer: z.string().optional() }),
  },
  {
    name: "save_calendar_link",
    title: "Save the calendar link",
    description: "Saves where the bookings come from. Pass the Guesty Lite link as url, or google true when the host uses Google Calendar, or both. The first job is read from those.",
    input: z.object({ url: z.string().optional(), google: z.boolean().optional() }),
  },
  {
    name: "save_sources",
    title: "Save the booking calendars",
    description:
      "Saves where bookings come from. calendars replaces every saved link: each is a name and its public https iCal url (Guesty, Airbnb, Vrbo, direct, or other), up to 8. Pass google true or false only to change Google Calendar; leaving it out keeps it. If the change would call off an upcoming cleaning, it is refused with wouldCancel: ask the host, then save again with dropJobs true. The reply never repeats a link.",
    input: z.object({
      calendars: z.array(z.object({ name: z.string(), url: z.string() })).optional(),
      google: z.boolean().optional(),
      dropJobs: z.boolean().optional(),
    }),
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
    description: "Enables the host for texting. That consent seats him in the cleaning group, so he does not text YES. It does not ask for account secrets.",
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
    description: "Reads the calendar and checks the setup. It does not send a live text. When the host uses Google Calendar, read its events with your own connector and pass them as googleEvents, the events.list result.",
    input: z.object({ googleEvents: z.object({ timeZone: z.string().optional(), items: z.array(z.unknown()) }).optional() }),
  },
  {
    name: "check_now",
    title: "Check the calendars now",
    description:
      "Re-reads the booking calendars, sends any reminders that are due, and returns new alerts for the host. Pass googleEvents only when you just read Google Calendar. unread names any calendar link that didn't read; its saved bookings are kept.",
    input: z.object({ googleEvents: z.object({ timeZone: z.string().optional(), items: z.array(z.unknown()) }).optional() }),
  },
  {
    name: "save_alert_routine",
    title: "Connect alerts",
    description: "Saves the alert routine's webhook address and token from the secure card. The reply never repeats them.",
    input: z.object({ url: z.string().optional(), token: z.string().optional() }),
  },
  {
    name: "resume_job",
    title: "Resume the cleaning",
    description: "The host resumes a cleaning that was on hold. A text from the cleaner cannot do this.",
    input: z.object({}),
  },
] as const;

function scratchCopy(name: (typeof SCRATCH_TOOLS)[number]["name"]) {
  const found = SCRATCH_TOOLS.find((tool) => tool.name === name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}

const SCRATCH_TOOL_LIST = [
  {
    name: "reset_scratch",
    title: scratchCopy("reset_scratch").title,
    description: scratchCopy("reset_scratch").description,
    input: z.object({}),
  },
  {
    name: "read_inbox",
    title: scratchCopy("read_inbox").title,
    description: scratchCopy("read_inbox").description,
    input: z.object({}),
  },
  {
    name: "read_outbox",
    title: scratchCopy("read_outbox").title,
    description: scratchCopy("read_outbox").description,
    input: z.object({}),
  },
  {
    name: "send_test_text",
    title: scratchCopy("send_test_text").title,
    description: scratchCopy("send_test_text").description,
    input: z.object({ from: z.string(), text: z.string() }),
  },
  {
    name: "report_delivery",
    title: scratchCopy("report_delivery").title,
    description: scratchCopy("report_delivery").description,
    input: z.object({ which: z.string(), status: z.enum(DELIVERY_REPORTS) }),
  },
  {
    name: "add_test_turn",
    title: scratchCopy("add_test_turn").title,
    description: scratchCopy("add_test_turn").description,
    input: z.object({ checkout: z.string(), checkIn: z.string() }),
  },
] as const;

type ToolName = (typeof TOOLS)[number]["name"] | (typeof SCRATCH_TOOL_LIST)[number]["name"];

function listedTools(scratchTools: boolean) {
  return scratchTools ? [...TOOLS, ...SCRATCH_TOOL_LIST] : [...TOOLS];
}

const Request = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export type SaveSecrets = (values: Partial<Record<SettingName, string>>) => void;

export async function handleCleanerMcpMessage(
  desk: LiveDesk,
  message: unknown,
  pinKey?: Buffer,
  scratchTools = false,
  saveSecrets?: SaveSecrets,
): Promise<{ status: number; body?: unknown }> {
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
      instructions: [
        "Call get_state first and follow its next step. Ask one plain question, then call get_state again. Do not skip ahead. Do not read out a door code.",
        "Use check_now when a routine wakes you or the host says check my calendars. Read Google Calendar with your own connector first when the host uses it. Post each alert in your own short words. Collect secrets only with your secure card.",
        "When check_now returns needsTimes, ask the host for the checkout time and the next check-in time, then call confirm_times.",
        "confirm_times keeps a check-in time already saved. To change only the check-in time, tell the host it can't be changed by text yet.",
      ].join(" "),
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    return rpcResult(id, {
      tools: listedTools(scratchTools).map((tool) => {
        const { $schema: _schema, ...inputSchema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
        return { name: tool.name, title: tool.title, description: tool.description, inputSchema };
      }),
    });
  }
  if (method === "tools/call") {
    const name = typeof params?.name === "string" ? params.name : "";
    const tool = listedTools(scratchTools).find((item) => item.name === name);
    if (!tool) return rpcError(id, -32602, "I can't do that from this chat.");
    const args = tool.input.safeParse(params?.arguments ?? {});
    if (!args.success) return rpcResult(id, { content: [{ type: "text", text: "That was missing something I need." }], isError: true });
    if (chatCarriesDoorCode(tool.name, args.data, desk)) {
      return rpcResult(id, { content: [{ type: "text", text: DOOR_CODE_IN_CHAT }], isError: true });
    }
    let reply: ToolReply;
    try {
      reply = await callTool(desk, tool.name, args.data, pinKey, saveSecrets);
    } catch {
      reply = { ok: false, error: "That didn't work. Try again." };
    }
    if (!reply.ok) {
      if (desk.leaks(reply.error) || (reply.result && desk.leaks(JSON.stringify(reply.result)))) reply = { ok: false, error: "That didn't work. Try again." };
      return rpcResult(id, { content: [{ type: "text", text: reply.error }], ...(reply.result ? { structuredContent: reply.result } : {}), isError: true });
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
  // Calendar names are shown back, so a door code can't hide in one.
  if (name === "save_sources") {
    const calendars = (args as { calendars?: { name: string }[] }).calendars ?? [];
    if (calendars.some((calendar) => desk.chatCarriesDoorCode(calendar.name))) return true;
  }
  return false;
}

async function callTool(desk: LiveDesk, name: ToolName, args: object, pinKey: Buffer | undefined, saveSecrets: SaveSecrets | undefined): Promise<ToolReply> {
  switch (name) {
    case "get_state":
      return desk.getState("said" in args ? (args as { said?: string }).said : undefined);
    case "save_property":
      return desk.saveProperty(args as { business: string; address: string; timeZone: string });
    case "save_people":
      return desk.savePeople(args as { host: string; cleaner: string; observer?: string });
    case "save_calendar_link":
      return desk.saveCalendarLink(args as { url?: string; google?: boolean });
    case "save_sources":
      return desk.saveSources(args as { calendars?: { name: string; url: string }[]; google?: boolean; dropJobs?: boolean });
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
      return desk.runChecks(args as { googleEvents?: GoogleEventList });
    case "check_now":
      return desk.checkNow(args as { googleEvents?: GoogleEventList });
    case "save_alert_routine":
      if (!saveSecrets) return { ok: false, error: "I can't save the alert routine from here." };
      return desk.saveAlertRoutine(args as { url?: string; token?: string }, saveSecrets, pinKey);
    case "resume_job":
      return desk.resumeCleaning();
    case "reset_scratch":
      return desk.resetScratch();
    case "read_inbox":
      return desk.readInbox();
    case "read_outbox":
      return desk.readOutbox();
    case "send_test_text":
      return desk.sendTestText(args as { from?: string; text?: string });
    case "report_delivery":
      return desk.reportDelivery(args as { which?: string; status?: string });
    case "add_test_turn":
      return desk.addTestTurn(args as { checkout?: string; checkIn?: string });
  }
}

function rpcError(id: string | number | null, code: number, message: string): { status: number; body: unknown } {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

function rpcResult(id: string | number | null, result: unknown): { status: number; body: unknown } {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}
