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

/** Offer copies drop the YES ask. The cleaner is the only person who can confirm. */
export function offerForOthers(body: string): string {
  return body.endsWith(OFFER_ASK) ? `${body.slice(0, -OFFER_ASK.length)}${OFFER_WAIT}` : body;
}

export function reminderBody(address: string, when: { day: string; time: string }, privateTurn: boolean): string {
  return privateTurn
    ? `Reminder: cleaning at ${address} is ${when.day} at ${when.time}.`
    : `Reminder: checkout at ${address} is ${when.day} at ${when.time}. Reply STOP to opt out.`;
}

export function doorCodeBody(address: string, code: string): string {
  return `Guests have left ${address}. Door code: ${code}. This code is only for you.`;
}

export function holdNote(address: string): string {
  return `The cleaning at ${address} is on hold until the cleaner replies YES.`;
}

export function resumeNote(address: string): string {
  return `The cleaning at ${address} is back on.`;
}

export function groupOptInBody(name: string, otherName: string, address: string): string {
  return `${name}, you're invited to the cleaning group for ${address} with ${otherName}. Reply YES to join that group, or STOP to opt out.`;
}

export function groupDoorCodeBody(cleanerName: string, address: string, code: string): string {
  return `${cleanerName}, guests have left ${address}. Door code: ${code}.`;
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
