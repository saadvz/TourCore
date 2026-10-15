import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parsePhone } from "../core/phone";
import { messagingKeyword, normalize } from "../intent";
import { stripFiller } from "../intent/normalize";
import { spokenTimes } from "../core/spokenTime";
import { interpretFeed } from "./calendar";
import { openCleanerCore, SAFETY, type CleanerCore, type CleanerText, type TextKind } from "./core";
import { readPublicCalendar, type CalendarFetch } from "./fetchLimits";
import { cleanerOptOutHold, isPrivateCodeLine, jobHoldLine, optedOutCodeLine, resumeNote } from "./cleanerTexts";
import { isInjuryReport } from "./injury";
import { GroupNotConfirmed } from "./groupThread";
import { cleanerPinStatusUrl, isAllowlisted, liveSmsOn, sendLiveGroup, sendLiveSms, smsAllowlist } from "./liveSms";
import { openPin, sealPin, type PinSeal } from "./pinSeal";
import { isScratchTestNumber } from "./scratch";
import {
  SCRATCH_NUMBER_REFUSAL,
  SCRATCH_PROPERTY_REFUSAL,
  SCRATCH_RESET_LINE,
  SCRATCH_STATUS_NEEDED,
  SCRATCH_TEST_WENT_THROUGH,
  SCRATCH_TEXT_MISSING,
  SCRATCH_TEXT_NEEDED,
  SCRATCH_WHICH_NEEDED,
  inboxLine,
  isDeliveryReport,
  isScratchPropertyAddress,
  outboxLabel,
  outboxLine,
  scratchToolsOn,
  whoTheyAre,
  type DeliveryReport,
} from "./scratchQa";

export const FIRST_QUESTION =
  "What do you want help with? 1) Letting renters tour a unit on their own, or 2) Scheduling cleaners between guest stays.";

const TOUR_PICK = "That's Tour Core. It lets renters tour a unit on their own.";
const CLEANER_PICK =
  "That's Cleaner Core. It schedules cleaners between guest stays. What's the property address, and what should I call the business?";

const DEPARTURES = new Set(["guests have left", "guests left", "they have left", "they left", "departed", "left"]);

const PIN_SENT = "I sent the door code to the cleaner. I'll tell you if it doesn't go through.";
const PIN_FAILED = "The door code didn't reach the cleaner. Tell your Grok Bot the guests have left and I'll resend it.";
const PIN_REPEAT = "I already sent the door code to the cleaner.";
const PIN_KEY_MISSING = "I can't send the door code yet. Let's finish setting up Cleaner Core first.";
const PIN_REENTER = "Please enter the door code again in the private box. Don't text it here.";
export const DOOR_CODE_IN_CHAT = "Please don't send the door code in chat. Use the private box instead.";
const DIRECT_TEXT_REPLY = "Got it. To send the door code, tell your Grok Bot the guests have left. The cleaner is still waiting for the OK.";

interface PinSend {
  sid: string;
  outcome: "accepted" | "undelivered" | "settled";
  notePending: boolean;
  delivered?: boolean;
}

