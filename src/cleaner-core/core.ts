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
  | "emergency";

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
  reason: "disabled" | "scratch-only" | "not-consented" | "read";
  sent: CleanerText[];
  jobs: JobView[];
  blocks: FeedBlock[];
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
  | "host-time";

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
  /** Cleaner identity. Step C never texts a door code to this number. */
  cleaner: { phone: string; approved: boolean };
  /** Landlord already approved texting this owner. A phone number alone is not consent. */
  consented?: boolean;
  sink: CleanerSink;
  now?: () => Date;
  triggers?: ReminderTrigger[];
  /** When set, jobs and the outbox reload after a process restart. */
  dataDir?: string;
}

export interface CleanerCore {
  pollFeed(ical: string): Promise<PollResult>;
  receive(input: { id: string; from: string; text: string }): Promise<ReceiveResult>;
  runReminders(): Promise<ReminderResult>;
  jobs(): JobView[];
  outbox(): OutboxView[];
  transcript(): string[];
  blocks(): FeedBlock[];
}

const HELP_ACK = "Cleaner Core: Reply here if you need help with this turnover. Reply STOP to opt out.";
const START_ACK = "You're opted back in. Reply YES if you still want this turnover. Reply STOP to opt out.";
const DECLINED = "Okay, that turnover is not scheduled.";
const EMERGENCY = VisitorDenialCopy.medicalAlert("property team", undefined, false);
const SAFETY = new Set<TextKind>(["stop", "help", "start", "emergency"]);
const DEFAULT_TRIGGERS: ReminderTrigger[] = [{ id: "morning-of", kind: "morning-of", localTime: "08:00" }];

