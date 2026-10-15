import { randomUUID } from "node:crypto";
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
import { openCleanerCore, SAFETY, type CleanerCore, type CleanerText, type TextKind } from "./core";
import { groupChatEnabled } from "./flag";
import { calendarUrlAllowed, readPublicCalendar, type CalendarFetch } from "./fetchLimits";
import { cleanerOptOutHold, hostStartReply, hostStopReply, isPrivateCodeLine, jobHoldLine, optedOutCodeLine, resumeNote } from "./cleanerTexts";
import { isInjuryReport } from "./injury";
import { GroupNotConfirmed } from "./groupThread";
import { cleanerPinStatusUrl, isAllowlisted, liveSmsOn, sendLiveGroup, sendLiveSms, smsAllowlist } from "./liveSms";
import { openPin, sealPin, type PinSeal } from "./pinSeal";
import { isScratchTestNumber } from "./scratch";
import { googleCalendarSource, type GoogleEventList } from "./sources";
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
const PEOPLE_ASK = "Who is the host and the cleaner? Send each phone number. An observer is optional.";

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
  seenInbound?: string[];
  conversationSid?: string;
  deliveries?: { id: string; status: DeliveryReport }[];
  localSends?: { id: string; to: string; kind: TextKind; status: DeliveryReport; body?: string }[];
}

interface CalendarRead {
  guestyFailed: boolean;
  reason?: string;
  googleUnread: boolean;
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

function propertyIdFor(business: string): string {
  const slug = business.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "property";
  return `live-${slug}`;
}

export class LiveDesk {
  private file: LiveFile = {};
  private pin: string | undefined;
  private engine: CleanerCore | undefined;
  private checking = false;
  private queue: Promise<void> = Promise.resolve();
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
    this.alerts.enqueue(cleaningUpdateEvent(this.now()));
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
    return this.reply({ next: PEOPLE_ASK });
  }

  savePeople(input: { host?: string; cleaner?: string; observer?: string }): ToolReply {
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
    this.file.host = host;
    this.file.cleaner = cleaner;
    if (observer) this.file.observer = observer;
    else delete this.file.observer;
    this.persist();
    this.engine = undefined;
    return this.reply({ next: CALENDAR_ASK });
  }

  saveCalendarLink(input: { url?: string; google?: boolean }): ToolReply {
    if (!this.file.cleaner) return this.fail("Save the host and the cleaner first.");
    const url = input.url?.trim() ?? "";
    if (!url && !input.google) return this.fail("Send the Guesty Lite link, or say you use Google Calendar.");
    if (url && !url.startsWith("https://")) return this.fail("Send a public https calendar link.");
    if (url) this.file.calendarLink = url;
    if (input.google) this.file.google = true;
    this.persist();
    return this.reply({ next: "What's the door code? I'll save it and I won't repeat it." });
  }

