import type { TurnoverWindow } from "./calendar";

export interface CleanerText {
  to: string;
  body: string;
  kind: "offer" | "confirm" | "declined" | "stop" | "help" | "start" | "emergency" | "pin";
}

export type ScheduleReason =
  | "disabled"
  | "not-consented"
  | "scratch-only"
  | "pin-invalid"
  | "no-turnover"
  | "offered"
  | "already-offered"
  | "declined";

export interface ScheduleResult {
  scheduled: boolean;
  reason: ScheduleReason;
  sent: CleanerText[];
  turnover?: TurnoverWindow;
}

export type ReceiveReason =
  | "disabled"
  | "duplicate"
  | "help"
  | "emergency"
  | "stop"
  | "start"
  | "scheduled"
  | "declined"
  | "ignored"
  | "scratch-only";

export interface ReceiveResult {
  handled: boolean;
  reason: ReceiveReason;
  sent: CleanerText[];
}

export interface CleanerSink {
  send(text: CleanerText): void | Promise<void>;
}

export interface CleanerCoreOptions {
  enabled: boolean;
  property: { id: string; address: string; timeZone: string };
  /** Cleaning-service owner who gets the schedule text. Never the door code. */
  ownerPhone: string;
  /** Approved cleaner who may receive the door code in a separate private text. */
  cleaner: { phone: string; approved: boolean };
  pin: string;
  /** Landlord already approved texting this owner. A phone number alone is not consent. */
  consented?: boolean;
  sink: CleanerSink;
  now?: () => Date;
}

export interface CleanerCore {
  scheduleFromIcal(ical: string): Promise<ScheduleResult>;
  receive(input: { id: string; from: string; text: string }): Promise<ReceiveResult>;
}

/**
 * Usage:
 *   const core = openCleanerCore({ enabled: cleanerCoreEnabled(env), property, ownerPhone, cleaner, pin, consented: true, sink, now });
 *   const offer = await core.scheduleFromIcal(icalText);
 *   const booked = await core.receive({ id, from: ownerPhone, text: "YES" });
 * Flag off returns reason "disabled" and sends nothing. The door code is a separate text to the approved cleaner only.
 */
export function openCleanerCore(_options: CleanerCoreOptions): CleanerCore {
  throw new Error("not implemented");
}
