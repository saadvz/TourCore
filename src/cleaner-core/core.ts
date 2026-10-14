import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMedicalEmergency, isPlainLanguageStop, keywordOf } from "../intent";
import { normalize, stripFiller } from "../intent/normalize";
import { spokenTimes } from "../core/spokenTime";
import { parsePhone } from "../core/phone";
import { smsStopAck } from "../visitor/smsConsent";
import { VisitorDenialCopy } from "../core/TourCore";
import { writeFileAtomic } from "../storage/atomicWrite";
import { addCalendarDays, formatWhen, interpretFeed, zonedInstant, type FeedBlock, type Turnover } from "./calendar";
import { isScratchTestNumber } from "./scratch";
import { normalizeSnapshots, type BookingSource, type BookingSourceKind, type SourceConflict, type SourceSnapshot } from "./sources";
import { isOtherScratchTenantPhone, SCRATCH_TENANTS } from "./tenants";

export type TextKind =
  | "host-checkout"
  | "host-checkin"
  | "offer"
  | "corrected"
  | "cancel-update"
  | "reminder"
  | "confirm"
  | "declined"
  | "stop"
  | "help"
  | "start"
  | "emergency"
  | "opt-in"
  | "pin"
  | "pin-notice"
  | "pin-failed"
  | "pin-held"
  | "started"
  | "done";

export interface CleanerText {
  to: string;
  body: string;
  kind: TextKind;
}

export type JobStatus =
  | "discovered"
  | "awaiting_checkin"
  | "host_confirmed"
  | "offered"
  | "confirmed"
  | "awaiting_departure"
  | "cleared"
  | "in_progress"
  | "done"
  | "declined"
  | "canceled";

export interface JobView {
  id: string;
  departingUid: string;
  arrivingUid: string | null;
  status: JobStatus;
  live: boolean;
  textsBlocked: boolean;
  checkoutDate: string;
  nextCheckInDate: string | null;
  sameDay: boolean;
  checkoutTime: string | null;
  nextCheckInTime: string | null;
  checkoutAt: string | null;
  nextCheckInAt: string | null;
  version: number;
  hostCheckoutVersion: number;
  hostCheckInVersion: number;
  asking: "checkout" | "checkin" | null;
}

export interface OutboxView {
  id: string;
  to: string;
  body: string;
  kind: TextKind;
  status: "sent" | "failed" | "canceled";
  jobId?: string;
}

export interface PollResult {
  polled: boolean;
  reason: "disabled" | "scratch-only" | "not-consented" | "read" | "wrong-tenant";
  sent: CleanerText[];
  jobs: JobView[];
  blocks: FeedBlock[];
}

export interface SyncState {
  reason: PollResult["reason"];
  conversation: "closed" | "open";
  sources: BookingSourceKind[];
  conflicts: SourceConflict[];
}

export type ReceiveReason =
  | "disabled"
  | "duplicate"
  | "help"
  | "emergency"
  | "stop"
  | "start"
  | "scheduled"
  | "declined"
  | "ignored"
  | "scratch-only"
  | "host-time"
  | "departure"
  | "opted-in"
  | "done"
  | "wrong-tenant";

export interface ReceiveResult {
  handled: boolean;
  reason: ReceiveReason;
  sent: CleanerText[];
}

export interface ReminderResult {
  sent: CleanerText[];
  failed: string[];
}

export interface CleanerSink {
  send(text: CleanerText): void | Promise<void>;
}

export interface ReminderTrigger {
  id: string;
  kind: "morning-of" | "days-before-checkout";
  localTime: string;
  days?: number;
}

export interface CleanerCoreOptions {
  enabled: boolean;
  property: { id: string; address: string; timeZone: string; defaultCheckout?: string; defaultCheckIn?: string };
  /** Host who confirms times and receives the schedule text. */
  ownerPhone: string;
  /** Approved cleaner. The door code is a private text to this number, and only after opt-in and departure. */
  cleaner: { phone: string; approved: boolean };
  /** Standing door code. Absent means this engine never texts one. */
  pin?: string;
  /** Name in the cleaner opt-in text. */
  hostName?: string;
  /** Numbers that share a group thread. They never receive the door code. */
  groupPhones?: string[];
  /** Landlord already approved texting this owner. A phone number alone is not consent. */
  consented?: boolean;
  sink: CleanerSink;
  now?: () => Date;
  triggers?: ReminderTrigger[];
  /** When set, jobs and the outbox reload after a process restart. */
  dataDir?: string;
  /** Scratch tenant id. Other Scratch tenants' phones are ignored and never texted. */
  tenantId?: string;
}

export interface CleanerCore {
  pollFeed(ical: string, options?: { conversation?: "closed" | "open" }): Promise<PollResult>;
  readSource(source: BookingSource, options?: { conversation?: "closed" | "open" }): Promise<PollResult & SyncState>;
  receive(input: { id: string; from: string; text: string }): Promise<ReceiveResult>;
  runReminders(): Promise<ReminderResult>;
  jobs(): JobView[];
  outbox(): OutboxView[];
  transcript(): string[];
  blocks(): FeedBlock[];
  lastSync(): SyncState;
}

const HELP_ACK = "Need help with this cleaning? Reply here and the host will see it. Reply STOP to opt out.";
const START_ACK = "You're opted back in. Reply YES if you still want this turnover. Reply STOP to opt out.";
const DECLINED = "Okay, that turnover is not scheduled.";
const EMERGENCY = VisitorDenialCopy.medicalAlert("property team", undefined, false);
const CLEANER_HURT = "If someone is hurt, call 911 now. I've let the host know.";
const CLEANER_HURT_MISSED = "If someone is hurt, call 911 now. I couldn't reach the host, so please call them too.";
const SAFETY = new Set<TextKind>(["stop", "help", "start", "emergency"]);
const DEFAULT_TRIGGERS: ReminderTrigger[] = [{ id: "morning-of", kind: "morning-of", localTime: "08:00" }];

/**
 * Usage:
 *   const core = openCleanerCore({ enabled: cleanerCoreEnabled(env), property, ownerPhone, cleaner, consented: true, sink, now, dataDir });
 *   await core.pollFeed(icalText);
 *   await core.receive({ id, from: ownerPhone, text: "YES" });
 * With a pin, the opted-in cleaner receives the offer, the scheduled confirmation, and the reminder.
 * That cleaner's YES confirms the job. The host's YES confirms times, not the offer.
 *   await core.runReminders();
 * Flag off returns reason "disabled" and sends nothing. With no pin, no door code is sent.
 * With a pin, the approved cleaner must opt in and the host must confirm departure first.
 */
export function openCleanerCore(options: CleanerCoreOptions): CleanerCore {
  return new Engine(options);
}

interface Announced {
  checkoutDate: string;
  checkoutMinutes: number;
  nextCheckInDate: string | null;
  checkInMinutes: number | null;
}

