/**
 * Property-local time without depending on the host machine's time zone.
 * Every tour-hour calculation goes through an explicit IANA zone.
 */

export const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** A calendar date as seen at the property. month is 1-12. */
export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

export interface LocalDateTime extends LocalDate {
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || (timeZone !== "UTC" && !timeZone.includes("/"))) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Returns the canonical spelling (e.g. "america/new_york" -> "America/New_York"), or undefined. */
export function canonicalTimeZone(timeZone: string): string | undefined {
  if (!isValidTimeZone(timeZone)) return undefined;
  return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
}

export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function zonedParts(date: Date, timeZone: string): LocalDateTime & { second: number } {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const hour = get("hour");
  return { year: get("year"), month: get("month"), day: get("day"), hour: hour === 24 ? 0 : hour, minute: get("minute"), second: get("second") };
}

function offsetMs(instant: number, timeZone: string): number {
  const p = zonedParts(new Date(instant), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
}

/** Wall-clock time at the property -> absolute instant. */
export function zonedTimeToUtc(local: LocalDateTime, timeZone: string): Date {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const first = offsetMs(guess, timeZone);
  let result = guess - first;
  const second = offsetMs(result, timeZone);
  if (second !== first) result = guess - second;
  return new Date(result);
}

export function localDateOf(date: Date, timeZone: string): LocalDate {
  const { year, month, day } = zonedParts(date, timeZone);
  return { year, month, day };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export function weekdayOf(date: LocalDate): Weekday {
  return WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()]!;
}

const clean = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");

export function formatTime(date: Date, timeZone: string): string {
  return clean(date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone }));
}

/** Same clock as other visitor texts, without ":00". "3 PM" or "3:30 PM". */
export function formatVisitorClock(date: Date, timeZone: string): string {
  return formatTime(date, timeZone).replace(":00", "");
}

/** Clock first, then the calendar day: "2:45 PM on Thursday, Oct 9". */
export function timeOnDay(date: Date, timeZone: string): string {
  return `${formatTime(date, timeZone)} on ${formatDay(date, timeZone)}`;
}

export function formatDay(date: Date, timeZone: string): string {
  return clean(date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone }));
}

/** "Monday" */
export function formatWeekday(date: Date, timeZone: string): string {
  return clean(date.toLocaleDateString("en-US", { weekday: "long", timeZone }));
}

/** "Mon, Oct 5 at 2:00 PM" — operator confirmation stamps that name the day and time. */
export function formatConfirmStamp(date: Date, timeZone: string): string {
  const day = clean(date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone }));
  return `${day} at ${formatTime(date, timeZone)}`;
}

/** "Sep 27, 2:14 PM" */
export function formatShortDateTime(date: Date, timeZone: string): string {
  const day = clean(date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone }));
  return `${day}, ${formatTime(date, timeZone)}`;
}

/** "Monday, Sep 28, 9:00 AM" */
export function formatDateTime(date: Date, timeZone: string): string {
  return `${formatDay(date, timeZone)}, ${formatTime(date, timeZone)}`;
}

/** ISO-8601 with seconds and the property's offset, e.g. 2026-09-28T09:00:00-04:00. */
export function formatIsoOffset(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  const offset = offsetMs(date.getTime(), timeZone);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(hours)}:${pad(minutes)}`;
}

export function formatLocalDate(date: LocalDate, timeZone: string): string {
  return formatDay(zonedTimeToUtc({ ...date, hour: 12, minute: 0 }, timeZone), timeZone);
}

/** "14:30" -> "2:30 PM". Pure clock formatting, no zone involved. */
export function formatClockTime(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "Eastern Time" style name for a zone, falling back to the zone id. */
export function friendlyTimeZone(timeZone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longGeneric" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** Plain zone word from {@link friendlyTimeZone}: "Eastern Time" becomes "Eastern". */
export function spokenTimeZone(timeZone: string): string {
  return friendlyTimeZone(timeZone).replace(/ Time$/i, "");
}
