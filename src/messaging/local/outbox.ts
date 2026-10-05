/**
 * In-process (and optionally file-backed) SMS outbox for the local loopback
 * provider. Each outbound send is one bubble, in send order. Never concatenated.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../../storage/atomicWrite";

export interface LocalOutboxBubble {
  id: string;
  /** Visitor number the text was sent to (E.164). */
  to: string;
  /** Property line it was sent from (E.164). */
  from: string;
  body: string;
  sentAt: string;
  audience: "PROSPECT" | "OPERATOR";
}

interface StoredOutbox {
  schemaVersion: 1;
  bubbles: LocalOutboxBubble[];
}

export class LocalSmsOutbox {
  private bubbles: LocalOutboxBubble[] = [];
  private seq = 0;

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try {
        const stored = JSON.parse(readFileSync(file, "utf8")) as StoredOutbox;
        if (stored.schemaVersion === 1 && Array.isArray(stored.bubbles)) this.bubbles = stored.bubbles;
      } catch {
        this.bubbles = [];
      }
    }
  }

  push(bubble: Omit<LocalOutboxBubble, "id"> & { id?: string }): LocalOutboxBubble {
    const recorded: LocalOutboxBubble = { ...bubble, id: bubble.id ?? `local_out_${++this.seq}` };
    this.bubbles.push(recorded);
    this.save();
    return recorded;
  }

  /** Prospect replies for one visitor number, oldest first. */
  forVisitor(phone: string): LocalOutboxBubble[] {
    return this.bubbles.filter((b) => b.audience === "PROSPECT" && b.to === phone);
  }

  all(): LocalOutboxBubble[] {
    return [...this.bubbles];
  }

  clear(): void {
    this.bubbles = [];
    this.seq = 0;
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    writeJsonAtomic(this.file, { schemaVersion: 1, bubbles: this.bubbles } satisfies StoredOutbox);
  }
}

let shared: LocalSmsOutbox | undefined;

/** Process-wide outbox so send() and the operator tools share one list. */
export function localSmsOutbox(): LocalSmsOutbox {
  return (shared ??= new LocalSmsOutbox());
}

/** Tests replace or reset the shared outbox. */
export function resetLocalSmsOutbox(next?: LocalSmsOutbox): () => void {
  const previous = shared;
  shared = next ?? new LocalSmsOutbox();
  return () => {
    shared = previous;
  };
}
