import type { TourCoreConfig } from "../config/tourCoreConfig";
import { relativeWhen } from "../core/customSlot";
import { isBeyondBookingHorizon, parseIsoDate } from "../core/schedule";
import { formatDay, formatLocalDate, localDateOf, weekdayOf, type LocalDate } from "../core/timezone";
import type { ReplyPrompt } from "../messaging/presentation";
import { timeMenu } from "./entry";
import type { VisitorDemoSession } from "./session";

function sameDay(a: LocalDate, b: LocalDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function weekdayPlural(requested: LocalDate, tz: string): string {
  return `${formatLocalDate(requested, tz).split(",")[0]!}s`;
}

function nextOpeningClause(nextOpening: Date | undefined, now: Date, tz: string): string {
  return nextOpening ? ` The next opening is ${relativeWhen(nextOpening, now, tz)}.` : "";
}

/**
 * Why a requested day has no bookable regular tours, in the visitor's words.
 * Uses the property's tour hours and timezone; never implies a closed weekday
 * when the day is open but the remaining starts have passed or been taken.
 */
export function unavailableDayReply(input: {
  config: TourCoreConfig;
  now: Date;
  requested: LocalDate;
  nextOpening?: Date;
}): string {
  const { config, now, requested, nextOpening } = input;
  const tz = config.property.timezone;
  const today = localDateOf(now, tz);
  const next = nextOpeningClause(nextOpening, now, tz);
  const ask = " Which day works for you?";

  if (!config.tourHours.days.includes(weekdayOf(requested))) {
    return `I don't have tours on ${weekdayPlural(requested, tz)}.${next}${ask}`;
  }
  if (isBeyondBookingHorizon(today, requested)) {
    return `That's too far out to book.${next}${ask}`;
  }
  if (sameDay(requested, today)) {
    return `There are no more tours today.${next}${ask}`;
  }
  return `${formatLocalDate(requested, tz)} is fully booked.${next}${ask}`;
}

function datePrompt(session: VisitorDemoSession): ReplyPrompt {
  return { kind: "choose", options: session.offeredDates.map((day) => day.label), what: "a day" };
}

/**
 * Show that day's open times, or explain why there are none. Shared by typed
 * day questions and the browser-phone date buttons.
 */
export async function offerDate(session: VisitorDemoSession, date: string): Promise<void> {
  const slots = await session.selectDate(date);
  const tz = session.config.property.timezone;
  const now = session.clock.now();
  const requested = parseIsoDate(date);
  const today = localDateOf(now, tz);
  const beyond = requested ? isBeyondBookingHorizon(today, requested) : false;
  if (!slots.length || beyond) {
    session.selectedDate = undefined;
    session.offeredSlots = [];
    const nextOpening = (await session.core.availableDates(1))[0]?.start;
    const body = requested
      ? unavailableDayReply({ config: session.config, now, requested, ...(nextOpening ? { nextOpening } : {}) })
      : `I don't have tours on that day. Which day works for you?`;
    await session.reply(body, datePrompt(session));
    return;
  }
  const menu = timeMenu(formatDay(slots[0]!.start, tz), slots.map((slot) => slot.label));
  await session.reply(menu.body, menu.prompt);
}
