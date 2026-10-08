import type { ServerResponse } from "node:http";

/**
 * Server notification the MCP SDK client re-fetches tools for.
 * Delivered on the GET SSE stream Streamable HTTP opens after
 * notifications/initialized (a JSON 202 has no body for that notification).
 */
export const TOOLS_LIST_CHANGED = {
  jsonrpc: "2.0" as const,
  method: "notifications/tools/list_changed" as const,
};

const pending = new Set<string>();
const streams = new Map<string, Set<ServerResponse>>();

export function isInitializedNotification(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const note = message as { method?: unknown; id?: unknown };
  return note.method === "notifications/initialized" && note.id === undefined;
}

function writeNotice(res: ServerResponse): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: message\ndata: ${JSON.stringify(TOOLS_LIST_CHANGED)}\n\n`);
}

/** The client finished initialize. Push list_changed now, or on the next SSE connect. */
export function noteInitialized(sessionKey: string): void {
  const open = streams.get(sessionKey);
  if (open && [...open].some((res) => !res.writableEnded && !res.destroyed)) {
    for (const res of open) writeNotice(res);
    pending.delete(sessionKey);
    return;
  }
  pending.add(sessionKey);
}

/** Hold the SSE stream. If initialize already finished, send list_changed immediately. */
export function attachToolListStream(sessionKey: string, res: ServerResponse): void {
  let set = streams.get(sessionKey);
  if (!set) {
    set = new Set();
    streams.set(sessionKey, set);
  }
  set.add(res);
  res.on("close", () => {
    set!.delete(res);
    if (set!.size === 0) streams.delete(sessionKey);
  });
  if (pending.has(sessionKey)) {
    pending.delete(sessionKey);
    writeNotice(res);
  }
}