  saveDoorCode(input: { code?: string }, pinKey: Buffer | undefined): ToolReply {
    if (!(this.file.calendarLink || this.file.google) || !this.file.propertyId) return this.fail("Save the calendar link first.");
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

  /** Runs `work` after every earlier serial job has settled, so two checks never overlap. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
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
    const shown = new Set(this.file.alertsShown ?? []);
    const fresh = [...this.visibleNotes(engine), ...this.newBookingAlert(engine)].filter((note) => !shown.has(note.id));
    this.file.alertsShown = [...shown, ...fresh.map((note) => note.id)];
    this.persist();
    return this.reply({
      alerts: fresh.map((note) => note.body),
      turns: this.turns(),
      ...(this.needsTimes(engine) ? { needsTimes: true as const } : {}),
      ...(read.guestyFailed ? { guestyUnread: true as const } : {}),
      ...(read.googleUnread ? { googleUnread: true as const } : {}),
    });
  }

  private async runChecksNow(input: { googleEvents?: GoogleEventList }): Promise<ToolReply> {
    if (!this.file.texting || !(this.file.calendarLink || this.file.google) || !this.pin) return this.fail("Set up texting first.");
    if (!this.file.host || !this.file.cleaner || !isAllowlisted(this.env(), this.file.host) || !isAllowlisted(this.env(), this.file.cleaner)) {
      return this.fail("I can text the host and the cleaner only after those numbers are approved for texts.");
    }
    if (this.file.google && !input.googleEvents) return this.fail("Read Google Calendar and pass its events.");
    const before = this.engine;
    this.engine = this.openEngine();
    this.checking = true;
    let read: CalendarRead;
    try {
      read = await this.readCalendars(input.googleEvents, { skipGoogleOnGuestyFailure: true });
    } catch (err) {
      this.engine = before;
      throw err;
    } finally {
      this.checking = false;
    }
    if (read.guestyFailed) {
      this.engine = before;
      return this.fail(read.reason ?? "I couldn't read that calendar.");
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
   * Reads every saved booking source into the engine. Guesty Lite first, then Google. A failed
   * Guesty read does not stop Google, unless the caller says so. An unread Google source is reported.
   */
  private async readCalendars(googleEvents?: GoogleEventList, options: { skipGoogleOnGuestyFailure?: boolean } = {}): Promise<CalendarRead> {
    const engine = this.engine;
    const file = this.file;
    if (!engine) throw new Error("Setup is incomplete.");
    let guestyFailed = false;
    let reason: string | undefined;
    if (file.calendarLink) {
      const read = await readPublicCalendar(file.calendarLink, calendarFetch ?? fetch);
      if (read.ok) await engine.pollFeed(read.body);
      else {
        guestyFailed = true;
        reason = read.reason;
      }
    }
    let googleUnread = false;
    if (googleEvents && file.propertyId && !(guestyFailed && options.skipGoogleOnGuestyFailure)) {
      const google = await engine.readSource(googleCalendarSource(googleEvents, file.propertyId));
      googleUnread = !google.polled;
    }
    return { guestyFailed, ...(reason ? { reason } : {}), googleUnread };
  }

  /**
   * With group chat on, the engine asks the host nothing about a new booking, because Grok collects
   * the times with confirm_times. This alert names the job confirm_times would time, so check_now
   * reports the booking once. It is not a host note, so get_state is unchanged. A job the host
   * already timed is left to needsTimes.
   */
  private newBookingAlert(engine: CleanerCore): { id: string; body: string }[] {
    if (!groupChatEnabled(this.env()) || !this.file.address || !this.file.timeZone) return [];
    const job = engine.jobs().find((item) => item.status !== "canceled" && item.status !== "declined");
    if (!job || job.status !== "discovered" || job.checkoutTime || (this.file.timedJobs ?? []).includes(job.id)) return [];
    const day = formatWhen(zonedInstant(job.checkoutDate, "12:00", this.file.timeZone), this.file.timeZone).day;
    return [{ id: `new-booking:${job.id}`, body: `New booking at ${this.file.address}, checking out ${day}. What are the checkout time and the next check-in time?` }];
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
    if (groupChatEnabled(this.env())) {
      await this.engine.confirmHostTimes({ checkout, checkIn });
    } else {
      await this.engine.receive({ id: `confirm-out-${randomUUID()}`, from: this.file.host, text: checkout });
      // The engine reads a lone time as the checkout while the job is still open. When the next
      // check-in is already stored (a moved stay keeps it), a second text would overwrite the checkout.
      if (!this.checkInStored(this.engine)) {
        await this.engine.receive({ id: `confirm-in-${randomUUID()}`, from: this.file.host, text: checkIn });
      }
    }
    const job = this.engine.jobs().find((item) => item.checkoutTime && item.nextCheckInTime);
    if (!job) {
      return this.fail("I only save a time you stated. Say the checkout and the next check-in, like 10:30 AM and 3:00 PM.");
    }
    this.file.released = true;
    this.file.timedJobs = [...new Set([...(this.file.timedJobs ?? []), ...this.engine.jobs().filter((item) => item.checkoutTime && item.nextCheckInTime).map((item) => item.id)])];
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
    if (groupChatEnabled(this.env()) && this.engine.groupPinSettled() && !sentNow) {
      this.file.pinSend = { sid: this.file.pinSend?.sid ?? "", outcome: "settled", notePending: false };
      this.persist();
      return this.reply({ next: "A text failed to send. I saved it for your review and did not count it as delivered." });
    }
    if (sentNow && groupChatEnabled(this.env()) && !privateNow) {
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
    const before = this.visibleNoteIds();
    await this.pinDeliveryNow(input);
    this.queueNewAlerts(before);
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
  async inbound(input: { id: string; from: string; text: string; channel?: "group" }): Promise<{ sent: CleanerText[] }> {
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

  private cleaningState(): Record<string, unknown> {
    const done: string[] = [];
    if (this.file.address) done.push("Property saved.");
    if (this.file.cleaner) done.push(this.file.observer ? "Cleaner and observer saved." : "Cleaner saved.");
    if (this.file.calendarLink) done.push("Calendar link saved.");
    if (this.file.google) done.push("Google Calendar saved.");
    if (this.pin) done.push("Door code saved.");
    if (this.file.texting) done.push("Texting saved.");
    if (this.file.texting && groupChatEnabled(this.env())) {
      done.push(this.file.observer ? "Group chat set up with you, the cleaner, and the observer." : "Group chat set up with you and the cleaner.");
    }
    if (this.file.checked) done.push("Checks finished.");
    let next = "What's the property address, and what should I call the business?";
    if (!this.file.address) next = "What's the property address, and what should I call the business?";
    else if (!this.file.cleaner) next = PEOPLE_ASK;
    else if (!this.file.calendarLink && !this.file.google) next = CALENDAR_ASK;
    else if (!this.pin) next = "What's the door code? I'll save it and I won't repeat it.";
    else if (!this.file.texting) next = "Set up texting when you're ready for the cleaner to get a YES text.";
    else if (!this.file.checked) next = "Run the checks. I'll read the calendar and I won't text anyone while I do.";
    else if (!this.env().CLEANER_CORE_ROUTINE_URL?.trim()) next = ROUTINE_ASK;
    else next = "Tell me the checkout time and the next check-in time before I text the cleaner.";
    if (this.held) next = this.holdLine();
    const notes = this.engine ? this.visibleNotes(this.engine).map((note) => note.body) : [];
    if (!this.held && this.privateCodeWaiting()) next = PIN_FAILED;
    return { done, next, ...(this.file.checked ? { turns: this.turns() } : {}), ...(notes.length > 0 ? { notes } : {}) };
  }

  /**
   * True when a job the host already timed has lost a time. With group chat on, a moved stay clears
   * the checkout time without a host note, so check_now flags it for Grok to ask. A job the host
   * never timed (the next stay on the calendar) is not asked about here.
   */
  private needsTimes(engine: CleanerCore): boolean {
    const timed = new Set(this.file.timedJobs ?? []);
    return engine.jobs().some((job) => timed.has(job.id) && job.status !== "canceled" && job.status !== "done" && (!job.checkoutTime || !job.nextCheckInTime));
  }

  /** True when the job the host is answering about already has its next check-in time saved. */
  private checkInStored(engine: CleanerCore): boolean {
    const open = new Set(["discovered", "awaiting_checkin", "host_confirmed", "offered"]);
    return Boolean(engine.jobs().find((job) => open.has(job.status))?.nextCheckInTime);
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
    const observer = parsePhone(file.observer ?? "");
    mkdirSync(dataDir, { recursive: true });
    return openCleanerCore({
      enabled: true,
      property: { id: file.propertyId, address: file.address, timeZone: file.timeZone },
      ownerPhone: file.host,
      cleaner: { phone: file.cleaner, approved: true },
      ...(this.pin ? { pin: this.pin } : {}),
      hostName: file.business,
      consented: file.texting === true,
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
      ...(groupChatEnabled(env())
        ? {
            groupChat: {
              hostName: "Cory",
              cleanerName: "Maria",
              ...(observer ? { extra: [{ phone: observer, name: "Observer" }] } : {}),
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
          if (hostLine && text.kind !== "pin-failed" && !SAFETY.has(text.kind) && !holdSms && !readySms) return;
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
    if (!groupChatEnabled(this.env()) || !this.engine) return false;
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
      if (!groupChatEnabled(this.env())) return { sent: [] };
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