interface Job {
  id: string;
  departingUid: string;
  arrivingUid: string | null;
  checkoutDate: string;
  nextCheckInDate: string | null;
  sameDay: boolean;
  version: number;
  sourceSequence: number;
  contentHash: string;
  canceled: boolean;
  declined: boolean;
  announced: Announced | null;
  started: boolean;
  done: boolean;
}

interface Clearance {
  jobId: string;
  checkoutDate: string;
  minutes: number;
  hostVersion: number;
}

interface PinSeal {
  iv: string;
  tag: string;
  data: string;
}

interface HostFact {
  jobId: string;
  field: "checkout" | "checkin";
  version: number;
  minutes: number;
}

interface Tombstone {
  uid: string;
  version: number;
  contentHash: string;
}

interface OutboxItem {
  id: string;
  to: string;
  body: string;
  kind: TextKind;
  status: "sent" | "failed" | "canceled";
  jobId?: string;
}

interface Stored {
  schemaVersion: 1;
  tenantId?: string;
  jobs: Job[];
  hostFacts: HostFact[];
  tombstones: Tombstone[];
  outbox: OutboxItem[];
  inboundIds: string[];
  transcript: string[];
  optedOut: boolean;
  injurySent: string[];
  blocks: FeedBlock[];
  cleanerConsent?: "pending" | "in" | "out";
  clearances?: Clearance[];
  pinSeal?: PinSeal;
}

/** One file can hold several tenants. A single-tenant file stays the flat step D shape. */
interface StoreFile {
  schemaVersion: 1;
  tenantId?: string;
  tenants?: Record<string, Stored>;
  jobs?: Job[];
  hostFacts?: HostFact[];
  tombstones?: Tombstone[];
  outbox?: OutboxItem[];
  inboundIds?: string[];
  transcript?: string[];
  optedOut?: boolean;
  injurySent?: string[];
  blocks?: FeedBlock[];
  cleanerConsent?: "pending" | "in" | "out";
  clearances?: Clearance[];
  pinSeal?: PinSeal;
  pin?: unknown;
}

interface Draft {
  id: string;
  jobId?: string;
  to: string;
  body: string;
  kind: TextKind;
  afterSend?: () => void;
}

class Engine implements CleanerCore {
  private readonly enabled: boolean;
  private readonly owner: string | undefined;
  private readonly cleanerPhone: string | undefined;
  private pin: string | undefined;
  private readonly hostName: string;
  private readonly groupPhones: string[];
  private cleanerConsent: "pending" | "in" | "out" = "pending";
  private clearances: Clearance[] = [];
  private readonly triggers: ReminderTrigger[];
  private readonly defaultCheckout: number;
  private readonly defaultCheckIn: number;
  private jobsState: Job[] = [];
  private hostFacts: HostFact[] = [];
  private tombstones: Tombstone[] = [];
  private outboxState: OutboxItem[] = [];
  private inboundIds: string[] = [];
  private transcriptState: string[] = [];
  private optedOut = false;
  private readonly everConsented: boolean;
  private injurySent: string[] = [];
  private blockState: FeedBlock[] = [];
  private readonly now: () => Date;
  private readonly file: string | undefined;
  private readonly tenantId: string;
  private readonly latest = new Map<BookingSourceKind, SourceSnapshot>();
  private conflictState: SourceConflict[] = [];
  private syncState: SyncState = { reason: "read", conversation: "open", sources: [], conflicts: [] };

  constructor(private readonly options: CleanerCoreOptions) {
    this.enabled = options.enabled;
    this.owner = parsePhone(options.ownerPhone);
    this.cleanerPhone = parsePhone(options.cleaner.phone);
    const pin = options.pin?.trim();
    this.pin = pin && /^\d{4,8}$/.test(pin) ? pin : undefined;
    this.hostName = options.hostName?.trim() || "Scratch";
    this.groupPhones = (options.groupPhones ?? []).flatMap((phone) => {
      const parsed = parsePhone(phone);
      return parsed ? [parsed] : [];
    });
    this.triggers = options.triggers ?? DEFAULT_TRIGGERS;
    this.defaultCheckout = minutesOf(options.property.defaultCheckout ?? "11:00");
    this.defaultCheckIn = minutesOf(options.property.defaultCheckIn ?? "16:00");
    this.everConsented = options.consented === true;
    this.now = options.now ?? (() => new Date());
    this.file = options.dataDir ? join(options.dataDir, "cleaner-core.json") : undefined;
    this.tenantId = options.tenantId?.trim() || options.property.id;
    this.load();
  }

  async pollFeed(ical: string, options?: { conversation?: "closed" | "open" }): Promise<PollResult> {
    const conversation = options?.conversation ?? "open";
    const blocked = this.syncBlocked(conversation);
    if (blocked) return blocked;
    const feed = interpretFeed(ical);
    return this.applySnapshot({ kind: "guesty-lite", tenantId: this.tenantId, turnovers: feed.turnovers, blocks: feed.blocks }, conversation);
  }

  async readSource(source: BookingSource, options?: { conversation?: "closed" | "open" }): Promise<PollResult & SyncState> {
    const conversation = options?.conversation ?? "open";
    const blocked = this.syncBlocked(conversation);
    if (blocked) return this.withSync(blocked);
    const snapshot = await source.read();
    if (snapshot.kind !== source.kind) throw new Error("Booking source kind does not match the read.");
    if (snapshot.tenantId !== this.tenantId) {
      this.syncState = { reason: "wrong-tenant", conversation, sources: this.sourceNames(), conflicts: this.conflictState };
      return this.withSync({ polled: false, reason: "wrong-tenant", sent: [], jobs: this.jobs(), blocks: this.blocks() });
    }
    return this.withSync(await this.applySnapshot(snapshot, conversation));
  }

  async receive(input: { id: string; from: string; text: string }): Promise<ReceiveResult> {
    if (!this.enabled) return { handled: false, reason: "disabled", sent: [] };
    const from = parsePhone(input.from);
    if (!from || !isScratchTestNumber(from)) return { handled: true, reason: "scratch-only", sent: [] };
    if (this.inboundIds.includes(input.id)) return { handled: true, reason: "duplicate", sent: [] };
    this.transcriptState.push(this.redact(`${from}: ${input.text.trim()}`));
    if (isOtherScratchTenantPhone(this.tenantId, from)) {
      this.inboundIds.push(input.id);
      this.save();
      return { handled: true, reason: "wrong-tenant", sent: [] };
    }

    const keyword = keywordOf(input.text);
    if (keyword === "help") return this.safety(input.id, () => this.reply(from, HELP_ACK, "help", "help", input.id));
    if (isMedicalEmergency(input.text)) return this.safety(input.id, () => this.emergency(from, input.id));
    if (keyword === "stop" || isPlainLanguageStop(input.text)) return this.safety(input.id, () => this.stop(from, input.id));
    if (keyword === "start") return this.safety(input.id, () => this.start(from, input.id));
    if (this.pin && from === this.cleanerPhone && isYes(input.text) && this.awaitingOptIn()) return this.optInCleaner(input.id);
    if (this.pin && from === this.cleanerPhone && isDone(input.text)) return this.finish(from, input.id);
    if (this.pin && from === this.owner && isDeparture(input.text)) return this.clearDeparture(input.id);
    const moved = await this.moveCheckout(input.id, from, input.text);
    if (moved) return moved;
    if (this.optedOut || !this.everConsented) return this.markIgnored(input.id);

    const result = await this.answer(input.id, from, input.text);
    this.save();
    return result;
  }

