import { isMedicalEmergency, isPlainLanguageStop, keywordOf } from "../intent";
import { normalize, stripFiller } from "../intent/normalize";
import { parsePhone } from "../core/phone";
import { smsStopAck } from "../visitor/smsConsent";
import { VisitorDenialCopy } from "../core/TourCore";
import { turnoverFromIcal, type TurnoverWindow } from "./calendar";
import { isScratchTestNumber } from "./scratch";

export interface CleanerText {
  to: string;
  body: string;
  kind: "offer" | "confirm" | "declined" | "stop" | "help" | "start" | "emergency" | "pin";
}

export type ScheduleReason =
  | "disabled"
  | "not-consented"
  | "scratch-only"
  | "pin-invalid"
  | "no-turnover"
  | "offered"
  | "already-offered"
  | "declined";

export interface ScheduleResult {
  scheduled: boolean;
  reason: ScheduleReason;
  sent: CleanerText[];
  turnover?: TurnoverWindow;
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
  | "scratch-only";

export interface ReceiveResult {
  handled: boolean;
  reason: ReceiveReason;
  sent: CleanerText[];
}

export interface CleanerSink {
  send(text: CleanerText): void | Promise<void>;
}

export interface CleanerCoreOptions {
  enabled: boolean;
  property: { id: string; address: string; timeZone: string };
  /** Cleaning-service owner who gets the schedule text. Never the door code. */
  ownerPhone: string;
  /** Approved cleaner who may receive the door code in a separate private text. */
  cleaner: { phone: string; approved: boolean };
  pin: string;
  /** Landlord already approved texting this owner. A phone number alone is not consent. */
  consented?: boolean;
  sink: CleanerSink;
  now?: () => Date;
}

export interface CleanerCore {
  scheduleFromIcal(ical: string): Promise<ScheduleResult>;
  receive(input: { id: string; from: string; text: string }): Promise<ReceiveResult>;
}

const HELP_ACK = "Cleaner Core: Reply here if you need help with this turnover. Reply STOP to opt out.";
const START_ACK = "You're opted back in. Reply YES if you still want this turnover. Reply STOP to opt out.";
const DECLINED = "Okay, that turnover is not scheduled.";
const EMERGENCY = VisitorDenialCopy.medicalAlert("property team", undefined, false);

/**
 * Usage:
 *   const core = openCleanerCore({ enabled: cleanerCoreEnabled(env), property, ownerPhone, cleaner, pin, consented: true, sink, now });
 *   const offer = await core.scheduleFromIcal(icalText);
 *   const booked = await core.receive({ id, from: ownerPhone, text: "YES" });
 * Flag off returns reason "disabled" and sends nothing. The door code is a separate text to the approved cleaner only.
 */
export function openCleanerCore(options: CleanerCoreOptions): CleanerCore {
  return new Engine(options);
}

type JobStatus = "offered" | "scheduled" | "declined" | "stopped";

class Engine implements CleanerCore {
  private readonly enabled: boolean;
  private readonly owner: string | undefined;
  private readonly cleanerPhone: string | undefined;
  private readonly pin: string;
  private consented: boolean;
  private readonly everConsented: boolean;
  private optedOut = false;
  private injurySent = false;
  private readonly seen = new Set<string>();
  private job: (TurnoverWindow & { status: JobStatus }) | undefined;

  constructor(private readonly options: CleanerCoreOptions) {
    this.enabled = options.enabled;
    this.owner = parsePhone(options.ownerPhone);
    this.cleanerPhone = parsePhone(options.cleaner.phone);
    this.pin = options.pin.trim();
    this.consented = options.consented === true;
    this.everConsented = this.consented;
  }

  async scheduleFromIcal(ical: string): Promise<ScheduleResult> {
    if (!this.enabled) return { scheduled: false, reason: "disabled", sent: [] };
    if (!this.owner || !this.cleanerPhone || !isScratchTestNumber(this.owner) || !isScratchTestNumber(this.cleanerPhone)) {
      return { scheduled: false, reason: "scratch-only", sent: [] };
    }
    if (!/^\d{4,8}$/.test(this.pin)) return { scheduled: false, reason: "pin-invalid", sent: [] };
    if (this.optedOut || !this.consented) return { scheduled: false, reason: "not-consented", sent: [] };
    const turnover = turnoverFromIcal(ical, this.options.property.timeZone, this.options.now?.() ?? new Date());
    if (!turnover) return { scheduled: false, reason: "no-turnover", sent: [] };
    if (this.job && this.job.checkout === turnover.checkout && this.job.nextArrival === turnover.nextArrival) {
      if (this.job.status === "declined") return { scheduled: false, reason: "declined", sent: [] };
      return { scheduled: false, reason: "already-offered", sent: [] };
    }
    const text = this.outbound(this.owner, offerBody(this.options.property.address, this.options.property.timeZone, turnover), "offer");
    this.job = { ...turnover, status: "offered" };
    await this.options.sink.send(text);
    return { scheduled: true, reason: "offered", sent: [text], turnover };
  }