/**
 * Usage:
 *   const core = openCleanerCore({ enabled: cleanerCoreEnabled(env), property, ownerPhone, cleaner, consented: true, sink, now, dataDir });
 *   await core.pollFeed(icalText);
 *   await core.receive({ id, from: ownerPhone, text: "YES" });
 *   await core.runReminders();
 * Flag off returns reason "disabled" and sends nothing. Step C never sends a door code.
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
  jobs: Job[];
  hostFacts: HostFact[];
  tombstones: Tombstone[];
  outbox: OutboxItem[];
  inboundIds: string[];
  transcript: string[];
  optedOut: boolean;
  injurySent: string[];
  blocks: FeedBlock[];
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

  constructor(private readonly options: CleanerCoreOptions) {
    this.enabled = options.enabled;
    this.owner = parsePhone(options.ownerPhone);
    this.cleanerPhone = parsePhone(options.cleaner.phone);
    this.triggers = options.triggers ?? DEFAULT_TRIGGERS;
    this.defaultCheckout = minutesOf(options.property.defaultCheckout ?? "11:00");
    this.defaultCheckIn = minutesOf(options.property.defaultCheckIn ?? "16:00");
    this.everConsented = options.consented === true;
    this.now = options.now ?? (() => new Date());
    this.file = options.dataDir ? join(options.dataDir, "cleaner-core.json") : undefined;
    this.load();
  }

  async pollFeed(ical: string): Promise<PollResult> {
    if (!this.enabled) return { polled: false, reason: "disabled", sent: [], jobs: [], blocks: [] };
    if (!this.scratchReady()) return { polled: false, reason: "scratch-only", sent: [], jobs: this.jobs(), blocks: [] };
    if (this.optedOut || !this.everConsented) {
      if (!this.everConsented) return { polled: false, reason: "not-consented", sent: [], jobs: [], blocks: [] };
    }
    const feed = interpretFeed(ical);
    this.blockState = feed.blocks;
    this.reconcile(feed.turnovers);
    const sent = this.optedOut ? [] : await this.drainOne();
    this.save();
    return { polled: true, reason: "read", sent, jobs: this.jobs(), blocks: this.blocks() };
  }

  async receive(input: { id: string; from: string; text: string }): Promise<ReceiveResult> {
    if (!this.enabled) return { handled: false, reason: "disabled", sent: [] };
    const from = parsePhone(input.from);
    if (!from || !isScratchTestNumber(from)) return { handled: true, reason: "scratch-only", sent: [] };
    if (this.inboundIds.includes(input.id)) return { handled: true, reason: "duplicate", sent: [] };
    this.transcriptState.push(`${from}: ${input.text.trim()}`);

    const keyword = keywordOf(input.text);
    if (keyword === "help") return this.safety(input.id, () => this.reply(from, HELP_ACK, "help", "help", input.id));
    if (isMedicalEmergency(input.text)) return this.safety(input.id, () => this.emergency(from, input.id));
    if (keyword === "stop" || isPlainLanguageStop(input.text)) return this.safety(input.id, () => this.stop(from, input.id));
    if (keyword === "start") return this.safety(input.id, () => this.start(from, input.id));
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
        const when = this.clock(job.checkoutDate, fact.minutes);
        const text = await this.emit({
          id,
          jobId: job.id,
          to: this.owner ?? "",
          kind: "reminder",
          body: `Reminder: checkout at ${this.options.property.address} is ${when.day} at ${when.time}. Reply STOP to opt out.`,
        });
        if (text) sent.push(text);
        else if (this.outboxState.find((item) => item.id === id)?.status === "failed") failed.push(id);
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

  private async answer(id: string, from: string, text: string): Promise<ReceiveResult> {
    const job = this.conversationJob();
    if (!job || from !== this.owner) return this.markIgnored(id);
    const status = this.derive(job);
    const minutes = clockMinutes(text);
    if (status === "discovered") {
      const chosen = isYes(text) ? this.defaultCheckout : minutes;
      if (chosen === undefined) return this.markIgnored(id);
      this.addFact(job.id, "checkout", chosen);
      this.inboundIds.push(id);
      const sent = await this.drainOne();
      return { handled: true, reason: "host-time", sent };
    }
    if (status === "awaiting_checkin") {
      const chosen = isYes(text) ? this.defaultCheckIn : minutes;
      if (chosen === undefined) return this.markIgnored(id);
      this.addFact(job.id, "checkin", chosen);
      this.inboundIds.push(id);
      const sent = await this.drainOne();
      return { handled: true, reason: "host-time", sent };
    }
    if (status === "offered") {
      if (minutes !== undefined) {
        this.addFact(job.id, "checkout", minutes);
        this.inboundIds.push(id);
        const sent = await this.drainOne();
        return { handled: true, reason: "host-time", sent };
      }
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
        const declined = await this.reply(this.owner ?? from, DECLINED, "declined", "declined", id, job.id);
        return declined;
      }
    }
    return this.markIgnored(id);
  }

  private async confirm(job: Job): Promise<CleanerText[]> {
    const checkout = this.latestFact(job.id, "checkout");
    if (!checkout || !this.owner) return [];
    const when = this.clock(job.checkoutDate, checkout.minutes);
    const id = `confirm:${job.id}:${job.checkoutDate}:${checkout.minutes}:${job.nextCheckInDate ?? ""}`;
    const text = await this.emit({
      id,
      jobId: job.id,
      to: this.owner,
      kind: "confirm",
      body: `Cleaning is scheduled for ${when.day} at ${when.time} at ${this.options.property.address}.`,
    });
    return text ? [text] : [];
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
      if (checkoutDateChanged) this.clearHostTime(existing.id, "checkout");
      if (checkInDateChanged) this.clearHostTime(existing.id, "checkin");
      this.cancelPendingReminders(existing.id);
    }
    for (const job of this.jobsState) {
      if (seen.has(job.id) || job.canceled) continue;
      job.canceled = true;
      job.version += 1;
      this.tombstones.push({ uid: job.id, version: job.version, contentHash: job.contentHash });
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
      if (this.derive(job) === "confirmed") continue;
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
      const checkMinutes = checkin?.minutes ?? null;
      const id = `offer:${job.id}:${job.checkoutDate}:${checkout.minutes}:${job.nextCheckInDate ?? ""}:${checkMinutes ?? ""}`;
      if (this.delivery(id) === "sent") return null;
      return {
        id,
        jobId: job.id,
        to: this.owner,
        kind: "offer",
        body: offerBody(this.options.property.address, this.clock(job.checkoutDate, checkout.minutes), job.nextCheckInDate ? this.clock(job.nextCheckInDate, checkMinutes ?? this.defaultCheckIn) : null, job.sameDay),
        afterSend: () => {
          job.announced = this.currentAnnouncement(job);
        },
      };
    }
    if (this.checkoutDrift(job)) {
      const when = this.clock(job.checkoutDate, checkout.minutes);
      const id = `corrected:${job.id}:${job.checkoutDate}:${checkout.minutes}:${job.nextCheckInDate ?? ""}`;
      if (this.delivery(id) === "sent") return null;
      return {
        id,
        jobId: job.id,
        to: this.owner,
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
    if (/\bdoor code\b/i.test(draft.body)) throw new Error("Step C does not send a door code.");
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
    this.transcriptState.push(draft.body);
    draft.afterSend?.();
    this.save();
    return text;
  }

  private upsert(draft: Draft, status: "sent" | "failed"): void {
    const next: OutboxItem = {
      id: draft.id,
      to: draft.to,
      body: draft.body,
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
    const result = await this.reply(from, EMERGENCY, "emergency", "emergency", inboundId);
    if (result.sent.length > 0) this.injurySent.push(key);
    return { ...result, seen: result.sent.length > 0 };
  }

  private async stop(from: string, inboundId: string): Promise<ReceiveResult & { seen?: boolean }> {
    this.optedOut = true;
    this.cancelPendingReminders();
    const result = await this.reply(from, smsStopAck(), "stop", "stop", inboundId);
    return { ...result, seen: result.sent.length > 0 };
  }

  private async start(from: string, inboundId: string): Promise<ReceiveResult & { seen?: boolean }> {
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
    if (this.confirmSent(job) && !this.stale(job)) return "confirmed";
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
    return (status === "offered" || status === "confirmed") && !this.stale(job);
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

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Stored & { pin?: unknown };
    if (parsed.schemaVersion !== 1) throw new Error("Cleaner Core store is not version 1.");
    delete parsed.pin;
    this.jobsState = parsed.jobs;
    this.hostFacts = parsed.hostFacts;
    this.tombstones = parsed.tombstones;
    this.outboxState = parsed.outbox;
    this.inboundIds = parsed.inboundIds;
    this.transcriptState = parsed.transcript;
    this.optedOut = parsed.optedOut;
    this.injurySent = parsed.injurySent;
    this.blockState = parsed.blocks;
  }

  private save(): void {
    if (!this.file) return;
    const stored: Stored = {
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
    };
    writeFileAtomic(this.file, `${JSON.stringify(stored)}\n`);
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