  async runReminders(): Promise<ReminderResult> {
    if (!this.enabled || this.optedOut || !this.scratchReady()) return { sent: [], failed: [] };
    const sent: CleanerText[] = [];
    const failed: string[] = [];
    for (const job of this.ordered()) {
      if (!this.canRemind(job)) continue;
      const fact = this.latestFact(job.id, "checkout");
      if (!fact) continue;
      for (const trigger of this.triggers) {
        if (!this.triggerDue(trigger, job.checkoutDate)) continue;
        const id = `reminder:${job.id}:${trigger.id}:${job.checkoutDate}:${fact.version}:${fact.minutes}`;
        this.cancelOtherReminders(job.id, trigger.id, id);
        const existing = this.outboxState.find((item) => item.id === id);
        if (existing?.status === "sent" || existing?.status === "canceled") continue;
        const to = this.schedulePhone();
        if (!to) continue;
        const when = this.clock(job.checkoutDate, fact.minutes);
        const address = this.options.property.address;
        const text = await this.emit({
          id,
          jobId: job.id,
          to,
          kind: "reminder",
          body: this.pin
            ? `Reminder: cleaning at ${address} is ${when.day} at ${when.time}.`
            : `Reminder: checkout at ${address} is ${when.day} at ${when.time}. Reply STOP to opt out.`,
        });
        if (text) sent.push(text);
        else if (this.outboxState.find((item) => item.id === id)?.status === "failed") failed.push(id);
      }
    }
    if (this.pin) {
      for (const job of this.ordered()) {
        const key = this.pinKey(job);
        if (!key || this.delivery(key) === "sent" || this.delivery(key) === "canceled") continue;
        for (const text of await this.deliverPin(job)) sent.push(text);
      }
    }
    this.save();
    return { sent, failed };
  }

  jobs(): JobView[] {
    return this.ordered().map((job) => this.view(job));
  }

  outbox(): OutboxView[] {
    return this.outboxState.map((item) => ({
      id: item.id,
      to: item.to,
      body: item.body,
      kind: item.kind,
      status: item.status,
      ...(item.jobId ? { jobId: item.jobId } : {}),
    }));
  }

  transcript(): string[] {
    return [...this.transcriptState];
  }

  blocks(): FeedBlock[] {
    return this.blockState.map((block) => ({ ...block }));
  }

  lastSync(): SyncState {
    return {
      reason: this.syncState.reason,
      conversation: this.syncState.conversation,
      sources: [...this.syncState.sources],
      conflicts: this.syncState.conflicts.map((conflict) => ({ ...conflict })),
    };
  }

  private syncBlocked(conversation: "closed" | "open"): PollResult | undefined {
    if (!this.enabled) return this.noteSync({ polled: false, reason: "disabled", sent: [], jobs: [], blocks: [] }, conversation);
    if (!this.scratchReady()) return this.noteSync({ polled: false, reason: "scratch-only", sent: [], jobs: this.jobs(), blocks: [] }, conversation);
    if (!this.everConsented) return this.noteSync({ polled: false, reason: "not-consented", sent: [], jobs: [], blocks: [] }, conversation);
    return undefined;
  }

  private noteSync(result: PollResult, conversation: "closed" | "open"): PollResult {
    this.syncState = { reason: result.reason, conversation, sources: this.sourceNames(), conflicts: this.conflictState };
    return result;
  }

  private async applySnapshot(snapshot: SourceSnapshot, conversation: "closed" | "open"): Promise<PollResult> {
    this.latest.set(snapshot.kind, snapshot);
    const normalized = normalizeSnapshots([...this.latest.values()]);
    this.conflictState = normalized.conflicts;
    this.blockState = normalized.feed.blocks;
    this.reconcile(normalized.feed.turnovers);
    const sent = this.optedOut ? [] : await this.drainOne();
    if (!this.optedOut) {
      const optIn = await this.sendOptIn();
      if (optIn) sent.push(optIn);
    }
    this.save();
    const result: PollResult = { polled: true, reason: "read", sent, jobs: this.jobs(), blocks: this.blocks() };
    this.syncState = { reason: "read", conversation, sources: this.sourceNames(), conflicts: this.conflictState };
    return result;
  }

  private sourceNames(): BookingSourceKind[] {
    return (["guesty-lite", "google-calendar"] as const).filter((kind) => this.latest.has(kind));
  }

  private withSync(result: PollResult): PollResult & SyncState {
    return {
      ...result,
      conversation: this.syncState.conversation,
      sources: [...this.syncState.sources],
      conflicts: this.syncState.conflicts.map((conflict) => ({ ...conflict })),
    };
  }

  private async answer(id: string, from: string, text: string): Promise<ReceiveResult> {
    const job = this.conversationJob();
    if (!job) return this.markIgnored(id);
    const status = this.derive(job);
    const minutes = clockMinutes(text);
    if (status === "discovered" || status === "awaiting_checkin") {
      if (from !== this.owner) return this.markIgnored(id);
      const chosen = isYes(text) ? (status === "discovered" ? this.defaultCheckout : this.defaultCheckIn) : minutes;
      if (chosen === undefined) return this.markIgnored(id);
      this.addFact(job.id, status === "discovered" ? "checkout" : "checkin", chosen);
      this.inboundIds.push(id);
      const sent = await this.drainOne();
      return { handled: true, reason: "host-time", sent };
    }
    if (status === "offered") {
      if (from === this.owner && minutes !== undefined) {
        this.addFact(job.id, "checkout", minutes);
        this.inboundIds.push(id);
        const sent = await this.drainOne();
        return { handled: true, reason: "host-time", sent };
      }
      const confirmer = this.schedulePhone();
      if (!confirmer || from !== confirmer) return this.markIgnored(id);
      if (isYes(text)) {
        if (this.stale(job)) return this.markIgnored(id);
        const sent = await this.confirm(job);
        if (sent.length === 0 && !this.confirmSent(job)) return { handled: true, reason: "ignored", sent: [] };
        this.inboundIds.push(id);
        return { handled: true, reason: "scheduled", sent };
      }
      if (isNo(text)) {
        job.declined = true;
        this.inboundIds.push(id);
        return this.reply(confirmer, DECLINED, "declined", "declined", id, job.id);
      }
    }
    return this.markIgnored(id);
  }

