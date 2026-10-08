import { spokenTimeZone } from "../core/timezone";
import { addressTimeZoneGuess, type SetupDraft } from "../setup/setupActions";
import { resolveTimeZone } from "../setup/parse";

const YES = /^(yes|yeah|yep)$/i;
const NO = /^(no|nope)$/i;

/**
 * The switch question, with no leading space. Empty when the zone was
 * updated, already matches, the state did not change, or the operator set
 * a zone on this call.
 */
export function zoneSwitchQuestion(stateBefore: string, next: SetupDraft, timezoneGiven: boolean): string {
  if (timezoneGiven) return "";
  const stateAfter = next.property.canonicalAddress?.state.trim() ?? "";
  if (!stateAfter || stateAfter === stateBefore) return "";
  const guess = addressTimeZoneGuess(next.property.canonicalAddress);
  if (guess.basis !== "address" || guess.timezone === next.property.timezone) return "";
  return `Tours still run on ${spokenTimeZone(next.property.timezone)} time. Should I switch to ${spokenTimeZone(guess.timezone)} time?`;
}

/** Spoken zone when one was just guessed. Empty when the switch question applies instead. */
export function guessedZoneName(stateBefore: string, timezoneBefore: string, next: SetupDraft, timezoneGiven: boolean): string {
  if (timezoneGiven || zoneSwitchQuestion(stateBefore, next, timezoneGiven)) return "";
  const stateAfter = next.property.canonicalAddress?.state.trim() ?? "";
  if (!stateAfter || stateAfter === stateBefore) return "";
  const guess = addressTimeZoneGuess(next.property.canonicalAddress);
  if (guess.basis !== "address" || guess.timezone !== next.property.timezone) return "";
  const firstState = stateBefore.length === 0;
  const moved = timezoneBefore.length > 0 && next.property.timezone !== timezoneBefore;
  if (!firstState && !moved) return "";
  return spokenTimeZone(next.property.timezone);
}

/**
 * One operator reply. A switch question is the only question. A guess that
 * is followed by a setup question is a statement, then that one question.
 * "Want a different one?" is only when nothing follows the guess.
 */
export function zoneReply(prefix: string, switchQuestion: string, guessed: string, nextQuestion?: string): string {
  if (switchQuestion) return prefix ? `${prefix} ${switchQuestion}` : switchQuestion;
  if (guessed && nextQuestion) {
    const sentence = `I'm using ${guessed} time for tours. You can change that anytime. ${nextQuestion}`;
    return prefix ? `${prefix} ${sentence}` : sentence;
  }
  if (guessed) {
    const sentence = `I'm using ${guessed} time for tours. Want a different one?`;
    return prefix ? `${prefix} ${sentence}` : sentence;
  }
  if (nextQuestion) return prefix ? `${prefix} ${nextQuestion}` : nextQuestion;
  return prefix;
}

export function offeredZone(draft: SetupDraft): string | undefined {
  const offer = draft.property.zoneSwitchOffer?.trim();
  return offer || undefined;
}

export function switchQuestionForOffer(draft: SetupDraft): string {
  const offer = offeredZone(draft);
  if (!offer) return "";
  return `Tours still run on ${spokenTimeZone(draft.property.timezone)} time. Should I switch to ${spokenTimeZone(offer)} time?`;
}

/**
 * How a timezone argument answers an open switch question.
 * "yes" takes the offered zone. "no" keeps the current zone.
 * A real zone name is an explicit choice. Anything else, including a ZIP, is not an answer.
 */
export function zoneSwitchAnswer(draft: SetupDraft, timezone: string | undefined): { timezone?: string; answered: boolean } {
  const offer = offeredZone(draft);
  if (!offer || timezone === undefined) return { answered: false };
  const text = timezone.trim();
  if (YES.test(text)) return { timezone: offer, answered: true };
  if (NO.test(text)) return { answered: true };
  if (resolveTimeZone(text)) return { timezone: text, answered: true };
  return { answered: false };
}

/** Clears an answered switch on the draft that will be saved. "no" keeps the current zone. */
export function applyZoneSwitchAnswer(draft: SetupDraft, answer: { timezone?: string; answered: boolean }): void {
  if (!answer.answered) return;
  delete draft.property.zoneSwitchOffer;
  if (answer.timezone === undefined) draft.property.timezoneConfirmed = true;
}

/** Remember the zone the switch question offered, so a later ZIP cannot count as yes. */
export function rememberZoneSwitch(draft: SetupDraft, stateBefore: string, timezoneGiven: boolean): void {
  if (!zoneSwitchQuestion(stateBefore, draft, timezoneGiven)) return;
  const guess = addressTimeZoneGuess(draft.property.canonicalAddress);
  if (guess.basis === "address") draft.property.zoneSwitchOffer = guess.timezone;
}
