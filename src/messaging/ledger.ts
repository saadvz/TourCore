import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../storage/atomicWrite";

interface LedgerEntry {
  state: "processing" | "done" | "failed";
  at: string;
  duplicates: number;
  value?: unknown;
}

/**
 * Remembers which provider events were already handled and which sends
 * already happened, so retries never repeat a business action or a text.
 * Kept in memory and, when given a file, saved atomically after each change.
 */
export class MessagingLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  constructor(
    private readonly file?: string,
    private readonly maxEntries = 5000,
  ) {
    if (file && existsSync(file)) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, LedgerEntry>)) this.entries.set(k, v);
      } catch {
        // A damaged ledger only means older events can't be recognized as duplicates.
      }
    }
  }

  /** True the first time a key is seen; false (and counted) for every repeat. */
  claim(key: string, at = new Date()): boolean {
    const existing = this.entries.get(key);
    if (existing) {
      existing.duplicates++;
      this.save();
      return false;
    }
    this.entries.set(key, { state: "processing", at: at.toISOString(), duplicates: 0 });
    this.trim();
    this.save();
    return true;
  }

  complete(key: string, value?: unknown): void {
    const entry = this.entries.get(key) ?? { state: "done", at: new Date().toISOString(), duplicates: 0 };
    this.entries.set(key, { ...entry, state: "done", ...(value === undefined ? {} : { value }) });
    this.save();
  }

  fail(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.state = "failed";
      this.save();
    }
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    return entry?.state === "done" ? (entry.value as T) : undefined;
  }

  duplicatesOf(key: string): number {
    return this.entries.get(key)?.duplicates ?? 0;
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  private save(): void {
    if (this.file) writeJsonAtomic(this.file, Object.fromEntries(this.entries));
  }
}
