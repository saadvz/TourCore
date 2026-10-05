import type { TourCoreConfig } from "../config/tourCoreConfig";
import { isoDate, isBeyondBookingHorizon, parseIsoDate } from "../core/schedule";
import { formatDay, formatLocalDate, formatTime, localDateOf, weekdayOf, type LocalDate } from "../core/timezone";
import { TourCoreError, VisitorDenialCopy } from "../core/TourCore";
import { normalize, stripFiller } from "../intent/normalize";
import type { ReplyPrompt } from "../messaging/presentation";
import { timeMenu } from "./entry";
import type { Said, VisitorDemoSession } from "./session";

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

function nextOpeningAsk(nextOpening: Date, tz: string): string {
  return `The next opening is ${nextOpeningWhen(nextOpening, tz)}. Want that, or another day?`;
}

const GRABBED = "Someone just grabbed that time.";

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
  const ask = nextOpening ? " Want that, or another day?" : "";

  if (!config.tourHours.days.includes(weekdayOf(requested))) {
    return `Tours don't run on ${weekdayPlural(requested, tz)}.${nextClause(nextOpening, tz, "opening")}${ask}`;
  }
  if (isBeyondBookingHorizon(today, requested)) {
    return `I can't book that far ahead yet.${nextClause(nextOpening, tz, "opening")}${ask}`;
  }
  if (sameDay(requested, today)) {
    return `There are no more tours today.${nextClause(nextOpening, tz, "one")}${ask}`;
  }
  return `${formatLocalDate(requested, tz)} is fully booked.${nextClause(nextOpening, tz, "opening")}${ask}`;
}

/** "that" / "yes" after "Want that, or another day?" */
export function acceptsOfferedOpening(text: string): boolean {
  const t = stripFiller(normalize(text));
  return /^(that|that one|that day|that time|that works|yes|yeah|yea|yep|yup|sure|ok|okay|k|yes that|yes that one|yeah that)$/.test(t);
}

function datePrompt(session: VisitorDemoSession): ReplyPrompt | undefined {
  if (!session.offeredDates.length) return undefined;
  return { kind: "choose", options: session.offeredDates.map((day) => day.label), what: "a day" };
}

async function explainUnavailable(session: VisitorDemoSession, requested: LocalDate | undefined): Promise<void> {
  const now = session.clock.now();
  const nextOpening = (await session.core.availableDates(1))[0]?.start;
  if (!nextOpening) {
    await session.reply(VisitorDenialCopy.noOpenTimes(session.config.operator.name));
    return;
  }
  const tz = session.config.property.timezone;
  const body = requested
    ? unavailableDayReply({ config: session.config, now, requested, nextOpening })
    : `I can't book that day. The next opening is ${nextOpeningWhen(nextOpening, tz)}. Want that, or another day?`;
  await session.reply(body, datePrompt(session));
  session.markDatesShown();
  session.expect("choose-date", {
    kind: "accept-next-opening",
    date: isoDate(localDateOf(nextOpening, tz)),
    slotStart: nextOpening.toISOString(),
  });
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
    await explainUnavailable(session, requested);
    return;
  }
  const menu = timeMenu(formatDay(slots[0]!.start, tz), slots.map((slot) => slot.label));
  await session.reply(menu.body, menu.prompt);
  session.markTimesShown();
}

async function offerAfterGrabbed(session: VisitorDemoSession, date: string): Promise<void> {
  const slots = await session.selectDate(date);
  const tz = session.config.property.timezone;
  const requested = parseIsoDate(date);
  const today = localDateOf(session.clock.now(), tz);
  const beyond = requested ? isBeyondBookingHorizon(today, requested) : false;
  if (slots.length && !beyond) {
    await session.reply(`${GRABBED} Here's what's left:`, { kind: "choose", options: slots.map((slot) => slot.label), what: "a time" });
    session.markTimesShown();
    return;
  }
  session.selectedDate = undefined;
  session.offeredSlots = [];
  const nextOpening = (await session.core.availableDates(1))[0]?.start;
  if (!nextOpening) {
    await session.reply(`${GRABBED} ${VisitorDenialCopy.noOpenTimes(session.config.operator.name)}`);
    return;
  }
  await session.reply(`${GRABBED} ${nextOpeningAsk(nextOpening, tz)}`, datePrompt(session));
  session.markDatesShown();
  session.expect("choose-date", {
    kind: "accept-next-opening",
    date: isoDate(localDateOf(nextOpening, tz)),
    slotStart: nextOpening.toISOString(),
  });
}

async function slotStillOpen(session: VisitorDemoSession, slotStart: string, date: string): Promise<boolean> {
  const start = new Date(slotStart);
  if (Number.isNaN(start.getTime())) return false;
  const day = parseIsoDate(date) ?? localDateOf(start, session.config.property.timezone);
  const open = await session.core.availableSlots(day);
  return open.some((slot) => slot.start.getTime() === start.getTime());
}

/**
 * "that" after a next-opening offer: book that exact start through the same
 * chooseTime path as the time menu, or fall back if it was taken. Re-checks
 * the offered start against the current published schedule first, so an hours
 * change after the offer cannot book a slot that is no longer open.
 */
export async function takeOfferedOpening(
  session: VisitorDemoSession,
  awaiting: { date: string; slotStart: string },
  said: Said = {},
): Promise<void> {
  if (await slotStillOpen(session, awaiting.slotStart, awaiting.date)) {
    await session.selectDate(awaiting.date);
    try {
      await session.act("chooseTime", { slotStart: awaiting.slotStart }, said);
      return;
    } catch (error) {
      if (!(error instanceof TourCoreError) || error.code !== "SLOT_UNAVAILABLE") throw error;
      session.selectedDate = undefined;
      session.offeredSlots = [];
      await offerAfterGrabbed(session, awaiting.date);
      return;
    }
  }
  if (said.text) await session.recordText(said);
  await offerAfterGrabbed(session, awaiting.date);
}