function groupChatOn(env: NodeJS.ProcessEnv): boolean {
  const raw = env.CLEANER_CORE_GROUP_CHAT?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export interface ToolOk {
  ok: true;
  result: Record<string, unknown>;
}

export interface ToolNo {
  ok: false;
  error: string;
}

export type ToolReply = ToolOk | ToolNo;

interface LiveFile {
  choice?: "tours" | "cleaners";
  business?: string;
  address?: string;
  timeZone?: string;
  propertyId?: string;
  host?: string;
  cleaner?: string;
  observer?: string;
  calendarLink?: string;
  pinSeal?: PinSeal;
  pinSend?: PinSend;
  texting?: boolean;
  checked?: boolean;
  released?: boolean;
  cleanerOut?: boolean;
  seenInbound?: string[];
  conversationSid?: string;
  deliveries?: { id: string; status: DeliveryReport }[];
  localSends?: { id: string; to: string; kind: TextKind; status: DeliveryReport }[];
}

interface OutboxRow {
  id: string;
  kind: TextKind;
  local: boolean;
  label: string;
  line: string;
}

let calendarFetch: CalendarFetch | undefined;

/** Tests stub the calendar read. Unset uses the platform fetch. */
export function setCleanerCalendarFetch(fetchImpl: CalendarFetch | undefined): void {
  calendarFetch = fetchImpl;
}

const desks = new Map<string, LiveDesk>();

export function liveDeskFor(root: string, env: () => NodeJS.ProcessEnv, now: () => Date): LiveDesk {
  const existing = desks.get(root);
  if (existing) return existing;
  const desk = new LiveDesk(root, env, now);
  desks.set(root, desk);
  return desk;
}

export function resetLiveDesks(): void {
  desks.clear();
}

function choiceOf(said: string): "tours" | "cleaners" | undefined {
  const text = said.trim().toLowerCase();
  if (text === "1" || text.startsWith("1)") || text.startsWith("1 ")) return "tours";
  if (text === "2" || text.startsWith("2)") || text.startsWith("2 ")) return "cleaners";
  if (/letting renters tour|tour a unit on their own/.test(text)) return "tours";
  if (/scheduling cleaners|cleaners between guest stays/.test(text)) return "cleaners";
  return undefined;
}

function statedClock(text: string): boolean {
  return Boolean(spokenTimes(normalize(text))[0]?.meridiem);
}

function propertyIdFor(business: string): string {
  const slug = business.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "property";
  return `live-${slug}`;
}

export class LiveDesk {
  private file: LiveFile = {};
  private pin: string | undefined;
  private engine: CleanerCore | undefined;
  private checking = false;
  private held = false;
  private readonly path: string;

  constructor(
    private readonly root: string,
    private readonly env: () => NodeJS.ProcessEnv,
    private readonly now: () => Date,
  ) {
    this.path = join(root, "cleaner-live.json");
    this.load();
  }

  /** True when `text` contains the saved door code. */
  leaks(text: string): boolean {
    return Boolean(this.pin && text.includes(this.pin));
  }

  chatCarriesDoorCode(text: string): boolean {
    if (this.pin && text.includes(this.pin)) return true;
    const trimmed = text.trim();
    if (/^\d{4,8}$/.test(trimmed)) return true;
    return /\bdoor code\b/i.test(text) && /\b\d{4,8}\b/.test(text);
  }

  getState(said?: string): ToolReply {
    if (this.file.choice === "cleaners") this.resume();
    const failure = this.engine?.pullPinFailure() ? PIN_FAILED : undefined;
    if (!this.file.choice) {
      const pick = said ? choiceOf(said) : undefined;
      if (!pick) return this.reply({ done: [], next: FIRST_QUESTION });
      this.file.choice = pick;
      this.persist();
      if (pick === "tours") return this.reply({ done: [], next: TOUR_PICK });
      return this.reply({ done: ["You chose cleaning."], next: CLEANER_PICK });
    }
    if (this.file.choice === "tours") return this.withFailure(this.reply({ done: ["You chose touring."], next: "What's the property you want renters to tour?" }), failure);
    return this.withFailure(this.reply(this.cleaningState()), failure);
  }

  saveProperty(input: { address?: string; business?: string; timeZone?: string }): ToolReply {
    if (this.file.choice !== "cleaners") return this.fail("Tell me which job you want help with first.");
    const address = input.address?.trim() ?? "";
    const business = input.business?.trim() ?? "";
    const timeZone = input.timeZone?.trim() ?? "";
    if (!address || !business || !timeZone.includes("/")) {
      return this.fail("I need the business name, the property address, and the time zone.");
    }
    this.file.business = business;
    this.file.address = address;
    this.file.timeZone = timeZone;
    this.file.propertyId = propertyIdFor(business);
    this.persist();
    return this.reply({ next: "Who is the host, the cleaner, and the observer? Send each phone number." });
  }

  savePeople(input: { host?: string; cleaner?: string; observer?: string }): ToolReply {
    if (!this.file.address) return this.fail("Save the property first.");
    const host = parsePhone(input.host ?? "");
    const cleaner = parsePhone(input.cleaner ?? "");
    const observer = parsePhone(input.observer ?? "");
    if (!host || !cleaner || !observer || new Set([host, cleaner, observer]).size < 3) {
      return this.fail("I need three different phone numbers: the host, the cleaner, and the observer.");
    }
    this.file.host = host;
    this.file.cleaner = cleaner;
    this.file.observer = observer;
    this.persist();
    return this.reply({ next: "What's the calendar link for this property?" });
  }

  saveCalendarLink(input: { url?: string }): ToolReply {
    if (!this.file.cleaner) return this.fail("Save the cleaner and the observer first.");
    const url = input.url?.trim() ?? "";
    if (!url.startsWith("https://")) return this.fail("Send a public https calendar link.");
    this.file.calendarLink = url;
    this.persist();
    return this.reply({ next: "What's the door code? I'll save it and I won't repeat it." });
  }

  saveDoorCode(input: { code?: string }, pinKey: Buffer | undefined): ToolReply {
    if (!this.file.calendarLink || !this.file.propertyId) return this.fail("Save the calendar link first.");
    const code = input.code?.trim() ?? "";
    if (!/^\d{4,8}$/.test(code)) return this.fail("Send the door code as 4 to 8 digits.");
    if (!pinKey) return this.fail(PIN_KEY_MISSING);
    const previousPin = this.pin;
    const previousSeal = this.file.pinSeal;
    this.pin = code;
    for (let attempt = 0; attempt < 8; attempt++) {
      this.file.pinSeal = sealPin(code, pinKey);
      const json = `${JSON.stringify(this.file)}\n`;
      if (json.includes(code) || json.includes(pinKey.toString("base64"))) continue;
      this.writeFile(json);
      return this.reply({
        next: "Saved the door code. It goes only to the cleaner, in a private text, after you say the guests have left.",
      });
    }
    this.pin = previousPin;
    this.file.pinSeal = previousSeal;
    return this.fail("Could not seal the door code.");
  }

  setUpTexting(): ToolReply {
    if (!this.pin) return this.fail("Save the door code first.");
    this.file.texting = true;
    this.persist();
    return this.reply({
      next: "Texting is saved. The cleaner gets one text asking them to reply YES, and only after you confirm the checkout and the next check-in.",
    });
  }

  async runChecks(): Promise<ToolReply> {
    if (!this.file.texting || !this.file.calendarLink || !this.pin) return this.fail("Set up texting first.");
    if (!this.file.host || !this.file.cleaner || !isAllowlisted(this.env(), this.file.host) || !isAllowlisted(this.env(), this.file.cleaner)) {
      return this.fail("I can text the host and the cleaner only after those numbers are approved for texts.");
    }
    const fetchImpl = calendarFetch ?? fetch;
    const read = await readPublicCalendar(this.file.calendarLink, fetchImpl);
    if (!read.ok) return this.fail(read.reason);
    const feed = interpretFeed(read.body);
    if (feed.turnovers.length === 0) return this.fail("That calendar has no guest stay yet.");
    this.engine = this.openEngine();
    this.checking = true;
    try {
      await this.engine.pollFeed(read.body);
    } finally {
      this.checking = false;
    }
    this.file.checked = true;
    this.persist();
    const turns = this.turns();
    return this.reply({
      next: "I read the calendar. Tell me the checkout time and the next check-in time before I text the cleaner.",
      turns,
    });
  }

  getTurns(): ToolReply {
    this.resume();
    return this.reply({ turns: this.turns(), ...(this.held ? { held: true } : {}) });
  }

  async confirmTimes(input: { checkout?: string; checkIn?: string }): Promise<ToolReply> {
    this.resume();
    if (!this.file.checked || !this.engine || !this.file.host) return this.fail("Run the checks first.");
    const checkout = input.checkout?.trim() ?? "";
    const checkIn = input.checkIn?.trim() ?? "";
    if (!statedClock(checkout) || !statedClock(checkIn)) {
      return this.fail("Tell me the checkout time and the next check-in time, like 10:30 AM and 3:00 PM.");
    }
    if (groupChatOn(this.env())) {
      await this.engine.confirmHostTimes({ checkout, checkIn });
    } else {
      await this.engine.receive({ id: `confirm-out-${randomUUID()}`, from: this.file.host, text: checkout });
      await this.engine.receive({ id: `confirm-in-${randomUUID()}`, from: this.file.host, text: checkIn });
    }
    const job = this.engine.jobs().find((item) => item.checkoutTime && item.nextCheckInTime);
    if (!job) {
      return this.fail("I only save a time you stated. Say the checkout and the next check-in, like 10:30 AM and 3:00 PM.");
    }
    this.file.released = true;
    this.persist();
    await this.engine.releaseCleanerTexts();
    const sentOptIn = this.engine.outbox().some((item) => item.kind === "opt-in" && item.status === "sent");
    return this.reply({
      next: sentOptIn
        ? "Times saved. The cleaner got one text asking them to reply YES. Nothing else goes to them until they do."
        : "Times saved. Nothing was sent.",
      turns: this.turns(),
    });
  }

  async markGuestsLeft(input: { said?: string }, pinKey: Buffer | undefined): Promise<ToolReply> {
    if (!this.file.host || !this.file.checked) return this.fail("Run the checks first.");
    const said = input.said?.trim() ?? "";
    const phrase = stripFiller(normalize(said)).replace(/^the\s+/, "");
    if (!DEPARTURES.has(phrase)) return this.fail("Say that the guests have left. I won't guess from the calendar.");
    if (!pinKey) return this.fail(PIN_KEY_MISSING);
    if (this.unlock(pinKey) !== "ready") return this.fail(PIN_REENTER);
    this.resume();
    if (this.pin) this.engine?.rememberPin(this.pin);
    if (!this.engine) return this.fail("Run the checks first.");
    if (this.file.pinSend?.outcome === "settled") return this.reply({ next: PIN_REPEAT });
    if (this.engine.jobOnHold()) {
      const line = this.heldDepartureLine();
      if (line === optedOutCodeLine()) this.engine.keepHostNote(`host:pin-held:${line}`, line);
      return this.reply({ next: line });
    }
    if (this.engine.pinAccepted()) return this.reply({ next: PIN_REPEAT });
    const result = await this.engine.receive({ id: `left-${randomUUID()}`, from: this.file.host, text: said });
    if (result.reason !== "departure") return this.fail("Say that the guests have left. I won't guess from the calendar.");
    const heldLine = result.sent.find((text) => text.kind === "pin-held")?.body;
    const sentNow = result.sent.some((text) => text.kind === "pin");
    const privateNow = result.sent.some((text) => text.kind === "pin" && text.channel !== "group");
    const failed = result.sent.some((text) => text.kind === "pin-failed") || this.engine.outbox().some((item) => item.kind === "pin" && item.status === "failed");
    if (groupChatOn(this.env()) && this.engine.groupPinSettled() && !sentNow) {
      this.file.pinSend = { sid: this.file.pinSend?.sid ?? "", outcome: "settled", notePending: false };
      this.persist();
      return this.reply({ next: "A text failed to send. I saved it for your review and did not count it as delivered." });
    }
    if (sentNow && groupChatOn(this.env()) && !privateNow) {
      this.file.pinSend = { sid: this.file.pinSend?.sid ?? "group", outcome: "accepted", notePending: false };
      this.persist();
    }
    if (heldLine) return this.reply({ next: heldLine });
    if (sentNow) return this.reply({ next: PIN_SENT });
    if (failed) return this.reply({ next: PIN_FAILED });
    return this.reply({ next: PIN_FAILED });
  }

  async resumeCleaning(): Promise<ToolReply> {
    this.resume();
    if (!this.file.address || !this.engine) return this.fail("Run the checks first.");
    await this.engine.resumeJob();
    this.syncHold();
    this.persist();
    return this.reply({ next: resumeNote(this.file.address) });
  }

  resetScratch(): ToolReply {
    const guard = this.scratchGuard();
    if (guard) return this.fail(guard);
    this.engine = undefined;
    rmSync(join(this.root, "cleaner-job"), { recursive: true, force: true });
    this.file.seenInbound = [];
    this.file.cleanerOut = false;
    this.file.released = false;
    delete this.file.pinSend;
    delete this.file.conversationSid;
    delete this.file.deliveries;
    delete this.file.localSends;
    this.held = false;
    this.persist();
    return this.reply({ next: SCRATCH_RESET_LINE });
  }

  readInbox(): ToolReply {
    const guard = this.scratchGuard();
    if (guard) return this.fail(guard);
    this.resume();
    const lines = (this.engine?.transcript() ?? []).flatMap((line) => {
      const formatted = this.inboxFromTranscript(line);
      return formatted ? [formatted] : [];
    });
    return this.reply({ lines });
  }

  readOutbox(): ToolReply {
    const guard = this.scratchGuard();
    if (guard) return this.fail(guard);
    this.resume();
    return this.reply({ lines: this.outboxRows().map((row) => row.line) });
  }

  async sendTestText(input: { from?: string; text?: string }): Promise<ToolReply> {
    const guard = this.scratchGuard(input.from ?? "");
    if (guard) return this.fail(guard);
    const text = input.text?.trim() ?? "";
    if (!text) return this.fail(SCRATCH_TEXT_NEEDED);
    await this.inbound({ id: `scratch-${randomUUID()}`, from: input.from ?? "", text });
    return this.reply({ next: SCRATCH_TEST_WENT_THROUGH });
  }

  async reportDelivery(input: { which?: string; status?: string }): Promise<ToolReply> {
    const guard = this.scratchGuard();
    if (guard) return this.fail(guard);
    const status = input.status?.trim().toLowerCase() ?? "";
    if (!isDeliveryReport(status)) return this.fail(SCRATCH_STATUS_NEEDED);
    this.resume();
    const which = input.which?.trim().toLowerCase() ?? "";
    const rows = this.outboxRows();
    const exactLine = rows.filter((row) => row.line.toLowerCase() === which);
    const exactLabel = rows.filter((row) => row.label.toLowerCase() === which);
    const contains = rows.filter((row) => which.length > 0 && row.label.toLowerCase().includes(which));
    if (exactLine.length === 0 && exactLabel.length === 0 && contains.length > 1) return this.fail(SCRATCH_WHICH_NEEDED);
    const matches = exactLine.length > 0 ? exactLine : exactLabel.length > 0 ? exactLabel : contains;
    const row = matches[matches.length - 1];
    if (!row) return this.fail(SCRATCH_TEXT_MISSING);
    if (row.kind === "pin" && !row.local) await this.applyPinReport(row.id, status);
    else this.setDelivery(row, status);
    const updated = this.outboxRows().find((item) => item.id === row.id);
    return this.reply({ next: updated?.line ?? row.line });
  }

  /** Records a Twilio delivery status. Does not unseal the door code. A failure tells the host once. */
  async notePinDelivery(input: { sid: string; status: string }): Promise<void> {
    const tracked = this.file.pinSend;
    if (!tracked || tracked.outcome === "settled" || tracked.sid !== input.sid) return;
    this.resume();
    const pinId = [...this.outboxRows()].reverse().find((item) => item.kind === "pin" && !item.local)?.id;
    if (!pinId) return;
    await this.applyPinReport(pinId, input.status.toLowerCase());
  }

  async inbound(input: { id: string; from: string; text: string; channel?: "group" }): Promise<{ sent: CleanerText[] }> {
    const from = parsePhone(input.from);
    if (!from || !isAllowlisted(this.env(), from)) return { sent: [] };
    if (this.claiming.has(input.id)) return { sent: [] };
    if (this.file.seenInbound?.includes(input.id)) {
      this.resume();
      return { sent: [] };
    }
    this.claiming.add(input.id);
    try {
      if (from === this.file.host) return await this.hostText(input.id, from, input.text);
      this.resume();
      const keyword = messagingKeyword(input.text);
      if (!this.engine) return { sent: await this.inboundBeforeJob(input.id, from, keyword) };
      const result = await this.engine.receive({ id: input.id, from, text: input.text, ...(input.channel ? { channel: input.channel } : {}) });
      this.noteSeen(input.id);
      this.syncHold();
      return { sent: result.sent };
    } finally {
      this.claiming.delete(input.id);
    }
  }

  private readonly claiming = new Set<string>();

  private async inboundBeforeJob(id: string, from: string, keyword: ReturnType<typeof messagingKeyword>): Promise<CleanerText[]> {
    if (keyword !== "stop" && keyword !== "start") return [];
    if (keyword === "stop" && from === this.file.cleaner) {
      this.held = true;
      this.file.cleanerOut = true;
    }
    if (keyword === "start" && from === this.file.cleaner) {
      this.held = false;
      this.file.cleanerOut = false;
    }
    this.noteSeen(id);
    const address = this.file.address ?? "the property";
    const body =
      keyword === "stop"
        ? `You're opted out of cleaning texts for ${address}. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.`
        : "You're opted back in to cleaning texts. Reply YES if you still want this turnover. Reply STOP to opt out.";
    if (this.scratchCapture()) {
      this.noteLocal(from, keyword);
      return [{ to: from, body, kind: keyword }];
    }
    if (!liveSmsOn(this.env())) return [];
    try {
      await sendLiveSms(this.env(), { to: from, body });
      return [{ to: from, body, kind: keyword }];
    } catch {
      return [];
    }
  }

  private cleaningState(): Record<string, unknown> {
    const done: string[] = [];
    if (this.file.address) done.push("Property saved.");
    if (this.file.cleaner) done.push("Cleaner and observer saved.");
    if (this.file.calendarLink) done.push("Calendar link saved.");
    if (this.pin) done.push("Door code saved.");
    if (this.file.texting) done.push("Texting saved.");
    if (this.file.checked) done.push("Checks finished.");
    let next = "What's the property address, and what should I call the business?";
    if (!this.file.address) next = "What's the property address, and what should I call the business?";
    else if (!this.file.cleaner) next = "Who is the host, the cleaner, and the observer? Send each phone number.";
    else if (!this.file.calendarLink) next = "What's the calendar link for this property?";
    else if (!this.pin) next = "What's the door code? I'll save it and I won't repeat it.";
    else if (!this.file.texting) next = "Set up texting when you're ready for the cleaner to get a YES text.";
    else if (!this.file.checked) next = "Run the checks. I'll read the calendar and I won't text anyone while I do.";
    else next = "Tell me the checkout time and the next check-in time before I text the cleaner.";
    if (this.held) next = this.holdLine();
    const delivered = this.file.pinSend?.delivered === true && this.file.pinSend.outcome !== "undelivered";
    let notes = (this.engine?.hostNotes() ?? []).filter((line) => delivered || !isPrivateCodeLine(line));
    if (this.engine && !this.engine.pinAccepted()) notes = notes.filter((line) => line !== PIN_SENT);
    if (!this.held && this.privateCodeWaiting()) next = PIN_FAILED;
    return { done, next, ...(this.file.checked ? { turns: this.turns() } : {}), ...(notes.length > 0 ? { notes } : {}) };
  }

  private turns(): Record<string, unknown>[] {
    if (!this.engine) return [];
    return this.engine.jobs().map((job) => ({
      checkoutDate: job.checkoutDate,
      nextCheckInDate: job.nextCheckInDate,
      checkoutTime: job.checkoutTime,
      nextCheckInTime: job.nextCheckInTime,
      status: job.status,
      ...(this.held ? { held: true } : {}),
    }));
  }

  private resume(): void {
    if (this.engine || !this.file.checked) return;
    if (!this.pin && !this.file.pinSeal) return;
    this.engine = this.openEngine();
    this.syncHold();
  }

  private noteSeen(id: string): void {
    const seen = this.file.seenInbound ?? [];
    if (seen.includes(id)) return;
    this.file.seenInbound = [...seen, id];
    this.persist();
  }

  private pinSends(): number {
    if (!this.engine) return 0;
    return this.engine.outbox().filter((item) => item.kind === "pin" && item.status === "sent").length;
  }

  private openEngine(): CleanerCore {
    const file = this.file;
    if (!file.host || !file.cleaner || !file.address || !file.timeZone || !file.propertyId || !file.business) {
      throw new Error("Setup is incomplete.");
    }
    const env = this.env;
    const dataDir = join(this.root, "cleaner-job");
    mkdirSync(dataDir, { recursive: true });
    return openCleanerCore({
      enabled: true,
      property: { id: file.propertyId, address: file.address, timeZone: file.timeZone },
      ownerPhone: file.host,
      cleaner: { phone: file.cleaner, approved: true },
      ...(this.pin ? { pin: this.pin } : {}),
      hostName: file.business,
      consented: true,
      allowlist: smsAllowlist(env()),
      holdSends: () => this.checking || (!liveSmsOn(env()) && !this.scratchCapture()),
      deferCleanerTexts: this.file.released !== true,
      ...(this.file.cleanerOut ? { cleanerConsent: "out" as const } : {}),
      optInBody: `Hi, this is ${file.business} at ${file.address}. You're getting this because you clean between guest stays. Reply YES to get cleaning texts, or STOP to opt out.`,
      stopReply: `You're opted out of cleaning texts for ${file.address}. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.`,
      noteHostOnStop: true,
      isolate: true,
      tenantId: file.propertyId,
      sealPinAtRest: false,
      pinSentBody: PIN_SENT,
      pinFailedBody: PIN_FAILED,
      ...(groupChatOn(env()) ? { groupChat: { hostName: "Cory", cleanerName: "Maria" } } : {}),
      sink: {
        send: async (text) => {
          const hostLine = text.to === file.host && text.channel !== "group";
          if (hostLine && text.kind !== "pin-notice" && text.kind !== "pin-failed") {
            this.engine?.keepHostNote(`host:${text.kind}:${text.body}`, text.body);
          }
          if (!liveSmsOn(env())) {
            if (text.kind === "pin") this.noteAccepted("scratch-pin");
            return;
          }
          const address = file.address;
          const holdSms = Boolean(address) && text.body === cleanerOptOutHold(address ?? "");
          if (hostLine && text.kind !== "pin-failed" && !SAFETY.has(text.kind) && !holdSms) return;
          if (text.channel === "group" && text.audience && text.audience.length > 0) {
            try {
              const sent = await sendLiveGroup(env(), { audience: [...text.audience], body: text.body, conversationSid: this.file.conversationSid });
              if (sent?.conversationSid) this.file.conversationSid = sent.conversationSid;
              if (text.kind === "pin" && sent?.sid) this.noteAccepted(sent.sid);
            } catch (err) {
              if (err instanceof GroupNotConfirmed && err.conversationSid) this.file.conversationSid = err.conversationSid;
              throw err;
            }
            return;
          }
          const statusCallback = text.kind === "pin" ? cleanerPinStatusUrl(env()) : undefined;
          const sid = await sendLiveSms(env(), { to: text.to, body: text.body, ...(statusCallback ? { statusCallback } : {}) });
          if (text.kind === "pin" && sid) this.noteAccepted(sid);
        },
      },
      now: this.now,
      dataDir,
    });
  }

  private scratchGuard(from?: string): string | undefined {
    if (!scratchToolsOn(this.env())) return SCRATCH_PROPERTY_REFUSAL;
    if (from !== undefined && !isScratchTestNumber(from)) return SCRATCH_NUMBER_REFUSAL;
    if (!isScratchPropertyAddress(this.file.address)) return SCRATCH_PROPERTY_REFUSAL;
    const saved = [this.file.host, this.file.cleaner, this.file.observer].filter((phone): phone is string => Boolean(phone));
    if (saved.some((phone) => !isScratchTestNumber(phone))) return SCRATCH_NUMBER_REFUSAL;
    if (from !== undefined) {
      const parsed = parsePhone(from);
      if (!parsed || !saved.includes(parsed)) return SCRATCH_NUMBER_REFUSAL;
    }
    return undefined;
  }

  private scratchCapture(): boolean {
    return this.scratchGuard() === undefined;
  }

  private inboxFromTranscript(line: string): string | undefined {
    const match = /^(\+\d+): (.*)$/.exec(line);
    if (!match?.[1]) return undefined;
    return inboxLine(whoTheyAre(match[1], this.file), this.hideCode(match[2] ?? ""));
  }

  private hideCode(text: string): string {
    if (!this.pin || !text.includes(this.pin)) return text;
    return text.split(this.pin).join("[redacted]");
  }

  private outboxRows(): OutboxRow[] {
    const people = this.file;
    const engineRows = (this.engine?.outbox() ?? []).map((item) => {
      const shown = item.kind === "pin" ? this.engine?.pinShownStatus(item.id) : undefined;
      const saved = shown ? undefined : this.file.deliveries?.find((row) => row.id === item.id)?.status;
      const status = shown ?? saved ?? (item.status === "sent" ? "sent" : item.status === "failed" ? "failed" : item.status === "canceled" ? "canceled" : "waiting");
      const role = whoTheyAre(item.to, people);
      return { id: item.id, kind: item.kind, local: false, label: outboxLabel(item.kind, role), line: outboxLine(item.kind, role, status) };
    });
    const localRows = (this.file.localSends ?? []).map((item) => {
      const role = whoTheyAre(item.to, people);
      return { id: item.id, kind: item.kind, local: true, label: outboxLabel(item.kind, role), line: outboxLine(item.kind, role, item.status) };
    });
    return [...engineRows, ...localRows];
  }

  private setDelivery(row: OutboxRow, status: DeliveryReport): void {
    if (row.local) {
      const item = this.file.localSends?.find((send) => send.id === row.id);
      if (item) item.status = status;
    } else {
      const deliveries = (this.file.deliveries ?? []).filter((item) => item.id !== row.id);
      deliveries.push({ id: row.id, status });
      this.file.deliveries = deliveries;
    }
    this.persist();
  }

  private noteLocal(to: string, kind: TextKind): void {
    const sends = this.file.localSends ?? [];
    sends.push({ id: `local-${randomUUID()}`, to, kind, status: "sent" });
    this.file.localSends = sends;
    this.persist();
  }

  private reply(result: Record<string, unknown>): ToolReply {
    const json = JSON.stringify(result);
    if (this.leaks(json)) return { ok: false, error: "That didn't work. Try again." };
    return { ok: true, result };
  }

  private fail(error: string): ToolReply {
    if (this.leaks(error)) return { ok: false, error: "That didn't work. Try again." };
    return { ok: false, error };
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as LiveFile;
    this.file = parsed;
    if (parsed.cleanerOut) this.held = true;
  }

  private persist(): void {
    const json = `${JSON.stringify(this.file)}\n`;
    if (this.pin && json.includes(this.pin)) throw new Error("Could not seal the door code.");
    this.writeFile(json);
  }

  private writeFile(json: string): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.path, json);
  }

  private unlock(pinKey: Buffer): "ready" | "closed" {
    if (!this.file.pinSeal) return this.pin ? "ready" : "closed";
    try {
      const opened = openPin(this.file.pinSeal, pinKey);
      if (!/^\d{4,8}$/.test(opened)) return "closed";
      this.pin = opened;
      return "ready";
    } catch {
      return "closed";
    }
  }

  private noteAccepted(sid: string): void {
    this.file.pinSend = { sid, outcome: "accepted", notePending: false };
    this.persist();
  }

  private privateCodeWaiting(): boolean {
    if (!groupChatOn(this.env()) || !this.engine) return false;
    const tracked = this.file.pinSend;
    if (tracked?.delivered === true && tracked.outcome !== "undelivered") return false;
    if (tracked?.outcome === "undelivered") return true;
    if (tracked?.sid === "group" || tracked?.outcome === "settled" || tracked?.outcome === "accepted") return false;
    return this.engine.outbox().some((item) => item.kind === "pin" && (item.status === "failed" || item.status === "uncertain"));
  }

  private withFailure(reply: ToolReply, failure: string | undefined): ToolReply {
    if (!failure || !reply.ok) return reply;
    return this.reply({ ...reply.result, next: failure });
  }

  async runReminders(): Promise<void> {
    this.resume();
    await this.engine?.runReminders();
  }

  private holdLine(): string {
    const address = this.file.address ?? "the property";
    return this.engine?.holdNotice() ?? (this.engine?.cleanerHasOptedOut() || this.file.cleanerOut ? cleanerOptOutHold(address) : jobHoldLine(address));
  }

  private heldDepartureLine(): string {
    if (this.engine?.cleanerHasOptedOut()) return optedOutCodeLine();
    return this.engine?.holdNotice() ?? jobHoldLine(this.file.address ?? "the property");
  }

  private syncHold(): void {
    this.held = this.file.cleanerOut === true || this.engine?.jobOnHold() === true || this.engine?.cleanerHasOptedOut() === true;
  }

  private async applyPinReport(id: string, status: string): Promise<void> {
    this.resume();
    const tracked = this.file.pinSend;
    const latest = [...this.outboxRows()].reverse().find((item) => item.kind === "pin" && !item.local)?.id;
    if (tracked && id === latest) {
      if (status === "sent" || status === "queued") return;
      if (status === "delivered") {
        if (tracked.outcome === "undelivered" || tracked.delivered) {
          await this.engine?.reportPin(id, status);
          return;
        }
        tracked.delivered = true;
        this.persist();
      } else if ((status === "failed" || status === "undelivered") && tracked.outcome !== "undelivered") {
        tracked.delivered = false;
        tracked.outcome = "undelivered";
        this.persist();
      }
    }
    await this.engine?.reportPin(id, status);
  }

  private async hostText(id: string, from: string, text: string): Promise<{ sent: CleanerText[] }> {
    this.noteSeen(id);
    const keyword = messagingKeyword(text);
    if (keyword === "stop" || keyword === "start" || isInjuryReport(text)) {
      this.resume();
      if (!this.engine) {
        if (keyword === "stop" || keyword === "start") return { sent: await this.inboundBeforeJob(id, from, keyword) };
        return { sent: [] };
      }
      const result = await this.engine.receive({ id, from, text });
      this.syncHold();
      return { sent: result.sent };
    }
    const phrase = stripFiller(normalize(text)).replace(/^the\s+/, "");
    if (!DEPARTURES.has(phrase)) {
      if (!groupChatOn(this.env())) return { sent: [] };
      this.resume();
      if (!this.engine) return { sent: [] };
      const result = await this.engine.receive({ id, from, text });
      this.syncHold();
      return { sent: result.sent };
    }
    this.resume();
    this.engine?.keepHostNote("host:direct-left", DIRECT_TEXT_REPLY);
    if (this.scratchCapture()) this.noteLocal(from, "held");
    return { sent: [] };
  }
}
