import { resolveSpokenTime } from "../core/customSlot";
import { orList, resolveQuestion, unitsNamedIn } from "../core/questions";
import { isoDate, parseIsoDate } from "../core/schedule";
import { dayReference, type DayReference, type SpokenTime } from "../core/spokenTime";
import { addDays, formatDay, formatTime, localDateOf, weekdayOf, zonedParts, type LocalDate } from "../core/timezone";
import {
  CONSENT_TEXT,
  TOUR_AGAIN_SUFFIX,
  TOUR_ENDED_REPLY,
  unknownAnswerReply,
  VisitorDenialCopy,
  visitorCancelConfirm,
  visitorCancelKept,
  type InboundMeta,
} from "../core/TourCore";
import { isLeavingTour, T5_NO_OFFER_BARE_YES } from "../core/overstayCopy";
import { afterCloseAlertOpen } from "./overstayScheduler";
import { yesNo } from "../intent/yesNo";
import { isCancelableReservation } from "../domain/stateMachine";
import { stripFiller } from "../intent/normalize";
import {
  isCancelTourAsk,
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
import { OPERATOR_SCHEDULE_CONFIRM_PROMPT, type InterpretationNote, type Said, type VisitorDemoSession, type VisitorStage } from "./session";
import { acceptsOfferedOpening, nextOpeningFollowUp, offerDate, takeOfferedOpening } from "./unavailableDay";
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

/** A greeting and nothing else — "hi", "hello!", "yo" — not "Hi, I'm still stuck". */
export function isStandaloneGreeting(text: string): boolean {
  return /^(hi|hello|hey|hiya|yo|hi there|good (morning|afternoon|evening))$/.test(normalize(text));
}

const AFTER_CLOSE_DISTRESS =
  /\b(stuck|trapped|inside|door|help|emergency|jammed|lock|locked|gate|let me out|lock in|cannot get out|can t get out|cannot get outside|can t get outside|no way out|will not open|cannot open|still in the unit|still inside)\b/;
const LEAVE_DISTRESS = /\b(cannot leave|unable to leave|how do i leave|let me leave)\b/;
const HELP_BOOKING = /\bhelp(?: me)? book(?:ing)?\b/;

/** After-close distress: never start a booking, even when booking words are also present. */
export function mentionsAfterCloseDistress(text: string): boolean {
  if (/🔒/.test(text)) return true;
  const t = stripFiller(normalize(text));
  const rest = HELP_BOOKING.test(t) ? t.replace(HELP_BOOKING, " ") : t;
  return AFTER_CLOSE_DISTRESS.test(rest) || LEAVE_DISTRESS.test(rest);
}

/** A clear ask to book — not a bare greeting. Distress always wins. */
export function isClearBookingPhrase(text: string, intent?: TourIntent): boolean {
  if (mentionsAfterCloseDistress(text)) return false;
  if (intent?.type === "START_INQUIRY") return true;
  const t = stripFiller(normalize(text));
  if (/^(tour|book|start over|new tour)$/.test(t)) return true;
  if (HELP_BOOKING.test(t)) return true;
  return /\b(book (another |a )?(tour|look|showing)|another (tour|look|showing)|new tour|tour again|i would like to book|see it again|schedule another (visit|tour))\b/.test(t);
}

/** After a +15 close, only a standalone greeting or a clear booking phrase starts a new booking. */
export function startsNewBookingAfterClose(text: string, intent?: TourIntent): boolean {
  if (mentionsAfterCloseDistress(text)) return false;
  if (isStandaloneGreeting(text)) return true;
  return isClearBookingPhrase(text, intent);
}

/** Locked visitor copy when an inbound is a photo with no caption. Do not say MMS. */
export const PHOTO_ALONE_REPLY = "I can't take photos yet. Text your question and I'll pass it along.";
/** Locked visitor copy when an inbound is a photo plus handleable text. Unanswerable questions use UNKNOWN_ANSWER_WITH_PHOTO instead. */
export const PHOTO_WITH_TEXT_REPLY = "I can't take photos yet.";

/** Sends the short photo line unless a combined unknown-question text will replace it. */
function photoAckFor(session: VisitorDemoSession, pending: boolean) {
  let open = pending;
  return {
    consume() {
      open = false;
    },
    async send() {
      if (!open) return;
      open = false;
      await session.reply(PHOTO_WITH_TEXT_REPLY);
    },
  };
}

/** Lead when published hours changed and a numbered/old-menu reply can't be mapped safely. */
export const SCHEDULE_CHANGED_LEAD = "Tour times just changed. Here's what's open now:";
const WHICH_DAY = "Which day works for you?";
const DAY_MENU = `I have tours available. ${WHICH_DAY}`;
const MENU_NUMBER = /^\s*(?:#|number |option )?(\d{1,2})\s*[.!]?\s*$/i;

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
    today: localDateOf(session.clock.now(), session.config.property.timezone),
    timezone: session.config.property.timezone,
    ...(r ? { reservedUnit: session.config.units.find((u) => u.id === r.unitId)?.name } : {}),
    remainingStops: remaining.map((id) => stopRef(session, id)),
    doors: session.config.doors.map((d) => stopRef(session, d.id)),
    hasCancelableTour: r ? isCancelableReservation(r) : false,
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

  /** True when this inbound already got the short photo line. Combined unknown replies must not mention photos again. */
  photoLineSent = false;

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

  const photo = !!meta?.hasMedia;
  const typed = text.trim();
  const keyword = keywordOf(text);
  const silent = session.optedOut && keyword !== "start" && keyword !== "stop";
  const photoAck = photoAckFor(session, photo && !!typed && !silent);

  if (photo && !typed) {
    if (!silent) await session.reply(PHOTO_ALONE_REPLY);
    await session.recordText({ text: "(photo)", meta });
    return undefined;
  }

  // Operator-set tour: YES/NO/STOP are about that confirmation, not the SMS keyword gate.
  // A released or cancelled hold is not still waiting — don't send another confirm text.
  if (session.pendingClarification?.awaiting.kind === "confirm-operator-tour") {
    const reservation = await session.reservation();
    if (reservation?.awaitingVisitorConfirm?.kind === "OPERATOR_SCHEDULED") {
      await photoAck.send();
      await handleOperatorScheduledReply(session, said, text);
      return undefined;
    }
    session.takeExpected(session.pendingClarification.stage);
  }

  // Someone who opted out gets no texts. A real question is still flagged for the landlord.
  // Check before the SMS keyword gate so STOP'd visitors aren't treated as un-enrolled senders.
  if (session.optedOut && keyword !== "start" && keyword !== "stop") {
    photoAck.consume();
    await flagSilentOptedOutQuestion(session, said, text, photo, interpreter);
    return undefined;
  }

  // SMS campaign consent comes before any property or booking content.
  if (session.kind === "messaging" && session.smsConsentMode !== "disabled" && session.smsConsent !== "opted_in") {
    await photoAck.send();
    await handleSmsGate(session, said, text);
    return undefined;
  }

  // After-close handling stays on the expired tour while the leaving issue is
  // open. A held booking is not promoted until that window ends.
  if (!isLeavingTour(stripFiller(normalize(text))) && !(await session.afterCloseStillOpen())) {
    await session.promotePendingBookingIfTourEnded();
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
      const resolved = resolveQuestion(session.config, pending.question, { selectedUnitId: unit.id, pickedUnitId: unit.id });
      if (resolved.kind === "unknown") photoAck.consume();
      else await photoAck.send();
      const endedPick = (stage === "done" || stage === "stopped") && !(await session.isPaused());
      const out = await session.askQuestion(pending.question, {
        meta,
        unitId: unit.id,
        alreadyRecorded: true,
        unknownReply: unknownAnswerReply({ hasMedia: photo && resolved.kind === "unknown", ended: endedPick }),
        ...(endedPick ? { answerSuffix: TOUR_AGAIN_SUFFIX } : {}),
      });
      if (out.outcome !== "which-unit" && !endedPick) await resumeStep(session, stage, pending.resume);
      return interpretation;
    }
  }

  const interpretation = await interpreter.interpret(await contextFor(session, text, stage, awaiting));
  const note = session.noteInterpretation(interpretation);
  const turn = new Turn(session, said, stage, interpretation, note, awaiting);
  const { intent } = interpretation;
  const ended = (stage === "done" || stage === "stopped") && !(await session.isPaused());
  if (awaiting?.kind !== "confirm-cancel-tour" && (await willSendCombinedUnknown(session, intent, stage, ended, firstMessage))) {
    photoAck.consume();
  } else {
    await photoAck.send();
    turn.photoLineSent = photo && !!typed && !silent;
  }

  if (intent.type === "STOP_MESSAGES" && turn.confident) await session.optOut(said);
  else if (intent.type === "START_MESSAGES" && turn.confident) await session.optIn(said);
  else if (await handleOverstayReply(turn)) {
    /* T-15 / T-5 / more-time / DONE / after-close / rebook after no-time */
  } else if (await handlePendingRebookPick(turn)) {
    /* day/time for a secondary rebook; tour commands already won above */
  } else if (await handlePendingBookingReply(turn)) {
    /* consent / verification for a booking held while the current tour runs */
  } else if (await takeOverHeldBookingOnGreeting(turn)) {
    /* after the tour ends, HI continues the held booking with booked-for then consent */
  } else if (keyword === "help") await session.help(said);
  else if (await handleCancelIntent(turn)) {
    /* cancel-by-text: confirm, YES, or NO */
  } else if (firstMessage) {
    if (intent.type === "SELECT_UNIT" && turn.confident) await chooseUnit(turn);
    else if (intent.type === "REQUEST_CUSTOM_TIME" && turn.confident) await openWithCustomTime(turn);
    else if (intent.type === "ASK_PROPERTY_QUESTION") await ask(turn, intent.question, () => session.welcome());
    else await session.greet(said);
  }   else await byStage(turn);
  if (session.overstay) await session.overstay.tickSession(session);
  return interpretation;
}

