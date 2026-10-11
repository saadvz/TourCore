import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../storage/atomicWrite";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const Instant = z.iso.datetime();
const TurnSchema = z.strictObject({
  tenantId: Id, id: Id, version: z.number().int().positive(), recipient: z.string().min(1).max(100),
  timeZone: z.string().refine((zone) => { try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; } }),
  windowStart: Instant, windowEnd: Instant, nextArrival: Instant,
  minimumMinutes: z.number().int().positive().max(1440), confirmedStart: Instant.optional(),
}).refine((t) => Date.parse(t.windowStart) < Date.parse(t.windowEnd) && Date.parse(t.windowEnd) <= Date.parse(t.nextArrival), "Invalid cleaning window");
export type PrototypeTurn = z.infer<typeof TurnSchema>;
const AuditSchema = z.strictObject({ at: Instant, type: z.string(), actor: z.string() });
const ReplySchema = z.strictObject({
  key: z.string(), text: z.string(), recipient: z.string(), turnVersion: z.number().int().positive().optional(), source: z.enum(["agent", "fallback"]),
  status: z.enum(["pending", "sending", "sent", "review_required"]),
  attempts: z.number().int().nonnegative(), nextAttemptAt: z.number(), receipt: z.string().optional(),
});
const WorkSchema = z.strictObject({
  id: Id, tenantId: Id, providerEventId: z.string().min(1).max(200), turnId: Id,
  requestedStart: Instant, receivedAt: Instant, deadlineAt: z.number(),
  status: z.enum(["pending", "leased", "reply_pending", "completed", "review_required"]),
  lease: z.strictObject({ owner: Id, token: z.string(), expiresAt: z.number() }).optional(),
  decision: z.strictObject({ actionKey: Id, fingerprint: z.string(), start: Instant }).optional(),
  reply: ReplySchema.optional(), audit: z.array(AuditSchema),
});
type Work = z.infer<typeof WorkSchema>;
const StateSchema = z.strictObject({ schemaVersion: z.literal(1), turns: z.array(TurnSchema), work: z.array(WorkSchema) });
type State = z.infer<typeof StateSchema>;
export interface AgentIdentity { tenantId: string; agentId: string }
export interface ReplySink {
  /** True only when repeated sends with the same key produce the same receipt without another delivery. */
  idempotent: boolean;
  send(reply: { key: string; tenantId: string; recipient: string; text: string }): Promise<{ receipt: string }>;
}
export class DelegationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Single-writer local prototype; one atomic snapshot holds decision, turn update, outbox, and audit. */
export class DelegationPrototype {
  private readonly path: string;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  constructor(readonly root: string, private readonly sink: ReplySink, private readonly options: {
    now?: () => number; deadlineMs?: number; leaseMs?: number; retryMs?: number; maxSendAttempts?: number; sendTimeoutMs?: number;
  } = {}) {
    this.path = join(root, "delegation.json");
    this.now = options.now ?? Date.now;
    for (const n of [options.deadlineMs ?? 120_000, options.leaseMs ?? 60_000, options.retryMs ?? 1000, options.maxSendAttempts ?? 3, options.sendTimeoutMs ?? 10_000]) {
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Prototype limits must be positive integers.");
    }
    this.read(); // Corrupt records are a blocker, never an empty queue.
  }
  private read(): State {
    return existsSync(this.path) ? StateSchema.parse(JSON.parse(readFileSync(this.path, "utf8"))) : { schemaVersion: 1, turns: [], work: [] };
  }
  private save(state: State): void { writeJsonAtomic(this.path, StateSchema.parse(state)); }
  private exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.serial.then(fn);
    this.serial = run.catch(() => {});
    return run;
  }
  private audit(work: Work, type: string, actor: string): void {
    work.audit.push({ at: new Date(this.now()).toISOString(), type, actor });
  }
  private find(state: State, identity: AgentIdentity, id: string): Work {
    const work = state.work.find((w) => w.id === id && w.tenantId === identity.tenantId);
    if (!work) throw new DelegationError("NOT_FOUND", "No work item is available to this caller.");
    return work;
  }
  private turn(state: State, work: Work): PrototypeTurn {
    const turn = state.turns.find((t) => t.tenantId === work.tenantId && t.id === work.turnId);
    if (!turn) throw new DelegationError("TURN_MISSING", "The authoritative cleaning turn is unavailable.");
    return turn;
  }
  private view(state: State, work: Work) {
    const { recipient: _recipient, tenantId: _tenantId, ...turn } = this.turn(state, work);
    return { id: work.id, eventType: "cleaner.reschedule_requested", requestedStart: work.requestedStart,
      receivedAt: work.receivedAt, deadlineAt: new Date(work.deadlineAt).toISOString(), status: work.status, turn,
      ...(work.reply ? { decisionSource: work.reply.source, deliveryStatus: work.reply.status } : {}) };
  }
  private expire(state: State): boolean {
    let changed = false;
    for (const work of state.work) {
      if ((work.status === "pending" || work.status === "leased") && this.now() >= work.deadlineAt) {
        work.lease = undefined;
        work.status = "reply_pending";
        work.reply = { key: `reply_${work.id}`, recipient: this.turn(state, work).recipient, source: "fallback", status: "pending", attempts: 0, nextAttemptAt: this.now(),
          text: "Your cleaning time change is awaiting host review. Your existing time is unchanged. Entry still requires host clearance." };
        this.audit(work, "deadline_fallback_selected", "engine");
        changed = true;
      } else if (work.status === "leased" && work.lease && this.now() >= work.lease.expiresAt) {
        work.lease = undefined;
        work.status = "pending";
        this.audit(work, "lease_expired", "engine");
        changed = true;
      }
    }
    return changed;
  }
  private refreshed(): State {
    const state = this.read();
    if (this.expire(state)) this.save(state);
    return state;
  }
  /** Trusted fixture/booking adapter only. No agent tool can create or rewrite turns. */
  saveTurn(input: PrototypeTurn): Promise<void> {
    return this.exclusive(() => {
      const turn = TurnSchema.parse(input);
      const state = this.read();
      const at = state.turns.findIndex((t) => t.tenantId === turn.tenantId && t.id === turn.id);
      if (at >= 0) {
        if (turn.version <= state.turns[at]!.version) throw new DelegationError("VERSION_CONFLICT", "Booking versions must increase.");
        state.turns[at] = turn;
      } else state.turns.push(turn);
      this.save(state);
    });
  }
  /** Trusted inbound adapter: persist before acknowledging. Repeated source IDs return the same work. */
  receive(input: { tenantId: string; providerEventId: string; turnId: string; requestedStart: string }): Promise<string> {
    return this.exclusive(() => {
      const parsed = z.strictObject({ tenantId: Id, providerEventId: z.string().min(1).max(200), turnId: Id, requestedStart: Instant }).parse(input);
      const state = this.read();
      const id = `work_${createHash("sha256").update(JSON.stringify([parsed.tenantId, parsed.providerEventId])).digest("hex").slice(0, 32)}`;
      const existing = state.work.find((w) => w.id === id);
      if (existing) {
        if (existing.turnId !== parsed.turnId || existing.requestedStart !== parsed.requestedStart) throw new DelegationError("SOURCE_CONFLICT", "A repeated source event changed its contents.");
        return id;
      }
      const work: Work = { ...parsed, id, receivedAt: new Date(this.now()).toISOString(), deadlineAt: this.now() + (this.options.deadlineMs ?? 120_000), status: "pending", audit: [] };
      this.turn(state, work);
      this.audit(work, "received", "inbound_adapter");
      state.work.push(work);
      this.save(state);
      return id;
    });
  }
  list(identity: AgentIdentity) {
    return this.exclusive(() => {
      const state = this.refreshed();
      return state.work.filter((w) => w.tenantId === identity.tenantId && (w.status === "pending" || w.status === "leased")).map((w) => this.view(state, w));
    });
  }
  get(identity: AgentIdentity, id: string) {
    return this.exclusive(() => { const state = this.refreshed(); return this.view(state, this.find(state, identity, id)); });
  }
  /** Operator evidence only; no lease token or credential is included. */
  evidence(identity: AgentIdentity, id: string) {
    return this.exclusive(() => {
      const state = this.refreshed();
      const work = this.find(state, identity, id);
      return { work: this.view(state, work), audit: work.audit };
    });
  }
  claim(identity: AgentIdentity, id: string) {
    return this.exclusive(() => {
      const state = this.refreshed();
      const work = this.find(state, identity, id);
      if (work.status === "leased" && work.lease?.owner !== identity.agentId) throw new DelegationError("LEASE_BUSY", "Another agent owns this lease.");
      if (work.status !== "pending" && work.status !== "leased") throw new DelegationError("CLOSED", "This request no longer accepts agent work.");
      if (!work.lease) {
        work.lease = { owner: identity.agentId, token: randomUUID(), expiresAt: Math.min(work.deadlineAt, this.now() + (this.options.leaseMs ?? 60_000)) };
        work.status = "leased";
        this.audit(work, "claimed", identity.agentId);
        this.save(state);
      }
      return { ...this.view(state, work), leaseToken: work.lease!.token, leaseExpiresAt: new Date(work.lease!.expiresAt).toISOString() };
    });
  }
  propose(identity: AgentIdentity, input: { id: string; leaseToken: string; actionKey: string; expectedTurnVersion: number; start: string }) {
    return this.exclusive(() => {
      const parsed = z.strictObject({ id: Id, leaseToken: z.string().min(1), actionKey: Id, expectedTurnVersion: z.number().int().positive(), start: Instant }).parse(input);
      const state = this.refreshed();
      const work = this.find(state, identity, parsed.id);
      const fingerprint = createHash("sha256").update(JSON.stringify([identity.agentId, parsed.expectedTurnVersion, parsed.start, parsed.leaseToken])).digest("hex");
      if (work.decision?.actionKey === parsed.actionKey) {
        if (work.decision.fingerprint !== fingerprint) throw new DelegationError("ACTION_CONFLICT", "This action key already describes a different proposal.");
        return { accepted: true, completed: work.status === "completed", deliveryStatus: work.reply!.status };
      }
      if (work.status !== "leased" || work.lease?.owner !== identity.agentId || work.lease.token !== parsed.leaseToken) throw new DelegationError("LEASE_INVALID", "Claim current work before proposing an action.");
      const turn = this.turn(state, work);
      if (turn.version !== parsed.expectedTurnVersion) throw new DelegationError("VERSION_CONFLICT", "The booking changed. Read current work and validate a new proposal.");
      const start = Date.parse(parsed.start);
      const end = start + turn.minimumMinutes * 60_000;
      if (start < Date.parse(turn.windowStart) || start <= this.now() || end > Date.parse(turn.windowEnd) || end > Date.parse(turn.nextArrival)) {
        throw new DelegationError("SLOT_INVALID", "The proposal does not fit the current cleaning window and next arrival.");
      }
      const label = new Intl.DateTimeFormat("en-US", { timeZone: turn.timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(start));
      turn.confirmedStart = parsed.start;
      turn.version++;
      work.decision = { actionKey: parsed.actionKey, fingerprint, start: parsed.start };
      work.lease = undefined;
      work.status = "reply_pending";
      work.reply = { key: `reply_${work.id}`, recipient: turn.recipient, turnVersion: turn.version, source: "agent", status: "pending", attempts: 0, nextAttemptAt: this.now(),
        text: `Cleaning scheduled for ${label} (${turn.timeZone}). Entry requires host clearance.` };
      this.audit(work, "validated_action_and_reply_saved", identity.agentId);
      this.save(state); // Authoritative change and reply are committed together, before any send.
      return { accepted: true, completed: false, deliveryStatus: work.reply.status };
    });
  }
  /** Worker runs independently of agent calls, including after restart. */
  tick(): Promise<void> {
    return this.exclusive(async () => {
      const state = this.refreshed();
      for (const work of state.work) {
        const reply = work.reply;
        if (work.status !== "reply_pending" || !reply || reply.nextAttemptAt > this.now()) continue;
        if (reply.source === "agent" && reply.attempts === 0 && this.turn(state, work).version !== reply.turnVersion) {
          reply.status = "review_required"; work.status = "review_required";
          this.audit(work, "booking_changed_before_delivery", "engine"); this.save(state); continue;
        }
        if (reply.status === "sending" && !this.sink.idempotent) {
          reply.status = "review_required"; work.status = "review_required";
          this.audit(work, "ambiguous_delivery_requires_review", "engine"); this.save(state); continue;
        }
        if (reply.status !== "pending" && reply.status !== "sending") continue;
        if (reply.attempts >= (this.options.maxSendAttempts ?? 3)) {
          reply.status = "review_required"; work.status = "review_required";
          this.audit(work, "delivery_attempts_exhausted", "engine"); this.save(state); continue;
        }
        reply.status = "sending"; reply.attempts++;
        this.audit(work, "send_attempt", "engine"); this.save(state);
        let receipt: string;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          ({ receipt } = await Promise.race([
            this.sink.send({ key: reply.key, tenantId: work.tenantId, recipient: reply.recipient, text: reply.text }),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Delivery timeout")), this.options.sendTimeoutMs ?? 10_000); }),
          ]));
          if (typeof receipt !== "string" || !receipt) throw new Error("Missing delivery receipt");
        } catch {
          reply.status = this.sink.idempotent ? "pending" : "review_required";
          work.status = this.sink.idempotent ? "reply_pending" : "review_required";
          reply.nextAttemptAt = this.now() + (this.options.retryMs ?? 1000) * 2 ** (reply.attempts - 1);
          this.audit(work, this.sink.idempotent ? "send_failed_retry_scheduled" : "ambiguous_delivery_requires_review", "engine");
          this.save(state); continue;
        } finally {
          if (timer) clearTimeout(timer);
        }
        reply.receipt = receipt; reply.status = "sent"; work.status = "completed";
        this.audit(work, "delivery_acknowledged_and_completed", "engine"); this.save(state);
      }
    });
  }
}

/** A durable simulated provider. No networking, no real phone number or credentials. */
export class LocalReplySink implements ReplySink {
  readonly idempotent = true;
  constructor(readonly path: string) {}
  replies(): Array<{ key: string; tenantId: string; recipient: string; text: string; receipt: string }> {
    if (!existsSync(this.path)) return [];
    return z.array(z.strictObject({ key: z.string(), tenantId: Id, recipient: z.string(), text: z.string(), receipt: z.string() })).parse(JSON.parse(readFileSync(this.path, "utf8")));
  }
  async send(input: { key: string; tenantId: string; recipient: string; text: string }) {
    const all = this.replies();
    const previous = all.find((r) => r.key === input.key);
    if (previous) {
      if (previous.text !== input.text || previous.recipient !== input.recipient || previous.tenantId !== input.tenantId) throw new Error("Provider idempotency conflict");
      return { receipt: previous.receipt };
    }
    const reply = { ...input, receipt: `local_${randomUUID()}` };
    all.push(reply); writeJsonAtomic(this.path, all);
    return { receipt: reply.receipt };
  }
}
