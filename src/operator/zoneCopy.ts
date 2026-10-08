import { spokenTimeZone } from "../core/timezone";
import { addressTimeZoneGuess, type SetupDraft } from "../setup/setupActions";

/**
 * One sentence when a state change would move a locked zone. Empty when the
 * zone was updated, already matches, the state did not change, or the
 * operator set a zone on this call.
 */
export function zoneSwitchSentence(stateBefore: string, next: SetupDraft, timezoneGiven: boolean): string {
  if (timezoneGiven) return "";
  const stateAfter = next.property.canonicalAddress?.state.trim() ?? "";
  if (!stateAfter || stateAfter === stateBefore) return "";
  const guess = addressTimeZoneGuess(next.property.canonicalAddress);
  if (guess.basis !== "address" || guess.timezone === next.property.timezone) return "";
  return ` Tours still run on ${spokenTimeZone(next.property.timezone)} time. Should I switch to ${spokenTimeZone(guess.timezone)} time?`;
}

/**
 * " I'm using Eastern time for tours. Want a different one?" when a zone was
 * just guessed: the state went from blank to set, or an unlocked state change
 * moved the zone. Empty when no state is known, the operator set the zone,
 * the state did not change, or a locked zone stayed put.
 */
export function guessedZoneSentence(stateBefore: string, timezoneBefore: string, next: SetupDraft, timezoneGiven: boolean): string {
  if (timezoneGiven) return "";
  const stateAfter = next.property.canonicalAddress?.state.trim() ?? "";
  if (!stateAfter || stateAfter === stateBefore) return "";
  const guess = addressTimeZoneGuess(next.property.canonicalAddress);
  if (guess.basis !== "address" || guess.timezone !== next.property.timezone) return "";
  const firstState = stateBefore.length === 0;
  const moved = timezoneBefore.length > 0 && next.property.timezone !== timezoneBefore;
  if (!firstState && !moved) return "";
  return ` I'm using ${spokenTimeZone(next.property.timezone)} time for tours. Want a different one?`;
}
