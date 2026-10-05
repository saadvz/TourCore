import { resolveSpokenTime } from "../core/customSlot";
import { orList, unitsNamedIn } from "../core/questions";
import { isoDate, parseIsoDate } from "../core/schedule";
import { type DayReference, type SpokenTime } from "../core/spokenTime";
import { addDays, formatDay, localDateOf, weekdayOf, zonedParts, type LocalDate } from "../core/timezone";
import { VisitorDenialCopy, type InboundMeta } from "../core/TourCore";
import {
  isConfident,
  keywordOf,
  LayeredIntentInterpreter,
  normalize,
  type Awaiting,
  type IntentInterpretation,
  type IntentInterpreter,
  type InterpretContext,
  type StepAwaiting,
  type StopRef,
  type TourIntent,
} from "../intent";
import type { ReplyPrompt } from "../messaging/presentation";
import { timeMenu } from "./entry";
import type { InterpretationNote, Said, VisitorDemoSession, VisitorStage } from "./session";
import { acceptsOfferedOpening, offerDate, takeOfferedOpening } from "./unavailableDay";
import { SMS_GATE_REMINDER, SMS_KEYWORD_PROMPT, smsDisclosure, smsOptInConfirmation } from "./smsConsent";

/**
 * Typed replies from a real phone ("1", "YES", "just pulled up", "does it
 * have laundry?") mapped onto the same visitor actions the browser phone's
 * buttons use. An interpreter says what the visitor is trying to do; this
 * file decides, deterministically, whether that's clear enough to act on or
 * needs a question back. Whether a door opens is still decided only by Tour
 * Core's policy, exactly as for a button tap.
 *
 * A text is one intent. If it asks a property question and names a custom
 * time, the question is answered and the time is filed only after the visitor
 * confirms it. The time is not dropped.
 */

export { keywordOf, type Keyword } from "../intent";

export const isGreeting = (text: string) => /^(hi|hello|hey|hiya|tour|book|start over|new tour|hi there|good (morning|afternoon|evening))\b/.test(normalize(text));

const SORRY = "Sorry, I didn't catch that.";
const rulesOnly = new LayeredIntentInterpreter();

function stopRef(session: VisitorDemoSession, doorId: string): StopRef {
  const door = session.config.doors.find((d) => d.id === doorId);
  const unit = session.config.units.find((u) => u.doorId === doorId);
  return { doorName: door?.name ?? doorId, kind: door?.kind ?? "COMMON", ...(unit ? { unitName: unit.name } : {}), label: session.stopLabel(doorId) };
}

