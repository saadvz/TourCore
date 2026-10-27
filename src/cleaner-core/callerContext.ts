import { AsyncLocalStorage } from "node:async_hooks";
import type { CleanerAssistant } from "./assistant";

/**
 * Which connected chat is making this request, on a multi-tenant Cleaner Core. A tool reply speaks
 * to that chat. Without one, a desk speaks as its primary, which is the single-tenant behavior.
 */
export interface CleanerCaller {
  assistant: CleanerAssistant;
  /** The OAuth grant id of the connection. */
  connectionId?: string;
}

const storage = new AsyncLocalStorage<CleanerCaller>();

export function withCaller<T>(caller: CleanerCaller, run: () => T): T {
  return storage.run(caller, run);
}

export function currentCaller(): CleanerCaller | undefined {
  return storage.getStore();
}
