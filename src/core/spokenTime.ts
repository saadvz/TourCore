/**
 * A clock time a person named in a message. The hour is 1–12. Meridiem and
 * day are set only when the words said them. Nothing here decides whether
 * that time is bookable.
 */

import type { Weekday } from "./timezone";

export interface SpokenTime {
  hour: number;
  minute: number;
  meridiem?: "AM" | "PM";
  day?: "today" | "tomorrow";
  weekday?: Weekday;
  /** "next Monday" means the following one, not today if today is Monday. */
  nextWeek?: boolean;
}

const CLOCK =
  /(?:^|\s)(?:(at|around|about|for|by)\s+)?(?<!\d)(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm|a m|p m|o'?clock))?(?!\d)(?=\s|$)/g;

/** Every distinct clock time in already-normalized text. "1" alone is not a time; "3:15" and "at 3" are. */
export function spokenTimes(normalized: string): SpokenTime[] {
  const day = /\btomorrow\b/.test(normalized) ? "tomorrow" : /\btoday\b/.test(normalized) ? "today" : undefined;
  const found: SpokenTime[] = [];
  for (const match of normalized.matchAll(CLOCK)) {
    const lead = match[1];
    const hour = Number(match[2]);
    const minutes = match[3];
    const suffix = match[4];
    if (!minutes && !suffix && !lead) continue;
    if (hour < 1 || hour > 12) continue;
    const minute = minutes ? Number(minutes) : 0;
    if (minute > 59) continue;
    const meridiem = suffix && !suffix.startsWith("o") ? (suffix.startsWith("a") ? "AM" : "PM") : undefined;
    const asked = dayReference(normalized);
    const named = asked && asked !== "menu" ? asked : undefined;
    const key = `${hour}:${minute}:${meridiem ?? ""}:${day ?? ""}:${named?.weekday ?? ""}`;
    if (found.some((item) => `${item.hour}:${item.minute}:${item.meridiem ?? ""}:${item.day ?? ""}:${item.weekday ?? ""}` === key)) continue;
    found.push({
      hour,
      minute,
      ...(meridiem ? { meridiem } : {}),
      ...(day ? { day } : {}),
      ...(named?.weekday ? { weekday: named.weekday } : {}),
      ...(named?.nextWeek ? { nextWeek: true } : {}),
    });
  }
  return found;
}

/** A change of time with no clock ("I need a later time"). */
export function vagueTimeRequest(normalized: string): boolean {
  return /\b(later time|another time|different time|need a later|something later|come later|later today|move it later|a later one)\b/.test(normalized);
}

const WEEKDAY_WORD: Record<string, Weekday> = {
  monday: "MON",
  tuesday: "TUE",
  wednesday: "WED",
  thursday: "THU",
  friday: "FRI",
  saturday: "SAT",
  sunday: "SUN",
};

export interface DayReference {
  weekday?: Weekday;
  relative?: "today" | "tomorrow" | "weekend";
  nextWeek?: boolean;
}

/** A day the visitor named, or a general availability ask, in already-normalized text. */
export function dayReference(normalized: string): DayReference | "menu" | undefined {
  if (/\b(this )?weekend\b/.test(normalized)) return { relative: "weekend" };
  if (/\btomorrow\b/.test(normalized)) return { relative: "tomorrow", ...weekdayFields(normalized) };
  if (/\btoday\b/.test(normalized)) return { relative: "today", ...weekdayFields(normalized) };
  const weekday = weekdayOfText(normalized);
  if (weekday) {
    const scheduling = /\b(what about|how about|anything|available|availability|what times|which times|do you have|can i come|could i come|instead)\b/.test(normalized) || normalized.split(" ").length <= 4;
    if (!scheduling) return undefined;
    return { weekday: weekday.day, ...(weekday.next ? { nextWeek: true } : {}) };
  }
  if (/\b(what availability|any availability|which days|what days|when are you available|when can i (come|tour|visit)|availability do you have)\b/.test(normalized)) {
    return "menu";
  }
  return undefined;
}

function weekdayFields(normalized: string): Pick<DayReference, "weekday" | "nextWeek"> {
  const weekday = weekdayOfText(normalized);
  return weekday ? { weekday: weekday.day, ...(weekday.next ? { nextWeek: true } : {}) } : {};
}

function weekdayOfText(normalized: string): { day: Weekday; next: boolean } | undefined {
  const match = normalized.match(/\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (!match) return undefined;
  return { day: WEEKDAY_WORD[match[2]!]!, next: !!match[1] };
}
