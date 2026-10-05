import type { TourCoreConfig } from "../config/tourCoreConfig";
import { isoDate, isBeyondBookingHorizon, parseIsoDate } from "../core/schedule";
import { formatDay, formatLocalDate, formatTime, localDateOf, weekdayOf, type LocalDate } from "../core/timezone";
import { normalize, stripFiller } from "../intent/normalize";
import type { ReplyPrompt } from "../messaging/presentation";
import { timeMenu } from "./entry";
import type { VisitorDemoSession } from "./session";

function sameDay(a: LocalDate, b: LocalDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function weekdayPlural(requested: LocalDate, tz: string): string {
  return `${formatLocalDate(requested, tz).split(",")[0]!}s`;
}

/** "Monday, Oct 5 at 8:15 AM" in the property's zone. */
export function nextOpeningWhen(start: Date, tz: string): string {
  return `${formatDay(start, tz)} at ${formatTime(start, tz)}`;
}

function nextClause(nextOpening: Date | undefined, tz: string, noun: "one" | "opening"): string {
  return nextOpening ? ` The next ${noun} is ${nextOpeningWhen(nextOpening, tz)}.` : "";
}

function ask(hasNext: boolean): string {
  return hasNext ? " Want that, or another day?" : " Which day works for you?";
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
  const closing = ask(!!nextOpening);

  if (!config.tourHours.days.includes(weekdayOf(requested))) {
    return `Tours don't run on ${weekdayPlural(requested, tz)}.${nextClause(nextOpening, tz, "opening")}${closing}`;
  }
  if (isBeyondBookingHorizon(today, requested)) {
    return `I can't book that far ahead yet.${nextClause(nextOpening, tz, "opening")}${closing}`;
  }
  if (sameDay(requested, today)) {
    return `There are no more tours today.${nextClause(nextOpening, tz, "one")}${closing}`;
  }
  return `${formatLocalDate(requested, tz)} is fully booked.${nextClause(nextOpening, tz, "opening")}${closing}`;
}

/** "that" / "yes" after "Want that, or another day?" */
export function acceptsOfferedOpening(text: string): boolean {
  const t = stripFiller(normalize(text));
  return /^(that|that one|that day|that time|that works|yes|yeah|yea|yep|yup|sure|ok|okay|k|yes that|yes that one|yeah that)$/.test(t);
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
      : "I can't book that day. Which day works for you?";
    await session.reply(body, datePrompt(session));
    if (nextOpening) {
      session.expect("choose-date", { kind: "accept-next-opening", date: isoDate(localDateOf(nextOpening, tz)) });
    }
    return;
  }
  const menu = timeMenu(formatDay(slots[0]!.start, tz), slots.map((slot) => slot.label));
  await session.reply(menu.body, menu.prompt);
}