  private async confirm(job: Job): Promise<CleanerText[]> {
    const checkout = this.latestFact(job.id, "checkout");
    const to = this.schedulePhone();
    if (!checkout || !to) return [];
    const when = this.clock(job.checkoutDate, checkout.minutes);
    const id = `confirm:${job.id}:${job.checkoutDate}:${checkout.minutes}:${job.nextCheckInDate ?? ""}`;
    const text = await this.emit({
      id,
      jobId: job.id,
      to,
      kind: "confirm",
      body: `Cleaning is scheduled for ${when.day} at ${when.time} at ${this.options.property.address}.`,
    });
    return text ? [text] : [];
  }

  /** Step C texts the host. Step D texts the opted-in approved cleaner, and waits while that YES is missing. */
  private schedulePhone(): string | undefined {
    if (!this.pin) return this.owner;
    if (!this.options.cleaner.approved || this.cleanerConsent !== "in" || !this.cleanerPhone) return undefined;
    return this.cleanerPhone;
  }

  private awaitingOptIn(): boolean {
    return Boolean(this.cleanerPhone && this.cleanerConsent === "pending" && this.delivery(`opt-in:${this.cleanerPhone}`) === "sent");
  }

  private async sendOptIn(): Promise<CleanerText | null> {
    if (!this.pin || !this.options.cleaner.approved || !this.cleanerPhone || this.cleanerConsent !== "pending") return null;
    const id = `opt-in:${this.cleanerPhone}`;
    if (this.delivery(id) === "sent") return null;
    return this.emit({
      id,
      to: this.cleanerPhone,
      kind: "opt-in",
      body: `Hi, this is ${this.hostName}'s cleaning scheduler for ${this.options.property.address}. Reply YES to get cleaning texts, or STOP to opt out.`,
    });
  }

  private async optInCleaner(id: string): Promise<ReceiveResult> {
    if (!this.cleanerPhone || this.delivery(`opt-in:${this.cleanerPhone}`) !== "sent" || this.cleanerConsent !== "pending") {
      return this.markIgnored(id);
    }
    this.cleanerConsent = "in";
    this.inboundIds.push(id);
    const sent = await this.drainOne();
    this.save();
    return { handled: true, reason: "opted-in", sent };
  }

  private async finish(from: string, id: string): Promise<ReceiveResult> {
    const job = this.ordered().find((item) => item.started && !item.done && this.pinDelivered(item));
    if (!job || this.cleanerConsent !== "in") return this.markIgnored(id);
    const result = await this.reply(from, "Thanks, cleaning marked done.", "done", "done", id, job.id);
    if (result.sent.length > 0) {
      job.done = true;
      this.inboundIds.push(id);
    }
    this.save();
    return result;
  }

  private async clearDeparture(id: string): Promise<ReceiveResult> {
    const job = this.releaseJob();
    if (!job || this.stale(job) || !this.confirmSent(job)) return this.markIgnored(id);
    this.recordClearance(job);
    this.inboundIds.push(id);
    const sent = await this.deliverPin(job);
    this.save();
    return { handled: true, reason: "departure", sent };
  }

  private async moveCheckout(id: string, from: string, text: string): Promise<ReceiveResult | undefined> {
    if (!this.pin || from !== this.owner) return undefined;
    const job = this.releaseJob();
    const minutes = clockMinutes(text);
    const checkout = job ? this.latestFact(job.id, "checkout") : undefined;
    if (!job || minutes === undefined || !checkout || minutes <= checkout.minutes) return undefined;
    this.addFact(job.id, "checkout", minutes);
    job.started = false;
    job.done = false;
    this.dropClearance(job.id);
    this.cancelUnsentPin(job.id);
    this.inboundIds.push(id);
    const sent = await this.drainOne();
    this.save();
    return { handled: true, reason: "host-time", sent };
  }

  private async deliverPin(job: Job): Promise<CleanerText[]> {
    if (!this.pin || !this.cleanerPhone || this.optedOut || this.stale(job) || job.canceled || job.declined) return [];
    const key = this.pinKey(job);
    if (!key) return [];
    const sent: CleanerText[] = [];
    if (!this.options.cleaner.approved || this.cleanerConsent !== "in") {
      if (this.cleanerConsent === "out" && this.options.cleaner.approved && this.owner && !this.groupPhones.includes(this.owner)) {
        const held = await this.emit({
          id: `pin-held:${key}`,
          jobId: job.id,
          to: this.owner,
          kind: "pin-held",
          body: "The cleaner opted out, so the door code wasn't sent. Please reach them directly.",
        });
        if (held) sent.push(held);
      }
      this.dropClearance(job.id);
      return sent;
    }
    if (this.delivery(key) !== "sent") {
      const text = await this.emit({
        id: key,
        jobId: job.id,
        to: this.cleanerPhone,
        kind: "pin",
        body: `Guests have left ${this.options.property.address}. Door code: ${this.pin}. This code is only for you.`,
      });
      if (text) sent.push(text);
    }
    if (this.delivery(key) === "failed" && this.owner && !this.groupPhones.includes(this.owner)) {
      const failed = await this.emit({
        id: `pin-failed:${key}`,
        jobId: job.id,
        to: this.owner,
        kind: "pin-failed",
        body: "The door code didn't reach the cleaner. We'll try again in a few minutes.",
      });
      if (failed) sent.push(failed);
    }
    if (this.delivery(key) === "sent" && this.owner && !this.groupPhones.includes(this.owner)) {
      const notice = await this.emit({
        id: `pin-notice:${key}`,
        jobId: job.id,
        to: this.owner,
        kind: "pin-notice",
        body: "Door code sent to the cleaner.",
      });
      if (notice) sent.push(notice);
    }
    return sent;
  }

