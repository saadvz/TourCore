import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cleaningUpdateEvent, GrokRoutineWebhookSink, testEvent } from "../alerts/operatorEvents";
import { OperatorEventOutbox } from "../alerts/outbox";
import { parsePhone } from "../core/phone";
import { FileRuntimeStore } from "../storage/runtimeStore";
import { messagingKeyword, normalize } from "../intent";
import { stripFiller } from "../intent/normalize";
import { spokenTimes } from "../core/spokenTime";
import { formatWhen, zonedInstant } from "./calendar";
import { openCleanerCore, SAFETY, type CleanerCore, type CleanerText, type SourceClaim, type TextKind } from "./core";
import { groupChatEnabled } from "./flag";
import { calendarUrlAllowed, readPublicCalendar, type CalendarFetch } from "./fetchLimits";
import { cleanerOptOutHold, hostStartReply, hostStopReply, isPrivateCodeLine, jobHoldLine, optedOutCodeLine, resumeNote } from "./cleanerTexts";
import { isInjuryReport } from "./injury";
import { GroupNotConfirmed } from "./groupThread";
import { cleanerPinStatusUrl, isAllowlisted, liveSmsOn, sendLiveGroup, sendLiveSms, smsAllowlist } from "./liveSms";
import { openPin, sealPin, type PinSeal } from "./pinSeal";
import { isScratchTestNumber } from "./scratch";
import { googleCalendarSource, guestyLiteSource, icalSource, type BookingSource, type GoogleEventList, type SourceSnapshot } from "./sources";
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
const CALENDAR_ASK = "Where do bookings come from? Send the Guesty Lite link, and tell me if you also use Google Calendar.";
const ROUTINE_ASK = "Create the Cleaner Core Check and Cleaner Core Alerts routines, then save the alert routine's address and key with the secure card.";
const PROPERTY_ASK = "What's the property address, what should I call the business, and what are the usual checkout and check-in times?";
const PEOPLE_ASK =
  "Who is the cleaner? Send their name and phone number, and the host's phone number. Extra contacts, like a co-host, an assistant, or an observer, are optional. Should texts go to the cleaner alone, to a group with the cleaner and you, or to a group with everyone?";
const SCHEDULE_ASK =
  "When should the cleaner get texts? The first cleaning text goes when you confirm the times, or a set number of days after check-in. The reminder goes the morning of checkout, or a set number of days before at a set time. Any quiet hours, and who should hear about problems? If the defaults are fine, save an empty schedule.";
const PREFERENCES_ASK =
  "Any cleaning preferences? A checklist, whether photos are required, whether the cleaner may send supply notes, and other instructions. If there are none, save empty preferences.";
const REVIEW_ASK = "Summarize this setup for the host in your own words, then ask them to reply Activate.";

const DEPARTURES = new Set(["guests have left", "guests left", "they have left", "they left", "departed", "left"]);

const PIN_SENT = "I sent the door code to the cleaner. I'll tell you if it doesn't go through.";
const PIN_FAILED = "The door code didn't reach the cleaner. Tell your Grok Bot the guests have left and I'll resend it.";
const PIN_REPEAT = "I already sent the door code to the cleaner.";
const PIN_KEY_MISSING = "I can't send the door code yet. Let's finish setting up Cleaner Core first.";
const PIN_REENTER = "Please enter the door code again in the private box. Don't text it here.";
export const DOOR_CODE_IN_CHAT = "Please don't send the door code in chat. Use the private box instead.";
const DIRECT_TEXT_REPLY = "Got it. To send the door code, tell your Grok Bot the guests have left. The cleaner is still waiting for the OK.";
const ROUTINE_SAVED = "Alerts are connected. I queued a test alert for the routine.";
const ROUTINE_NEEDED = "Send the routine's https address and its key.";
const GOOGLE_UNREAD = "I couldn't read those Google Calendar events. Read Google Calendar again and pass its events.";
const DOOR_CODE_ASK = "What's the door code, and where is the lock? I'll save the code and I won't repeat it.";
const MAX_CALENDARS = 8;
const MAX_CONTACTS = 4;
const MAX_NAME = 40;
const MAX_LOCK_LOCATION = 80;
const MAX_CHECKLIST = 12;
const MAX_CHECKLIST_ITEM = 80;
const MAX_INSTRUCTIONS = 300;
const MIN_SCHEDULE_DAYS = 1;
const MAX_SCHEDULE_DAYS = 14;
/** A timed first cleaning text goes at this local time on its day. */
const FIRST_TEXT_TIME = "09:00";
const FIRST_TEXTS = ["when-confirmed", "days-after-check-in"] as const;
const REMINDERS = ["morning-of", "days-before-checkout"] as const;
const DEFAULT_SCHEDULE: Schedule = { firstText: "when-confirmed", reminder: "morning-of", reminderTime: "08:00" };
const CONTACT_ROLES = ["co-host", "assistant", "observer"] as const;
const GROUP_CHOICES = ["cleaner-only", "cleaner-and-host", "everyone"] as const;

export type ContactRole = (typeof CONTACT_ROLES)[number];
export type GroupChoice = (typeof GROUP_CHOICES)[number];

interface Contact {
  name: string;
  role: ContactRole;
  phone: string;
}

/** The messaging schedule. Times are "HH:MM". */
interface Schedule {
  firstText: (typeof FIRST_TEXTS)[number];
  /** Days after check-in, for days-after-check-in. */
  firstTextDays?: number;
  reminder: (typeof REMINDERS)[number];
  /** Days before checkout, for days-before-checkout. */
  reminderDays?: number;
  reminderTime: string;
  quietFrom?: string;
  quietUntil?: string;
  /** Who should hear about problems. Recorded for the review; problems still go to the host. */
  escalateTo?: string;
}

interface Preferences {
  checklist: string[];
  photosRequired: boolean;
  supplyNotes: boolean;
  instructions?: string;
}
/** The name a legacy single calendar link reads as. Its source id stays `guesty-lite`. */
const LEGACY_CALENDAR = "Guesty Lite";

interface PinSend {
  sid: string;
  outcome: "accepted" | "undelivered" | "settled";
  notePending: boolean;
  delivered?: boolean;
}

export interface ToolOk {
  ok: true;
  result: Record<string, unknown>;
}

export interface ToolNo {
  ok: false;
  error: string;
  /** Details for Grok beside the refusal, such as the cleanings a save would call off. */
  result?: Record<string, unknown>;
}

export type ToolReply = ToolOk | ToolNo;

interface LiveFile {
  choice?: "tours" | "cleaners";
  business?: string;
  nickname?: string;
  address?: string;
  propertyType?: string;
  timeZone?: string;
  /** The usual checkout and check-in times, as "HH:MM". */
  checkoutTime?: string;
  checkInTime?: string;
  propertyId?: string;
  host?: string;
  cleaner?: string;
  cleanerName?: string;
  /** The legacy single observer from save_people. It reads as one contact named Observer. */
  observer?: string;
  contacts?: Contact[];
  /** Unset keeps every saved contact in the group, as before the choice existed. */
  groupChat?: GroupChoice;
  /** Where the lock is. Never digits that could be a code. */
  lockLocation?: string;
  /** Set once the host saved a messaging schedule, or kept the defaults. */
  schedule?: Schedule;
  /** Set once the host saved cleaning preferences or said there are none. */
  preferences?: Preferences;
  /** Legacy single link from save_calendar_link. It reads as one calendar named Guesty Lite. */
  calendarLink?: string;
  /** Saved calendar links in dedupe order, after the legacy link. Each one is the source `ical:<slug>`. */
  calendars?: { name: string; url: string }[];
  google?: boolean;
  pinSeal?: PinSeal;
  pinSend?: PinSend;
  texting?: boolean;
  checked?: boolean;
  /** Ids of the host notes `check_now` has already returned, or that the host saw before it. */
  alertsShown?: string[];
  /** Ids of the host notes that already woke the cleaning routine. */
  alertsQueued?: string[];
  released?: boolean;
  /** Ids of the jobs the host gave both times for through confirm_times. */
  timedJobs?: string[];
  cleanerOut?: boolean;
  hostOut?: boolean;
  seenInbound?: string[];
  conversationSid?: string;
  deliveries?: { id: string; status: DeliveryReport }[];
  localSends?: { id: string; to: string; kind: TextKind; status: DeliveryReport; body?: string }[];
}

