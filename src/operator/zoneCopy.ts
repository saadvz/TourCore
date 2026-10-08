import { spokenTimeZone } from "../core/timezone";
import { addressTimeZoneGuess, SetupInputError, type SetupDraft } from "../setup/setupActions";
import { resolveTimeZone } from "../setup/parse";
import type { TourCoreConfig } from "../config/tourCoreConfig";

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

export type ZoneSwitchHeld = NonNullable<Extract<NonNullable<TourCoreConfig["property"]["zoneSwitchOffer"]>, { zone: string }>["held"]>;

const HOLD_KEYS = [
  "name",
  "address",
  "propertyType",
  "street",
  "city",
  "state",
  "postalCode",
  "confirmAddress",
  "facts",
  "buildingAccess",
  "entryInstructions",
  "skipEntryInstructions",
  "alertName",
  "alertContact",
  "visitorContact",
  "skipVisitorHelp",
] as const satisfies readonly (keyof ZoneSwitchHeld)[];

export function offeredZone(draft: SetupDraft): string | undefined {
  const offer = draft.property.zoneSwitchOffer;
  const zone = typeof offer === "string" ? offer : offer?.zone;
  const trimmed = zone?.trim();
  return trimmed || undefined;
}

/** Fields waiting on an open switch. Absent on a string offer or an offer with no held field. */
export function heldZoneFields(draft: SetupDraft): ZoneSwitchHeld | undefined {
  const offer = draft.property.zoneSwitchOffer;
  if (!offer || typeof offer === "string" || !offer.held) return undefined;
  return Object.keys(offer.held).length ? offer.held : undefined;
}

export function fieldsToHold(input: Partial<ZoneSwitchHeld>): ZoneSwitchHeld | undefined {
  const held: ZoneSwitchHeld = {};
  for (const key of HOLD_KEYS) {
    const value = input[key];
    if (value !== undefined) (held as Record<string, unknown>)[key] = value;
  }
  return Object.keys(held).length ? held : undefined;
}

/**
 * Keeps the offered zone and merges these fields over any already held.
 * A later ZIP replaces the earlier one. The offer stays on this property,
 * so starting or updating another property neither applies it nor drops it.
 */
export function holdZoneSwitchFields(draft: SetupDraft, incoming: ZoneSwitchHeld | undefined): boolean {
  if (!incoming) return false;
  const zone = offeredZone(draft);
  if (!zone) return false;
  draft.property.zoneSwitchOffer = { zone, held: { ...heldZoneFields(draft), ...incoming } };
  return true;
}

export function switchQuestionForOffer(draft: SetupDraft): string {
  const offer = offeredZone(draft);
  if (!offer) return "";
  return `Tours still run on ${spokenTimeZone(draft.property.timezone)} time. Should I switch to ${spokenTimeZone(offer)} time?`;
}

/** The repeat while something is waiting to be saved. The switch question is the only question. */
export function switchHoldReply(question: string): string {
  return `Before I save that, one thing. ${question}`;
}

/**
 * Saves the zone answer, then the held fields. A held ZIP that does not match
 * the state is not saved: the zone answer is kept, and the mismatch question
 * is the reply.
 */
export function commitZoneAnswer<T>(attempt: (dropPostal: boolean) => T): T {
  try {
    return attempt(false);
  } catch (err) {
    if (!(err instanceof SetupInputError) || err.code !== "ZIP_STATE_MISMATCH") throw err;
    attempt(true);
    throw err;
  }
}

/** Fields to save with a zone answer. The call's own values win. A mismatched ZIP is left out. */
export function mergedZoneDetails(input: ZoneSwitchHeld, held: ZoneSwitchHeld | undefined, timezone: string | undefined, dropPostal: boolean) {
  return {
    name: input.name ?? held?.name,
    address: input.address ?? held?.address,
    propertyType: input.propertyType ?? held?.propertyType,
    street: input.street ?? held?.street,
    city: input.city ?? held?.city,
    state: input.state ?? held?.state,
    postalCode: dropPostal ? undefined : (input.postalCode ?? held?.postalCode),
    confirmAddress: input.confirmAddress ?? held?.confirmAddress,
    facts: input.facts ?? held?.facts,
    buildingAccess: input.buildingAccess ?? held?.buildingAccess,
    entryInstructions: input.entryInstructions ?? held?.entryInstructions,
    skipEntryInstructions: input.skipEntryInstructions ?? held?.skipEntryInstructions,
    timezone,
    alertName: input.alertName ?? held?.alertName,
    alertContact: input.alertContact ?? held?.alertContact,
    visitorContact: input.visitorContact ?? held?.visitorContact,
    skipVisitorHelp: input.skipVisitorHelp ?? held?.skipVisitorHelp,
  };
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
  const kept = text.match(/^keep\s+(.+)$/i);
  const named = resolveTimeZone(kept ? kept[1]! : text);
  if (named) return { timezone: named, answered: true };
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
