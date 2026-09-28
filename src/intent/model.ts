import { z } from "zod";

/**
 * What a visitor is trying to do, in Tour Core's own terms. An interpreter
 * turns free text into one of these; it never decides whether anything is
 * allowed. Tour Core's state machine and access policy decide that, exactly
 * as they do for a button tap.
 */

export const HelpProblemSchema = z.enum(["DOOR_WONT_OPEN", "LOST", "CANT_FIND_UNIT", "GENERAL"]);
export type HelpProblem = z.infer<typeof HelpProblemSchema>;

const Name = z.string().trim().min(1).max(80);

export const TourIntentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("START_INQUIRY") }),
  /** `unitName` is one of the unit names Tour Core offered. */
  z.object({ type: z.literal("SELECT_UNIT"), unitName: Name }),
  /** `timeLabel` is one of the time labels Tour Core offered ("2:00 PM"). */
  z.object({ type: z.literal("SELECT_TIME"), timeLabel: Name }),
  /**
   * A specific time that isn't being booked as a normal slot. Hour is 1–12.
   * Meridiem and day are present only when the visitor said them.
   */
  z.object({
    type: z.literal("REQUEST_CUSTOM_TIME"),
    hour: z.number().int().min(1).max(12),
    minute: z.number().int().min(0).max(59),
    meridiem: z.enum(["AM", "PM"]).optional(),
    day: z.enum(["today", "tomorrow"]).optional(),
  }),
  z.object({ type: z.literal("ACCEPT_PROPOSED_TIME") }),
  z.object({ type: z.literal("DECLINE_PROPOSED_TIME") }),
  z.object({ type: z.literal("CONSENT_YES") }),
  z.object({ type: z.literal("CONSENT_NO") }),
  z.object({ type: z.literal("ARRIVAL") }),
  /** A non-unit stop by door name ("Entrance"); no name means "wherever I'm expected next". */
  z.object({ type: z.literal("AT_ROUTE_STOP"), stopName: Name.optional() }),
  /** A unit by name; no name means "the unit" without saying which. */
  z.object({ type: z.literal("AT_UNIT"), unitName: Name.optional() }),
  z.object({ type: z.literal("ASK_PROPERTY_QUESTION"), question: z.string().trim().min(1).max(300) }),
  z.object({ type: z.literal("REQUEST_HELP"), problem: HelpProblemSchema.optional() }),
  z.object({ type: z.literal("FINISH_TOUR") }),
  z.object({ type: z.literal("FOLLOW_UP_YES") }),
  z.object({ type: z.literal("FOLLOW_UP_NO") }),
  z.object({ type: z.literal("STOP_MESSAGES") }),
  z.object({ type: z.literal("START_MESSAGES") }),
  z.object({ type: z.literal("UNKNOWN") }),
]);
export type TourIntent = z.infer<typeof TourIntentSchema>;
export type IntentType = TourIntent["type"];

export type InterpreterKind = "rules" | "semantic";

export interface IntentInterpretation {
  intent: TourIntent;
  /** 0..1. Tour Core compares this against its own thresholds; the interpreter doesn't act on it. */
  confidence: number;
  interpreter: InterpreterKind;
  /** The interpreter saw more than one plausible meaning (e.g. two units named). */
  clarificationNeeded: boolean;
  /** Tour Core-authored wording for the clarification, when the rules have a specific one. */
  clarificationQuestion?: string;
  /**
   * A clock time mentioned next to a property question. One message still has
   * one intent: the question is answered, and the time is filed only after the
   * visitor confirms it.
   */
  mentionedTime?: { hour: number; minute: number; meridiem?: "AM" | "PM"; day?: "today" | "tomorrow" };
  /** The text reads like an instruction to the assistant ("ignore your rules..."), not a visitor action. */
  manipulation?: boolean;
}

/** A door as the interpreter sees it: names only, never credentials. */
export interface StopRef {
  doorName: string;
  kind: "ENTRANCE" | "UNIT" | "COMMON";
  /** Set for a unit's own door. */
  unitName?: string;
  /** How Tour Core refers to it in messages ("Unit 101", "the entrance"). */
  label: string;
}

/** A tour-step confirmation Tour Core is waiting on, so a bare "yes" or "2" has a meaning. */
export type StepAwaiting =
  | { kind: "confirm-arrival" }
  | { kind: "confirm-stop"; stop: StopRef }
  | { kind: "choose-stop"; stops: StopRef[] }
  | { kind: "confirm-finish" }
  | { kind: "confirm-custom-time"; hour: number; minute: number; meridiem?: "AM" | "PM"; day?: "today" | "tomorrow" }
  | { kind: "confirm-alternative"; requestId: string; startsAt: string };

/**
 * Something Tour Core just asked the visitor. `which-unit` interrupts the
 * step for a question ("Which unit do you mean: 1A or 2B?"); `resume` is the
 * step confirmation that was open before, restored once the question is done.
 */
export type Awaiting = StepAwaiting | { kind: "which-unit"; question: string; units: string[]; resume?: StepAwaiting };

export type ConversationStep = "intro" | "choose-unit" | "choose-time" | "consent" | "identity" | "ready" | "touring" | "follow-up" | "done" | "stopped";

export interface InterpretContext {
  message: string;
  /** Where the conversation is, which also says what Tour Core last asked for. */
  step: ConversationStep;
  awaiting?: StepAwaiting;
  units: { name: string; summary?: string }[];
  /** Tour times offered, in menu order. */
  timeChoices: string[];
  /** The unit on the visitor's reservation, once there is one. */
  reservedUnit?: string;
  /** Stops on the reserved route that haven't been opened yet, in order. */
  remainingStops: StopRef[];
  /** Every door on file, so a visitor naming an off-route door is understood (and then refused by policy). */
  doors: StopRef[];
}

export interface IntentInterpreter {
  /** Short label for developer details, e.g. "rules" or "rules + grok-4". */
  readonly description: string;
  interpret(context: InterpretContext): Promise<IntentInterpretation>;
}

/** Intents that lead toward a door opening. */
export const ACCESS_INTENTS: ReadonlySet<IntentType> = new Set(["ARRIVAL", "AT_ROUTE_STOP", "AT_UNIT"]);

const STATE_CHANGING: ReadonlySet<IntentType> = new Set([
  "SELECT_UNIT",
  "SELECT_TIME",
  "REQUEST_CUSTOM_TIME",
  "ACCEPT_PROPOSED_TIME",
  "DECLINE_PROPOSED_TIME",
  "CONSENT_YES",
  "CONSENT_NO",
  "FINISH_TOUR",
  "FOLLOW_UP_YES",
  "FOLLOW_UP_NO",
  "STOP_MESSAGES",
  "START_MESSAGES",
]);

/**
 * Tour Core's bar for acting on an interpretation. Below it, Tour Core asks
 * instead of acting. Access-bound intents need the most certainty.
 */
export function requiredConfidence(type: IntentType): number {
  if (ACCESS_INTENTS.has(type)) return 0.85;
  if (STATE_CHANGING.has(type)) return 0.75;
  return 0.5;
}

export function isConfident(i: IntentInterpretation): boolean {
  return i.intent.type !== "UNKNOWN" && !i.clarificationNeeded && !i.manipulation && i.confidence >= requiredConfidence(i.intent.type);
}
