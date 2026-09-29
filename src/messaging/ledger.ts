import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../storage/atomicWrite";

export interface LedgerEntry {
  /** "processing" that never finished (e.g. a crash mid-message) still counts as seen: a retry is not run again. */
  state: "processing" | "done" | "failed";
  /** When the event was first claimed. */
  at: string;
  processedAt?: string;
  provider?: string;
  /** The provider's own id for the event or message. */
  messageId?: string;
  /** Which conversation handled it, when known. */
  correlationId?: string;
  duplicates: number;
  value?: unknown;
}

/**
 * Remembers which provider events were already handled and which sends
 * already happened, so retries never repeat a business action or a text.
 * Kept in memory and, when given a file, saved atomically after each change,
 * so it holds across restarts. The oldest entries are dropped past the cap;
 * providers retry within minutes, not weeks.
 */
export class MessagingLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  constructor(
    private readonly file?: string,
    private readonly maxEntries = 5000,
    /** An older ledger location to carry over the first time this file is created. */
    legacyFile?: string,
  ) {
    const source = file && existsSync(file) ? file : legacyFile && existsSync(legacyFile) ? legacyFile : undefined;
    if (source) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(readFileSync(source, "utf8")) as Record<string, LedgerEntry>)) this.entries.set(k, v);
      } catch {
        // A damaged ledger only means older events can't be recognized as duplicates.
      }
      if (source !== file) this.save();
    }
  }

  /** True the first time a key is seen; false (and counted) for every repeat. */
  claim(key: string, at = new Date(), meta: { provider?: string; messageId?: string } = {}): boolean {
    const existing = this.entries.get(key);
    if (existing) {
      existing.duplicates++;
      this.save();
      return false;
    }
    this.entries.set(key, { state: "processing", at: at.toISOString(), duplicates: 0, ...meta });
    this.trim();
    this.save();
    return true;
  }

  complete(key: string, value?: unknown, meta: { correlationId?: string; at?: Date } = {}): void {
    const entry = this.entries.get(key) ?? { state: "done", at: new Date().toISOString(), duplicates: 0 };
    this.entries.set(key, {
      ...entry,
      state: "done",
      processedAt: (meta.at ?? new Date()).toISOString(),
      ...(meta.correlationId ? { correlationId: meta.correlationId } : {}),
      ...(value === undefined ? {} : { value }),
    });
    this.save();
  }

  fail(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.state = "failed";
      entry.processedAt = new Date().toISOString();
      this.save();
    }
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    return entry?.state === "done" ? (entry.value as T) : undefined;
  }

  entry(key: string): LedgerEntry | undefined {
    return this.entries.get(key);
  }

  duplicatesOf(key: string): number {
    return this.entries.get(key)?.duplicates ?? 0;
  }

  /** Forgets every provider event. The next inbound message is treated as new. */
  clear(): void {
    this.entries.clear();
    this.save();
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  private save(): void {
    if (this.file) writeJsonAtomic(this.file, Object.fromEntries(this.entries));
  }
}