async function contextFor(session: VisitorDemoSession, message: string, step: VisitorStage, awaiting?: StepAwaiting): Promise<InterpretContext> {
  const r = await session.reservation();
  const remaining = step === "ready" || step === "touring" ? await session.remainingStops() : [];
  return {
    message,
    step,
    ...(awaiting ? { awaiting } : {}),
    units: session.config.units.map((u) => ({ name: u.name, ...(u.summary ? { summary: u.summary } : {}) })),
    timeChoices: step === "choose-date" ? session.offeredDates.map((day) => day.label) : session.offeredSlots.map((s) => s.label),
    ...(r ? { reservedUnit: session.config.units.find((u) => u.id === r.unitId)?.name } : {}),
    remainingStops: remaining.map((id) => stopRef(session, id)),
    doors: session.config.doors.map((d) => stopRef(session, d.id)),
  };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The door a named stop refers to. Only doors on file; the interpreter can't invent one. */
function namedDoor(session: VisitorDemoSession, intent: TourIntent): string | undefined {
  if (intent.type === "AT_UNIT" && intent.unitName) return session.config.units.find((u) => same(u.name, intent.unitName!))?.doorId;
  if (intent.type === "AT_ROUTE_STOP" && intent.stopName) return session.config.doors.find((d) => same(d.name, intent.stopName!))?.id;
  return undefined;
}

type Target = { doorId: string } | { choices: string[] } | { none: true } | { unknownName: true };

/** Which door "I'm at the unit" / "I'm here" means. A reference that fits more than one stop is never guessed. */
function targetOf(session: VisitorDemoSession, intent: TourIntent, remaining: string[]): Target {
  const named = intent.type === "AT_UNIT" ? intent.unitName : intent.type === "AT_ROUTE_STOP" ? intent.stopName : undefined;
  if (named) {
    const doorId = namedDoor(session, intent);
    return doorId ? { doorId } : { unknownName: true };
  }
  const unitDoors = new Set(session.config.units.map((u) => u.doorId));
  const candidates = intent.type === "AT_UNIT" ? remaining.filter((d) => unitDoors.has(d)) : remaining;
  if (candidates.length === 1) return { doorId: candidates[0]! };
  if (candidates.length > 1) return { choices: candidates };
  return { none: true };
}

/** One typed message being handled: its interpretation, and what Tour Core said back. */
class Turn {
  constructor(
    readonly session: VisitorDemoSession,
    readonly said: Said,
    readonly stage: VisitorStage,
    readonly interpretation: IntentInterpretation,
    private readonly note: InterpretationNote,
    /** The step confirmation Tour Core was waiting on when this message arrived. */
    readonly awaiting?: StepAwaiting,
  ) {}

  markClarification(): void {
    this.note.clarification = true;
  }

  get intent(): TourIntent {
    return this.interpretation.intent;
  }

  get confident(): boolean {
    return isConfident(this.interpretation);
  }

  act(action: string, input: unknown = {}): Promise<void> {
    return this.session.act(action, input, this.said);
  }

  /** Records the visitor's text and answers without acting. */
  async respond(body: string, prompt?: ReplyPrompt): Promise<void> {
    await this.session.recordText(this.said);
    await this.session.reply(body, prompt);
  }

  /** Asks instead of acting. `awaiting` gives the visitor's next short reply ("yes", "2") its meaning. */
  async clarify(body: string, prompt?: ReplyPrompt, awaiting?: Awaiting): Promise<void> {
    this.note.clarification = true;
    if (awaiting) this.session.expect(this.stage, awaiting);
    await this.respond(body, prompt);
  }

  /** The rules' own follow-up ("No rush! Text me when...") or a nudge after "ignore your rules...". */
  async fallback(sorry: string, prompt?: ReplyPrompt, hint = ""): Promise<void> {
    const i = this.interpretation;
    if (i.manipulation) return this.clarify(`I can only help with your own tour. Doors open only for the stops on it, during your tour time.${hint}`);
    // A "Text X when..." prompt would repeat the follow-up's own wording; menus and yes/no still apply.
    if (i.clarificationQuestion) return this.clarify(i.clarificationQuestion, prompt?.kind === "say" ? undefined : prompt);
    return this.respond(sorry, prompt);
  }
}

/**
 * The single entry point for a typed message from a visitor. The caller
 * (any messaging webhook) has already verified and de-duplicated it.
 * Returns how the message was read, for the caller's own records.
 */
export async function handleVisitorText(
  session: VisitorDemoSession,
  from: string,
  text: string,
  meta?: InboundMeta,
  interpreter: IntentInterpreter = rulesOnly,
): Promise<IntentInterpretation | undefined> {
  const said: Said = { text, meta };
  const firstMessage = !session.visitor;
  if (firstMessage) session.identify(from);

  // SMS campaign consent comes before any property or booking content.
  if (session.kind === "messaging" && session.smsConsentMode !== "disabled" && session.smsConsent !== "opted_in") {
    await handleSmsGate(session, said, text);
    return undefined;
  }

  // Someone who opted out only gets START / STOP handled; nothing they send is interpreted or answered.
  const keyword = keywordOf(text);
  if (session.optedOut && keyword !== "start" && keyword !== "stop") {
    await session.recordText(said);
    return undefined;
  }

  const stage = await session.stage();
  const pending = session.takeExpected(stage);
  const awaiting = pending?.kind === "which-unit" ? pending.resume : pending;

  // "Which unit do you mean?" was asked for a question: a reply naming one answers that question, then the step resumes.
  if (pending?.kind === "which-unit" && !keyword) {
    const unit = unitFromReply(session, text, pending.units);
    if (unit) {
      const interpretation: IntentInterpretation = { intent: { type: "ASK_PROPERTY_QUESTION", question: pending.question }, confidence: 1, interpreter: "rules", clarificationNeeded: false };
      session.noteInterpretation(interpretation);
      await session.recordText(said);
      const out = await session.askQuestion(pending.question, { meta, unitId: unit.id, alreadyRecorded: true });
      if (out.outcome !== "which-unit") await resumeStep(session, stage, pending.resume);
      return interpretation;
    }
  }

  const interpretation = await interpreter.interpret(await contextFor(session, text, stage, awaiting));
  const note = session.noteInterpretation(interpretation);
  const turn = new Turn(session, said, stage, interpretation, note, awaiting);
  const { intent } = interpretation;

  if (intent.type === "STOP_MESSAGES" && turn.confident) await session.optOut(said);
  else if (intent.type === "START_MESSAGES" && turn.confident) await session.optIn(said);
  else if (keyword === "help") await session.help(said);
  else if (firstMessage) {
    if (intent.type === "SELECT_UNIT" && turn.confident) await chooseUnit(turn);
    else if (intent.type === "REQUEST_CUSTOM_TIME" && turn.confident) await openWithCustomTime(turn);
    else if (intent.type === "ASK_PROPERTY_QUESTION") await ask(turn, intent.question, () => session.welcome());
    else await session.greet(said);
  } else await byStage(turn);
  return interpretation;
}

/**
 * Keyword campaign gate. Property questions, availability, and booking stay
 * closed until the sender replies YES to the disclosure. Tour/record consent
 * is a later step and is not decided here.
 */
async function handleSmsGate(session: VisitorDemoSession, said: Said, text: string): Promise<void> {
  const keyword = keywordOf(text);
  if (keyword === "stop") {
    await session.optOut(said);
    return;
  }
  if (keyword === "help") {
    await session.help(said);
    return;
  }
  const normalized = normalize(text);
  if (keyword === "start" || normalized === "tour") {
    await session.recordText(said);
    await session.allowMessagingAgain();
    session.noteSmsConsent("pending", keyword === "start" ? "START" : "TOUR");
    await session.reply(smsDisclosure(session.complianceBaseUrl?.()), undefined, { deliverDespiteOptOut: true });
    return;
  }
  if (session.smsConsent === "pending" && normalized === "yes") {
    await session.recordText(said);
    await session.allowMessagingAgain();
    session.noteSmsConsent("opted_in", "YES");
    await session.reply(smsOptInConfirmation(), undefined, { deliverDespiteOptOut: true });
    if (!(await session.reservation())) await session.welcome();
    return;
  }
  await session.recordText(said);
  if (session.smsConsent === "opted_out" || session.optedOut) return;
  await session.reply(session.smsConsent === "pending" ? SMS_GATE_REMINDER : SMS_KEYWORD_PROMPT, undefined, { deliverDespiteOptOut: true });
}

/** The unit a short reply points at, among the ones offered: its name ("1A") or its number in the list ("2"). */
function unitFromReply(session: VisitorDemoSession, text: string, offered: string[]) {
  const units = session.config.units.filter((u) => offered.includes(u.name));
  const named = unitsNamedIn(text, units);
  if (named.length === 1) return units.find((u) => u.id === named[0]!.id);
  const n = /^\s*(?:#|number |option )?(\d{1,2})\s*[.!]?\s*$/i.exec(text)?.[1];
  const pick = n ? offered[Number(n) - 1] : undefined;
  return pick ? units.find((u) => u.name === pick) : undefined;
}

/**
 * A property question, at any step. It's answered from approved facts only
 * (or flagged for the team), then the visitor is shown exactly where they
 * were: the same menu, the same offered times, the same pending
 * confirmation. Nothing about the booking changes.
 */
async function ask(turn: Turn, question: string, resume?: () => Promise<void>): Promise<void> {
  const { session } = turn;
  await session.recordText(turn.said);
  const out = await session.askQuestion(question, { meta: turn.said.meta, alreadyRecorded: true });
  if (turn.interpretation.mentionedTime && out.outcome !== "which-unit") {
    await confirmMentionedTime(turn, turn.interpretation.mentionedTime);
    return;
  }
  if (turn.interpretation.mentionedDate && out.outcome !== "which-unit") {
    await showAskedDay(turn, turn.interpretation.mentionedDate, true);
    return;
  }
  if (out.outcome === "which-unit") {
    const units = out.units ?? [];
    turn.markClarification();
    session.expect(turn.stage, { kind: "which-unit", question, units, ...(turn.awaiting ? { resume: turn.awaiting } : {}) });
    await session.reply(`Which unit do you mean: ${orList(units)}?`, { kind: "choose", options: units, what: "a unit" });
    return;
  }
  if (resume) await resume();
  else await resumeStep(session, turn.stage, turn.awaiting);
}

const listOf = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

async function contextDay(session: VisitorDemoSession): Promise<LocalDate | undefined> {
  const reservation = await session.reservation();
  const tz = session.config.property.timezone;
  if (reservation?.slotStart) return localDateOf(new Date(reservation.slotStart), tz);
  if (session.selectedDate) return parseIsoDate(session.selectedDate);
  const offered = session.offeredSlots[0];
  return offered ? localDateOf(offered.start, tz) : undefined;
}

function asSpoken(intent: Extract<TourIntent, { type: "REQUEST_CUSTOM_TIME" }> | SpokenTime): SpokenTime {
  return {
    hour: intent.hour,
    minute: intent.minute,
    ...(intent.meridiem ? { meridiem: intent.meridiem } : {}),
    ...(intent.day ? { day: intent.day } : {}),
    ...("weekday" in intent && intent.weekday ? { weekday: intent.weekday } : {}),
    ...("nextWeek" in intent && intent.nextWeek ? { nextWeek: true } : {}),
  };
}

function meridiemOf(session: VisitorDemoSession, start: Date): "AM" | "PM" {
  return zonedParts(start, session.config.property.timezone).hour >= 12 ? "PM" : "AM";
}

/** Files a custom-time request, or books a regular slot when that's what they named. */
async function fileCustomTime(turn: Turn, spoken: SpokenTime, alreadyRecorded = false): Promise<void> {
  const { session } = turn;
  const resolved = resolveSpokenTime(session.config, session.clock.now(), spoken, await contextDay(session));
  if (!resolved.ok) {
    const awaiting = { kind: "confirm-custom-time" as const, hour: spoken.hour, minute: spoken.minute, ...(spoken.day ? { day: spoken.day } : {}) };
    if (alreadyRecorded) {
      turn.markClarification();
      session.expect(await session.stage(), awaiting);
      await session.reply(resolved.ask);
    } else await turn.clarify(resolved.ask, undefined, awaiting);
    return;
  }
  const reservation = await session.reservation();
  if (reservation?.status === "INQUIRY" && resolved.placement === "ON_GRID") {
    if (!alreadyRecorded) await session.recordText(turn.said);
    return session.bookOffered(resolved.start.toISOString());
  }
  if (!reservation) {
    session.holdTime(spoken);
    const menu: ReplyPrompt = { kind: "choose", options: session.config.units.map((unit) => unit.name), what: "a unit" };
    const body = `${resolved.label} isn't one of the regular tour times. Which unit should I ask the property team about?`;
    if (alreadyRecorded) {
      turn.markClarification();
      await session.reply(body, menu);
    } else await turn.clarify(body, menu);
    return;
  }
  if (!alreadyRecorded) await session.recordText(turn.said);
  await session.requestCustomTime(resolved.start, turn.said.meta?.providerMessageId);
}

async function confirmMentionedTime(turn: Turn, spoken: SpokenTime): Promise<void> {
  const { session } = turn;
  const resolved = resolveSpokenTime(session.config, session.clock.now(), spoken, await contextDay(session));
  if (!resolved.ok) {
    session.expect(turn.stage, { kind: "confirm-custom-time", hour: spoken.hour, minute: spoken.minute, ...(spoken.day ? { day: spoken.day } : {}) });
    await session.reply(resolved.ask);
    return;
  }
  session.expect(turn.stage, {
    kind: "confirm-custom-time",
    hour: spoken.hour,
    minute: spoken.minute,
    meridiem: meridiemOf(session, resolved.start),
    ...(spoken.day ? { day: spoken.day } : {}),
  });
  await session.reply(`If you'd like ${resolved.label}, reply YES and I'll ask the property team.`, { kind: "yes-no" });
}

async function openWithCustomTime(turn: Turn): Promise<void> {
  if (turn.intent.type !== "REQUEST_CUSTOM_TIME") return;
  const spoken = asSpoken(turn.intent);
  await turn.session.recordText(turn.said);
  await turn.session.welcome();
  if (await turn.session.reservation()) await fileCustomTime(turn, spoken, true);
  else turn.session.holdTime(spoken);
}

/**
 * What Tour Core was asking before a question interrupted it, asked again
 * from the saved conversation (menus keep their numbering). During a booked
 * or running tour there's no menu to repeat, so only an open confirmation is
 * asked again.
 */
export async function resumeStep(session: VisitorDemoSession, stage?: VisitorStage, awaiting?: StepAwaiting): Promise<void> {
  const now = await session.stage();
  // Called from outside a text (e.g. the operator answered later): repeat whatever confirmation is still open.
  const open = stage === undefined ? session.pendingClarification : undefined;
  const pending = open && open.stage === now && open.awaiting.kind !== "which-unit" ? open.awaiting : undefined;
  const p = stepPrompt(session, now, stage === undefined ? pending : stage === now ? awaiting : undefined);
  if (!p) return;
  if (p.awaiting) session.expect(now, p.awaiting);
  await session.reply(p.body, p.prompt);
}

function stepPrompt(session: VisitorDemoSession, stage: VisitorStage, awaiting?: StepAwaiting): { body: string; prompt?: ReplyPrompt; awaiting?: StepAwaiting } | undefined {
  const yesNo: ReplyPrompt = { kind: "yes-no" };
  switch (awaiting?.kind) {
    case "confirm-arrival":
      return { body: "Are you at the property now?", prompt: yesNo, awaiting };
    case "confirm-stop":
      return { body: `Are you at ${awaiting.stop.label} now?`, prompt: yesNo, awaiting };
    case "choose-stop":
      return { body: `Which door are you at: ${awaiting.stops.map((s) => s.label).join(" or ")}?`, prompt: { kind: "choose", options: awaiting.stops.map((s) => s.label), what: "a door" }, awaiting };
    case "confirm-finish":
      return { body: "Are you finished with your tour?", prompt: yesNo, awaiting };
  }
  switch (stage) {
    case "choose-unit":
      return { body: "Which unit would you like to see?", prompt: { kind: "choose", options: session.config.units.map((u) => u.name), what: "a unit" } };
    case "choose-date": {
      const labels = session.offeredDates.map((day) => day.label);
      if (!labels.length) return undefined;
      return { body: "I have tours available. Which day works for you?", prompt: { kind: "choose", options: labels, what: "a day" } };
    }
    case "choose-time": {
      const labels = session.offeredSlots.map((s) => s.label);
      if (!labels.length) return undefined;
      const day = session.selectedDate ? formatDay(session.offeredSlots[0]!.start, session.config.property.timezone) : formatDay(session.offeredSlots[0]!.start, session.config.property.timezone);
      return timeMenu(day, labels);
    }
    case "consent":
      return { body: CONSENT_QUESTION, prompt: yesNo };
    case "identity":
      return { body: "Your identity form is in my earlier message. Once it's filled out, I'll confirm your tour." };
    case "follow-up":
      return { body: FOLLOW_UP_QUESTION, prompt: yesNo };
    default:
      return undefined;
  }
}

const CONSENT_QUESTION = "Is it OK if I text you about this tour and keep a record of your visit?";
const FOLLOW_UP_QUESTION = "Would you like someone from the property team to follow up?";

async function chooseUnit(turn: Turn): Promise<void> {
  const units = turn.session.config.units;
  const unit = turn.intent.type === "SELECT_UNIT" ? units.find((u) => same(u.name, (turn.intent as { unitName: string }).unitName)) : undefined;
  const menu: ReplyPrompt = { kind: "choose", options: units.map((u) => u.name), what: "a unit" };
  if (unit && turn.confident) {
    await turn.act("chooseUnit", { unitId: unit.id });
    const held = turn.session.takeHeldTime();
    if (held) await fileCustomTime(turn, held, true);
    return;
  }
  const names = units.map((u) => u.name);
  const which = names.length === 2 ? `did you mean ${names[0]} or ${names[1]}?` : "which unit did you mean?";
  return turn.clarify(`Sure — ${which}`, menu);
}

function dayOnOrAfter(start: LocalDate, weekday: NonNullable<DayReference["weekday"]>): LocalDate {
  let day = start;
  for (let i = 0; i < 14; i++) {
    if (weekdayOf(day) === weekday) return day;
    day = addDays(day, 1);
  }
  return start;
}

async function showAskedDay(turn: Turn, ask: DayReference, alreadyRecorded = false): Promise<void> {
  const { session } = turn;
  const dates = session.offeredDates;
  const dateMenu = { kind: "choose" as const, options: dates.map((day) => day.label), what: "a day" };
  if (!ask.weekday && !ask.relative) {
    const index = /^\s*(?:#|number |option )?(\d{1,2})\s*[.!]?\s*$/i.exec(turn.said.text ?? "")?.[1];
    const picked = index ? dates[Number(index) - 1] : undefined;
    if (picked) return presentDay(turn, picked.date, alreadyRecorded);
    if (alreadyRecorded) await session.reply("I have tours available. Which day works for you?", dateMenu);
    else await turn.respond("I have tours available. Which day works for you?", dateMenu);
    return;
  }
  if (ask.relative === "weekend") {
    const weekend = dates.filter((day) => {
      const local = parseIsoDate(day.date);
      const name = local ? weekdayOf(local) : undefined;
      return name === "SAT" || name === "SUN";
    });
    if (!alreadyRecorded) await session.recordText(turn.said);
    if (weekend.length === 1) return presentDay(turn, weekend[0]!.date, true);
    const options = (weekend.length ? weekend : dates).map((day) => day.label);
    const lead = weekend.length ? "I have tours available. Which day works for you?" : "I don't have weekend tours. I have tours available. Which day works for you?";
    await session.reply(lead, { kind: "choose", options, what: "a day" });
    return;
  }
  const tz = session.config.property.timezone;
  const today = localDateOf(session.clock.now(), tz);
  const start = ask.relative === "today" ? today : ask.relative === "tomorrow" || ask.nextWeek ? addDays(today, 1) : today;
  const day = ask.weekday ? dayOnOrAfter(start, ask.weekday) : start;
  await presentDay(turn, isoDate(day), alreadyRecorded);
}

async function presentDay(turn: Turn, date: string, alreadyRecorded = false): Promise<void> {
  const { session } = turn;
  if (!alreadyRecorded) await session.recordText(turn.said);
  await offerDate(session, date);
}

async function byStage(turn: Turn): Promise<void> {
  const { session, intent } = turn;
  const yesNo: ReplyPrompt = { kind: "yes-no" };
  if (turn.awaiting?.kind === "confirm-custom-time" && turn.interpretation.clarificationQuestion === "No problem.") {
    await turn.respond("No problem.");
    await resumeStep(session, turn.stage);
    return;
  }
  if (intent.type === "ACCEPT_PROPOSED_TIME" && turn.awaiting?.kind === "confirm-alternative" && turn.confident) {
    await session.recordText(turn.said);
    await session.acceptAlternative(turn.awaiting.requestId);
    return;
  }
  if (intent.type === "DECLINE_PROPOSED_TIME" && turn.awaiting?.kind === "confirm-alternative" && turn.confident) {
    await session.recordText(turn.said);
    await session.declineAlternative(turn.awaiting.requestId);
    return;
  }
  if (intent.type === "REQUEST_CUSTOM_TIME" && turn.confident) return fileCustomTime(turn, asSpoken(intent));
  if (intent.type === "ASK_PROPERTY_QUESTION" && turn.stage !== "stopped" && turn.stage !== "intro") return ask(turn, intent.question);

  switch (turn.stage) {
    case "intro":
      return session.greet(turn.said);

    case "choose-unit": {
      const menu: ReplyPrompt = { kind: "choose", options: session.config.units.map((u) => u.name), what: "a unit" };
      if (intent.type === "SELECT_DATE") return showAskedDay(turn, intent);
      if (intent.type === "SELECT_UNIT") return chooseUnit(turn);
      if (intent.type === "REQUEST_HELP") return session.help(turn.said);
      if (intent.type === "START_INQUIRY") return turn.respond("Hi! Which unit would you like to see?", menu);
      if (turn.interpretation.clarificationNeeded && !turn.interpretation.manipulation) return chooseUnit(turn);
      return turn.fallback(`${SORRY} Which unit would you like to see?`, menu);
    }

    case "choose-date": {
      if (turn.awaiting?.kind === "accept-next-opening" && acceptsOfferedOpening(turn.said.text ?? "")) {
        return takeOfferedOpening(session, turn.awaiting, turn.said);
      }
      if (intent.type === "SELECT_DATE") return showAskedDay(turn, intent);
      if (intent.type === "REQUEST_HELP") return session.help(turn.said);
      return turn.fallback(`${SORRY} Which day works for you?`, { kind: "choose", options: session.offeredDates.map((day) => day.label), what: "a day" });
    }

    case "choose-time": {
      const labels = session.offeredSlots.map((s) => s.label);
      const menu: ReplyPrompt = { kind: "choose", options: labels, what: "a time" };
      if (intent.type === "SELECT_DATE") return showAskedDay(turn, intent);
      if (intent.type === "SELECT_TIME") {
        const slot = session.offeredSlots.find((s) => same(s.label, intent.timeLabel));
        if (slot && turn.confident) return turn.act("chooseTime", { slotStart: slot.start.toISOString() });
        return turn.clarify("Which time works for you?", menu);
      }
      if (intent.type === "REQUEST_HELP") return session.help(turn.said);
      if (turn.interpretation.clarificationQuestion) return turn.clarify(`${turn.interpretation.clarificationQuestion} Which time works for you?`, menu);
      if (turn.interpretation.clarificationNeeded && !turn.interpretation.manipulation) return turn.clarify("Sure — which time works for you?", menu);
      return turn.fallback(`${SORRY} Which time works for you?`, menu);
    }

    case "consent": {
      const question = CONSENT_QUESTION;
      if (intent.type === "CONSENT_YES" || intent.type === "CONSENT_NO") {
        if (turn.confident) return turn.act("consent", { agree: intent.type === "CONSENT_YES" });
        return turn.clarify(`Just to check: ${question.charAt(0).toLowerCase()}${question.slice(1)}`, yesNo);
      }
      if (intent.type === "REQUEST_HELP") return session.help(turn.said);
      return turn.fallback(`${SORRY} ${question}`, yesNo);
    }

    case "identity":
      if (intent.type === "REQUEST_HELP") return session.help(turn.said);
      return session.resendVerificationLink(turn.said);

    case "ready":
      return onArrival(turn);

    case "touring":
      return onTour(turn);

    case "follow-up": {
      const question = FOLLOW_UP_QUESTION;
      if (intent.type === "FOLLOW_UP_YES" || intent.type === "FOLLOW_UP_NO") {
        if (turn.confident) return turn.act("followUp", { wantsContact: intent.type === "FOLLOW_UP_YES" });
        return turn.clarify(`Just to check: ${question.charAt(0).toLowerCase()}${question.slice(1)}`, yesNo);
      }
      if (intent.type === "REQUEST_HELP") return session.help(turn.said);
      return turn.fallback(`${SORRY} ${question}`, yesNo);
    }

    case "done":
    case "stopped":
      if (await session.isPaused()) {
        if (intent.type === "REQUEST_HELP") return session.help(turn.said);
        return turn.respond(VisitorDenialCopy.operatorHold(session.config.operator.name, session.config.operator.visitorContact));
      }
      return turn.respond("This tour has ended. Text HI any time to start a new one.");
  }
}

/** Booked and verified, not yet in: the only door that can be asked for is the first stop, via arrival. */
async function onArrival(turn: Turn): Promise<void> {
  const { session, intent } = turn;
  const r = (await session.reservation())!;
  const first = r.allowedRoute[0]!;
  const yesNo: ReplyPrompt = { kind: "yes-no" };
  const confirmArrival = () => turn.clarify("Are you at the property now?", yesNo, { kind: "confirm-arrival" });

  switch (intent.type) {
    case "ARRIVAL":
      return turn.confident ? turn.act("arrive") : confirmArrival();
    case "AT_UNIT":
    case "AT_ROUTE_STOP": {
      const doorId = namedDoor(session, intent);
      const named = (intent.type === "AT_UNIT" && intent.unitName) || (intent.type === "AT_ROUTE_STOP" && intent.stopName);
      if (!named || doorId === first) return turn.confident ? turn.act("arrive") : confirmArrival();
      // A later stop, or a door off the route: start at the first stop, and only once they confirm they're there.
      return turn.clarify(`Let's start at ${session.stopLabel(first)}. Are you there now?`, yesNo, { kind: "confirm-arrival" });
    }
    case "REQUEST_HELP":
      return session.help(turn.said);
    case "FINISH_TOUR":
      return turn.respond("Your tour hasn't started yet.", { kind: "say", phrase: "I'm here", purpose: "when you arrive" });
    default:
      return turn.fallback(`${SORRY} You can ask me a question about the property.`, { kind: "say", phrase: "I'm here", purpose: "when you arrive" });
  }
}

/** In the building: stops along the route, questions, help, finishing. */
async function onTour(turn: Turn): Promise<void> {
  const { session, intent } = turn;
  const remaining = await session.remainingStops();
  const next = remaining[0];
  const yesNo: ReplyPrompt = { kind: "yes-no" };
  const nextHint = next ? ` Text me when you're at ${session.stopLabel(next)}.` : ' Text "finish" when you\'re done.';

  switch (intent.type) {
    case "FINISH_TOUR":
      return turn.confident ? turn.act("finish") : turn.clarify("Are you finished with your tour?", yesNo, { kind: "confirm-finish" });
    case "AT_UNIT":
    case "AT_ROUTE_STOP": {
      const target = targetOf(session, intent, remaining);
      if ("choices" in target) {
        const stops = target.choices.map((d) => stopRef(session, d));
        return turn.clarify(
          `Which door are you at: ${stops.map((s) => s.label).join(" or ")}?`,
          { kind: "choose", options: stops.map((s) => s.label), what: "a door" },
          { kind: "choose-stop", stops },
        );
      }
      if ("none" in target) return turn.clarify("Every door on your tour is already open for you. Text HELP if one isn't working.", { kind: "say", phrase: "finish", purpose: "when you're done" });
      if ("unknownName" in target) return turn.fallback(`${SORRY}${nextHint}`);
      if (turn.confident) return turn.act("atStop", { doorId: target.doorId });
      return turn.clarify(`Are you at ${session.stopLabel(target.doorId)} now?`, yesNo, { kind: "confirm-stop", stop: stopRef(session, target.doorId) });
    }
    case "ARRIVAL":
      return turn.respond(`You're all set.${nextHint}`);
    case "REQUEST_HELP":
      return session.help(turn.said);
    default:
      return turn.fallback(
        `${SORRY} You can ask me a question${next ? `, text "at ${session.stopLabel(next)}" when you get there,` : ","} or text "finish" when you're done.`,
        undefined,
        nextHint,
      );
  }
}