  async receive(input: { id: string; from: string; text: string }): Promise<ReceiveResult> {
    if (!this.enabled) return { handled: false, reason: "disabled", sent: [] };
    const from = parsePhone(input.from);
    if (!from || !isScratchTestNumber(from)) return { handled: true, reason: "scratch-only", sent: [] };
    if (this.seen.has(input.id)) return { handled: true, reason: "duplicate", sent: [] };

    const keyword = keywordOf(input.text);
    let result: ReceiveResult;
    if (keyword === "help") result = await this.reply(from, HELP_ACK, "help", "help");
    else if (isMedicalEmergency(input.text)) result = await this.emergency(from);
    else if (keyword === "stop" || isPlainLanguageStop(input.text)) result = await this.stop(from);
    else if (keyword === "start") result = await this.start(from);
    else if (this.optedOut) result = { handled: true, reason: "ignored", sent: [] };
    else if (isYes(input.text)) result = await this.accept(from);
    else if (isNo(input.text)) result = await this.decline(from);
    else result = { handled: true, reason: "ignored", sent: [] };

    this.seen.add(input.id);
    return result;
  }

  private async emergency(from: string): Promise<ReceiveResult> {
    if (this.injurySent) return { handled: true, reason: "emergency", sent: [] };
    this.injurySent = true;
    return this.reply(from, EMERGENCY, "emergency", "emergency");
  }

  private async stop(from: string): Promise<ReceiveResult> {
    this.optedOut = true;
    if (this.job?.status === "offered") this.job.status = "stopped";
    return this.reply(from, smsStopAck(), "stop", "stop");
  }

  private async start(from: string): Promise<ReceiveResult> {
    if (!this.everConsented) return { handled: true, reason: "ignored", sent: [] };
    this.optedOut = false;
    this.consented = true;
    return this.reply(from, START_ACK, "start", "start");
  }

  private async accept(from: string): Promise<ReceiveResult> {
    if (from !== this.owner || !this.job || (this.job.status !== "offered" && this.job.status !== "stopped")) {
      return { handled: true, reason: "ignored", sent: [] };
    }
    const confirm = this.outbound(this.owner, confirmBody(this.options.property.address, this.options.property.timeZone, this.job.checkout), "confirm");
    const sent: CleanerText[] = [confirm];
    await this.options.sink.send(confirm);
    if (this.options.cleaner.approved && this.cleanerPhone) {
      const pin = this.outbound(this.cleanerPhone, pinBody(this.options.property.address, this.options.property.timeZone, this.job.checkout, this.pin), "pin");
      sent.push(pin);
      await this.options.sink.send(pin);
    }
    this.job.status = "scheduled";
    return { handled: true, reason: "scheduled", sent };
  }

  private async decline(from: string): Promise<ReceiveResult> {
    if (from !== this.owner || this.job?.status !== "offered") return { handled: true, reason: "ignored", sent: [] };
    this.job.status = "declined";
    return this.reply(from, DECLINED, "declined", "declined");
  }

  private async reply(to: string, body: string, kind: CleanerText["kind"], reason: ReceiveReason): Promise<ReceiveResult> {
    const text = this.outbound(to, body, kind);
    await this.options.sink.send(text);
    return { handled: true, reason, sent: [text] };
  }

  /** The door code is only legal on a pin text addressed to the approved cleaner. */
  private outbound(to: string, body: string, kind: CleanerText["kind"]): CleanerText {
    if (!isScratchTestNumber(to)) throw new Error("Cleaner Core only texts Scratch test numbers.");
    if (kind === "pin") {
      if (!this.options.cleaner.approved || to !== this.cleanerPhone) throw new Error("The door code only goes to the approved cleaner.");
    } else if (body.includes(this.pin)) {
      throw new Error("The door code leaked into a schedule text.");
    }
    return { to, body, kind };
  }
}

function offerBody(address: string, timeZone: string, window: TurnoverWindow): string {
  const checkout = formatWhen(window.checkout, timeZone);
  const arrival = formatWhen(window.nextArrival, timeZone);
  return `Turnover at ${address} on ${checkout.day}. Checkout ${checkout.time}, next guest ${arrival.time}. Reply YES to schedule it, or STOP to opt out.`;
}

function confirmBody(address: string, timeZone: string, checkout: string): string {
  const when = formatWhen(checkout, timeZone);
  return `Cleaning is scheduled for ${when.day} at ${when.time} at ${address}.`;
}

function pinBody(address: string, timeZone: string, checkout: string, pin: string): string {
  const when = formatWhen(checkout, timeZone);
  return `Door code for ${address} on ${when.day}: ${pin}. This code is only for you.`;
}

function formatWhen(iso: string, timeZone: string): { day: string; time: string } {
  const date = new Date(iso);
  return {
    day: new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "short", day: "numeric" }).format(date),
    time: new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date),
  };
}

function isYes(text: string): boolean {
  return /^(yes|yep|yeah|y|ok|okay|sure)( please)?$/.test(stripFiller(normalize(text)));
}

function isNo(text: string): boolean {
  return /^(no|nope|nah)$/.test(stripFiller(normalize(text)));
}
