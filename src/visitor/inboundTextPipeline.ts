import { isFairHousingQuestion } from "../core/fairHousing";
import {
  isCancelTourAsk,
  isMedicalEmergency,
  isOnTourDoorAsk,
  isUnbookedCancelAsk,
  keywordOf,
  messagingKeyword,
} from "../intent/ruleBased";
import { normalize } from "../intent/normalize";
import type { StopRef } from "../intent/model";

/**
 * Every inbound SMS is classified here. Handlers are in the fixed order and
 * the first one that matches wins. Callers dispatch that one handler. They
 * do not run a later check on the same text.
 *
 * HELP is only the bare carrier keyword. A clock in the same text is a time.
 * An injury that also says "help" is an emergency. CANCEL alone is STOP.
 * While a tour is in progress, that bare cancel stays a cancel so the tour
 * the visitor is on is not opted out from under them.
 */
export type InboundKind = "help" | "emergency" | "door" | "stop" | "cancel" | "menu" | "fair-housing";

export interface InboundFacts {
  text: string;
  /** Property stops. Empty unless a tour is running, so a named door off the route is still a door ask. */
  doors?: StopRef[];
  /** Booked tour in progress, on hold, or paused for a door problem. */
  touring?: boolean;
  /** The day or time menu they are looking at already accepts this text. */
  menuAnswer?: boolean;
}

interface Handler {
  kind: InboundKind;
  matches(facts: InboundFacts): boolean;
}

/** Whole-message cancel, the carrier STOP word, not "please cancel". */
export function isBareCarrierCancel(text: string): boolean {
  return keywordOf(text) === "stop" && normalize(text) === "cancel";
}

/** A day or time choice on the menu in front of them. A day named at the unit menu is not this. */
export function isSchedulingMenuAnswer(step: string | undefined, intentType: string): boolean {
  if (step === "choose-date" && intentType === "SELECT_DATE") return true;
  if (step === "choose-time" && (intentType === "SELECT_TIME" || intentType === "SELECT_DATE")) return true;
  return false;
}

const HANDLERS: readonly Handler[] = [
  {
    kind: "help",
    matches: (facts) => keywordOf(facts.text) === "help",
  },
  {
    kind: "emergency",
    matches: (facts) => isMedicalEmergency(facts.text),
  },
  {
    kind: "door",
    matches: (facts) => !!facts.touring && !!facts.doors?.length && isOnTourDoorAsk(facts.text, facts.doors),
  },
  {
    kind: "stop",
    matches: (facts) => {
      if (messagingKeyword(facts.text) !== "stop") return false;
      if (facts.touring && isBareCarrierCancel(facts.text)) return false;
      return true;
    },
  },
  {
    kind: "cancel",
    matches: (facts) => isCancelTourAsk(facts.text) || isUnbookedCancelAsk(facts.text),
  },
  {
    kind: "menu",
    matches: (facts) => !!facts.menuAnswer,
  },
  {
    kind: "fair-housing",
    matches: (facts) => isFairHousingQuestion(facts.text),
  },
];

/** The first matching handler, or nothing when the text is ordinary booking chatter. */
export function firstInboundMatch(facts: InboundFacts): InboundKind | undefined {
  return HANDLERS.find((handler) => handler.matches(facts))?.kind;
}
