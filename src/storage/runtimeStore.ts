import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomicWrite";

/**
 * Small, named JSON documents that let running tours survive a restart:
 * conversation sessions, identity-form links, messaging lines, processed
 * provider events. Provider-neutral: each document is plain JSON with its own
 * schema version, so a folder, a Drive folder, Notion or a database can hold
 * it without Tour Core changing. Canonical tour records (reservations,
 * grants, audit) stay in the tour records; these only point at them.
 */

export type RuntimeNamespace = "sessions" | "verification" | "endpoints" | "messaging-ledger" | "oauth" | "probe" | "operator-events" | "setup-sessions" | "approval-sessions" | "audit-export-links";

/** A stored document that exists but can't be read back. Never treated as empty. */
export class RuntimeRecordDamaged extends Error {
  constructor(
    readonly namespace: RuntimeNamespace,
    readonly key: string,
    cause: unknown,
  ) {
    super(`Saved ${namespace} record ${key} couldn't be read (${cause instanceof Error ? cause.message : "unreadable"})`);
  }
}

export interface RuntimeStore {
  get<T>(namespace: RuntimeNamespace, key: string): T | undefined;
  put(namespace: RuntimeNamespace, key: string, value: unknown): void;
  delete(namespace: RuntimeNamespace, key: string): void;
  /** Every document in a namespace. Damaged ones are listed separately instead of hidden. */
  list<T>(namespace: RuntimeNamespace): { entries: { key: string; value: T }[]; damaged: string[] };
  /** Removes one namespace. Does not remove the store root. */
  clearNamespace(namespace: RuntimeNamespace): void;
}

const KEY = /^[A-Za-z0-9_-]{1,120}$/;

function checkKey(key: string): string {
  if (!KEY.test(key)) throw new Error("Runtime record keys may only use letters, numbers, - and _.");
  return key;
}

/** <root>/<namespace>/<key>.json, each written atomically (temp file, validate, rename). */
export class FileRuntimeStore implements RuntimeStore {
  constructor(readonly root: string) {}

  get<T>(namespace: RuntimeNamespace, key: string): T | undefined {
    const path = this.path(namespace, key);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch (err) {
      throw new RuntimeRecordDamaged(namespace, key, err);
    }
  }

  put(namespace: RuntimeNamespace, key: string, value: unknown): void {
    writeJsonAtomic(this.path(namespace, key), value);
  }

  delete(namespace: RuntimeNamespace, key: string): void {
    rmSync(this.path(namespace, key), { force: true });
  }

  clearNamespace(namespace: RuntimeNamespace): void {
    rmSync(join(this.root, namespace), { recursive: true, force: true });
  }

  list<T>(namespace: RuntimeNamespace): { entries: { key: string; value: T }[]; damaged: string[] } {
    const dir = join(this.root, namespace);
    const entries: { key: string; value: T }[] = [];
    const damaged: string[] = [];
    if (!existsSync(dir)) return { entries, damaged };
    for (const name of readdirSync(dir)) {
      const key = name.replace(/\.json$/, "");
      if (!name.endsWith(".json") || !KEY.test(key)) continue;
      try {
        entries.push({ key, value: this.get<T>(namespace, key)! });
      } catch {
        damaged.push(key);
      }
    }
    return { entries, damaged };
  }

  private path(namespace: RuntimeNamespace, key: string): string {
    return join(this.root, namespace, `${checkKey(key)}.json`);
  }
}

/** Same contract, nothing written anywhere. For tests and the browser-only demo. */
export class MemoryRuntimeStore implements RuntimeStore {
  private readonly docs = new Map<string, string>();

  get<T>(namespace: RuntimeNamespace, key: string): T | undefined {
    const text = this.docs.get(`${namespace}/${checkKey(key)}`);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  }

  put(namespace: RuntimeNamespace, key: string, value: unknown): void {
    this.docs.set(`${namespace}/${checkKey(key)}`, JSON.stringify(value));
  }

  delete(namespace: RuntimeNamespace, key: string): void {
    this.docs.delete(`${namespace}/${checkKey(key)}`);
  }

  clearNamespace(namespace: RuntimeNamespace): void {
    const prefix = `${namespace}/`;
    for (const key of this.docs.keys()) if (key.startsWith(prefix)) this.docs.delete(key);
  }

  list<T>(namespace: RuntimeNamespace): { entries: { key: string; value: T }[]; damaged: string[] } {
    const prefix = `${namespace}/`;
    const entries = [...this.docs.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k.slice(prefix.length), value: JSON.parse(v) as T }));
    return { entries, damaged: [] };
  }
}

/** Writes, reads back and removes a throwaway document. Throws with the underlying problem if any step fails. */
export function probeRuntimeStore(store: RuntimeStore, now = new Date()): void {
  const key = `probe_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
  const value = { schemaVersion: 1, at: now.toISOString() };
  store.put("probe", key, value);
  const back = store.get<typeof value>("probe", key);
  store.delete("probe", key);
  if (back?.at !== value.at) throw new Error("A saved record came back different.");
}