  private reconcile(turnovers: Turnover[]): void {
    const seen = new Set<string>();
    for (const turnover of turnovers) {
      seen.add(turnover.id);
      const tomb = this.tombstones.find((item) => item.uid === turnover.id);
      const existing = this.jobsState.find((job) => job.id === turnover.id);
      if (!existing) {
        if (tomb && turnover.contentHash === tomb.contentHash) continue;
        this.jobsState.push({
          id: turnover.id,
          departingUid: turnover.departingUid,
          arrivingUid: turnover.arrivingUid,
          checkoutDate: turnover.checkoutDate,
          nextCheckInDate: turnover.nextCheckInDate,
          sameDay: turnover.sameDay,
          version: (tomb?.version ?? 0) + 1,
          sourceSequence: turnover.sequence,
          contentHash: turnover.contentHash,
          canceled: false,
          declined: false,
          announced: null,
          started: false,
          done: false,
        });
        continue;
      }
      if (existing.canceled && turnover.contentHash === existing.contentHash) continue;
      if (turnover.sequence < existing.sourceSequence) continue;
      if (turnover.contentHash === existing.contentHash && !existing.canceled) {
        existing.sourceSequence = Math.max(existing.sourceSequence, turnover.sequence);
        continue;
      }
      const checkoutDateChanged = existing.checkoutDate !== turnover.checkoutDate;
      const checkInDateChanged = existing.nextCheckInDate !== turnover.nextCheckInDate;
      existing.arrivingUid = turnover.arrivingUid;
      existing.checkoutDate = turnover.checkoutDate;
      existing.nextCheckInDate = turnover.nextCheckInDate;
      existing.sameDay = turnover.sameDay;
      existing.contentHash = turnover.contentHash;
      existing.sourceSequence = turnover.sequence;
      existing.version += 1;
      existing.canceled = false;
      if (checkoutDateChanged) {
        this.clearHostTime(existing.id, "checkout");
        this.dropClearance(existing.id);
        existing.started = false;
        existing.done = false;
        this.cancelUnsentPin(existing.id);
      }
      if (checkInDateChanged) this.clearHostTime(existing.id, "checkin");
      this.cancelPendingReminders(existing.id);
    }
    for (const job of this.jobsState) {
      if (seen.has(job.id) || job.canceled) continue;
      job.canceled = true;
      job.version += 1;
      this.tombstones.push({ uid: job.id, version: job.version, contentHash: job.contentHash });
      this.dropClearance(job.id);
      this.cancelUnsentPin(job.id);
      this.cancelPendingReminders(job.id);
    }
  }

  private async drainOne(): Promise<CleanerText[]> {
    if (this.optedOut) return [];
    for (const job of this.ordered()) {
      if (job.declined) continue;
      if (job.canceled) {
        const draft = this.noticeFor(job);
        if (!draft) continue;
        const text = await this.emit(draft);
        return text ? [text] : [];
      }
      const status = this.derive(job);
      if (status === "confirmed" || status === "awaiting_departure" || status === "cleared" || status === "in_progress" || status === "done") continue;
      const draft = this.noticeFor(job);
      if (!draft) return [];
      const text = await this.emit(draft);
      return text ? [text] : [];
    }
    return [];
  }

  private noticeFor(job: Job): Draft | null {
    if (!this.owner) return null;
    if (job.canceled) {
      if (!this.toldOwner(job.id)) return null;
      const id = `cancel:${job.id}:v${job.version}`;
      if (this.delivery(id) === "sent") return null;
      const when = formatWhen(zonedInstant(job.checkoutDate, "12:00", this.options.property.timeZone), this.options.property.timeZone);
      return {
        id,
        jobId: job.id,
        to: this.owner,
        kind: "cancel-update",
        body: `Update: the cleaning at ${this.options.property.address} on ${when.day} is canceled, so no need to come. Reply STOP to opt out.`,
      };
    }
    if (job.declined) return null;
    const checkout = this.latestFact(job.id, "checkout");
    const checkin = this.latestFact(job.id, "checkin");
    if (!checkout) {
      const id = `host-checkout:${job.id}:${job.checkoutDate}:${this.defaultCheckout}`;
      if (this.delivery(id) === "sent") return null;
      const when = this.clock(job.checkoutDate, this.defaultCheckout);
      return {
        id,
        jobId: job.id,
        to: this.owner,
        kind: "host-checkout",
        body: `Is checkout at ${this.options.property.address} on ${when.day} still ${when.time}? Reply YES or send the new time.`,
      };
    }
    if (job.nextCheckInDate && !checkin) {
      const id = `host-checkin:${job.id}:${job.nextCheckInDate}:${this.defaultCheckIn}`;
      if (this.delivery(id) === "sent") return null;
      const when = this.clock(job.nextCheckInDate, this.defaultCheckIn);
      return {
        id,
        jobId: job.id,
        to: this.owner,
        kind: "host-checkin",
        body: `Is check-in at ${this.options.property.address} on ${when.day} still ${when.time}? Reply YES or send the new time.`,
      };
    }
    if (!job.announced) {
      const to = this.schedulePhone();
      if (!to) return null;
      const checkMinutes = checkin?.minutes ?? null;
      const id = `offer:${job.id}:${job.checkoutDate}:${checkout.minutes}:${job.nextCheckInDate ?? ""}:${checkMinutes ?? ""}`;
      if (this.delivery(id) === "sent") return null;
      return {
        id,
        jobId: job.id,
        to,
        kind: "offer",
        body: offerBody(this.options.property.address, this.clock(job.checkoutDate, checkout.minutes), job.nextCheckInDate ? this.clock(job.nextCheckInDate, checkMinutes ?? this.defaultCheckIn) : null, job.sameDay),
        afterSend: () => {
          job.announced = this.currentAnnouncement(job);
        },
      };
    }
    if (this.checkoutDrift(job)) {
      const to = this.schedulePhone();
      if (!to) return null;
      const when = this.clock(job.checkoutDate, checkout.minutes);
      const id = `corrected:${job.id}:${job.checkoutDate}:${checkout.minutes}:${job.nextCheckInDate ?? ""}`;
      if (this.delivery(id) === "sent") return null;
      return {
        id,
        jobId: job.id,
        to,
        kind: "corrected",
        body: `Update: checkout at ${this.options.property.address} moved to ${when.day} at ${when.time}. Reply YES to keep the cleaning, or STOP to opt out.`,
        afterSend: () => {
          job.announced = this.currentAnnouncement(job);
        },
      };
    }
    if (job.announced && this.stale(job)) job.announced = this.currentAnnouncement(job);
    return null;
  }

  private async emit(draft: Draft): Promise<CleanerText | null> {
    if (!isScratchTestNumber(draft.to)) throw new Error("Cleaner Core only texts Scratch test numbers.");
    if (/\bready\b/i.test(draft.body)) throw new Error("A calendar time cannot mark the job ready.");
    if (draft.kind === "pin") {
      if (!this.pin || !this.options.cleaner.approved || draft.to !== this.cleanerPhone || this.groupPhones.includes(draft.to)) {
        throw new Error("The door code only goes to the approved cleaner.");
      }
    } else if (this.pin && draft.body.includes(this.pin)) {
      throw new Error("The door code leaked into a schedule text.");
    } else if (!this.pin && /\bdoor code\b/i.test(draft.body)) {
      throw new Error("Step C does not send a door code.");
    }
    if (this.optedOut && !SAFETY.has(draft.kind)) return null;
    const existing = this.outboxState.find((item) => item.id === draft.id);
    if (existing?.status === "sent" || existing?.status === "canceled") return null;
    const text: CleanerText = { to: draft.to, body: draft.body, kind: draft.kind };
    try {
      await this.options.sink.send(text);
    } catch {
      this.upsert(draft, "failed");
      this.save();
      return null;
    }
    this.upsert(draft, "sent");
    this.transcriptState.push(this.redact(draft.body));
    draft.afterSend?.();
    this.save();
    return text;
  }

