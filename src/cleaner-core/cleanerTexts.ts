/**
 * The only place a cleaning offer, reminder, or door code is addressed.
 * The recipient is the property's opted-in cleaner record. There is no phone
 * argument and no fallback to the host.
 */

export interface OptedInCleaner {
  readonly phone: string;
  readonly approved: true;
  readonly consent: "in";
}

export type CleanerTextKind = "offer" | "reminder" | "pin";

export interface AddressedCleanerText {
  to: string;
  kind: CleanerTextKind;
  body: string;
}

/** Turns the stored cleaner record into the only recipient a cleaner text can name. */
export function asOptedInCleaner(record: {
  phone: string | undefined;
  approved: boolean;
  consent: "pending" | "in" | "out";
}): OptedInCleaner | undefined {
  if (!record.phone || record.approved !== true || record.consent !== "in") return undefined;
  return { phone: record.phone, approved: true, consent: "in" };
}

/** Addresses one cleaner text. No record means no text. */
export function addressCleaner(
  cleaner: OptedInCleaner | undefined,
  message: { kind: CleanerTextKind; body: string },
): AddressedCleanerText | null {
  if (!cleaner) return null;
  return { to: cleaner.phone, kind: message.kind, body: message.body };
}

const OFFER_ASK = "Reply YES to schedule it, or STOP to opt out.";
const OFFER_WAIT = "The cleaner will reply to confirm.";

export function offerBody(
  address: string,
  checkout: { day: string; time: string },
  next: { day: string; time: string } | null,
  sameDay: boolean,
): string {
  const guest = !next ? "" : sameDay || next.day === checkout.day ? `, next guest ${next.time}` : `, next guest ${next.day} at ${next.time}`;
  return `Turnover at ${address} on ${checkout.day}. Checkout ${checkout.time}${guest}. ${OFFER_ASK}`;
}

const HOST_NOTE = " Note from the host: ";

/** The first offer with the host's saved other instructions at the end. Without any, the offer is unchanged. */
export function withHostNote(body: string, instructions: string | undefined): string {
  const note = instructions?.trim();
  return note ? `${body}${HOST_NOTE}${note}` : body;
}

/** The text an offer adds after Cleaner Core's own words: the host's note, or nothing. */
export function hostNoteOf(body: string): string {
  const index = body.indexOf(HOST_NOTE);
  return index < 0 ? "" : body.slice(index);
}

/**
 * Offer copies drop the YES ask. The cleaner is the only person who can confirm. The host's note,
 * when there is one, stays after it.
 */
export function offerForOthers(body: string): string {
  const note = hostNoteOf(body);
  const own = body.slice(0, body.length - note.length);
  return own.endsWith(OFFER_ASK) ? `${own.slice(0, -OFFER_ASK.length)}${OFFER_WAIT}${note}` : body;
}

/** The checklist, after the private code. Each item loses a trailing period or semicolon. */
export function checklistBody(name: string, items: readonly string[]): string {
  const list = items.map((item) => item.trim().replace(/[.;]+$/, "")).join("; ");
  return `Checklist for ${name}: ${list}. Send photos, then reply DONE when finished.`;
}

export const PHOTO_FIRST = "Please send a photo of the finished rooms, then reply DONE.";

export function reminderBody(address: string, when: { day: string; time: string }, privateTurn: boolean): string {
  return privateTurn
    ? `Reminder: cleaning at ${address} is ${when.day} at ${when.time}.`
    : `Reminder: checkout at ${address} is ${when.day} at ${when.time}. Reply STOP to opt out.`;
}

/** The scheduled reminder. It names the checkout and asks the cleaner when they plan to arrive. */
export function arrivalReminderBody(address: string, when: { day: string; time: string }): string {
  return `Reminder: cleaning at ${address} on ${when.day}. Checkout is ${when.time}. What time do you plan to arrive?`;
}

