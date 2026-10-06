import type { Reservation } from "../domain/model";
import { dayReference, spokenTimes } from "../core/spokenTime";
import { addDays, localDateOf, weekdayOf, zonedParts, type LocalDate, type Weekday } from "../core/timezone";
import { isCancelableReservation } from "../domain/stateMachine";
import { normalize } from "../intent/normalize";

export type VisitorCancelTarget = {
  reservation: Reservation;
  laterWhileTouring: boolean;
};

export const TOURING_NOW: Reservation["status"][] = ["TOURING", "OPERATOR_HOLD", "PROVIDER_FAILURE"];

export type NamedCancelFocus = "running" | "later" | "unspecified";

const WEEKDAY_WORD: Record<string, Weekday> = {
  monday: "MON",
  tuesday: "TUE",
  wednesday: "WED",
  thursday: "THU",
  friday: "FRI",
  saturday: "SAT",
  sunday: "SUN",
};

/**
 * While they are touring and a later booking is held, cancel-by-text targets
 * that later booking. The running tour is never cancelled by visitor text.
 */
export function visitorCancelTarget(input: { current?: Reservation; later?: Reservation }): VisitorCancelTarget | undefined {
  const later = input.later && isCancelableReservation(input.later) ? input.later : undefined;
  if (input.current && TOURING_NOW.includes(input.current.status) && later) {
    return { reservation: later, laterWhileTouring: true };
  }
  if (input.current && isCancelableReservation(input.current)) {
    return { reservation: input.current, laterWhileTouring: false };
  }
  if (later) return { reservation: later, laterWhileTouring: false };
  return undefined;
}

/**
 * When they are touring and a later booking is held, a named day/time or
 * "this" / "current" tour points at the running tour. A named later booking
 * still goes to the later-cancel confirm. Bare cancel stays unspecified.
 */
export function namedCancelFocus(input: {
  text: string;
  current?: Reservation;
  later?: Reservation;
  timeZone: string;
  now: Date;
}): NamedCancelFocus {
  const normalized = normalize(input.text);
  const today = localDateOf(input.now, input.timeZone);
  const namedLaterDay = slotMatchesNamedDay(input.later, input.timeZone, today, normalized);
  const namedRunningDay = slotMatchesNamedDay(input.current, input.timeZone, today, normalized);
  if (namedLaterDay && !namedRunningDay) return "later";
  if (namedRunningDay) return "running";
  if (/\b(this|current) tour\b/.test(normalized)) return "running";
  const times = spokenTimes(normalized, today);
  const namedRunningTime = slotMatchesNamedTime(input.current, input.timeZone, times);
  const namedLaterTime = slotMatchesNamedTime(input.later, input.timeZone, times);
  if (namedRunningTime) return "running";
  if (namedLaterTime && !namedRunningDay) return "later";
  return "unspecified";
}

function slotMatchesNamedDay(reservation: Reservation | undefined, timeZone: string, today: LocalDate, normalized: string): boolean {
  if (!reservation?.slotStart) return false;
  const day = localDateOf(new Date(reservation.slotStart), timeZone);
  if (/\btoday\b/.test(normalized) && sameDate(day, today)) return true;
  if (/\btomorrow\b/.test(normalized) && sameDate(day, addDays(today, 1))) return true;
  const weekday = normalized.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (weekday && weekdayOf(day) === WEEKDAY_WORD[weekday[1]!]) return true;
  const asked = dayReference(normalized, today);
  if (asked && asked !== "menu" && asked.date) return sameDate(day, asked.date);
  return false;
}

function slotMatchesNamedTime(
  reservation: Reservation | undefined,
  timeZone: string,
  times: ReturnType<typeof spokenTimes>,
): boolean {
  if (!reservation?.slotStart || !times.length) return false;
  const parts = zonedParts(new Date(reservation.slotStart), timeZone);
  const hour12 = parts.hour % 12 || 12;
  const meridiem = parts.hour >= 12 ? "PM" : "AM";
  return times.some((spoken) => {
    if (spoken.hour !== hour12 || spoken.minute !== parts.minute) return false;
    if (spoken.meridiem && spoken.meridiem !== meridiem) return false;
    return true;
  });
}

function sameDate(a: LocalDate, b: LocalDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}
