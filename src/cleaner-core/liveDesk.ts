import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parsePhone } from "../core/phone";
import { messagingKeyword, normalize } from "../intent";
import { stripFiller } from "../intent/normalize";
import { spokenTimes } from "../core/spokenTime";
import { interpretFeed } from "./calendar";
import { openCleanerCore, type CleanerCore, type CleanerText } from "./core";
import { readPublicCalendar, type CalendarFetch } from "./fetchLimits";
import { isAllowlisted, liveSmsOn, sendLiveSms, smsAllowlist } from "./liveSms";
import { openPin, pinKeyFor, sealPin, type PinSeal } from "./pinSeal";

export const FIRST_QUESTION =
  "What do you want help with? 1) Letting renters tour a unit on their own, or 2) Scheduling cleaners between guest stays.";

const TOUR_PICK = "That's Tour Core. It lets renters tour a unit on their own.";
const CLEANER_PICK =
  "That's Cleaner Core. It schedules cleaners between guest stays. What's the property address, and what should I call the business?";

const DEPARTURES = new Set(["guests have left", "guests left", "they have left", "they left", "departed", "left"]);

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
  texting?: boolean;
  checked?: boolean;
  released?: boolean;
  cleanerOut?: boolean;
  seenInbound?: string[];
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

  getState(said?: string): ToolReply {
    if (this.file.choice === "cleaners") this.resume();
    if (!this.file.choice) {
      const pick = said ? choiceOf(said) : undefined;
      if (!pick) return this.reply({ done: [], next: FIRST_QUESTION });
      this.file.choice = pick;
      this.persist();
      if (pick === "tours") return this.reply({ done: [], next: TOUR_PICK });
      return this.reply({ done: ["You chose cleaning."], next: CLEANER_PICK });
    }
    if (this.file.choice === "tours") return this.reply({ done: ["You chose touring."], next: "What's the property you want renters to tour?" });
    return this.reply(this.cleaningState());
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

  saveDoorCode(input: { code?: string }): ToolReply {
    if (!this.file.calendarLink || !this.file.propertyId) return this.fail("Save the calendar link first.");
    const code = input.code?.trim() ?? "";
    if (!/^\d{4,8}$/.test(code)) return this.fail("Send the door code as 4 to 8 digits.");
    this.pin = code;
    this.file.pinSeal = sealPin(code, pinKeyFor(this.file.propertyId));
    this.persist();
    return this.reply({
      next: "Saved the door code. It goes only to the cleaner, in a private text, after you say the guests have left.",
    });
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
    await this.engine.receive({ id: `confirm-out-${randomUUID()}`, from: this.file.host, text: checkout });
    await this.engine.receive({ id: `confirm-in-${randomUUID()}`, from: this.file.host, text: checkIn });
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

  async markGuestsLeft(input: { said?: string }): Promise<ToolReply> {
    this.resume();
    if (!this.engine || !this.file.host) return this.fail("Run the checks first.");
    const said = input.said?.trim() ?? "";
    const phrase = stripFiller(normalize(said)).replace(/^the\s+/, "");
    if (!DEPARTURES.has(phrase)) return this.fail("Say that the guests have left. I won't guess from the calendar.");
    const before = this.pinSends();
    const result = await this.engine.receive({ id: `left-${randomUUID()}`, from: this.file.host, text: said });
    if (result.reason !== "departure") return this.fail("Say that the guests have left. I won't guess from the calendar.");
    const sentNow = result.sent.some((text) => text.kind === "pin");
    const failed = result.sent.some((text) => text.kind === "pin-failed") || this.engine.outbox().some((item) => item.kind === "pin" && item.status === "failed");
    if (sentNow) return this.reply({ next: "Door code sent to the cleaner." });
    if (before > 0) return this.reply({ next: "The cleaner already has the door code." });
    if (failed || !liveSmsOn(this.env())) return this.reply({ next: "The door code didn't reach the cleaner." });
    return this.reply({ next: "The door code didn't reach the cleaner." });
  }

  async inbound(input: { id: string; from: string; text: string }): Promise<{ sent: CleanerText[] }> {
    const from = parsePhone(input.from);
    if (!from || !isAllowlisted(this.env(), from)) return { sent: [] };
    if (this.claiming.has(input.id)) return { sent: [] };
    if (this.file.seenInbound?.includes(input.id)) {
      this.resume();
      return { sent: [] };
    }
    this.claiming.add(input.id);
    try {
      this.resume();
      const keyword = messagingKeyword(input.text);
      if (!this.engine) return { sent: await this.inboundBeforeJob(input.id, from, keyword) };
      const result = await this.engine.receive({ id: input.id, from, text: input.text });
      this.noteSeen(input.id);
      if (from === this.file.cleaner && keyword === "stop") this.held = this.engine?.cleanerHasOptedOut() === true;
      if (from === this.file.cleaner && keyword === "start") this.held = false;
      return { sent: result.sent };
    } finally {
      this.claiming.delete(input.id);
    }
  }

  private readonly claiming = new Set<string>();

  private async inboundBeforeJob(id: string, from: string, keyword: ReturnType<typeof messagingKeyword>): Promise<CleanerText[]> {
    if (keyword !== "stop" && keyword !== "help" && keyword !== "start") return [];
    if (keyword === "stop" && from === this.file.cleaner) {
      this.held = true;
      this.file.cleanerOut = true;
    }
    if (keyword === "start" && from === this.file.cleaner) {
      this.held = false;
      this.file.cleanerOut = false;
    }
    this.noteSeen(id);
    if (!liveSmsOn(this.env())) return [];
    const address = this.file.address ?? "the property";
    const body =
      keyword === "stop"
        ? `You're opted out of cleaning texts for ${address}. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.`
        : keyword === "start"
          ? "You're opted back in to cleaning texts. Reply YES if you still want this turnover. Reply STOP to opt out."
          : "Need help with this cleaning? Reply here and the host will see it. Reply STOP to opt out.";
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
    if (this.held) next = "The cleaner opted out of cleaning texts, so the job is on hold.";
    return { done, next, ...(this.file.checked ? { turns: this.turns() } : {}) };
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
    if (this.engine || !this.file.checked || !this.pin) return;
    this.engine = this.openEngine();
    this.held = this.engine.cleanerHasOptedOut();
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
    if (!file.host || !file.cleaner || !file.address || !file.timeZone || !file.propertyId || !file.business || !this.pin) {
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
      pin: this.pin,
      hostName: file.business,
      consented: true,
      allowlist: smsAllowlist(env()),
      holdSends: () => this.checking || !liveSmsOn(env()),
      deferCleanerTexts: this.file.released !== true,
      ...(this.file.cleanerOut ? { cleanerConsent: "out" as const } : {}),
      optInBody: `Hi, this is ${file.business} at ${file.address}. You're getting this because you clean between guest stays. Reply YES to get cleaning texts, or STOP to opt out.`,
      stopReply: `You're opted out of cleaning texts for ${file.address}. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.`,
      noteHostOnStop: true,
      isolate: true,
      tenantId: file.propertyId,
      sink: {
        send: (text) => sendLiveSms(env(), text),
      },
      now: this.now,
      dataDir,
    });
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
    if (parsed.pinSeal && parsed.propertyId) {
      try {
        const opened = openPin(parsed.pinSeal, pinKeyFor(parsed.propertyId));
        if (/^\d{4,8}$/.test(opened)) this.pin = opened;
      } catch {
        this.pin = undefined;
      }
    }
  }

  private persist(): void {
    mkdirSync(this.root, { recursive: true });
    for (let attempt = 0; attempt < 8; attempt++) {
      if (this.pin && this.file.propertyId) this.file.pinSeal = sealPin(this.pin, pinKeyFor(this.file.propertyId));
      const json = `${JSON.stringify(this.file)}\n`;
      if (this.pin && json.includes(this.pin)) continue;
      writeFileSync(this.path, json);
      return;
    }
    throw new Error("Could not seal the door code.");
  }
}
