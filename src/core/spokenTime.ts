/**
 * A clock time a person named in a message. The hour is 1–12. Meridiem and
 * day are set only when the words said them. Nothing here decides whether
 * that time is bookable.
 */

export interface SpokenTime {
  hour: number;
  minute: number;
  meridiem?: "AM" | "PM";
  day?: "today" | "tomorrow";
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
    const key = `${hour}:${minute}:${meridiem ?? ""}:${day ?? ""}`;
    if (found.some((item) => `${item.hour}:${item.minute}:${item.meridiem ?? ""}:${item.day ?? ""}` === key)) continue;
    found.push({ hour, minute, ...(meridiem ? { meridiem } : {}), ...(day ? { day } : {}) });
  }
  return found;
}

/** A change of time with no clock ("I need a later time"). */
export function vagueTimeRequest(normalized: string): boolean {
  return /\b(later time|another time|different time|need a later|something later|come later|later today|move it later|a later one)\b/.test(normalized);
}
