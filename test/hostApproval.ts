import type { LiveDesk, ToolReply } from "../src/cleaner-core/liveDesk";
import type { ToolResult } from "./wiringProof";

/** The approval code from a first call that only asked the host. */
function codeOf(result: Record<string, unknown> | undefined): string {
  return String((result?.confirmation as { code?: string } | undefined)?.code ?? "");
}

/** Asks, then answers with the code, as Grok does after the host says yes. */
export async function approvedOnDesk(ask: (confirmation?: string) => Promise<ToolReply>): Promise<ToolReply> {
  const asked = await ask();
  return ask(codeOf(asked.ok ? asked.result : undefined));
}

/** The same two calls through the MCP route. */
export async function approvedTool(call: (args?: Record<string, unknown>) => Promise<ToolResult>): Promise<ToolResult> {
  const asked = await call();
  return call({ confirmation: codeOf(asked.structured) });
}

export function resumeApproved(desk: LiveDesk): Promise<ToolReply> {
  return approvedOnDesk((confirmation) => desk.resumeCleaning(confirmation ? { confirmation } : {}));
}

/** A host message to the group, sent after the host's yes. Tests use it to see who is in the group. */
export function postToGroup(desk: LiveDesk, text: string): Promise<ToolReply> {
  return approvedOnDesk((confirmation) => desk.sendMessage({ to: "group", text, ...(confirmation ? { confirmation } : {}) }));
}
