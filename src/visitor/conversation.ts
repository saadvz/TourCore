import type { InboundMeta } from "../core/TourCore";
import {
  isConfident,
  keywordOf,
  LayeredIntentInterpreter,
  normalize,
  type Awaiting,
  type IntentInterpretation,
  type IntentInterpreter,
  type InterpretContext,
  type StopRef,
  type TourIntent,
} from "../intent";
import type { ReplyPrompt } from "../messaging/presentation";
import type { InterpretationNote, Said, VisitorDemoSession, VisitorStage } from "./session";

/**
 * Typed replies from a real phone ("1", "YES", "just pulled up", "does it
 * have laundry?") mapped onto the same visitor actions the browser phone's
 * buttons use. An interpreter says what the visitor is trying to do; this
 * file decides, deterministically, whether that's clear enough to act on or
 * needs a question back. Whether a door opens is still decided only by Tour
 * Core's policy, exactly as for a button tap.
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

async function contextFor(session: VisitorDemoSession, message: string, step: VisitorStage, awaiting?: Awaiting): Promise<InterpretContext> {
  const r = await session.reservation();
  const remaining = step === "ready" || step === "touring" ? await session.remainingStops() : [];
  return {
    message,
    step,
    ...(awaiting ? { awaiting } : {}),
    units: session.config.units.map((u) => ({ name: u.name, ...(u.summary ? { summary: u.summary } : {}) })),
    timeChoices: session.offeredSlots.map((s) => s.label),
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
  ) {}

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

  // Someone who opted out only gets START / STOP handled; nothing they send is interpreted or answered.
  const keyword = keywordOf(text);
  if (session.optedOut && keyword !== "start" && keyword !== "stop") {
    await session.recordText(said);
    return undefined;
  }

  const stage = await session.stage();
  const awaiting = session.takeExpected(stage);
  const interpretation = await interpreter.interpret(await contextFor(session, text, stage, awaiting));
  const note = session.noteInterpretation(interpretation);
  const turn = new Turn(session, said, stage, interpretation, note);
  const { intent } = interpretation;

  if (intent.type === "STOP_MESSAGES" && turn.confident) await session.optOut(said);
  else if (intent.type === "START_MESSAGES" && turn.confident) await session.optIn(said);
  else if (keyword === "help") await session.help(said);
  else if (firstMessage) {
    if (intent.type === "SELECT_UNIT" && turn.confident) await chooseUnit(turn);
    else await session.greet(said);
  } else await byStage(turn);
  return interpretation;
}

async function chooseUnit(turn: Turn): Promise<void> {
  const units = turn.session.config.units;
  const unit = turn.intent.type === "SELECT_UNIT" ? units.find((u) => same(u.name, (turn.intent as { unitName: string }).unitName)) : undefined;
  const menu: ReplyPrompt = { kind: "choose", options: units.map((u) => u.name), what: "a unit" };
  if (unit && turn.confident) return turn.act("chooseUnit", { unitId: unit.id });
  const names = units.map((u) => u.name);
  const which = names.length === 2 ? `did you mean ${names[0]} or ${names[1]}?` : "which unit did you mean?";
  return turn.clarify(`Sure — ${which}`, menu);
}

async function byStage(turn: Turn): Promise<void> {
  const { session, intent } = turn;
  const yesNo: ReplyPrompt = { kind: "yes-no" };
  const later = (what: string) => `Good question! I can answer questions about the property once ${what}.`;

  switch (turn.stage) {
    case "intro":
      return session.greet(turn.said);

    case "choose-unit": {
      const menu: ReplyPrompt = { kind: "choose", options: session.config.units.map((u) => u.name), what: "a unit" };
      if (intent.type === "SELECT_UNIT") return chooseUnit(turn);
      if (intent.type === "REQUEST_HELP") return session.help(turn.said);
      if (intent.type === "ASK_PROPERTY_QUESTION") return turn.clarify(`${later("you've picked a unit")} Which unit would you like to see?`, menu);
      if (intent.type === "START_INQUIRY") return turn.respond("Hi! Which unit would you like to see?", menu);
      if (turn.interpretation.clarificationNeeded && !turn.interpretation.manipulation) return chooseUnit(turn);
      return turn.fallback(`${SORRY} Which unit would you like to see?`, menu);
    }

    case "choose-time": {
      const labels = session.offeredSlots.map((s) => s.label);
      const menu: ReplyPrompt = { kind: "choose", options: labels, what: "a time" };
      if (intent.type === "SELECT_TIME") {
        const slot = session.offeredSlots.find((s) => same(s.label, intent.timeLabel));
        if (slot && turn.confident) return turn.act("chooseTime", { slotStart: slot.start.toISOString() });
        return turn.clarify("Which time works for you?", menu);
      }
      if (intent.type === "REQUEST_HELP") return session.help(turn.said);
      if (intent.type === "ASK_PROPERTY_QUESTION") return turn.clarify(`${later("your tour is booked")} Which time works for you?`, menu);
      if (turn.interpretation.clarificationQuestion) return turn.clarify(`${turn.interpretation.clarificationQuestion} Which time works for you?`, menu);
      if (turn.interpretation.clarificationNeeded && !turn.interpretation.manipulation) return turn.clarify("Sure — which time works for you?", menu);
      return turn.fallback(`${SORRY} Which time works for you?`, menu);
    }

    case "consent": {
      const question = "Is it OK if I text you about this tour and keep a record of your visit?";
      if (intent.type === "CONSENT_YES" || intent.type === "CONSENT_NO") {
        if (turn.confident) return turn.act("consent", { agree: intent.type === "CONSENT_YES" });
        return turn.clarify(`Just to check: ${question.charAt(0).toLowerCase()}${question.slice(1)}`, yesNo);
      }
      if (intent.type === "REQUEST_HELP") return session.help(turn.said);
      if (intent.type === "ASK_PROPERTY_QUESTION") return turn.clarify(`${later("your tour is booked")} First: ${question}`, yesNo);
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
      const question = "Would you like someone from the property team to follow up?";
      if (intent.type === "FOLLOW_UP_YES" || intent.type === "FOLLOW_UP_NO") {
        if (turn.confident) return turn.act("followUp", { wantsContact: intent.type === "FOLLOW_UP_YES" });
        return turn.clarify(`Just to check: ${question.charAt(0).toLowerCase()}${question.slice(1)}`, yesNo);
      }
      if (intent.type === "REQUEST_HELP") return session.help(turn.said);
      return turn.fallback(`${SORRY} ${question}`, yesNo);
    }

    case "done":
    case "stopped":
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
    case "ASK_PROPERTY_QUESTION":
      return turn.act("ask", { question: intent.question });
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
    case "ASK_PROPERTY_QUESTION":
      return turn.act("ask", { question: intent.question });
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