  private upsert(draft: Draft, status: "sent" | "failed"): void {
    const next: OutboxItem = {
      id: draft.id,
      to: draft.to,
      body: this.redact(draft.body),
      kind: draft.kind,
      status,
      ...(draft.jobId ? { jobId: draft.jobId } : {}),
    };
    const index = this.outboxState.findIndex((item) => item.id === draft.id);
    if (index >= 0) this.outboxState[index] = next;
    else this.outboxState.push(next);
  }

  private async safety(id: string, run: () => Promise<ReceiveResult & { seen?: boolean }>): Promise<ReceiveResult> {
    const result = await run();
    if (result.seen) this.inboundIds.push(id);
    const { seen: _seen, ...publicResult } = result;
    this.save();
    return publicResult;
  }

  private async emergency(from: string, inboundId: string): Promise<ReceiveResult & { seen?: boolean }> {
    const job = this.conversationJob() ?? this.ordered()[0];
    const key = `${from}|${job?.id ?? "none"}|${job?.version ?? 0}`;
    if (this.injurySent.includes(key)) return { handled: true, reason: "emergency", sent: [], seen: true };
    if (from === this.cleanerPhone && this.owner && this.owner !== from) return this.alertHostOfInjury(from, inboundId, key, job?.id);
    const result = await this.reply(from, EMERGENCY, "emergency", "emergency", inboundId);
    if (result.sent.length > 0) this.injurySent.push(key);
    return { ...result, seen: result.sent.length > 0 };
  }

  private async alertHostOfInjury(from: string, inboundId: string, key: string, jobId?: string): Promise<ReceiveResult & { seen?: boolean }> {
    const hostId = `emergency-host:${key}`;
    const host = await this.emit({
      id: hostId,
      ...(jobId ? { jobId } : {}),
      to: this.owner ?? "",
      kind: "emergency",
      body: `The cleaner at ${this.options.property.address} says someone is hurt. They've been told to call 911.`,
    });
    const hostReached = this.delivery(hostId) === "sent";
    const cleaner = await this.reply(from, hostReached ? CLEANER_HURT : CLEANER_HURT_MISSED, "emergency", "emergency", inboundId, jobId);
    if (cleaner.sent.length > 0) this.injurySent.push(key);
    return { handled: true, reason: "emergency", sent: [...(host ? [host] : []), ...cleaner.sent], seen: cleaner.sent.length > 0 };
  }

  private async stop(from: string, inboundId: string): Promise<ReceiveResult & { seen?: boolean }> {
    if (this.pin && from === this.cleanerPhone) {
      this.cleanerConsent = "out";
      const result = await this.reply(from, smsStopAck(), "stop", "stop", inboundId);
      return { ...result, seen: result.sent.length > 0 };
    }
    this.optedOut = true;
    this.cancelPendingReminders();
    const result = await this.reply(from, smsStopAck(), "stop", "stop", inboundId);
    return { ...result, seen: result.sent.length > 0 };
  }

  private async start(from: string, inboundId: string): Promise<ReceiveResult & { seen?: boolean }> {
    if (this.pin && from === this.cleanerPhone) {
      if (this.cleanerConsent === "out") {
        this.cleanerConsent = "in";
        const result = await this.reply(from, START_ACK, "start", "start", inboundId);
        return { ...result, seen: result.sent.length > 0 };
      }
      const job = this.ordered().find((item) => this.pinDelivered(item) && !item.started && !item.done);
      if (this.cleanerConsent !== "in" || !job) return { handled: true, reason: "ignored", sent: [], seen: true };
      const result = await this.reply(from, "Got it, cleaning started.", "started", "start", inboundId, job.id);
      if (result.sent.length > 0) job.started = true;
      return { ...result, seen: result.sent.length > 0 };
    }
    if (!this.everConsented) return { handled: true, reason: "ignored", sent: [], seen: true };
    this.optedOut = false;
    const result = await this.reply(from, START_ACK, "start", "start", inboundId);
    return { ...result, seen: result.sent.length > 0 };
  }

  private async reply(to: string, body: string, kind: TextKind, reason: ReceiveReason, inboundId: string, jobId?: string): Promise<ReceiveResult> {
    const text = await this.emit({ id: `${kind}:${inboundId}`, to, body, kind, ...(jobId ? { jobId } : {}) });
    return { handled: true, reason, sent: text ? [text] : [] };
  }

  private markIgnored(id: string): ReceiveResult {
    this.inboundIds.push(id);
    return { handled: true, reason: "ignored", sent: [] };
  }

  private conversationJob(): Job | undefined {
    return this.ordered().find((job) => {
      const status = this.derive(job);
      return status === "discovered" || status === "awaiting_checkin" || status === "host_confirmed" || status === "offered";
    });
  }

  private derive(job: Job): JobStatus {
    if (job.canceled) return "canceled";
    if (job.declined) return "declined";
    const checkout = this.latestFact(job.id, "checkout");
    const checkin = this.latestFact(job.id, "checkin");
    if (!checkout) return "discovered";
    if (job.nextCheckInDate && !checkin) return "awaiting_checkin";
    if (!job.announced) return "host_confirmed";
    if (this.confirmSent(job) && !this.stale(job)) {
      if (job.done) return "done";
      if (job.started) return "in_progress";
      if (this.pinDelivered(job)) return "cleared";
      if (this.pin && this.checkoutReached(job)) return "awaiting_departure";
      return "confirmed";
    }
    return "offered";
  }

  private view(job: Job): JobView {
    const status = this.derive(job);
    const checkout = this.latestFact(job.id, "checkout");
    const checkin = this.latestFact(job.id, "checkin");
    const live = !job.canceled && !job.declined;
    const checkoutClock = checkout ? this.clock(job.checkoutDate, checkout.minutes) : null;
    const checkinClock = checkin && job.nextCheckInDate ? this.clock(job.nextCheckInDate, checkin.minutes) : null;
    return {
      id: job.id,
      departingUid: job.departingUid,
      arrivingUid: job.arrivingUid,
      status,
      live,
      textsBlocked: !live || this.optedOut,
      checkoutDate: job.checkoutDate,
      nextCheckInDate: job.nextCheckInDate,
      sameDay: job.sameDay,
      checkoutTime: checkoutClock?.time ?? null,
      nextCheckInTime: checkinClock?.time ?? null,
      checkoutAt: checkout ? zonedInstant(job.checkoutDate, hm(checkout.minutes), this.options.property.timeZone) : null,
      nextCheckInAt: checkin && job.nextCheckInDate ? zonedInstant(job.nextCheckInDate, hm(checkin.minutes), this.options.property.timeZone) : null,
      version: job.version,
      hostCheckoutVersion: checkout?.version ?? 0,
      hostCheckInVersion: checkin?.version ?? 0,
      asking: status === "discovered" && this.delivery(`host-checkout:${job.id}:${job.checkoutDate}:${this.defaultCheckout}`) === "sent" ? "checkout" : status === "awaiting_checkin" ? "checkin" : null,
    };
  }

