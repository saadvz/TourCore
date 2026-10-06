import type { TourCoreConfig } from "../config/tourCoreConfig";
import { normalize } from "../intent/normalize";
import { slotsOn } from "./schedule";
import { spokenTimes, type SpokenTime } from "./spokenTime";
import { addDays, formatClockTime, formatDay, formatTime, formatWeekday, localDateOf, weekdayOf, zonedParts, zonedTimeToUtc, type LocalDate } from "./timezone";

/** Where a start sits relative to the recurring schedule. The schedule itself is never edited. */
export type SlotPlacement = "ON_GRID" | "INSIDE_HOURS" | "OUTSIDE_HOURS";

export interface TimeInterval {
  startMs: number;
  endMs: number;
}

/** A held tour window shared across conversations, including extensions. */
export interface OccupiedWindow {
  start: Date;
  end: Date;
}

export function occupiedInterval(window: OccupiedWindow): TimeInterval {
  return { startMs: window.start.getTime(), endMs: window.end.getTime() };
}

export function tourInterval(config: TourCoreConfig, start: Date, end?: Date): TimeInterval {
  return { startMs: start.getTime(), endMs: (end ?? new Date(start.getTime() + config.tourHours.tourLengthMinutes * 60_000)).getTime() };
}

export function intervalsOverlap(a: TimeInterval, b: TimeInterval): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/** ON_GRID is a normal self-service start. INSIDE_HOURS fits the touring day but isn't one of those starts. */
export function placementOf(config: TourCoreConfig, start: Date): SlotPlacement {
  const tz = config.property.timezone;
  const day = localDateOf(start, tz);
  if (slotsOn(config, day).some((slot) => slot.start.getTime() === start.getTime())) return "ON_GRID";
  if (!config.tourHours.days.includes(weekdayOf(day))) return "OUTSIDE_HOURS";
  const local = zonedParts(start, tz);
  const startMin = local.hour * 60 + local.minute;
  const [openH = 0, openM = 0] = config.tourHours.start.split(":").map(Number);
  const [closeH = 0, closeM = 0] = config.tourHours.end.split(":").map(Number);
  const open = openH * 60 + openM;
  const close = closeH * 60 + closeM;
  if (startMin >= open && startMin + config.tourHours.tourLengthMinutes <= close) return "INSIDE_HOURS";
  return "OUTSIDE_HOURS";
}

export function touringHoursLabel(config: TourCoreConfig): string {
  return `${formatClockTime(config.tourHours.start)}–${formatClockTime(config.tourHours.end)}`;
}

function hour24(hour: number, meridiem: "AM" | "PM"): number {
  if (meridiem === "AM") return hour === 12 ? 0 : hour;
  return hour === 12 ? 12 : hour + 12;
}

function at(day: LocalDate, hour: number, minute: number, meridiem: "AM" | "PM", tz: string): Date {
  return zonedTimeToUtc({ ...day, hour: hour24(hour, meridiem), minute }, tz);
}

/**
 * Picks AM or PM without guessing when both readings are real touring times.
 * When neither reading falls in touring hours, morning hours (8–11) read as
 * AM and early afternoon hours (1–6) read as PM, and the result is an
 * outside-hours request the landlord still has to approve. 7 and 12 stay
 * ambiguous in that case.
 */
function chooseMeridiem(config: TourCoreConfig, day: LocalDate, spoken: SpokenTime): "AM" | "PM" | undefined {
  if (spoken.meridiem) return spoken.meridiem;
  const fits = (["AM", "PM"] as const).filter((meridiem) => placementOf(config, at(day, spoken.hour, spoken.minute, meridiem, config.property.timezone)) !== "OUTSIDE_HOURS");
  if (fits.length === 1) return fits[0];
  if (fits.length > 1) return undefined;
  if (spoken.hour >= 8 && spoken.hour <= 11) return "AM";
  if (spoken.hour >= 1 && spoken.hour <= 6) return "PM";
  return undefined;
}

export type ResolvedTime = { ok: true; start: Date; placement: SlotPlacement; label: string } | { ok: false; ask: string };