/** The new-booking question for the host when the property's usual times are saved. */
export function usualTimesAsk(name: string, checkInDay: string, checkoutDay: string, checkout: string, checkIn: string): string {
  return `New booking at ${name}: check-in ${checkInDay}, checkout ${checkoutDay}. Use the usual ${checkout} checkout and ${checkIn} check-in?`;
}

export function doorCodeBody(address: string, code: string, lockLocation?: string): string {
  const label = lockLocation ? `Door code for the ${lockLocation}` : "Door code";
  return `Guests have left ${address}. ${label}: ${code}. This code is only for you. Reply DONE when the cleaning is finished.`;
}

export function holdNote(address: string): string {
  return `The cleaning at ${address} is on hold until the cleaner replies YES.`;
}

export function jobHoldLine(address: string): string {
  return `The cleaning at ${address} is on hold.`;
}

export function cleanerOptOutHold(address: string): string {
  return `The cleaner opted out of cleaning texts for ${address}, so the cleaning is on hold. Find another cleaner or reach them directly, then tell your Grok Bot to restart it.`;
}

export function injuryHoldLine(address: string): string {
  return `The cleaning at ${address} is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.`;
}

export function ownerOptOutHoldNote(address: string): string {
  return `The cleaning at ${address} is on hold because you opted out of texts. Tell your Grok Bot to restart it.`;
}

export function optedOutCodeLine(): string {
  return "The cleaner opted out, so the door code wasn't sent. Please reach them directly.";
}

export function resumeNote(address: string): string {
  return `The cleaning at ${address} is back on.`;
}

export function hostStopReply(address: string, held: boolean): string {
  return held
    ? `You're opted out of cleaning texts for ${address}, and the cleaning there is on hold. Reply START to get texts again.`
    : `You're opted out of cleaning texts for ${address}. Reply START to get texts again.`;
}

export function hostStartReply(address: string, held: boolean): string {
  return held
    ? `You'll get cleaning texts for ${address} again. The cleaning is still on hold. Tell your Grok Bot to restart it.`
    : `You'll get cleaning texts for ${address} again.`;
}

export function hostDoneLine(address: string): string {
  return `The cleaner marked the cleaning at ${address} done.`;
}

export function groupOptInBody(name: string, otherName: string, address: string): string {
  return `${name}, you're invited to the cleaning group for ${address} with ${otherName}. Reply YES to join that group, or STOP to opt out.`;
}

export type CleanerStep =
  | "needs-yes"
  | "waiting-for-guests"
  | "waiting-for-code"
  | "in-progress"
  | "already-done"
  | "on-hold";

export function cleanerNextStep(step: CleanerStep): string {
  switch (step) {
    case "needs-yes":
      return "Reply YES to schedule the cleaning, or STOP to opt out.";
    case "waiting-for-guests":
      return "I'll text you the door code after the guests leave. Reply DONE after that.";
    case "waiting-for-code":
      return "I haven't sent the door code yet. Reply DONE after I do.";
    case "in-progress":
      return "Reply DONE when the cleaning is finished.";
    case "already-done":
      return "This cleaning is already marked done.";
    case "on-hold":
      return "The cleaning is on hold. I'll text you when it can start again.";
  }
}

export function privateCodeLine(cleanerName: string): string {
  return `${cleanerName} got the door code privately.`;
}

const PRIVATE_GOT = " got the door code privately.";

export function isPrivateCodeLine(body: string): boolean {
  return body.endsWith(PRIVATE_GOT) && body.length > PRIVATE_GOT.length;
}

const GROUP_SEND_TOPICS = new Map<string, string>([
  ["confirm", "checkout time"],
  ["offer", "cleaning offer"],
  ["reminder", "reminder"],
  ["opt-in", "invitation"],
]);

export function groupUnconfirmedLine(kind: string): string {
  const topic = GROUP_SEND_TOPICS.get(kind);
  if (!topic) return "I couldn't send that to the group.";
  return `I couldn't send the ${topic} to the group.`;
}

export function groupTimeLine(hostName: string): string {
  return `${hostName} will confirm that time.`;
}