  private checkoutDrift(job: Job): boolean {
    const checkout = this.latestFact(job.id, "checkout");
    if (!job.announced || !checkout) return false;
    return job.announced.checkoutDate !== job.checkoutDate || job.announced.checkoutMinutes !== checkout.minutes;
  }

  private clearHostTime(jobId: string, field: "checkout" | "checkin"): void {
    this.hostFacts = this.hostFacts.filter((fact) => fact.jobId !== jobId || fact.field !== field);
  }

  private stale(job: Job): boolean {
    if (!job.announced) return false;
    const current = this.currentAnnouncement(job);
    if (!current) return false;
    return JSON.stringify(current) !== JSON.stringify(job.announced);
  }

  private currentAnnouncement(job: Job): Announced | null {
    const checkout = this.latestFact(job.id, "checkout");
    if (!checkout) return null;
    const checkin = this.latestFact(job.id, "checkin");
    return {
      checkoutDate: job.checkoutDate,
      checkoutMinutes: checkout.minutes,
      nextCheckInDate: job.nextCheckInDate,
      checkInMinutes: job.nextCheckInDate ? (checkin?.minutes ?? null) : null,
    };
  }

  private confirmSent(job: Job): boolean {
    const checkout = this.latestFact(job.id, "checkout");
    if (!checkout) return false;
    return this.delivery(`confirm:${job.id}:${job.checkoutDate}:${checkout.minutes}:${job.nextCheckInDate ?? ""}`) === "sent";
  }

  private canRemind(job: Job): boolean {
    const status = this.derive(job);
    if (this.stale(job)) return false;
    if (this.pin) return status === "confirmed" || status === "awaiting_departure";
    return status === "offered" || status === "confirmed";
  }

  private triggerDue(trigger: ReminderTrigger, checkoutDate: string): boolean {
    const day = trigger.kind === "days-before-checkout" ? addCalendarDays(checkoutDate, -(trigger.days ?? 0)) : checkoutDate;
    return this.now().getTime() >= Date.parse(zonedInstant(day, trigger.localTime, this.options.property.timeZone));
  }

  private latestFact(jobId: string, field: "checkout" | "checkin"): HostFact | undefined {
    return this.hostFacts.filter((fact) => fact.jobId === jobId && fact.field === field).sort((a, b) => a.version - b.version).at(-1);
  }

  private addFact(jobId: string, field: "checkout" | "checkin", minutes: number): void {
    const latest = this.latestFact(jobId, field);
    if (latest?.minutes === minutes) return;
    this.hostFacts.push({ jobId, field, version: (latest?.version ?? 0) + 1, minutes });
    this.cancelPendingReminders(jobId);
  }

  private toldOwner(jobId: string): boolean {
    return this.outboxState.some((item) => item.jobId === jobId && item.status === "sent" && item.kind !== "cancel-update");
  }

  private delivery(id: string): OutboxItem["status"] | undefined {
    return this.outboxState.find((item) => item.id === id)?.status;
  }

  private cancelPendingReminders(jobId?: string): void {
    for (const item of this.outboxState) {
      if (item.kind !== "reminder" || item.status === "sent") continue;
      if (jobId && item.jobId !== jobId) continue;
      item.status = "canceled";
    }
  }

  private cancelOtherReminders(jobId: string, triggerId: string, keepId: string): void {
    for (const item of this.outboxState) {
      if (item.kind !== "reminder" || item.jobId !== jobId || item.status === "sent" || item.id === keepId) continue;
      if (item.id.startsWith(`reminder:${jobId}:${triggerId}:`)) item.status = "canceled";
    }
  }

  private ordered(): Job[] {
    return [...this.jobsState].sort((a, b) => a.checkoutDate.localeCompare(b.checkoutDate) || a.id.localeCompare(b.id));
  }

  private clock(ymd: string, minutes: number): { day: string; time: string } {
    return formatWhen(zonedInstant(ymd, hm(minutes), this.options.property.timeZone), this.options.property.timeZone);
  }

  private scratchReady(): boolean {
    return Boolean(this.owner && this.cleanerPhone && isScratchTestNumber(this.owner) && isScratchTestNumber(this.cleanerPhone));
  }

  private releaseJob(): Job | undefined {
    return this.ordered().find((job) => {
      const status = this.derive(job);
      return status === "confirmed" || status === "awaiting_departure" || status === "cleared" || status === "in_progress" || status === "done";
    });
  }

  private pinKey(job: Job): string | undefined {
    const checkout = this.latestFact(job.id, "checkout");
    const clearance = [...this.clearances].reverse().find((item) => item.jobId === job.id);
    if (!checkout || !clearance) return undefined;
    if (clearance.checkoutDate !== job.checkoutDate || clearance.minutes !== checkout.minutes || clearance.hostVersion !== checkout.version) return undefined;
    return `pin:${job.id}:${job.checkoutDate}:${checkout.minutes}:${checkout.version}`;
  }

  private pinDelivered(job: Job): boolean {
    const key = this.pinKey(job);
    return Boolean(key && this.delivery(key) === "sent");
  }

  private recordClearance(job: Job): void {
    const checkout = this.latestFact(job.id, "checkout");
    if (!checkout) return;
    const current = [...this.clearances].reverse().find((item) => item.jobId === job.id);
    if (current && current.checkoutDate === job.checkoutDate && current.minutes === checkout.minutes && current.hostVersion === checkout.version) return;
    this.clearances.push({ jobId: job.id, checkoutDate: job.checkoutDate, minutes: checkout.minutes, hostVersion: checkout.version });
  }

  private dropClearance(jobId: string): void {
    this.clearances = this.clearances.filter((item) => item.jobId !== jobId);
  }

  private cancelUnsentPin(jobId: string): void {
    for (const item of this.outboxState) {
      if (item.jobId !== jobId || item.status === "sent") continue;
      if (item.kind === "pin" || item.kind === "pin-failed" || item.kind === "pin-notice" || item.kind === "pin-held") item.status = "canceled";
    }
  }

  private checkoutReached(job: Job): boolean {
    const checkout = this.latestFact(job.id, "checkout");
    if (!checkout) return false;
    return this.now().getTime() >= Date.parse(zonedInstant(job.checkoutDate, hm(checkout.minutes), this.options.property.timeZone));
  }

  private redact(body: string): string {
    if (!this.pin || !body.includes(this.pin)) return body;
    return body.split(this.pin).join("[redacted]");
  }

