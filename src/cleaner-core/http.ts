import { authorized } from "../mcp/mcpBridge";
import { cleanerCoreEnabled } from "./flag";
import { liveDeskFor } from "./liveDesk";
import { CLEANER_MCP_PATH, handleCleanerMcpMessage, type SaveSecrets } from "./mcp";
import { pinKeyFromHeader } from "./pinSeal";
import { scratchToolsOn } from "./scratchQa";
import { CLEANER_TWILIO_PATH, CLEANER_TWILIO_STATUS_PATH, handleCleanerTwilioStatus, handleCleanerTwilioWebhook, textAddressedTo } from "./twilioHook";

export { CLEANER_MCP_PATH, CLEANER_TWILIO_PATH, CLEANER_TWILIO_STATUS_PATH, handleCleanerTwilioStatus, handleCleanerTwilioWebhook, textAddressedTo };

/**
 * Cleaning scheduler chat. Its own credential. It lists none of the touring tools.
 * Off unless cleaning texts are turned on and a credential is set.
 */
export async function handleCleanerMcpHttp(input: {
  method: string;
  authorization: string | undefined;
  pinKeyHeader: string | string[] | undefined;
  contentType: string;
  readBody: () => Promise<Buffer>;
  env: NodeJS.ProcessEnv;
  root: string;
  now: () => Date;
  /** Writes to the secret store. Only `save_alert_routine` uses it. */
  saveSecrets: SaveSecrets;
}): Promise<{ status: number; body: string; headers?: Record<string, string> }> {
  if (!cleanerCoreEnabled(input.env)) {
    return { status: 503, body: JSON.stringify({ error: { message: "Cleaning texts aren't turned on." } }) };
  }
  const token = input.env.CLEANER_CORE_MCP_TOKEN?.trim();
  if (!token) return { status: 503, body: JSON.stringify({ error: { message: "The cleaning scheduler chat is off." } }) };
  if (!authorized(input.authorization, token)) {
    return {
      status: 401,
      body: JSON.stringify({ error: { message: "Missing or wrong cleaning scheduler credential." } }),
      headers: { "WWW-Authenticate": 'Bearer realm="cleaning"' },
    };
  }
  if (input.method !== "POST") {
    return { status: 405, body: JSON.stringify({ error: { message: "Send requests with POST." } }), headers: { Allow: "POST" } };
  }
  if (!input.contentType.startsWith("application/json")) {
    return { status: 415, body: JSON.stringify({ error: { message: "Unsupported request." } }) };
  }
  let message: unknown;
  try {
    message = JSON.parse((await input.readBody()).toString("utf8") || "null");
  } catch {
    return { status: 400, body: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "That request couldn't be read." } }) };
  }
  const desk = liveDeskFor(input.root, () => input.env, input.now);
  const reply = await handleCleanerMcpMessage(desk, message, pinKeyFromHeader(input.pinKeyHeader), scratchToolsOn(input.env), input.saveSecrets);
  if (reply.body === undefined) return { status: reply.status, body: "" };
  return { status: reply.status, body: JSON.stringify(reply.body) };
}