interface CalendarRead {
  /** The legacy Guesty Lite link did not read. */
  guestyFailed: boolean;
  /** Why the first failed link did not read. Never the URL. */
  reason?: string;
  googleUnread: boolean;
  /** Names of the calendar links that were not applied. Never a URL. */
  unread: string[];
}

interface SavedCalendar {
  name: string;
  url: string;
  sourceId: string;
  /** A hash of the link, so a held snapshot follows the link and not the name. */
  origin: string;
}

interface OutboxRow {
  id: string;
  kind: TextKind;
  local: boolean;
  label: string;
  line: string;
  status: string;
  body: string;
}

let calendarFetch: CalendarFetch | undefined;

/** Tests stub the calendar read. Unset uses the platform fetch. */
export function setCleanerCalendarFetch(fetchImpl: CalendarFetch | undefined): void {
  calendarFetch = fetchImpl;
}

type AlertFetch = NonNullable<NonNullable<ConstructorParameters<typeof GrokRoutineWebhookSink>[1]>["fetch"]>;

let alertFetch: AlertFetch | undefined;

/** Tests stub the routine webhook. Unset uses the platform fetch. */
export function setCleanerAlertFetch(fetchImpl: AlertFetch | undefined): void {
  alertFetch = fetchImpl;
}

const desks = new Map<string, LiveDesk>();

/**
 * One desk per state folder. The first caller's env getter is kept, so the server passes a live
 * one (`() => installation.env()`) and a secret saved later is seen at once.
 */
export function liveDeskFor(root: string, env: () => NodeJS.ProcessEnv, now: () => Date): LiveDesk {
  const existing = desks.get(root);
  if (existing) return existing;
  const desk = new LiveDesk(root, env, now);
  desks.set(root, desk);
  return desk;
}

