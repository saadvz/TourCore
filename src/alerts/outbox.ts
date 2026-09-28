import type { RuntimeStore } from "../storage/runtimeStore";
import { DeliveryError, type OperatorEvent, type OperatorNotificationSink } from "./operatorEvents";

/**
 * A durable outbox for operator events. An event is saved before any
 * delivery is attempted, keyed by its stable eventId, so:
 *  - the same exception is never queued twice (no duplicate alerts);
 *  - a failed delivery stays pending and is retried with bounded backoff;
 *  - pending events survive a restart and are retried by the next process.
 * Delivery happens after the visitor has been answered and never affects the
 * visitor's conversation.
 */

export interface OutboxRecord {
  schemaVersion: 1;
  event: OperatorEvent;
  /** suppressed: known before alerts were set up, recorded so it's never announced late. */
  status: "pending" | "delivered" | "failed" | "suppressed";
  attempts: number;
  createdAt: string;
  nextAttemptAt: string;
  lastAttemptAt?: string;
  deliveredAt?: string;
  /** Plain language, never an address or key. */
  lastError?: string;
}

export interface OutboxOptions {
  now?: () => number;
  /** After this many failed attempts the event is marked failed and no longer retried. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Checked just before delivery; false marks the event suppressed (e.g. the exception was already handled). */
  stillRelevant?: (event: OperatorEvent) => Promise<boolean>;
  log?: (line: string) => void;
}

export class OperatorEventOutbox {
  private running?: Promise<DrainResult>;
  private again = false;

  constructor(
    private readonly store: RuntimeStore,
    private readonly sink: () => OperatorNotificationSink,
    private readonly options: OutboxOptions = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get(eventId: string): OutboxRecord | undefined {
    return this.store.get<OutboxRecord>("operator-events", eventId);
  }

  /** Saves the event once. Re-queuing the same eventId returns the existing record unchanged. */
  enqueue(event: OperatorEvent, options: { suppress?: boolean } = {}): { record: OutboxRecord; created: boolean } {
    const existing = this.get(event.eventId);
    if (existing) return { record: existing, created: false };
    const at = new Date(this.now()).toISOString();
    const record: OutboxRecord = { schemaVersion: 1, event, status: options.suppress ? "suppressed" : "pending", attempts: 0, createdAt: at, nextAttemptAt: at };
    this.store.put("operator-events", event.eventId, record);
    return { record, created: true };
  }

  records(): OutboxRecord[] {
    return this.store.list<OutboxRecord>("operator-events").entries.map((e) => e.value);
  }

  /** Delivers everything that's due. Concurrent calls share one pass (plus one follow-up pass), so nothing is sent twice at once. */
  drain(): Promise<DrainResult> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let result: DrainResult;
      do {
        this.again = false;
        result = await this.pass();
      } while (this.again);
      return result;
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass(): Promise<DrainResult> {
    const result: DrainResult = { delivered: 0, failed: 0, waiting: 0 };
    const sink = this.sink();
    const due = this.records()
      .filter((r) => r.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const record of due) {
      if (!sink.configured()) {
        result.waiting++;
        continue;
      }
      if (Date.parse(record.nextAttemptAt) > this.now()) {
        result.waiting++;
        continue;
      }
      const attemptAt = new Date(this.now()).toISOString();
      const relevant = await (this.options.stillRelevant?.(record.event) ?? Promise.resolve(true)).catch(() => true);
      if (!relevant) {
        this.store.put("operator-events", record.event.eventId, { ...record, status: "suppressed", lastAttemptAt: attemptAt } satisfies OutboxRecord);
        continue;
      }
      try {
        await sink.deliver(record.event);
        this.store.put("operator-events", record.event.eventId, { ...record, status: "delivered", attempts: record.attempts + 1, lastAttemptAt: attemptAt, deliveredAt: attemptAt, lastError: undefined } satisfies OutboxRecord);
        result.delivered++;
      } catch (err) {
        const attempts = record.attempts + 1;
        const retryable = !(err instanceof DeliveryError) || err.retryable;
        const giveUp = !retryable || attempts >= (this.options.maxAttempts ?? 20);
        const message = err instanceof DeliveryError ? err.message : "The alert couldn't be delivered.";
        this.store.put("operator-events", record.event.eventId, {
          ...record,
          status: giveUp ? "failed" : "pending",
          attempts,
          lastAttemptAt: attemptAt,
          nextAttemptAt: new Date(this.now() + this.delay(attempts)).toISOString(),
          lastError: message,
        } satisfies OutboxRecord);
        result.failed++;
        this.options.log?.(`An operator alert couldn't be delivered (attempt ${attempts}${giveUp ? ", giving up" : ""}): ${message}`);
      }
    }
    return result;
  }

  private delay(attempts: number): number {
    const base = this.options.baseDelayMs ?? 5_000;
    return Math.min(base * 2 ** Math.max(0, attempts - 1), this.options.maxDelayMs ?? 15 * 60_000);
  }

  /** For installation status. No payload details beyond counts and the last plain error. */
  health(): { pending: number; retrying: number; failed: number; delivered: number; lastError?: string; lastDeliveredAt?: string } {
    const all = this.records();
    const delivered = all.filter((r) => r.status === "delivered");
    const retrying = all.filter((r) => r.status === "pending" && r.attempts > 0);
    const latestProblem = [...all].filter((r) => r.lastError && r.status !== "delivered").sort((a, b) => (b.lastAttemptAt ?? "").localeCompare(a.lastAttemptAt ?? ""))[0];
    const lastDelivered = delivered.map((r) => r.deliveredAt!).sort().at(-1);
    return {
      pending: all.filter((r) => r.status === "pending").length,
      retrying: retrying.length,
      failed: all.filter((r) => r.status === "failed").length,
      delivered: delivered.length,
      ...(latestProblem?.lastError ? { lastError: latestProblem.lastError } : {}),
      ...(lastDelivered ? { lastDeliveredAt: lastDelivered } : {}),
    };
  }
}

export interface DrainResult {
  delivered: number;
  failed: number;
  waiting: number;
}