async function handleOperatorScheduledReply(session: VisitorDemoSession, said: Said, text: string): Promise<void> {
  const keyword = keywordOf(text);
  if (keyword === "stop") {
    session.takeExpected(await session.stage());
    await session.optOut(said);
    return;
  }
  if (keyword === "help") {
    await session.help(said);
    return;
  }
  const normalized = normalize(text);
  if (normalized === "yes" || /^(yeah|yep|sure|ok|okay)$/.test(normalized)) {
    session.takeExpected(await session.stage());
    await session.recordText(said);
    await session.allowMessagingAgain();
    session.noteSmsConsent("opted_in", "YES");
    await session.confirmOperatorSchedule();
    return;
  }
  if (normalized === "no" || /^(nope|nah)$/.test(normalized)) {
    session.takeExpected(await session.stage());
    await session.recordText(said);
    await session.declineOperatorSchedule();
    return;
  }
  if (isBareMenuNumber(text)) {
    await session.recordText(said);
    await session.reply(OPERATOR_SCHEDULE_CONFIRM_PROMPT);
    return;
  }
  await session.flagQuestionWhileAwaitingConfirm(said);
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

function unknownReplyFor(turn: Turn, ended = false): string {
  return unknownAnswerReply({ hasMedia: !!turn.said.meta?.hasMedia && !turn.photoLineSent, ended });
}

/** True when this turn will send a combined unknown-question text instead of the short photo line. */
async function willSendCombinedUnknown(
  session: VisitorDemoSession,
  intent: TourIntent,
  stage: VisitorStage,
  ended: boolean,
  firstMessage: boolean,
): Promise<boolean> {
  if (intent.type !== "ASK_PROPERTY_QUESTION") return false;
  if (stage === "intro" && !firstMessage) return false;
  if ((stage === "stopped" || stage === "done") && !ended) return false;
  const r = await session.reservation();
  return resolveQuestion(session.config, intent.question, { selectedUnitId: r?.unitId }).kind === "unknown";
}

/** Ended tour: answer from approved facts first; flag only when there is no answer. */
async function handleEndedQuestion(turn: Turn): Promise<void> {
  const question = turn.intent.type === "ASK_PROPERTY_QUESTION" ? turn.intent.question : (turn.said.text ?? "");
  await turn.session.recordText(turn.said);
  const r = await turn.session.reservation();
  const resolved = resolveQuestion(turn.session.config, question, { selectedUnitId: r?.unitId });
  if (resolved.kind === "unknown") {
    await turn.session.flagUnknownQuestion(turn.said, { reply: unknownReplyFor(turn, true), alreadyRecorded: true });
    return;
  }
  const out = await turn.session.askQuestion(question, {
    meta: turn.said.meta,
    alreadyRecorded: true,
    unknownReply: unknownReplyFor(turn, true),
    answerSuffix: TOUR_AGAIN_SUFFIX,
  });
  if (out.outcome === "which-unit") {
    const units = out.units ?? [];
    turn.markClarification();
    turn.session.expect(turn.stage, { kind: "which-unit", question, units, ...(turn.awaiting ? { resume: turn.awaiting } : {}) });
    await turn.session.reply(`Which unit do you mean: ${orList(units)}?`, { kind: "choose", options: units, what: "a unit" });
  }
}

/** STOP'd visitors get no texts; an unanswerable question is still flagged. */
async function flagSilentOptedOutQuestion(
  session: VisitorDemoSession,
  said: Said,
  text: string,
  photo: boolean,
  interpreter: IntentInterpreter,
): Promise<void> {
  const stage = await session.stage();
  const interpretation = await interpreter.interpret(await contextFor(session, text, stage));
  session.noteInterpretation(interpretation);
  if (interpretation.intent.type !== "ASK_PROPERTY_QUESTION") {
    await session.recordText(said);
    return;
  }
  const ended = (stage === "done" || stage === "stopped") && !(await session.isPaused());
  const r = await session.reservation();
  const resolved = resolveQuestion(session.config, interpretation.intent.question, { selectedUnitId: r?.unitId });
  if (resolved.kind === "unknown") {
    await session.flagUnknownQuestion(said, { reply: unknownAnswerReply({ hasMedia: photo, ended }) });
    return;
  }
  await session.recordText(said);
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
  const out = await session.askQuestion(question, {
    meta: turn.said.meta,
    alreadyRecorded: true,
    unknownReply: unknownReplyFor(turn),
  });
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

/** A new day named while a next-opening offer is pending — not an accept of that offer. */
function dayAskWhileOfferPending(turn: Turn): DayReference | undefined {
  const { intent } = turn;
  if (intent.type === "SELECT_DATE" && (intent.date || intent.weekday || intent.relative || intent.unclear)) return intent;
  if (intent.type === "REQUEST_CUSTOM_TIME") {
    if (intent.date) return { date: intent.date };
    if (intent.weekday) return { weekday: intent.weekday, ...(intent.nextWeek ? { nextWeek: true } : {}) };
    if (intent.day) return { relative: intent.day };
  }
  const today = localDateOf(turn.session.clock.now(), turn.session.config.property.timezone);
  const asked = dayReference(normalize(turn.said.text ?? ""), today);
  return asked && asked !== "menu" ? asked : undefined;
}

function asSpoken(intent: Extract<TourIntent, { type: "REQUEST_CUSTOM_TIME" }> | SpokenTime): SpokenTime {
  return {
    hour: intent.hour,
    minute: intent.minute,
    ...(intent.meridiem ? { meridiem: intent.meridiem } : {}),
    ...(intent.day ? { day: intent.day } : {}),
    ...("weekday" in intent && intent.weekday ? { weekday: intent.weekday } : {}),
    ...("nextWeek" in intent && intent.nextWeek ? { nextWeek: true } : {}),
    ...("date" in intent && intent.date ? { date: intent.date } : {}),
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
  if (resolved.placement === "ON_GRID") {
    if (reservation?.status === "INQUIRY") {
      if (!alreadyRecorded) await session.recordText(turn.said);
      return session.bookOffered(resolved.start.toISOString());
    }
    if (reservation?.status === "TOURING") {
      if (!alreadyRecorded) await session.recordText(turn.said);
      await session.confirmRebook(resolved.start.toISOString());
      return;
    }
  }
  if (!reservation) {
    session.holdTime(spoken);
    const menu: ReplyPrompt = { kind: "choose", options: session.offerableUnits().map((unit) => unit.name), what: "a unit" };
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
  if (now === "choose-date") session.markDatesShown();
  if (now === "choose-time") session.markTimesShown();
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
    case "confirm-cancel-tour":
      return { body: visitorCancelConfirm(awaiting.day, awaiting.time), awaiting };
  }
  switch (stage) {
    case "choose-unit":
      return { body: "Which unit would you like to see?", prompt: { kind: "choose", options: session.offerableUnits().map((u) => u.name), what: "a unit" } };
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

async function offerCancelConfirm(turn: Turn): Promise<void> {
  const reservation = await turn.session.reservation();
  const line = reservation ? turn.session.cancelConfirmLine(reservation) : undefined;
  if (!line || !reservation?.slotStart) {
    await turn.session.reportCancelFailed(turn.said);
    return;
  }
  const start = new Date(reservation.slotStart);
  const tz = turn.session.config.property.timezone;
  await turn.clarify(line, undefined, { kind: "confirm-cancel-tour", day: formatDay(start, tz), time: formatTime(start, tz) });
}

/**
 * Booked-tour cancel-by-text. Confirm first; never send the unanswered-
 * question fallback for a clear cancel ask.
 */
async function handleCancelIntent(turn: Turn): Promise<boolean> {
  const { session, intent } = turn;
  const text = turn.said.text ?? "";
  const cancelable = await session.hasCancelableTour();
  const cancelAsk = intent.type === "CANCEL_TOUR" || intent.type === "CONFIRM_CANCEL_TOUR" || isCancelTourAsk(text);
  const awaiting = turn.awaiting?.kind === "confirm-cancel-tour" ? turn.awaiting : undefined;

  if (awaiting && intent.type === "KEEP_TOUR" && turn.confident) {
    await turn.respond(visitorCancelKept(awaiting.day, awaiting.time));
    return true;
  }
  if (awaiting && intent.type === "CONFIRM_CANCEL_TOUR" && turn.confident) {
    await session.cancelBookedTour(turn.said);
    return true;
  }
  if (awaiting && cancelAsk && intent.type !== "ASK_PROPERTY_QUESTION" && intent.type !== "REQUEST_HELP") {
    await session.cancelBookedTour(turn.said);
    return true;
  }
  if (awaiting && intent.type !== "REQUEST_HELP") {
    await session.flagQuestionWhileAwaitingConfirm(turn.said);
    session.expect(turn.stage, awaiting);
    return true;
  }
  if (cancelAsk && cancelable) {
    await offerCancelConfirm(turn);
    return true;
  }
  if (intent.type === "CANCEL_TOUR" && !cancelable) {
    await session.reportCancelFailed(turn.said);
    return true;
  }
  return false;
}

async function chooseUnit(turn: Turn): Promise<void> {
  const units = turn.session.config.units;
  const unit = turn.intent.type === "SELECT_UNIT" ? units.find((u) => same(u.name, (turn.intent as { unitName: string }).unitName)) : undefined;
  const menu: ReplyPrompt = { kind: "choose", options: turn.session.offerableUnits().map((u) => u.name), what: "a unit" };
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
  if (ask.date) {
    await presentDay(turn, isoDate(ask.date), alreadyRecorded);
    return;
  }
  if (ask.unclear) {
    if (!alreadyRecorded) await session.recordText(turn.said);
    session.markDatesShown();
    await session.reply("I couldn't tell which day you meant. Which day works for you?", dateMenu);
    return;
  }
  if (!ask.weekday && !ask.relative) {
    const index = /^\s*(?:#|number |option )?(\d{1,2})\s*[.!]?\s*$/i.exec(turn.said.text ?? "")?.[1];
    const menu = session.lastShownDates;
    const picked = index && menu.length ? menu[Number(index) - 1] : undefined;
    if (picked) return presentDay(turn, picked.date, alreadyRecorded);
    session.markDatesShown();
    if (alreadyRecorded) await session.reply(DAY_MENU, dateMenu);
    else await turn.respond(DAY_MENU, dateMenu);
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
    const lead = weekend.length ? DAY_MENU : "I don't have weekend tours. I have tours available. Which day works for you?";
    session.markDatesShown();
    await session.reply(lead, { kind: "choose", options, what: "a day" });
    return;
  }
  const tz = session.config.property.timezone;
  const today = localDateOf(session.clock.now(), tz);
  const start = ask.relative === "today" ? today : ask.relative === "tomorrow" || ask.nextWeek ? addDays(today, 1) : today;
  const day = ask.weekday ? dayOnOrAfter(start, ask.weekday) : start;
  await presentDay(turn, isoDate(day), alreadyRecorded);
}

/** START_INQUIRY during booking: keep the unit, offer days again from the current schedule. */
async function restartBookingDays(turn: Turn): Promise<void> {
  const { session } = turn;
  session.selectedDate = undefined;
  await session.refreshOfferedSchedule();
  const labels = session.offeredDates.map((day) => day.label);
  if (!labels.length) {
    await turn.respond(VisitorDenialCopy.noOpenTimes(session.config.operator.name));
    return;
  }
  session.markDatesShown();
  await turn.respond(DAY_MENU, { kind: "choose", options: labels, what: "a day" });
}

function isBareMenuNumber(text: string): boolean {
  return MENU_NUMBER.test(text);
}

/** Day name, or a number/time from a menu the visitor actually saw. */
async function isShownMenuBookingInput(turn: Turn): Promise<boolean> {
  const { session, intent } = turn;
  const text = turn.said.text ?? "";
  if (intent.type === "SELECT_DATE") {
    if (intent.date || intent.weekday || intent.relative) return true;
    const index = MENU_NUMBER.exec(text)?.[1];
    return !!(index && session.lastShownDates[Number(index) - 1]);
  }
  if (intent.type === "SELECT_TIME") {
    return session.lastShownSlots.some((slot) => same(slot.label, intent.timeLabel));
  }
  if (isBareMenuNumber(text)) {
    if (session.selectedDate && session.lastShownSlots.length) {
      const index = MENU_NUMBER.exec(text)?.[1];
      return !!(index && session.lastShownSlots[Number(index) - 1]);
    }
    const index = MENU_NUMBER.exec(text)?.[1];
    return !!(index && session.lastShownDates[Number(index) - 1]);
  }
  return false;
}

/** From consent, a regular day or shown slot replaces the held/booked tour. */
async function tryRegularSlotFromConsent(turn: Turn): Promise<boolean> {
  const { session } = turn;
  const text = turn.said.text ?? "";
  const step: VisitorStage = session.selectedDate && session.lastShownSlots.length ? "choose-time" : "choose-date";
  const interpretation = await rulesOnly.interpret(await contextFor(session, text, step));
  const intent = interpretation.intent;
  if (intent.type === "SELECT_DATE" && (intent.date || intent.weekday || intent.relative)) {
    await showAskedDay(turn, intent);
    return true;
  }
  if (intent.type === "SELECT_TIME") {
    const slot = session.lastShownSlots.find((s) => same(s.label, intent.timeLabel)) ?? session.offeredSlots.find((s) => same(s.label, intent.timeLabel));
    if (slot && isConfident(interpretation) && session.lastShownSlots.length) {
      await session.recordText(turn.said);
      await session.bookOffered(slot.start.toISOString());
      return true;
    }
  }
  if (isBareMenuNumber(text) && session.lastShownSlots.length) {
    const index = MENU_NUMBER.exec(text)?.[1];
    const slot = index ? session.lastShownSlots[Number(index) - 1] : undefined;
    if (slot) {
      await session.recordText(turn.said);
      await session.bookOffered(slot.start.toISOString());
      return true;
    }
  }
  if (isBareMenuNumber(text) && session.lastShownDates.length && !session.lastShownSlots.length) {
    await showAskedDay(turn, intent.type === "SELECT_DATE" ? intent : {});
    return true;
  }
  return false;
}

function matchesLabel(text: string, labels: string[]): boolean {
  return labels.some((label) => same(label, text));
}

async function showScheduleChanged(turn: Turn): Promise<void> {
  const { session } = turn;
  session.selectedDate = undefined;
  session.offeredSlots = [];
  await session.refreshOfferedSchedule();
  const labels = session.offeredDates.map((day) => day.label);
  if (!labels.length) {
    await turn.respond(VisitorDenialCopy.noOpenTimes(session.config.operator.name));
    return;
  }
  session.markDatesShown();
  await turn.respond(SCHEDULE_CHANGED_LEAD, { kind: "choose", options: labels, what: "a day", after: WHICH_DAY });
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
  if (intent.type === "REQUEST_CUSTOM_TIME" && turn.confident) {
    const named = turn.awaiting?.kind === "accept-next-opening" ? dayAskWhileOfferPending(turn) : undefined;
    if (named) return showAskedDay(turn, named);
    return fileCustomTime(turn, asSpoken(intent));
  }
  if (intent.type === "ASK_PROPERTY_QUESTION" && turn.stage !== "stopped" && turn.stage !== "done" && turn.stage !== "intro") return ask(turn, intent.question);

  switch (turn.stage) {
    case "intro":
      return session.greet(turn.said);

    case "choose-unit": {
      const menu: ReplyPrompt = { kind: "choose", options: session.offerableUnits().map((u) => u.name), what: "a unit" };
      if (intent.type === "SELECT_DATE") return showAskedDay(turn, intent);
      if (intent.type === "SELECT_UNIT") return chooseUnit(turn);
      if (intent.type === "REQUEST_HELP") return session.help(turn.said);
      // After pause, welcome() may have sent the paused line without starting
      // an inquiry. Tour / Hi / book must restart like a first text: a home
      // gets the welcome and day list, not a leftover unit-picker fallthrough.
      if (intent.type === "START_INQUIRY") return session.greet(turn.said);
      if (turn.interpretation.clarificationNeeded && !turn.interpretation.manipulation) return chooseUnit(turn);
      return turn.fallback(`${SORRY} Which unit would you like to see?`, menu);
    }

    case "choose-date": {
      const pendingDateRequest = await session.unapprovedCustomTimeRequest();
      if (pendingDateRequest && !pendingDateRequest.pendingNoticeSentAt && !(await isShownMenuBookingInput(turn))) {
        await session.recordText(turn.said);
        await session.announceUnapprovedCustomTime();
        return;
      }
      if (turn.awaiting?.kind === "accept-next-opening") {
        const today = localDateOf(session.clock.now(), session.config.property.timezone);
        if (acceptsOfferedOpening(turn.said.text ?? "", today)) {
          return takeOfferedOpening(session, turn.awaiting, turn.said);
        }
      }
      if (mentionsAfterCloseDistress(turn.said.text ?? "") || intent.type === "REQUEST_HELP") return session.help(turn.said);
      if (intent.type === "START_INQUIRY") return restartBookingDays(turn);
      if (session.staleDateMenu) {
        const text = turn.said.text ?? "";
        const still = session.offeredDates.find((day) => same(day.label, text) || day.date === text.trim());
        if (still) return presentDay(turn, still.date);
        if (isBareMenuNumber(text) || matchesLabel(text, session.lastShownDates.map((day) => day.label))) return showScheduleChanged(turn);
      }
      if (intent.type === "SELECT_DATE") return showAskedDay(turn, intent);
      if (turn.awaiting?.kind === "accept-next-opening") {
        const labels = session.offeredDates.map((day) => day.label);
        session.markDatesShown();
        return turn.clarify(nextOpeningFollowUp(new Date(turn.awaiting.slotStart), session.config.property.timezone), { kind: "choose", options: labels, what: "a day", after: "" }, turn.awaiting);
      }
      session.markDatesShown();
      return turn.fallback(`${SORRY} Which day works for you?`, { kind: "choose", options: session.offeredDates.map((day) => day.label), what: "a day" });
    }

    case "choose-time": {
      const pendingTimeRequest = await session.unapprovedCustomTimeRequest();
      if (pendingTimeRequest && !pendingTimeRequest.pendingNoticeSentAt && !(await isShownMenuBookingInput(turn))) {
        await session.recordText(turn.said);
        await session.announceUnapprovedCustomTime();
        return;
      }
      const labels = session.offeredSlots.map((s) => s.label);
      const menu: ReplyPrompt = { kind: "choose", options: labels, what: "a time" };
      if (mentionsAfterCloseDistress(turn.said.text ?? "") || intent.type === "REQUEST_HELP") return session.help(turn.said);
      if (intent.type === "START_INQUIRY") return restartBookingDays(turn);
      if (session.staleTimeMenu || session.staleDateMenu) {
        const text = turn.said.text ?? "";
        const still = session.offeredSlots.find((slot) => same(slot.label, text));
        if (still && turn.confident) return turn.act("chooseTime", { slotStart: still.start.toISOString() });
        if (isBareMenuNumber(text) || matchesLabel(text, session.lastShownSlots.map((slot) => slot.label))) return showScheduleChanged(turn);
      }
      if (intent.type === "SELECT_DATE") return showAskedDay(turn, intent);
      if (intent.type === "SELECT_TIME") {
        const slot = session.offeredSlots.find((s) => same(s.label, intent.timeLabel));
        if (slot && turn.confident) return turn.act("chooseTime", { slotStart: slot.start.toISOString() });
        return turn.clarify("Which time works for you?", menu);
      }
      if (turn.interpretation.clarificationQuestion) return turn.clarify(`${turn.interpretation.clarificationQuestion} Which time works for you?`, menu);
      if (turn.interpretation.clarificationNeeded && !turn.interpretation.manipulation) return turn.clarify("Sure — which time works for you?", menu);
      session.markTimesShown();
      return turn.fallback(`${SORRY} Which time works for you?`, menu);
    }

    case "consent": {
      const question = CONSENT_QUESTION;
      if (await tryRegularSlotFromConsent(turn)) return;
      if (intent.type === "CONSENT_YES" || intent.type === "CONSENT_NO") {
        if (turn.confident) return turn.act("consent", { agree: intent.type === "CONSENT_YES" });
        return turn.clarify(`Just to check: ${question.charAt(0).toLowerCase()}${question.slice(1)}`, yesNo);
      }
      if (intent.type === "REQUEST_HELP") return session.help(turn.said);
      if (session.heldBookingTakenOver && (await session.activeNeedsConsent())) {
        await session.announceHeldBookingConsent();
        return;
      }
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
      if (await takeOverHeldBookingOnGreeting(turn)) return;
      if (intent.type === "REQUEST_HELP") return session.help(turn.said);
      return turn.fallback(`${SORRY} ${question}`, yesNo);
    }

    case "done":
    case "stopped":
      if (await session.isPaused()) {
        if (intent.type === "REQUEST_HELP") return session.help(turn.said);
        return turn.respond(VisitorDenialCopy.operatorHold(session.config.operator.name, session.config.operator.visitorContact));
      }
      if (intent.type === "ASK_PROPERTY_QUESTION") return handleEndedQuestion(turn);
      return turn.respond(TOUR_ENDED_REPLY);
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

async function handleOverstayReply(turn: Turn): Promise<boolean> {
  const { session, intent } = turn;
  const reservation = await session.reservation();
  const overstay = session.overstay;
  if (!overstay || !reservation?.windowEnd) return false;
  if (reservation.status !== "TOURING" && reservation.status !== "EXPIRED") return false;
  const said = turn.said.text ?? "";

  if (reservation.status === "EXPIRED") {
    const confirmed = await session.core.hasConfirmedLeftAfterClose(reservation.id);
    if (confirmed) return false;
    if (isLeavingTour(stripFiller(normalize(said))) || (intent.type === "FINISH_TOUR" && turn.confident)) {
      await session.recordText(turn.said);
      await session.core.confirmLeftAfterClose(reservation.id);
      overstay.cancel(reservation.id);
      await session.refreshThread();
      session.followUpReservationId = reservation.id;
      return true;
    }
    const closedAt = (await session.store.listAudit()).find((e) => e.type === "TOUR_OVERSTAY_CLOSED" && e.reservationId === reservation.id)?.at;
    const afterCloseOpen = afterCloseAlertOpen({
      nowMs: session.clock.now().getTime(),
      closedAt,
      confirmedLeft: false,
      exceptionResolved: !!overstay.get(reservation.id)?.alertClosedAt,
    });
    if (afterCloseOpen) {
      if (isClearBookingPhrase(said, intent) && !session.pendingBookingId) {
        await startBookingAfterClose(turn);
        return true;
      }
      await session.recordText(turn.said);
      await session.core.replyAfterOverstayClose(reservation.id, said);
      await session.refreshThread();
      return true;
    }
    if (session.pendingBookingId) {
      session.promotePendingBookingIfEnded();
      if (await session.activeNeedsConsent()) {
        await session.recordText(turn.said);
        await session.announceHeldBookingConsent();
        return true;
      }
    }
    if (startsNewBookingAfterClose(said, intent)) {
      await startBookingAfterClose(turn);
      return true;
    }
    return false;
  }

  if (overstay.takePendingRebook(reservation.id, said)) {
    await startRebook(turn);
    return true;
  }

  // T-15 / T-5 / more-time replies first so "all set" after T-15 is not treated as leaving.
  const reply = await overstay.replyToVisitor(session.core, reservation.id, said);
  if (reply !== undefined) {
    if (reply === T5_NO_OFFER_BARE_YES && (await session.pendingBookingNeedsConsent())) {
      await session.answerPendingConsent(true, turn.said);
      return true;
    }
    await turn.respond(reply);
    if (reply.startsWith("You've got 10 more minutes.") && (await session.pendingBookingNeedsConsent())) {
      await session.reply(CONSENT_TEXT, { kind: "yes-no" });
    }
    return true;
  }

  if (intent.type === "FINISH_TOUR" && turn.confident) {
    await turn.act("finish");
    overstay.cancel(reservation.id);
    return true;
  }
  if (intent.type === "ASK_MORE_TIME" && turn.confident) {
    const body = await overstay.handleAsk(session.core, reservation.id, "natural");
    await turn.respond(body);
    return true;
  }
  return false;
}

async function startRebook(turn: Turn): Promise<void> {
  const { session } = turn;
  await session.recordText(turn.said);
  const dates = await session.beginRebook();
  if (!dates.length) {
    await session.reply(VisitorDenialCopy.noOpenTimes(session.config.operator.name));
    return;
  }
  session.markDatesShown();
  await session.reply(DAY_MENU, { kind: "choose", options: dates.map((day) => day.label), what: "a day" });
}

/** After a tour ends, a greeting continues the held booking: booked-for line, then the original consent question. */
async function takeOverHeldBookingOnGreeting(turn: Turn): Promise<boolean> {
  const { session, intent } = turn;
  const text = turn.said.text ?? "";
  if (await session.afterCloseStillOpen()) return false;
  if (session.followUpReservationId && !(await session.hasFollowUpResponse(session.followUpReservationId))) return false;
  if (!startsNewBookingAfterClose(text, intent)) return false;
  if (session.pendingBookingId) {
    const current = await session.reservation();
    if (current && current.status !== "COMPLETED" && current.status !== "EXPIRED") return false;
    if (current?.status === "COMPLETED" && !(await session.hasFollowUpResponse(current.id))) return false;
    session.promotePendingBookingIfEnded();
  }
  if ((session.heldBookingTakenOver || session.followUpReservationId) && (await session.activeNeedsConsent())) {
    session.followUpReservationId = undefined;
    await session.recordText(turn.said);
    await session.announceHeldBookingConsent();
    return true;
  }
  return false;
}

async function handlePendingBookingReply(turn: Turn): Promise<boolean> {
  const { session } = turn;
  if (!session.pendingBookingId) return false;
  if ((await session.stage()) === "follow-up") return false;
  const text = turn.said.text ?? "";
  if (await session.pendingBookingNeedsConsent()) {
    const yn = yesNo(stripFiller(normalize(text)));
    if (yn.answer === "yes" && yn.confidence >= 0.75) {
      await session.answerPendingConsent(true, turn.said);
      return true;
    }
    if (yn.answer === "no" && yn.confidence >= 0.75) {
      await session.answerPendingConsent(false, turn.said);
      return true;
    }
  }
  if ((await session.pendingBookingNeedsVerification()) && /\b(form|link|identity|verify|verification)\b/.test(stripFiller(normalize(text)))) {
    await session.resendPendingVerification(turn.said);
    return true;
  }
  return false;
}

async function startBookingAfterClose(turn: Turn): Promise<void> {
  const { session } = turn;
  session.pendingRebook = false;
  session.rebookUnitId = undefined;
  const current = await session.reservation();
  if (current) session.overstay?.cancel(current.id);
  session.reservationId = undefined;
  await session.greet(turn.said);
}

async function handlePendingRebookPick(turn: Turn): Promise<boolean> {
  const { session } = turn;
  if (!session.pendingRebook) return false;
  if (
    turn.awaiting &&
    (turn.awaiting.kind === "confirm-stop" ||
      turn.awaiting.kind === "confirm-arrival" ||
      turn.awaiting.kind === "confirm-finish" ||
      turn.awaiting.kind === "choose-stop" ||
      turn.awaiting.kind === "confirm-cancel-tour")
  ) {
    return false;
  }
  const step: VisitorStage = session.selectedDate ? "choose-time" : "choose-date";
  const interpretation = await rulesOnly.interpret(await contextFor(session, turn.said.text ?? "", step, turn.awaiting));
  if (interpretation.intent.type === "SELECT_DATE") {
    await showAskedDay(turn, interpretation.intent);
    return true;
  }
  if (interpretation.intent.type === "SELECT_TIME") {
    const picked = interpretation.intent;
    const slot = session.offeredSlots.find((s) => same(s.label, picked.timeLabel));
    if (slot && isConfident(interpretation)) {
      await session.recordText(turn.said);
      await session.confirmRebook(slot.start.toISOString());
      return true;
    }
  }
  return false;
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
