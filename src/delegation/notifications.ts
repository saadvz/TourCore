import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { type AgentIdentity, type DelegationPrototype } from "./prototype";
import { grokWorkEvent } from "../agents/grok";

const Notification = z.strictObject({
  workId: z.string().regex(/^work_[a-f0-9]{32}$/), deadlineAt: z.iso.datetime(),
  status: z.enum(["pending", "sending", "accepted", "failed", "cancelled"]),
  attempts: z.number().int().nonnegative(), nextAttemptAt: z.number(), queuedAt: z.iso.datetime(),
  attemptedAt: z.iso.datetime().optional(), acceptedAt: z.iso.datetime().optional(),
  lastHttpStatus: z.number().int().min(100).max(599).optional(), failure: z.enum(["http", "network", "attempts_exhausted", "work_closed"]).optional(),
});
const Ledger = z.strictObject({ schemaVersion: z.literal(1), events: z.array(Notification) });
type LedgerState = z.infer<typeof Ledger>;
export interface WebhookSettings { url: string; authorization: string }
export type FetchWebhook = (url: string, init: RequestInit) => Promise<Pick<Response, "status" | "body">>;

/** Durable, bounded wakeups. HTTP acceptance never means agent completion. */
export class DelegationNotifications {
  private readonly path: string;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  constructor(root: string, private readonly engine: DelegationPrototype, private readonly identity: AgentIdentity,
    private readonly settings: WebhookSettings, private readonly options: {
      now?: () => number; fetch?: FetchWebhook; timeoutMs?: number; retryMs?: number; maxAttempts?: number;
    } = {}) {
    this.path = join(root, "notifications.json");
    this.now = options.now ?? Date.now;
    const url = new URL(settings.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !settings.authorization || /[\r\n]/.test(settings.authorization)) throw new Error("Invalid webhook configuration.");
    for (const value of [options.timeoutMs ?? 5000, options.retryMs ?? 1000, options.maxAttempts ?? 3]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Notification limits must be positive integers.");
    }
    this.read(); // Damaged records fail closed; do not silently forget attempts.
  }
  private read(): LedgerState {
    return existsSync(this.path) ? Ledger.parse(JSON.parse(readFileSync(this.path, "utf8"))) : { schemaVersion: 1, events: [] };
  }
  private save(state: LedgerState) { writeJsonAtomic(this.path, Ledger.parse(state)); }
  private exclusive<T>(action: () => T | Promise<T>): Promise<T> {
    const next = this.serial.then(action); this.serial = next.catch(() => {}); return next;
  }
  status(id: string) {
    return this.exclusive(() => this.read().events.find((event) => event.workId === id) ?? { workId: id, status: "not_queued" });
  }
  tick(): Promise<void> {
    return this.exclusive(async () => {
      const state = this.read();
      // Reconcile durable inbound requests on every sweep. A crash between
      // receiving work and enqueuing its wakeup cannot permanently lose it.
      for (const work of await this.engine.list(this.identity)) {
        if (!state.events.some((event) => event.workId === work.id)) {
          state.events.push({ workId: work.id, deadlineAt: work.deadlineAt, status: "pending", attempts: 0, nextAttemptAt: this.now(), queuedAt: new Date(this.now()).toISOString() });
          this.save(state);
        }
      }
      for (const event of state.events) {
        if (event.status !== "pending" && event.status !== "sending") continue;
        const work = await this.engine.get(this.identity, event.workId);
        if ((work.status !== "pending" && work.status !== "leased") || this.now() >= Date.parse(event.deadlineAt)) {
          event.status = "cancelled"; event.failure = "work_closed"; this.save(state); continue;
        }
        if (event.nextAttemptAt > this.now()) continue;
        if (event.attempts >= (this.options.maxAttempts ?? 3)) {
          event.status = "failed"; event.failure = "attempts_exhausted"; this.save(state); continue;
        }
        event.status = "sending"; event.attempts++; event.attemptedAt = new Date(this.now()).toISOString();
        delete event.lastHttpStatus; delete event.failure;
        this.save(state); // Record the attempt before any network operation.
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let httpStatus: number | undefined;
        try {
          const response = await Promise.race([
            (this.options.fetch ?? fetch)(this.settings.url, {
              method: "POST", redirect: "error", signal: controller.signal,
              headers: { Authorization: this.settings.authorization, "Content-Type": "application/json" },
              body: JSON.stringify(grokWorkEvent({ id: event.workId, deadlineAt: event.deadlineAt })),
            }),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Notification timeout")); }, this.options.timeoutMs ?? 5000); }),
          ]);
          httpStatus = response.status;
          // Do not save response bodies: they are unnecessary to prove
          // transport acceptance and can contain private platform information.
          void response.body?.cancel().catch(() => {});
        } catch { event.failure = "network"; }
        finally { if (timer) clearTimeout(timer); }
        if (httpStatus !== undefined) event.lastHttpStatus = httpStatus;
        if (httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300) {
          event.status = "accepted"; event.acceptedAt = new Date(this.now()).toISOString();
        } else {
          if (httpStatus !== undefined) event.failure = "http";
          const retryable = httpStatus === undefined || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
          event.status = retryable && event.attempts < (this.options.maxAttempts ?? 3) ? "pending" : "failed";
          event.nextAttemptAt = this.now() + (this.options.retryMs ?? 1000) * 2 ** (event.attempts - 1);
        }
        this.save(state);
      }
    });
  }
}
