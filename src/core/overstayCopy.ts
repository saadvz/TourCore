import { UNNAMED_VISITOR } from "../domain/model";
import { formatPhone } from "./phone";

/**
 * Locked visitor copy for overstay and the one-time 10-minute extension.
 * {place} = visitorSubject. {name} is omitted cleanly when unknown.
 * {end} = local end time like "3:30 PM".
 */

export const EXTENSION_MINUTES = 10;

export function knownFirstName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed || trimmed === UNNAMED_VISITOR) return undefined;
  return trimmed.split(/\s+/)[0];
}

export function landlordWho(name: string | undefined): string {
  return knownFirstName(name) ?? "A visitor";
}

export function t15Questions(place: string, name?: string): string {
  return name
    ? `Hope you're enjoying ${place}, ${name}! You have about 15 minutes left. Any questions about the place? Just text them here.`
    : `Hope you're enjoying ${place}! You have about 15 minutes left. Any questions about the place? Just text them here.`;
}

export const T15_BARE_YES = "Sure, what's your question?";
export const T15_NO_OR_ALL_GOOD = "Sounds good. Enjoy the rest of your tour!";

export function t5Offering(place: string, end: string, name?: string): string {
  return name
    ? `Heads up, ${name}, your tour of ${place} ends in 5 minutes, at ${end}. Want 10 more minutes? Just reply and ask.`
    : `Heads up, your tour of ${place} ends in 5 minutes, at ${end}. Want 10 more minutes? Just reply and ask.`;
}

export function t5NoOffer(place: string, end: string, name?: string): string {
  return name
    ? `Heads up, ${name}, your tour of ${place} ends in 5 minutes, at ${end}. Text DONE once you're outside.`
    : `Heads up, your tour of ${place} ends in 5 minutes, at ${end}. Text DONE once you're outside.`;
}

export const T5_NO_OFFER_BARE_YES = "Sounds good. Text DONE once you're outside.";

export function extensionGranted(newEnd: string): string {
  return `You've got 10 more minutes. Your tour now ends at ${newEnd}, and your doors will keep opening for you until then.`;
}

export function extensionUnavailable(end: string): string {
  return `Sorry, I can't add more time to this tour. It still ends at ${end}. Want to come back for another look? Reply here and I'll find you another time.`;
}

export function extensionAlreadyUsed(end: string): string {
  return `You've already used your extra 10 minutes, so your tour still ends at ${end}.`;
}

export const EXTENSION_AFTER_T =
  "Your tour time has ended, so I can't add more time now. Please head out the way you came in and text DONE once you're outside.";

export function tourEnded(place: string, name?: string): string {
  return name
    ? `Your tour of ${place} just ended, ${name}. I can't open any more doors for this tour, so please head out the way you came in and text DONE once you're outside.`
    : `Your tour of ${place} just ended. I can't open any more doors for this tour, so please head out the way you came in and text DONE once you're outside.`;
}

export const DOOR_AFTER_T =
  "Your tour time has ended, so I can't open that door. Please head out the way you came in and text DONE once you're outside.";

export function plus5CheckIn(place: string): string {
  return `Just checking in. Have you left ${place}? Text DONE once you're outside.`;
}

export function plus15Closed(place: string, helpNumber?: string): string {
  if (helpNumber) return `Your tour of ${place} is now closed. If you're still inside or need a hand, call ${formatPhone(helpNumber)}.`;
  return `Your tour of ${place} is now closed. If you're still inside or need a hand, reply here and I'll get someone to help.`;
}

export function landlordExtensionGranted(who: string, place: string, end: string): string {
  return `${who}'s tour of ${place} was extended. It now ends at ${end}.`;
}

export function landlordPlus5(who: string, place: string): string {
  return `${who} hasn't confirmed leaving ${place}.`;
}

export function landlordPlus15(who: string, place: string): string {
  return `${who}'s tour of ${place} is now closed, but they haven't confirmed leaving. You may want to check on the place.`;
}

/** Late arrival who never entered: restore the pre-overstay door-attempt line. */
export const LATE_ARRIVAL_EXPIRED = "Your tour time has ended, so I can't open doors anymore. Want me to find you another time?";

export function landlordRepliedAfterClose(who: string, place: string, message: string): string {
  return `${who} replied after their tour of ${place} closed: "${message}"`;
}

export function visitorRepliedAfterClose(helpNumber?: string): string {
  if (helpNumber) return `Thanks, I've let the property team know. If you're still inside or need a hand right away, call ${formatPhone(helpNumber)}.`;
  return `Thanks, I've let the property team know, and someone will reach out soon.`;
}

export function tourFinishedFollowUp(place: string, name?: string, recap?: string): string {
  const thanks = name ? `Thanks for touring ${place}, ${name}!` : `Thanks for touring ${place}!`;
  return `${thanks}${recap ? ` Quick recap: ${recap.replace(/\.$/, "")}.` : ""} The doors are locked again behind you.\nWould you like someone from the property team to follow up?`;
}

const REBOOK =
  /\b(another time|another look|find (me )?another|sure,? another|come back)\b/;

/** Yes / "sure, another time" after the no-time line. */
export function isRebookAccept(normalized: string): boolean {
  return REBOOK.test(normalized);
}

const MORE_TIME =
  /\b(more time|more minutes|extra time|extra minutes|10 more|ten more|another (10|ten) minutes|few more minutes|stay (a bit )?longer|need more time|can i (have|get) (more|10|ten|extra)|could i (have|get) (more|10|ten|extra))\b/;
const MORE_TIME_BARE = /^(can i stay|can we stay|a bit longer|little longer|10 more minutes|ten more minutes|more time)$/;

/** Natural ask for the one-time extension. */
export function isMoreTimeAsk(normalized: string): boolean {
  return MORE_TIME.test(normalized) || MORE_TIME_BARE.test(normalized);
}

const LEFT =
  /^(done|i am done|i am out|i am outside|im out|i left|i have left|we left|we have left|leaving|i am leaving|we are leaving|heading out|i am heading out|i am heading out now)$/;

/** DONE / I'm out / leaving / I left — ends the tour with the normal goodbye. */
export function isLeavingTour(normalized: string): boolean {
  return LEFT.test(normalized);
}

const ALL_GOOD = /^(no|nope|nah|no thanks|no thank you|all good|i am good|i am all good|im good|we are good|i am all set|all set|no questions|nothing)$/;

export function isT15NoOrAllGood(normalized: string): boolean {
  return ALL_GOOD.test(normalized);
}
