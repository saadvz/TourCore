import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePhone } from "../core/phone";
import { writeJsonAtomic } from "../storage/atomicWrite";

const DAY_MS = 24 * 60 * 60 * 1000;

interface RemovedReplyFile {
  schemaVersion: 1;
  phones: Record<string, string>;
}

export function removedRepliesPath(root: string, propertyId: string): string {
  return join(root, "properties", propertyId, "operator", "removed-replies.json");
}

function readRemovedReplies(root: string, propertyId: string): Record<string, string> {
  const path = removedRepliesPath(root, propertyId);
  if (!existsSync(path)) return {};
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as Partial<RemovedReplyFile>).phones ?? {};
  } catch {
    return {};
  }
}

/** True when this phone has not been sent the removed-property reply in the last 24 hours. */
export function shouldReplyRemoved(root: string, propertyId: string, phone: string, now: Date): boolean {
  const sender = normalizePhone(phone);
  if (!sender || sender === "+") return false;
  const last = readRemovedReplies(root, propertyId)[sender];
  if (!last) return true;
  return now.getTime() - Date.parse(last) >= DAY_MS;
}

export function markRemovedReply(root: string, propertyId: string, phone: string, now: Date): void {
  const sender = normalizePhone(phone);
  if (!sender || sender === "+") return;
  writeJsonAtomic(removedRepliesPath(root, propertyId), {
    schemaVersion: 1,
    phones: { ...readRemovedReplies(root, propertyId), [sender]: now.toISOString() },
  } satisfies RemovedReplyFile);
}