function sameDay(a: LocalDate, b: LocalDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function clockLabel(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

/** Turns a spoken clock into an instant in the property's zone. Asks when AM/PM or the day can't be known. */
export function resolveSpokenTime(config: TourCoreConfig, now: Date, spoken: SpokenTime, contextDay?: LocalDate): ResolvedTime {
  const tz = config.property.timezone;
  const today = localDateOf(now, tz);
  const named = spoken.date
    ? spoken.date
    : spoken.weekday
      ? weekdayOnOrAfter(spoken.nextWeek ? addDays(today, 1) : today, spoken.weekday)
      : undefined;
  const day = spoken.day === "tomorrow" ? addDays(today, 1) : spoken.day === "today" ? today : (named ?? contextDay ?? today);
  const meridiem = chooseMeridiem(config, day, spoken);
  if (!meridiem) {
    return { ok: false, ask: `Did you mean ${clockLabel(spoken.hour, spoken.minute)} AM or ${clockLabel(spoken.hour, spoken.minute)} PM?` };
  }
  const start = at(day, spoken.hour, spoken.minute, meridiem, tz);
  if (start.getTime() <= now.getTime()) {
    if (spoken.day === "today" || (contextDay && sameDay(day, today) && !spoken.day && !spoken.weekday && !spoken.date)) {
      return { ok: false, ask: "That time has already passed. What time would you like?" };
    }
    if (!spoken.day && !spoken.weekday && !spoken.date) return { ok: false, ask: "That time today has already passed. Did you mean tomorrow?" };
  }
  return { ok: true, start, placement: placementOf(config, start), label: formatTime(start, tz) };
}

function weekdayOnOrAfter(start: LocalDate, weekday: NonNullable<SpokenTime["weekday"]>): LocalDate {
  let day = start;
  for (let i = 0; i < 14; i++, day = addDays(day, 1)) if (weekdayOf(day) === weekday) return day;
  return start;
}

/** An ISO instant, or everyday words ("3:15 PM", "tomorrow at 11:15"). */
export function parseFlexibleTime(text: string, config: TourCoreConfig, now: Date, contextDay?: LocalDate): ResolvedTime {
  const trimmed = text.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const start = new Date(trimmed);
    if (Number.isNaN(start.getTime())) return { ok: false, ask: "That time isn't valid." };
    return { ok: true, start, placement: placementOf(config, start), label: formatTime(start, config.property.timezone) };
  }
  const times = spokenTimes(normalize(trimmed), localDateOf(now, config.property.timezone));
  if (times.length !== 1) return { ok: false, ask: times.length > 1 ? "Which time did you mean?" : "What time should that be?" };
  return resolveSpokenTime(config, now, times[0]!, contextDay);
}

/** Up to two regular starts nearest to `requested` that don't overlap `busy`. */
export function closestOpenSlots(config: TourCoreConfig, now: Date, requested: Date, busy: TimeInterval[]): Date[] {
  const candidates: Date[] = [];
  let day = localDateOf(now, config.property.timezone);
  for (let i = 0; i < 14; i++, day = addDays(day, 1)) {
    for (const slot of slotsOn(config, day)) {
      if (slot.start.getTime() <= now.getTime()) continue;
      const interval = tourInterval(config, slot.start);
      if (busy.some((block) => intervalsOverlap(interval, block))) continue;
      candidates.push(slot.start);
    }
  }
  return candidates.sort((a, b) => Math.abs(a.getTime() - requested.getTime()) - Math.abs(b.getTime() - requested.getTime())).slice(0, 2);
}

export function overlapSummary(config: TourCoreConfig, requested: Date, alternatives: Date[]): string {
  const tz = config.property.timezone;
  const label = formatTime(requested, tz);
  if (alternatives.length === 0) return `${label} overlaps another tour, and there isn't an open regular time nearby.`;
  const labels = alternatives.map((start) => {
    const same = sameDay(localDateOf(start, tz), localDateOf(requested, tz));
    return same ? formatTime(start, tz) : `${formatDay(start, tz)} ${formatTime(start, tz)}`;
  });
  const list = labels.length === 1 ? labels[0]! : `${labels[0]} and ${labels[1]}`;
  return `${label} overlaps another tour. The closest available ${labels.length === 1 ? "option is" : "options are"} ${list}.`;
}

/** "today at 3:15 PM", "tomorrow at 11:15 AM", or "on Monday, Sep 28 at 3:15 PM". */
export function relativeWhen(start: Date, now: Date, tz: string): string {
  const day = localDateOf(start, tz);
  const today = localDateOf(now, tz);
  const word = sameDay(day, today) ? "today" : sameDay(day, addDays(today, 1)) ? "tomorrow" : `on ${formatDay(start, tz)}`;
  return `${word} at ${formatTime(start, tz)}`;
}

/** Clock only when the tour is today; otherwise "Monday at 3:15 PM". */
export function releasedWhen(start: Date, now: Date, tz: string): string {
  return sameDay(localDateOf(start, tz), localDateOf(now, tz)) ? formatTime(start, tz) : `${formatWeekday(start, tz)} at ${formatTime(start, tz)}`;
}

/** Deadline for an operator-set tour the visitor still has to confirm. */
export function operatorConfirmBy(start: Date, setupAt: Date): Date {
  const hourBeforeStart = start.getTime() - 60 * 60_000;
  if (start.getTime() - setupAt.getTime() < 60 * 60_000) return new Date(setupAt.getTime() + 30 * 60_000);
  return new Date(hourBeforeStart);
}