  private pinKeyMaterial(): Buffer {
    return createHash("sha256").update(`cleaner-core-pin:${this.options.property.id}`).digest();
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StoreFile;
    if (parsed.schemaVersion !== 1) throw new Error("Cleaner Core store is not version 1.");
    const mine = sliceForTenant(parsed, this.tenantId);
    if (!mine) return;
    const record = JSON.parse(JSON.stringify(mine)) as Stored & { pin?: unknown };
    delete record.pin;
    this.jobsState = record.jobs.map((job) => ({ ...job, started: job.started === true, done: job.done === true }));
    this.hostFacts = record.hostFacts;
    this.tombstones = record.tombstones;
    this.outboxState = record.outbox;
    this.inboundIds = record.inboundIds;
    this.transcriptState = record.transcript;
    this.optedOut = record.optedOut;
    this.injurySent = record.injurySent;
    this.blockState = record.blocks;
    this.cleanerConsent = record.cleanerConsent ?? "pending";
    this.clearances = record.clearances ?? [];
    if (!this.pin && record.pinSeal) {
      try {
        this.pin = openPin(record.pinSeal, this.pinKeyMaterial());
      } catch {
        this.pin = undefined;
      }
    }
  }

  private save(): void {
    if (!this.file) return;
    const mine: Stored = {
      schemaVersion: 1,
      jobs: this.jobsState,
      hostFacts: this.hostFacts,
      tombstones: this.tombstones,
      outbox: this.outboxState,
      inboundIds: this.inboundIds,
      transcript: this.transcriptState,
      optedOut: this.optedOut,
      injurySent: this.injurySent,
      blocks: this.blockState,
      cleanerConsent: this.cleanerConsent,
      clearances: this.clearances,
      ...(this.pin ? { pinSeal: sealPin(this.pin, this.pinKeyMaterial()) } : {}),
    };
    const existing = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as StoreFile) : undefined;
    if (existing && existing.schemaVersion !== 1) throw new Error("Cleaner Core store is not version 1.");
    const json = JSON.stringify(mergeTenantSlice(existing, this.tenantId, mine));
    if (this.pin && json.includes(this.pin)) throw new Error("The door code cannot be stored in plaintext.");
    writeFileAtomic(this.file, `${json}\n`);
  }
}

function offerBody(address: string, checkout: { day: string; time: string }, next: { day: string; time: string } | null, sameDay: boolean): string {
  const guest = !next ? "" : sameDay || next.day === checkout.day ? `, next guest ${next.time}` : `, next guest ${next.day} at ${next.time}`;
  return `Turnover at ${address} on ${checkout.day}. Checkout ${checkout.time}${guest}. Reply YES to schedule it, or STOP to opt out.`;
}

function minutesOf(hmText: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(hmText);
  if (!match) throw new Error("Bad local time");
  return Number(match[1]) * 60 + Number(match[2]);
}

function hm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function clockMinutes(text: string): number | undefined {
  const time = spokenTimes(normalize(text))[0];
  if (!time?.meridiem) return undefined;
  let hour = time.hour % 12;
  if (time.meridiem === "PM") hour += 12;
  return hour * 60 + time.minute;
}

function isYes(text: string): boolean {
  return /^(yes|yep|yeah|y|ok|okay|sure)( please)?$/.test(stripFiller(normalize(text)));
}

function isNo(text: string): boolean {
  return /^(no|nope|nah)$/.test(stripFiller(normalize(text)));
}

function isDone(text: string): boolean {
  return stripFiller(normalize(text)) === "done";
}

function isDeparture(text: string): boolean {
  const phrase = stripFiller(normalize(text));
  return phrase === "guests have left" || phrase === "guests left" || phrase === "they have left" || phrase === "they left" || phrase === "departed" || phrase === "left";
}

function isStoredSlice(value: unknown): value is Stored {
  if (!value || typeof value !== "object") return false;
  const record = value as Stored;
  return record.schemaVersion === 1 && Array.isArray(record.jobs) && Array.isArray(record.outbox);
}

function sliceOwnedBy(slice: Stored, tenantId: string): boolean {
  const known = SCRATCH_TENANTS.find((tenant) => tenant.id === tenantId);
  if (!known) return true;
  const phones = slice.outbox.map((item) => item.to);
  if (phones.length === 0) return true;
  const other = phones.some((phone) => isOtherScratchTenantPhone(tenantId, phone));
  const own = phones.some((phone) => phone === known.ownerPhone || phone === known.cleanerPhone || phone === known.unapprovedPhone);
  return !(other && !own);
}

function foreignTenantId(slice: Stored): string {
  if (typeof slice.tenantId === "string" && slice.tenantId !== "") return slice.tenantId;
  const phones = new Set(slice.outbox.map((item) => item.to));
  const match = SCRATCH_TENANTS.find((tenant) => [tenant.ownerPhone, tenant.cleanerPhone, tenant.unapprovedPhone].some((phone) => phones.has(phone)));
  return match?.id ?? "scratch-lane";
}

function sliceForTenant(file: StoreFile, tenantId: string): Stored | undefined {
  if (file.tenants && typeof file.tenants === "object") {
    const slice = file.tenants[tenantId];
    return isStoredSlice(slice) ? slice : undefined;
  }
  if (typeof file.tenantId === "string" && file.tenantId !== tenantId) return undefined;
  if (!isStoredSlice(file)) return undefined;
  if (!sliceOwnedBy(file, tenantId)) return undefined;
  return file;
}

function otherSlices(file: StoreFile | undefined, tenantId: string): Record<string, Stored> {
  if (!file || file.schemaVersion !== 1) return {};
  if (file.tenants && typeof file.tenants === "object") {
    const rest: Record<string, Stored> = {};
    for (const [key, value] of Object.entries(file.tenants)) {
      if (key === tenantId || !isStoredSlice(value)) continue;
      rest[key] = value;
    }
    return rest;
  }
  if (!isStoredSlice(file)) return {};
  if (sliceOwnedBy(file, tenantId)) return {};
  const key = foreignTenantId(file);
  if (key === tenantId) return {};
  return { [key]: { ...file, tenantId: key } };
}

function mergeTenantSlice(existing: StoreFile | undefined, tenantId: string, mine: Stored): StoreFile {
  const others = otherSlices(existing, tenantId);
  if (Object.keys(others).length === 0) return mine;
  return { schemaVersion: 1, tenants: { ...others, [tenantId]: { ...mine, tenantId } } };
}

function sealPin(pin: string, key: Buffer): PinSeal {
  for (let attempt = 0; attempt < 8; attempt++) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(pin, "utf8"), cipher.final()]);
    const sealed = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    if (!JSON.stringify(sealed).includes(pin)) return sealed;
  }
  throw new Error("Could not seal the door code.");
}

function openPin(sealed: PinSeal, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
}