/** Delivers the cleaning routine's pending wake-ups. The server's retry timer calls this. */
export async function drainCleanerAlerts(root: string, env: () => NodeJS.ProcessEnv, now: () => Date): Promise<void> {
  await liveDeskFor(root, env, now).drainAlerts();
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

/** Lowercase, each run of other characters as one dash, at most 32 characters, and unique. */
function calendarSlug(name: string, used: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "calendar";
  for (let count = 1; ; count++) {
    const suffix = count === 1 ? "" : `-${count}`;
    const slug = `${base.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (used.has(slug)) continue;
    used.add(slug);
    return slug;
  }
}

function originOf(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/** The saved calendar links with their source ids. A legacy single link reads as Guesty Lite and comes first. */
function calendarsOf(file: LiveFile): SavedCalendar[] {
  const used = new Set<string>();
  const legacy = file.calendarLink ? [{ name: LEGACY_CALENDAR, url: file.calendarLink, sourceId: "guesty-lite", origin: originOf(file.calendarLink) }] : [];
  const named = (file.calendars ?? []).map((calendar) => ({
    name: calendar.name,
    url: calendar.url,
    sourceId: `ical:${calendarSlug(calendar.name, used)}`,
    origin: originOf(calendar.url),
  }));
  return [...legacy, ...named];
}

/** Every saved source in dedupe order, as the engine holds them. */
function claimsOf(file: LiveFile): SourceClaim[] {
  return [...calendarsOf(file).map((calendar) => ({ id: calendar.sourceId, origin: calendar.origin })), ...(file.google ? [{ id: "google-calendar" }] : [])];
}

function hasSources(file: LiveFile): boolean {
  return calendarsOf(file).length > 0 || file.google === true;
}

/** Stamps a read with the hash of the link it came from. */
function fromLink(source: BookingSource, origin: string): BookingSource {
  return { kind: source.kind, read: async () => ({ ...(await source.read()), origin }) };
}

/** A stated clock time with AM or PM, like "10:30 AM", as "HH:MM". Anything else is undefined. */
function usualTime(text: string): string | undefined {
  const times = spokenTimes(normalize(text));
  const time = times[0];
  if (times.length !== 1 || !time?.meridiem) return undefined;
  const hour = (time.hour % 12) + (time.meridiem === "PM" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

/** "HH:MM" as "10:30 AM". */
function clockText(hm: string): string {
  const [hour = 0, minute = 0] = hm.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/** The saved extra contacts. A legacy observer reads as one contact named Observer and comes first. */
function contactsOf(file: LiveFile): Contact[] {
  return [...(file.observer ? [{ name: "Observer", role: "observer" as const, phone: file.observer }] : []), ...(file.contacts ?? [])];
}

function propertyIdFor(business: string): string {
  const slug = business.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "property";
  return `live-${slug}`;
}

type JobView = ReturnType<CleanerCore["jobs"]>[number];

/** A job has its times when it has a checkout time, and a next check-in time if a next stay is booked. */
function hasTimes(job: JobView): boolean {
  return Boolean(job.checkoutTime && (job.nextCheckInTime || !job.nextCheckInDate));
}

/**
 * The job confirm_times would time: the first one that is not called off, declined, started, or done.
 * A finished cleaning is never timed again, so a later booking is the one asked about.
 */
function timesTarget(engine: CleanerCore): JobView | undefined {
  const closed = new Set(["canceled", "declined", "in_progress", "done"]);
  return engine.jobs().find((job) => !closed.has(job.status));
}

export class LiveDesk {
  private file: LiveFile = {};
  private pin: string | undefined;
  private engine: CleanerCore | undefined;
  private checking = false;
  private queue: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private held = false;
  private readonly path: string;
  private readonly alerts: OperatorEventOutbox;

  constructor(
    private readonly root: string,
    private readonly env: () => NodeJS.ProcessEnv,
    private readonly now: () => Date,
  ) {
    this.path = join(root, "cleaner-live.json");
    this.load();
    // The routine's address and key are read from the env on every delivery, never saved here.
    this.alerts = new OperatorEventOutbox(
      new FileRuntimeStore(join(root, "cleaner-alerts")),
      () =>
        new GrokRoutineWebhookSink(
          { url: () => this.env().CLEANER_CORE_ROUTINE_URL?.trim() || undefined, key: () => this.env().CLEANER_CORE_ROUTINE_KEY?.trim() || undefined },
          alertFetch ? { fetch: alertFetch } : {},
        ),
      { now: () => this.now().getTime() },
    );
  }

  /**
   * Saves the cleaning routine's webhook address and token through `save` (the secret store) and
   * queues a test wake-up. Neither value is kept in this desk's file or repeated in the reply.
   * The door-code key is never accepted as the token.
   */
  saveAlertRoutine(
    input: { url?: string; token?: string },
    save: (values: { CLEANER_CORE_ROUTINE_URL: string; CLEANER_CORE_ROUTINE_KEY: string }) => void,
    pinKey?: Buffer,
  ): ToolReply {
    const url = input.url?.trim() ?? "";
    const token = input.token?.trim() ?? "";
    if (!calendarUrlAllowed(url) || token.length < 8) return this.fail(ROUTINE_NEEDED);
    if (pinKey && token === pinKey.toString("base64")) return this.fail(ROUTINE_NEEDED);
    save({ CLEANER_CORE_ROUTINE_URL: url, CLEANER_CORE_ROUTINE_KEY: token });
    this.alerts.enqueue(testEvent(this.now()));
    this.startDrain();
    return this.reply({ next: ROUTINE_SAVED });
  }

  /** Delivers every pending wake-up that is due. A routine that is down or not saved leaves them pending. */
  async drainAlerts(): Promise<void> {
    await this.alerts.drain();
  }

  private startDrain(): void {
    void this.drainAlerts().catch(() => undefined);
  }

  /** Ids of the host notes visible now. Taken before a path Grok doesn't see, so only that path's notes wake the routine. */
  private visibleNoteIds(): Set<string> {
    this.resume();
    return new Set(this.engine ? this.visibleNotes(this.engine).map((note) => note.id) : []);
  }

  /**
   * Wakes the cleaning routine once when a host note became visible since `before` and the host
   * has not seen it yet. The event carries no content: Grok reads the notes with `check_now`.
   */
  private queueNewAlerts(before: Set<string>): void {
    const engine = this.engine;
    if (!engine) return;
    const queued = new Set(this.file.alertsQueued ?? []);
    const shown = new Set(this.file.alertsShown ?? []);
    const fresh = this.visibleNotes(engine).filter((note) => !before.has(note.id) && !queued.has(note.id) && !shown.has(note.id));
    if (fresh.length === 0) return;
    // One waiting wake-up is enough: check_now returns every note that is new by then. Without a
    // routine saved, a wake-up per note would arrive later as a backlog of identical wake-ups.
    const waiting = this.alerts.records().some((record) => record.event.eventType === "cleaning.update" && record.status === "pending");
    if (!waiting) this.alerts.enqueue(cleaningUpdateEvent(this.now()));
    this.file.alertsQueued = [...queued, ...fresh.map((note) => note.id)];
    this.persist();
    this.startDrain();
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

  saveProperty(input: {
    address?: string;
    business?: string;
    timeZone?: string;
    nickname?: string;
    propertyType?: string;
    checkoutTime?: string;
    checkInTime?: string;
  }): ToolReply {
    if (this.file.choice !== "cleaners") return this.fail("Tell me which job you want help with first.");
    const address = input.address?.trim() ?? "";
    const business = input.business?.trim() ?? "";
    const timeZone = input.timeZone?.trim() ?? "";
    if (!address || !business || !timeZone.includes("/")) {
      return this.fail("I need the business name, the property address, and the time zone.");
    }
    const nickname = input.nickname?.trim() ?? "";
    const propertyType = input.propertyType?.trim() ?? "";
    if (nickname.length > MAX_NAME || propertyType.length > MAX_NAME) return this.fail(`Keep the nickname and the property type under ${MAX_NAME} characters.`);
    const checkoutText = input.checkoutTime?.trim() ?? "";
    const checkInText = input.checkInTime?.trim() ?? "";
    const checkoutTime = checkoutText ? usualTime(checkoutText) : undefined;
    const checkInTime = checkInText ? usualTime(checkInText) : undefined;
    if ((checkoutText && !checkoutTime) || (checkInText && !checkInTime)) {
      return this.fail("Send the usual checkout and check-in times like 11:00 AM and 3:00 PM.");
    }
    this.file.business = business;
    this.file.address = address;
    this.file.timeZone = timeZone;
    this.file.propertyId = propertyIdFor(business);
    this.keep("nickname", nickname || undefined);
    this.keep("propertyType", propertyType || undefined);
    if (checkoutTime) this.file.checkoutTime = checkoutTime;
    if (checkInTime) this.file.checkInTime = checkInTime;
    this.persist();
    // The engine reads the usual times when it opens.
    this.engine = undefined;
    return this.reply({ next: this.setupNext() });
  }

  /**
   * Saves the host, the cleaner (with an optional name), up to four extra contacts, and the
   * group-chat choice. Each save replaces the saved people. The legacy observer counts as a contact.
   */
  savePeople(input: {
    host?: string;
    cleaner?: string;
    observer?: string;
    cleanerName?: string;
    contacts?: { name?: string; role?: string; phone?: string }[];
    groupChat?: string;
  }): ToolReply {
    if (!this.file.address) return this.fail("Save the property first.");
    const host = parsePhone(input.host ?? "");
    const cleaner = parsePhone(input.cleaner ?? "");
    const observerText = input.observer?.trim() ?? "";
    const observer = observerText ? parsePhone(observerText) : undefined;
    if (!host || !cleaner || host === cleaner) {
      return this.fail("I need two different phone numbers: the host and the cleaner. An observer is optional.");
    }
    if (observerText && !observer) return this.fail("Send the observer as a phone number, or leave that number out.");
    if (observer && (observer === host || observer === cleaner)) {
      return this.fail("The observer has to be a different phone number from the host and the cleaner.");
    }
    const cleanerName = input.cleanerName?.trim() ?? "";
    if (cleanerName.length > MAX_NAME) return this.fail(`Keep the cleaner's name under ${MAX_NAME} characters.`);
    const groupChat = input.groupChat?.trim() ?? "";
    if (groupChat && !(GROUP_CHOICES as readonly string[]).includes(groupChat)) {
      return this.fail("Choose who gets the texts: cleaner-only, cleaner-and-host, or everyone.");
    }
    const contacts: Contact[] = [];
    const used = new Set([host, cleaner, ...(observer ? [observer] : [])]);
    for (const contact of input.contacts ?? []) {
      const name = contact.name?.trim() ?? "";
      const role = contact.role?.trim() ?? "";
      const phone = parsePhone(contact.phone ?? "");
      if (!name || name.length > MAX_NAME) return this.fail(`Give each contact a name under ${MAX_NAME} characters.`);
      if (!(CONTACT_ROLES as readonly string[]).includes(role)) return this.fail("Each contact is a co-host, an assistant, or an observer.");
      if (!phone) return this.fail(`Send ${name}'s phone number.`);
      if (used.has(phone)) return this.fail("Each person needs a different phone number.");
      if (this.chatCarriesDoorCode(name)) return this.fail(DOOR_CODE_IN_CHAT);
      used.add(phone);
      contacts.push({ name, role: role as ContactRole, phone });
    }
    if (contacts.length + (observer ? 1 : 0) > MAX_CONTACTS) return this.fail(`I can keep up to ${MAX_CONTACTS} extra contacts.`);
    if (this.chatCarriesDoorCode(cleanerName)) return this.fail(DOOR_CODE_IN_CHAT);
    this.file.host = host;
    this.file.cleaner = cleaner;
    if (observer) this.file.observer = observer;
    else delete this.file.observer;
    this.keep("cleanerName", cleanerName || undefined);
    this.keep("contacts", contacts.length > 0 ? contacts : undefined);
    this.keep("groupChat", (groupChat || undefined) as GroupChoice | undefined);
    this.persist();
    this.engine = undefined;
    return this.reply({ next: this.setupNext() });
  }

  /**
   * Saves the messaging schedule: when the first cleaning text goes, when the reminder goes, quiet
   * hours, and who should hear about problems. A field left out keeps what was saved, and `{}` the
   * first time keeps the defaults. Days run 1 to 14 and times are clock times like 8:00 AM. Empty
   * quiet hours clear them. The schedule can only hold a text back. The first cleaning text still
   * waits for the host's confirmed times, and the door code still waits for "guests have left".
   */
  saveSchedule(input: {
    firstText?: "when-confirmed" | "days-after-check-in";
    firstTextDays?: number;
    reminder?: "morning-of" | "days-before-checkout";
    reminderDays?: number;
    reminderTime?: string;
    quietFrom?: string;
    quietUntil?: string;
    escalateTo?: string;
  }): ToolReply {
    if (!this.file.cleaner) return this.fail("Save the host and the cleaner first.");
    const saved = this.file.schedule ?? DEFAULT_SCHEDULE;
    const firstText = input.firstText ?? saved.firstText;
    const reminder = input.reminder ?? saved.reminder;
    if (!(FIRST_TEXTS as readonly string[]).includes(firstText)) return this.fail("Send the first cleaning text when the times are confirmed, or a number of days after check-in.");
    if (!(REMINDERS as readonly string[]).includes(reminder)) return this.fail("Send the reminder the morning of checkout, or a number of days before checkout.");
    const days = (value: number | undefined) => (value !== undefined && Number.isInteger(value) && value >= MIN_SCHEDULE_DAYS && value <= MAX_SCHEDULE_DAYS ? value : undefined);
    const dayRange = `${MIN_SCHEDULE_DAYS} to ${MAX_SCHEDULE_DAYS} days`;
    const firstTextDays = firstText === "days-after-check-in" ? days(input.firstTextDays ?? saved.firstTextDays) : undefined;
    if (firstText === "days-after-check-in" && firstTextDays === undefined) return this.fail(`Say how many days after check-in the first text goes, ${dayRange}.`);
    const reminderDays = reminder === "days-before-checkout" ? days(input.reminderDays ?? saved.reminderDays) : undefined;
    if (reminder === "days-before-checkout" && reminderDays === undefined) return this.fail(`Say how many days before checkout the reminder goes, ${dayRange}.`);
    const reminderText = input.reminderTime?.trim();
    const reminderTime = reminderText === undefined ? saved.reminderTime : usualTime(reminderText);
    if (!reminderTime) return this.fail("Send the reminder time like 8:00 AM.");
    let quiet = saved.quietFrom && saved.quietUntil ? { from: saved.quietFrom, until: saved.quietUntil } : undefined;
    if (input.quietFrom !== undefined || input.quietUntil !== undefined) {
      const fromText = input.quietFrom?.trim() ?? "";
      const untilText = input.quietUntil?.trim() ?? "";
      const from = fromText ? usualTime(fromText) : undefined;
      const until = untilText ? usualTime(untilText) : undefined;
      if (!fromText && !untilText) quiet = undefined;
      else if (!from || !until || from === until) return this.fail("Send both quiet-hours times, like 9:00 PM and 8:00 AM.");
      else quiet = { from, until };
    }
    const escalateTo = input.escalateTo === undefined ? saved.escalateTo : input.escalateTo.trim() || undefined;
    if (escalateTo && escalateTo.length > MAX_NAME) return this.fail(`Keep who hears about problems under ${MAX_NAME} characters.`);
    if (escalateTo && this.chatCarriesDoorCode(escalateTo)) return this.fail(DOOR_CODE_IN_CHAT);
    this.file.schedule = {
      firstText,
      ...(firstTextDays !== undefined ? { firstTextDays } : {}),
      reminder,
      ...(reminderDays !== undefined ? { reminderDays } : {}),
      reminderTime,
      ...(quiet ? { quietFrom: quiet.from, quietUntil: quiet.until } : {}),
      ...(escalateTo ? { escalateTo } : {}),
    };
    this.persist();
    // The engine reads the schedule when it opens.
    this.engine = undefined;
    return this.reply({ next: this.setupNext() });
  }

  saveCalendarLink(input: { url?: string; google?: boolean }): ToolReply {
    if (!this.file.address) return this.fail("Save the property first.");
    const url = input.url?.trim() ?? "";
    if (!url && !input.google) return this.fail("Send the Guesty Lite link, or say you use Google Calendar.");
    if (url && !url.startsWith("https://")) return this.fail("Send a public https calendar link.");
    // Replaces only the Guesty Lite link. Every other saved calendar stays.
    if (url) this.file.calendarLink = url;
    if (input.google) this.file.google = true;
    this.persist();
    return this.reply({ next: this.setupNext() });
  }

  /**
   * Saves the booking sources: the calendar links in the order given, and whether Google Calendar is
   * used. A calendars list replaces every saved link, the legacy one too. Leaving calendars or google
   * out keeps what was saved. A link that is not public https is refused, and the reply never repeats
   * a link. When the change would call off an upcoming cleaning that only a dropped source lists, it
   * is refused with `wouldCancel` until Grok asks the host and passes dropJobs.
   */
  saveSources(input: { calendars?: { name?: string; url?: string }[]; google?: boolean; dropJobs?: boolean }): ToolReply {
    if (!this.file.address) return this.fail("Save the property first.");
    const next: LiveFile = { ...this.file };
    if (input.calendars !== undefined) {
      const calendars = input.calendars.map((calendar) => ({ name: calendar.name?.trim() ?? "", url: calendar.url?.trim() ?? "" }));
      if (calendars.length > MAX_CALENDARS) return this.fail(`I can keep up to ${MAX_CALENDARS} calendar links.`);
      for (const calendar of calendars) {
        if (!calendar.name) return this.fail("Give each calendar link a name, like Airbnb or Vrbo.");
        if (!calendarUrlAllowed(calendar.url)) {
          return this.fail(`I can't use the ${calendar.name} link. It has to be a public https address, and not a private network.`);
        }
      }
      if (calendars.length > 0) next.calendars = calendars;
      else delete next.calendars;
      delete next.calendarLink;
    }
    if (input.google === true) next.google = true;
    if (input.google === false) delete next.google;
    if (!hasSources(next)) return this.fail("Send at least one calendar link, or say you use Google Calendar.");
    if (input.dropJobs !== true) {
      this.resume();
      const lost = this.engine?.wouldCancel(claimsOf(next)) ?? [];
      if (lost.length > 0) {
        const count = `${lost.length} upcoming ${lost.length === 1 ? "cleaning" : "cleanings"}`;
        return this.failWith(`Removing that calendar would call off ${count}. Ask the host, then save again with dropJobs: true.`, { wouldCancel: lost });
      }
    }
    this.file = next;
    this.persist();
    return this.reply({ next: this.setupNext() });
  }

  /**
   * Seals the door code. lockLocation names where the lock is, for the private code text. Leaving it
   * out keeps the saved one, and an empty one clears it. It may not carry a run of 4 or more digits.
   */
  saveDoorCode(input: { code?: string; lockLocation?: string }, pinKey: Buffer | undefined): ToolReply {
    if (!this.file.cleaner || !this.file.propertyId) return this.fail("Save the host and the cleaner first.");
    if (!hasSources(this.file) && !isScratchPropertyAddress(this.file.address)) return this.fail("Save the calendar link first.");
    const code = input.code?.trim() ?? "";
    if (!/^\d{4,8}$/.test(code)) return this.fail("Send the door code as 4 to 8 digits.");
    const lockLocation = input.lockLocation?.trim();
    if (lockLocation && (lockLocation.length > MAX_LOCK_LOCATION || /\d{4,}/.test(lockLocation) || this.chatCarriesDoorCode(lockLocation))) {
      return this.fail(`Say where the lock is in under ${MAX_LOCK_LOCATION} characters, with no code or long number in it.`);
    }
    if (!pinKey) return this.fail(PIN_KEY_MISSING);
    const previousPin = this.pin;
    const previousSeal = this.file.pinSeal;
    const previousLock = this.file.lockLocation;
    this.pin = code;
    if (lockLocation !== undefined) this.keep("lockLocation", lockLocation || undefined);
    for (let attempt = 0; attempt < 8; attempt++) {
      this.file.pinSeal = sealPin(code, pinKey);
      const json = `${JSON.stringify(this.file)}\n`;
      if (json.includes(code) || json.includes(pinKey.toString("base64"))) continue;
      this.writeFile(json);
      // The engine names the lock in the private code text, so it reopens with the new location.
      if (this.file.lockLocation !== previousLock) this.engine = undefined;
      return this.reply({
        next: "Saved the door code. It goes only to the cleaner, in a private text, after you say the guests have left.",
      });
    }
    this.pin = previousPin;
    this.file.pinSeal = previousSeal;
    this.keep("lockLocation", previousLock);
    return this.fail("Could not seal the door code.");
  }

  /**
   * Saves the cleaning preferences. A field left out keeps what was saved, and `{}` the first time
   * means there are none, which still moves setup on to the review.
   */
  savePreferences(input: { checklist?: string[]; photosRequired?: boolean; supplyNotes?: boolean; instructions?: string }): ToolReply {
    if (!this.pin && !this.file.pinSeal) return this.fail("Save the door code first.");
    const saved = this.file.preferences ?? { checklist: [], photosRequired: false, supplyNotes: false };
    const checklist = input.checklist === undefined ? saved.checklist : input.checklist.map((item) => item.trim()).filter((item) => item.length > 0);
    if (checklist.length > MAX_CHECKLIST) return this.fail(`I can keep up to ${MAX_CHECKLIST} checklist items.`);
    if (checklist.some((item) => item.length > MAX_CHECKLIST_ITEM)) return this.fail(`Keep each checklist item under ${MAX_CHECKLIST_ITEM} characters.`);
    const instructions = input.instructions === undefined ? saved.instructions : input.instructions.trim() || undefined;
    if (instructions && instructions.length > MAX_INSTRUCTIONS) return this.fail(`Keep the other instructions under ${MAX_INSTRUCTIONS} characters.`);
    if ([...checklist, instructions ?? ""].some((text) => text && this.chatCarriesDoorCode(text))) return this.fail(DOOR_CODE_IN_CHAT);
    this.file.preferences = {
      checklist,
      photosRequired: input.photosRequired ?? saved.photosRequired,
      supplyNotes: input.supplyNotes ?? saved.supplyNotes,
      ...(instructions ? { instructions } : {}),
    };
    this.persist();
    return this.reply({ next: this.setupNext() });
  }

  setUpTexting(): ToolReply {
    if (!this.pin) return this.fail("Save the door code first.");
    this.file.texting = true;
    this.persist();
    return this.reply({
      next: "Texting is saved. The cleaner gets one text asking them to reply YES, and only after you confirm the checkout and the next check-in.",
    });
  }

  /** Review & Activate: saves texting, then runs the checks. Takes the same input as run_checks. */
  activate(input: { googleEvents?: GoogleEventList } = {}): Promise<ToolReply> {
    if (!this.file.preferences) return Promise.resolve(this.fail("Save the cleaning preferences first, or save empty ones if there are none."));
    const texting = this.setUpTexting();
    if (!texting.ok) return Promise.resolve(texting);
    return this.runChecks(input);
  }

  /**
   * Runs `work` after every earlier serial job has settled, so a check never overlaps a text or a
   * tool step that is still sending. Work already inside the queue calls the inner steps, never a
   * serial entry point, or it would wait on itself. With nothing in flight, `work` starts at once.
   */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const now = (): Promise<T> => {
      try {
        return work();
      } catch (err) {
        return Promise.reject(err);
      }
    };
    const idle = this.inFlight === 0;
    this.inFlight += 1;
    const run = idle ? now() : this.queue.then(now, now);
    this.queue = run.then(
      () => {
        this.inFlight -= 1;
      },
      () => {
        this.inFlight -= 1;
      },
    );
    return run;
  }

  runChecks(input: { googleEvents?: GoogleEventList } = {}): Promise<ToolReply> {
    return this.serial(() => this.runChecksNow(input));
  }

  /**
   * Re-reads the saved calendars, sends reminders that are due, and returns the host alerts
   * that are new since the last call. Google events are applied only when Grok passes them.
   */
  checkNow(input: { googleEvents?: GoogleEventList } = {}): Promise<ToolReply> {
    return this.serial(() => this.checkNowSerial(input));
  }

  private async checkNowSerial(input: { googleEvents?: GoogleEventList }): Promise<ToolReply> {
    this.resume();
    const engine = this.engine;
    if (!this.file.checked || !engine) return this.fail("Run the checks first.");
    const read = await this.readCalendars(input.googleEvents);
    await engine.runReminders();
    this.syncHold();
    this.nudgeCheckout(engine);
    const shown = new Set(this.file.alertsShown ?? []);
    const fresh = [...this.visibleNotes(engine), ...this.newBookingAlert(engine)].filter((note) => !shown.has(note.id));
    this.file.alertsShown = [...shown, ...fresh.map((note) => note.id)];
    this.persist();
    return this.reply({
      alerts: fresh.map((note) => note.body),
      turns: this.turns(),
      ...(this.needsTimes(engine) ? { needsTimes: true as const } : {}),
      ...(read.unread.length > 0 ? { unread: read.unread } : {}),
      // Kept for one release beside `unread`, for Grok setups that still read it.
      ...(read.guestyFailed ? { guestyUnread: true as const } : {}),
      ...(read.googleUnread ? { googleUnread: true as const } : {}),
    });
  }

  private async runChecksNow(input: { googleEvents?: GoogleEventList }): Promise<ToolReply> {
    if (!this.file.texting || !hasSources(this.file) || !this.pin) return this.fail("Set up texting first.");
    if (!this.file.host || !this.file.cleaner || !isAllowlisted(this.env(), this.file.host) || !isAllowlisted(this.env(), this.file.cleaner)) {
      return this.fail("I can text the host and the cleaner only after those numbers are approved for texts.");
    }
    if (this.file.google && !input.googleEvents) return this.fail("Read Google Calendar and pass its events.");
    const before = this.engine;
    this.engine = this.openEngine();
    this.checking = true;
    let read: CalendarRead;
    try {
      read = await this.readCalendars(input.googleEvents, { allOrNothing: true });
    } catch (err) {
      this.engine = before;
      throw err;
    } finally {
      this.checking = false;
    }
    if (read.reason) {
      this.engine = before;
      if (read.guestyFailed) return this.fail(read.reason);
      return this.fail(`I couldn't read the calendar link for ${read.unread.join(", ")}. Each link has to be a public https address, and not a private network.`);
    }
    if (read.googleUnread) {
      this.engine = before;
      return this.fail(GOOGLE_UNREAD);
    }
    this.file.checked = true;
    // run_checks' own reply already asks for the times, so its new-booking alert counts as shown too.
    const seen = [...this.visibleNotes(this.engine), ...this.newBookingAlert(this.engine)].map((note) => note.id);
    this.file.alertsShown = [...new Set([...(this.file.alertsShown ?? []), ...seen])];
    this.persist();
    const turns = this.turns();
    return this.reply({
      next:
        turns.length === 0
          ? "I read the calendar. There's no guest stay yet. I'll tell you when one shows up."
          : "I read the calendar. Tell me the checkout time and the next check-in time before I text the cleaner.",
      turns,
    });
  }

  /**
   * Reads every saved booking source into the engine as one read: the calendar links in saved order,
   * then Google. The engine saves each source's last snapshot, so after a restart a link that fails
   * keeps its snapshot and its jobs. A link that fails is not applied, and is named in `unread`.
   *
   * A saved source the engine holds no snapshot of (never read, or saved before snapshots were kept)
   * and that is not read now would make the others look like they removed its stays, so then nothing
   * is applied. With `allOrNothing` (run_checks), any failed link applies nothing.
   */
  private async readCalendars(googleEvents?: GoogleEventList, options: { allOrNothing?: boolean } = {}): Promise<CalendarRead> {
    const engine = this.engine;
    const file = this.file;
    const tenantId = file.propertyId;
    if (!engine || !tenantId) throw new Error("Setup is incomplete.");
    const calendars = calendarsOf(file);
    const held = new Set(engine.keepSources(claimsOf(file)));
    let googleUnread = false;
    let google: SourceSnapshot | undefined;
    // Google events count only when the host saved Google as a source.
    if (googleEvents && file.google) {
      google = await googleCalendarSource(googleEvents, tenantId).read();
      // Events that are there but none of which reads as a stay or a block are a shape this reader
      // doesn't know. Applying them would remove every Google stay, so the read counts as unread.
      if (googleEvents.items.length > 0 && google.turnovers.length === 0 && google.blocks.length === 0) {
        google = undefined;
        googleUnread = true;
      }
    }
    if (file.google && !google && !held.has("google-calendar")) return { guestyFailed: false, googleUnread, unread: [] };
    const reads = await Promise.all(calendars.map(async (calendar) => ({ calendar, read: await readPublicCalendar(calendar.url, calendarFetch ?? fetch) })));
    const failed = reads.flatMap(({ calendar, read }) => (read.ok ? [] : [{ calendar, reason: read.reason }]));
    const result: CalendarRead = {
      guestyFailed: failed.some((item) => item.calendar.sourceId === "guesty-lite"),
      ...(failed[0] ? { reason: failed[0].reason } : {}),
      googleUnread,
      unread: failed.map((item) => item.calendar.name),
    };
    if (failed.length > 0 && (options.allOrNothing || failed.some((item) => !held.has(item.calendar.sourceId)))) return result;
    const sources: BookingSource[] = [];
    const applied: string[] = [];
    for (const { calendar, read } of reads) {
      if (!read.ok) continue;
      const source = calendar.sourceId === "guesty-lite" ? guestyLiteSource(read.body, tenantId) : icalSource(read.body, tenantId, calendar.sourceId);
      sources.push(fromLink(source, calendar.origin));
      applied.push(calendar.name);
    }
    if (google) {
      const snapshot = google;
      sources.push({ kind: "google-calendar", read: async () => snapshot });
    }
    if (sources.length === 0) return result;
    const polled = (await engine.readSources(sources)).polled;
    if (!polled) {
      result.unread.push(...applied);
      if (google) result.googleUnread = true;
    }
    return result;
  }

  /**
   * With group chat on, the engine asks the host nothing about a new booking, because Grok collects
   * the times with confirm_times. This alert names the job confirm_times would time, so check_now
   * reports the booking once. It is not a host note, so get_state is unchanged. A job the host
   * already timed is left to needsTimes.
   */
  private newBookingAlert(engine: CleanerCore): { id: string; body: string }[] {
    if (!this.groupOn() || !this.file.address || !this.file.timeZone) return [];
    const job = timesTarget(engine);
    if (!job || job.status !== "discovered" || job.checkoutTime || (this.file.timedJobs ?? []).includes(job.id)) return [];
    const day = formatWhen(zonedInstant(job.checkoutDate, "12:00", this.file.timeZone), this.file.timeZone).day;
    const body = engine.newBookingAsk(job.id) ?? `New booking at ${this.file.address}, checking out ${day}. What are the checkout time and the next check-in time?`;
    return [{ id: `new-booking:${job.id}`, body }];
  }

  /**
   * At a confirmed cleaning's checkout time, with no departure recorded yet, keeps one host note
   * asking whether the guests have left. It sends nothing: the door code still waits for the host.
   */
  private nudgeCheckout(engine: CleanerCore): void {
    // A cleaning on hold won't get the code, so the host is not asked.
    if (this.held) return;
    const now = this.now().getTime();
    const name = this.file.nickname ?? this.file.address ?? "the property";
    for (const job of engine.jobs()) {
      if (job.status !== "confirmed" && job.status !== "awaiting_departure") continue;
      if (!job.checkoutAt || Date.parse(job.checkoutAt) > now) continue;
      engine.keepHostNote(`nudge:${job.id}`, `Checkout time at ${name}. Have the guests left?`);
    }
  }

  getTurns(): ToolReply {
    this.resume();
    return this.reply({ turns: this.turns(), ...(this.held ? { held: true } : {}) });
  }

  confirmTimes(input: { checkout?: string; checkIn?: string }): Promise<ToolReply> {
    return this.serial(() => this.confirmTimesNow(input));
  }

  private async confirmTimesNow(input: { checkout?: string; checkIn?: string }): Promise<ToolReply> {
    this.resume();
    if (!this.file.checked || !this.engine || !this.file.host) return this.fail("Run the checks first.");
    const checkout = input.checkout?.trim() ?? "";
    const checkIn = input.checkIn?.trim() ?? "";
    if (!statedClock(checkout) || !statedClock(checkIn)) {
      return this.fail("Tell me the checkout time and the next check-in time, like 10:30 AM and 3:00 PM.");
    }
    const engine = this.engine;
    const target = timesTarget(engine);
    const sentBefore = new Set(engine.outbox().filter((item) => item.status === "sent").map((item) => item.id));
    if (this.groupOn()) {
      await engine.confirmHostTimes({ checkout, checkIn });
    } else {
      await engine.receive({ id: `confirm-out-${randomUUID()}`, from: this.file.host, text: checkout });
      // The engine reads a lone time as the checkout while the job is still open. A stay with no
      // next stay has no check-in to ask about, and when the next check-in is already stored (a
      // moved stay keeps it), a second text would overwrite the checkout.
      const after = engine.jobs().find((item) => item.id === target?.id);
      if (after?.nextCheckInDate && !after.nextCheckInTime) {
        await engine.receive({ id: `confirm-in-${randomUUID()}`, from: this.file.host, text: checkIn });
      }
    }
    const job = engine.jobs().find((item) => item.id === target?.id);
    if (!job || !hasTimes(job)) {
      return this.fail("I only save a time you stated. Say the checkout and the next check-in, like 10:30 AM and 3:00 PM.");
    }
    this.file.released = true;
    this.file.timedJobs = [...new Set([...(this.file.timedJobs ?? []), ...engine.jobs().filter(hasTimes).map((item) => item.id)])];
    this.persist();
    await engine.releaseCleanerTexts();
    // Only the texts this call sent, so an opt-in from an earlier job is not reported again.
    const sentNow = engine.outbox().filter((item) => item.status === "sent" && !sentBefore.has(item.id) && item.to === this.file.cleaner);
    const sent = (kind: TextKind) => sentNow.some((item) => item.kind === kind);
    return this.reply({
      next: sent("opt-in")
        ? "Times saved. The cleaner got one text asking them to reply YES. Nothing else goes to them until they do."
        : sent("offer")
          ? "Times saved. I sent the cleaner the cleaning offer. They reply YES to take it."
          : sent("corrected")
            ? "Times saved. I sent the cleaner the new time."
            : "Times saved. Nothing was sent.",
      turns: this.turns(),
    });
  }

  markGuestsLeft(input: { said?: string }, pinKey: Buffer | undefined): Promise<ToolReply> {
    return this.serial(() => this.markGuestsLeftNow(input, pinKey));
  }

  private async markGuestsLeftNow(input: { said?: string }, pinKey: Buffer | undefined): Promise<ToolReply> {
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
    if (this.groupOn() && this.engine.groupPinSettled() && !sentNow) {
      this.file.pinSend = { sid: this.file.pinSend?.sid ?? "", outcome: "settled", notePending: false };
      this.persist();
      return this.reply({ next: "A text failed to send. I saved it for your review and did not count it as delivered." });
    }
    if (sentNow && this.groupOn() && !privateNow) {
      this.file.pinSend = { sid: this.file.pinSend?.sid ?? "group", outcome: "accepted", notePending: false };
      this.persist();
    }
    if (heldLine) return this.reply({ next: heldLine });
    if (sentNow) return this.reply({ next: PIN_SENT });
    if (failed) return this.reply({ next: PIN_FAILED });
    return this.reply({ next: PIN_FAILED });
  }

  resumeCleaning(): Promise<ToolReply> {
    return this.serial(() => this.resumeCleaningNow());
  }

  private async resumeCleaningNow(): Promise<ToolReply> {
    this.resume();
    if (!this.file.address || !this.engine) return this.fail("Run the checks first.");
    await this.engine.resumeJob();
    this.syncHold();
    this.persist();
    return this.reply({ next: resumeNote(this.file.address) });
  }

  resetScratch(): Promise<ToolReply> {
    return this.serial(async () => this.resetScratchNow());
  }

  private resetScratchNow(): ToolReply {
    const guard = this.scratchGuard();
    if (guard) return this.fail(guard);
    this.engine = undefined;
    rmSync(join(this.root, "cleaner-job"), { recursive: true, force: true });
    this.file.seenInbound = [];
    this.file.cleanerOut = false;
    this.file.released = false;
    delete this.file.pinSend;
    delete this.file.hostOut;
    delete this.file.conversationSid;
    delete this.file.deliveries;
    delete this.file.localSends;
    delete this.file.alertsShown;
    delete this.file.alertsQueued;
    delete this.file.timedJobs;
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
    const rows = this.outboxRows();
    return this.reply({
      lines: rows.map((row) => row.line),
      texts: rows.map((row) => ({ label: row.label, status: row.status, body: this.hideCode(row.body) })),
    });
  }

  sendTestText(input: { from?: string; text?: string }): Promise<ToolReply> {
    return this.serial(() => this.sendTestTextNow(input));
  }

  private async sendTestTextNow(input: { from?: string; text?: string }): Promise<ToolReply> {
    const guard = this.scratchGuard(input.from ?? "");
    if (guard) return this.fail(guard);
    const text = input.text?.trim() ?? "";
    if (!text) return this.fail(SCRATCH_TEXT_NEEDED);
    // Already inside the serial queue, so this calls the inner step, not `inbound`.
    await this.inboundSerial({ id: `scratch-${randomUUID()}`, from: input.from ?? "", text });
    return this.reply({ next: SCRATCH_TEST_WENT_THROUGH });
  }

  addTestTurn(input: { checkout?: string; checkIn?: string }): Promise<ToolReply> {
    return this.serial(() => this.addTestTurnNow(input));
  }

  private async addTestTurnNow(input: { checkout?: string; checkIn?: string }): Promise<ToolReply> {
    const guard = this.testTurnGuard();
    if (guard) return this.fail(guard);
    if (!this.file.texting || !this.pin || !this.file.host || !this.file.cleaner) return this.fail("Set up texting first.");
    const checkout = input.checkout?.trim() ?? "";
    const checkIn = input.checkIn?.trim() ?? "";
    if (!statedClock(checkout) || !statedClock(checkIn)) {
      return this.fail("Tell me the checkout time and the next check-in time, like 10:30 AM and 3:00 PM.");
    }
    this.file.checked = true;
    this.file.released = true;
    this.persist();
    this.resume();
    if (!this.engine) return this.fail("Set up texting first.");
    if (this.pin) this.engine.rememberPin(this.pin);
    const created = await this.engine.addTestTurn({ checkout, checkIn });
    if (!created.created) {
      if (created.reason === "exists") return this.reply({ next: "That test turnover is already saved.", turns: this.turns() });
      if (created.reason === "refused") return this.fail("I can text the host and the cleaner only after those numbers are approved for texts.");
      return this.fail("Tell me the checkout time and the next check-in time, like 10:30 AM and 3:00 PM.");
    }
    const invited = this.engine.outbox().some((item) => item.kind === "opt-in" && item.status === "sent");
    return this.reply({
      next: invited ? "Test turnover saved. Anyone who has not replied YES got only the opt-in text." : "Test turnover saved. Nothing was sent.",
      turns: this.turns(),
    });
  }

  reportDelivery(input: { which?: string; status?: string }): Promise<ToolReply> {
    return this.serial(() => this.reportDeliveryNow(input));
  }

  private async reportDeliveryNow(input: { which?: string; status?: string }): Promise<ToolReply> {
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
  notePinDelivery(input: { sid: string; status: string }): Promise<void> {
    return this.serial(async () => {
      const before = this.visibleNoteIds();
      await this.pinDeliveryNow(input);
      this.queueNewAlerts(before);
    });
  }

  private async pinDeliveryNow(input: { sid: string; status: string }): Promise<void> {
    const tracked = this.file.pinSend;
    if (!tracked || tracked.outcome === "settled" || tracked.sid !== input.sid) return;
    this.resume();
    const pinId = [...this.outboxRows()].reverse().find((item) => item.kind === "pin" && !item.local)?.id;
    if (!pinId) return;
    await this.applyPinReport(pinId, input.status.toLowerCase());
  }

  /** A text from the host, the cleaner, or the group. Grok does not see it, so a new host note wakes the routine. */
  inbound(input: { id: string; from: string; text: string; channel?: "group" }): Promise<{ sent: CleanerText[] }> {
    return this.serial(() => this.inboundSerial(input));
  }

  /** The body of `inbound`, for a caller already inside the serial queue. */
  private async inboundSerial(input: { id: string; from: string; text: string; channel?: "group" }): Promise<{ sent: CleanerText[] }> {
    const before = this.visibleNoteIds();
    const result = await this.inboundNow(input);
    this.queueNewAlerts(before);
    return result;
  }

  private async inboundNow(input: { id: string; from: string; text: string; channel?: "group" }): Promise<{ sent: CleanerText[] }> {
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
      const offered = new Set(this.engine.jobs().filter((job) => job.status === "offered").map((job) => job.id));
      const result = await this.engine.receive({ id: input.id, from, text: input.text, ...(input.channel ? { channel: input.channel } : {}) });
      this.noteCleanerYes(offered);
      this.noteSeen(input.id);
      this.syncHold();
      return { sent: result.sent };
    } finally {
      this.claiming.delete(input.id);
    }
  }

  private readonly claiming = new Set<string>();

  /** The engine tells the host nothing when the cleaner accepts. One note per job, the first time it is confirmed. */
  private noteCleanerYes(offered: Set<string>): void {
    const engine = this.engine;
    if (!engine) return;
    for (const job of engine.jobs()) {
      if (!offered.has(job.id) || job.status !== "confirmed") continue;
      engine.keepHostNote(`cleaner-yes:${job.id}`, `The cleaner said YES to the turnover at ${this.file.address ?? "the property"}.`);
    }
  }

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
    if (from === this.file.host && keyword === "stop") this.file.hostOut = true;
    if (from === this.file.host && keyword === "start") this.file.hostOut = false;
    this.noteSeen(id);
    const address = this.file.address ?? "the property";
    const host = from === this.file.host;
    const body = host
      ? keyword === "stop"
        ? hostStopReply(address, this.held)
        : hostStartReply(address, this.held)
      : keyword === "stop"
        ? `You're opted out of cleaning texts for ${address}. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.`
        : "You're opted back in to cleaning texts. Reply YES if you still want this turnover. Reply STOP to opt out.";
    if (this.scratchCapture()) {
      this.noteLocal(from, keyword, body);
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

  /**
   * The setup steps follow the diagram: property, sources, people, door code, preferences, then
   * review. At review the saved choices come back as `setup` for Grok to summarize in its own words.
   */
  private cleaningState(): Record<string, unknown> {
    const done: string[] = [];
    if (this.file.address) done.push("Property saved.");
    if (this.file.cleaner) done.push(this.peopleLine());
    if (this.file.schedule) done.push("Schedule saved.");
    const calendars = calendarsOf(this.file).length;
    if (calendars === 1) done.push("Calendar link saved.");
    if (calendars > 1) done.push(`${calendars} calendar links saved.`);
    if (this.file.google) done.push("Google Calendar saved.");
    if (this.pin) done.push("Door code saved.");
    const preferences = this.file.preferences;
    if (preferences) {
      const any = preferences.checklist.length > 0 || preferences.photosRequired || preferences.supplyNotes || Boolean(preferences.instructions);
      done.push(any ? "Preferences saved." : "No cleaning preferences.");
    }
    if (this.file.texting) done.push("Texting saved.");
    if (this.file.texting && this.groupOn()) done.push(this.groupLine());
    if (this.file.checked) done.push("Checks finished.");
    let next: string;
    if (!this.file.address) next = PROPERTY_ASK;
    else if (!hasSources(this.file)) next = CALENDAR_ASK;
    else if (!this.file.cleaner) next = PEOPLE_ASK;
    // Setups that saved texting before the schedule step existed skip it.
    else if (!this.file.schedule && !this.file.texting) next = SCHEDULE_ASK;
    else if (!this.pin) next = DOOR_CODE_ASK;
    else if (!this.file.texting) next = preferences ? REVIEW_ASK : PREFERENCES_ASK;
    else if (!this.file.checked) next = "Run the checks. I'll read the calendar and I won't text anyone while I do.";
    else if (!this.env().CLEANER_CORE_ROUTINE_URL?.trim()) next = ROUTINE_ASK;
    else next = "Tell me the checkout time and the next check-in time before I text the cleaner.";
    const review = next === REVIEW_ASK;
    if (this.held) next = this.holdLine();
    const notes = this.engine ? this.visibleNotes(this.engine).map((note) => note.body) : [];
    if (!this.held && this.privateCodeWaiting()) next = PIN_FAILED;
    return {
      done,
      next,
      ...(review && next === REVIEW_ASK ? { setup: this.reviewSetup() } : {}),
      ...(this.file.checked ? { turns: this.turns() } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
  }

  /** The next setup step, for a save tool's reply. */
  private setupNext(): string {
    return String(this.cleaningState().next);
  }

  private peopleLine(): string {
    const contacts = contactsOf(this.file).length;
    if (contacts === 0) return "Cleaner saved.";
    if (this.file.observer && !this.file.contacts) return "Cleaner and observer saved.";
    return `Cleaner and ${contacts} extra ${contacts === 1 ? "contact" : "contacts"} saved.`;
  }

  private groupLine(): string {
    const extra = this.groupExtras();
    if (extra.length === 0) return "Group chat set up with you and the cleaner.";
    if (this.file.observer && extra.length === 1) return "Group chat set up with you, the cleaner, and the observer.";
    return "Group chat set up with you, the cleaner, and your contacts.";
  }

  /**
   * The saved choices, for Grok's review summary. Phones show their last 4 digits only. The door
   * code is never here, and access holds the lock location alone.
   */
  private reviewSetup(): Record<string, unknown> {
    const file = this.file;
    const last4 = (phone: string | undefined) => {
      const four = phone?.replace(/\D/g, "").slice(-4) ?? "";
      return four && !this.leaks(four) ? { phoneLast4: four } : {};
    };
    return {
      property: {
        business: file.business,
        ...(file.nickname ? { nickname: file.nickname } : {}),
        address: file.address,
        ...(file.propertyType ? { propertyType: file.propertyType } : {}),
        timeZone: file.timeZone,
        ...(file.checkoutTime ? { checkoutTime: clockText(file.checkoutTime) } : {}),
        ...(file.checkInTime ? { checkInTime: clockText(file.checkInTime) } : {}),
      },
      sources: { calendars: calendarsOf(file).map((calendar) => calendar.name), google: file.google === true },
      people: {
        host: last4(file.host),
        cleaner: { ...(file.cleanerName ? { name: file.cleanerName } : {}), ...last4(file.cleaner) },
        contacts: contactsOf(file).map((contact) => ({ name: contact.name, role: contact.role, ...last4(contact.phone) })),
        groupChat: file.groupChat ?? "everyone",
        groupThread: this.groupOn(),
      },
      ...(file.schedule ? { schedule: this.reviewSchedule(file.schedule) } : {}),
      access: file.lockLocation ? { lockLocation: file.lockLocation } : {},
      preferences: file.preferences,
    };
  }

  /** The saved schedule with clock times like 8:00 AM. Problems go to the host unless someone else was named. */
  private reviewSchedule(schedule: Schedule): Record<string, unknown> {
    return {
      firstText: schedule.firstText,
      ...(schedule.firstTextDays !== undefined ? { firstTextDays: schedule.firstTextDays } : {}),
      reminder: schedule.reminder,
      ...(schedule.reminderDays !== undefined ? { reminderDays: schedule.reminderDays } : {}),
      reminderTime: clockText(schedule.reminderTime),
      ...(schedule.quietFrom && schedule.quietUntil ? { quietFrom: clockText(schedule.quietFrom), quietUntil: clockText(schedule.quietUntil) } : {}),
      escalateTo: schedule.escalateTo ?? "host",
    };
  }

  /** The engine options for the saved schedule. Without one, the engine keeps its defaults. */
  private scheduleOptions(): Partial<Parameters<typeof openCleanerCore>[0]> {
    const schedule = this.file.schedule;
    if (!schedule) return {};
    const reminderDays = schedule.reminder === "days-before-checkout" ? schedule.reminderDays : undefined;
    return {
      offerTrigger:
        schedule.firstText === "days-after-check-in" && schedule.firstTextDays !== undefined
          ? { kind: "days-after-check-in", days: schedule.firstTextDays, localTime: FIRST_TEXT_TIME }
          : { kind: "when-confirmed" },
      triggers: [{ id: schedule.reminder, kind: schedule.reminder, localTime: schedule.reminderTime, ...(reminderDays !== undefined ? { days: reminderDays } : {}) }],
      ...(schedule.quietFrom && schedule.quietUntil ? { quietHours: { from: schedule.quietFrom, until: schedule.quietUntil } } : {}),
    };
  }

  /** Group texts are on when the server allows them and the host didn't choose cleaner-only. */
  private groupOn(): boolean {
    return groupChatEnabled(this.env()) && this.file.groupChat !== "cleaner-only";
  }

  /** The contacts who join the group. cleaner-and-host leaves them all out. */
  private groupExtras(): { phone: string; name: string }[] {
    if (this.file.groupChat === "cleaner-and-host") return [];
    return contactsOf(this.file).map((contact) => ({ phone: contact.phone, name: contact.name }));
  }

  /** Sets a saved field, or removes it when the value is undefined. */
  private keep<K extends keyof LiveFile>(key: K, value: LiveFile[K] | undefined): void {
    if (value === undefined) delete this.file[key];
    else this.file[key] = value;
  }

  /**
   * True when a job the host already timed has lost a time. With group chat on, a moved stay clears
   * the checkout time without a host note, so check_now flags it for Grok to ask. A job the host
   * never timed (the next stay on the calendar) is not asked about here.
   */
  private needsTimes(engine: CleanerCore): boolean {
    const timed = new Set(this.file.timedJobs ?? []);
    return engine.jobs().some((job) => timed.has(job.id) && job.status !== "canceled" && job.status !== "done" && !hasTimes(job));
  }

  /** The host notes the host may see now. A private-code line waits for delivery, and PIN_SENT for the accepted text. */
  private visibleNotes(engine: CleanerCore): { id: string; body: string }[] {
    const delivered = this.file.pinSend?.delivered === true && this.file.pinSend.outcome !== "undelivered";
    return engine
      .hostNoteEntries()
      .filter((note) => (delivered || !isPrivateCodeLine(note.body)) && (note.body !== PIN_SENT || engine.pinAccepted()));
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
    const env = () => this.env();
    const dataDir = join(this.root, "cleaner-job");
    const extra = this.groupExtras();
    mkdirSync(dataDir, { recursive: true });
    return openCleanerCore({
      enabled: true,
      property: {
        id: file.propertyId,
        address: file.address,
        timeZone: file.timeZone,
        ...(file.checkoutTime ? { defaultCheckout: file.checkoutTime } : {}),
        ...(file.checkInTime ? { defaultCheckIn: file.checkInTime } : {}),
      },
      ...(file.checkoutTime && file.checkInTime ? { usualTimesName: file.nickname ?? file.address } : {}),
      ...this.scheduleOptions(),
      reminderAsksArrival: true,
      ownerPhone: file.host,
      cleaner: { phone: file.cleaner, approved: true },
      ...(this.pin ? { pin: this.pin } : {}),
      ...(file.lockLocation ? { lockLocation: file.lockLocation } : {}),
      hostName: file.business,
      consented: file.texting === true,
      allowlist: smsAllowlist(env()),
      holdSends: () => this.checking || (!liveSmsOn(env()) && !this.scratchCapture()),
      deferCleanerTexts: this.file.released !== true,
      ...(this.file.cleanerOut ? { cleanerConsent: "out" as const } : {}),
      ...(this.file.hostOut ? { ownerOptedOut: true } : {}),
      optInBody: `Hi, this is ${file.business} at ${file.address}. You're getting this because you clean between guest stays. Reply YES to get cleaning texts, or STOP to opt out.`,
      stopReply: `You're opted out of cleaning texts for ${file.address}. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.`,
      noteHostOnStop: true,
      isolate: true,
      tenantId: file.propertyId,
      sealPinAtRest: false,
      pinSentBody: PIN_SENT,
      pinFailedBody: PIN_FAILED,
      ...(this.groupOn()
        ? {
            groupChat: {
              hostName: "Cory",
              cleanerName: file.cleanerName ?? "Maria",
              ...(extra.length > 0 ? { extra } : {}),
            },
          }
        : {}),
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
          const readySms = text.kind === "done";
          const inviteSms = text.kind === "opt-in";
          if (hostLine && text.kind !== "pin-failed" && !SAFETY.has(text.kind) && !holdSms && !readySms && !inviteSms) return;
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

  /** Scratch only. The host and cleaner saved with save_people are allowed even when they are not 555 numbers. */
  private testTurnGuard(): string | undefined {
    if (!scratchToolsOn(this.env())) return SCRATCH_PROPERTY_REFUSAL;
    if (!isScratchPropertyAddress(this.file.address)) return SCRATCH_PROPERTY_REFUSAL;
    return undefined;
  }

  private scratchGuard(from?: string): string | undefined {
    if (!scratchToolsOn(this.env())) return SCRATCH_PROPERTY_REFUSAL;
    if (from !== undefined && !isScratchTestNumber(from)) return SCRATCH_NUMBER_REFUSAL;
    if (!isScratchPropertyAddress(this.file.address)) return SCRATCH_PROPERTY_REFUSAL;
    const saved = [this.file.host, this.file.cleaner, ...contactsOf(this.file).map((contact) => contact.phone)].filter((phone): phone is string => Boolean(phone));
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
      const stored = item.status === "uncertain" ? "waiting" : item.status;
      const status = shown ?? saved ?? stored;
      const role = whoTheyAre(item.to, people);
      return { id: item.id, kind: item.kind, local: false, label: outboxLabel(item.kind, role), line: outboxLine(item.kind, role, status), status, body: item.body };
    });
    const localRows = (this.file.localSends ?? []).map((item) => {
      const role = whoTheyAre(item.to, people);
      return { id: item.id, kind: item.kind, local: true, label: outboxLabel(item.kind, role), line: outboxLine(item.kind, role, item.status), status: item.status, body: item.body ?? "" };
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

  private noteLocal(to: string, kind: TextKind, body = ""): void {
    const sends = this.file.localSends ?? [];
    sends.push({ id: `local-${randomUUID()}`, to, kind, status: "sent", body });
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

  private failWith(error: string, result: Record<string, unknown>): ToolReply {
    if (this.leaks(error) || this.leaks(JSON.stringify(result))) return { ok: false, error: "That didn't work. Try again." };
    return { ok: false, error, result };
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
    if (!this.groupOn() || !this.engine) return false;
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
      if (!this.groupOn()) return { sent: [] };
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
