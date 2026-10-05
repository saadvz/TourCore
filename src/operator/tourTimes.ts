import { isLiveMessaging } from "../config/tourCoreConfig";
import { intervalsOverlap, parseFlexibleTime, placementOf, relativeWhen, tourInterval, touringHoursLabel } from "../core/customSlot";
import { addDays, formatConfirmStamp, formatDay, formatTime, formatWeekday, localDateOf } from "../core/timezone";
import { formatPhone, parsePhone } from "../core/phone";
import type { TourTimeRequest } from "../domain/model";
import { TERMINAL } from "../domain/stateMachine";
import { SetupInputError } from "../setup/setupActions";
import { SmsConsentDirectory } from "../visitor/smsConsent";
import type { ConfirmationBook } from "./confirmations";
import { requireUnit, resolvePropertyId } from "./resolve";
import { persistSession, type OperatorServices } from "./services";
import { currentReservation, findTour, tourRef, tourSnapshots, unitNameOf, visitorNameOf, type TourSnapshot } from "./tours";

interface Ctx {
  services: OperatorServices;
  confirmations: ConfirmationBook;
  now: () => Date;
}

function ask(ctx: Ctx, action: string, target: string, fingerprint: string, question: string, details: Record<string, unknown> = {}) {
  const confirmation = ctx.confirmations.issue(action, target, fingerprint, question);
  return {
    status: "needs-confirmation" as const,
    summary: question,
    confirmation,
    instructions: "Ask the operator exactly this question. Call this tool again with confirmationCode only if they clearly say yes.",
    ...details,
  };
}

function redeem(ctx: Ctx, code: string, action: string, target: string, fingerprint: string): void {
  ctx.confirmations.redeem(code, action, target, fingerprint);
}

export async function findTimeRequest(services: OperatorServices, id: string): Promise<{ tour: TourSnapshot; request: TourTimeRequest } | undefined> {
  for (const tour of await tourSnapshots(services)) {
    const request = tour.bundle.tourTimeRequests.find((item) => item.id === id);
    if (request) return { tour, request };
  }
  return undefined;
}

function who(tour: TourSnapshot): string {
  const name = visitorNameOf(tour);
  return name.startsWith("A visitor") ? "The visitor" : (name.split(/\s+/)[0] ?? name);
}

function sameLocalDay(a: Date, b: Date, tz: string): boolean {
  const left = localDateOf(a, tz);
  const right = localDateOf(b, tz);
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function dayWord(start: Date, now: Date, tz: string): string {
  const today = localDateOf(now, tz);
  const day = localDateOf(start, tz);
  if (day.year === today.year && day.month === today.month && day.day === today.day) return "today";
  const tomorrow = addDays(today, 1);
  if (day.year === tomorrow.year && day.month === tomorrow.month && day.day === tomorrow.day) return "tomorrow";
  return `on ${formatDay(start, tz)}`;
}

function visitorTextNote(who: string, confirm: boolean, outside: boolean): string {
  const text = `${who} gets a text ${confirm ? "to confirm" : "with the new time"}.`;
  return outside ? `This is a one-off. Your regular tour hours stay the same, and ${text}` : text;
}

function moveFromTo(from: Date, to: Date, now: Date, tz: string, outside: boolean): string {
  if (outside || !sameLocalDay(from, to, tz)) {
    return `from ${formatConfirmStamp(from, tz)} to ${formatConfirmStamp(to, tz)}`;
  }
  return `from ${formatTime(from, tz)} to ${formatTime(to, tz)} ${dayWord(to, now, tz)}`;
}

function moveConfirmQuestion(input: { who: string; from?: Date; to: Date; now: Date; tz: string; outside: boolean; confirm: boolean }): string {
  const toLabel = input.outside ? formatConfirmStamp(input.to, input.tz) : relativeWhen(input.to, input.now, input.tz);
  const lead = input.from
    ? `Move ${input.who}'s tour ${moveFromTo(input.from, input.to, input.now, input.tz, input.outside)}?`
    : `Book ${input.who} for ${toLabel}?`;
  const extra = input.outside ? " That's outside your tour hours." : "";
  const verb = input.from ? "Move it?" : "Book it?";
  return `${lead}${extra} ${visitorTextNote(input.who, input.confirm, input.outside)} ${verb}`;
}

function requestView(tour: TourSnapshot, request: TourTimeRequest, now: Date) {
  const tz = tour.config.property.timezone;
  const reservation = tour.bundle.reservations.find((item) => item.id === request.reservationId);
  const placement = placementOf(tour.config, new Date(request.requestedStartsAt));
  return {
    tourTimeRequestId: request.id,
    tourRef: tourRef(tour.propertyId, tour.tourId),
    visitorName: visitorNameOf(tour),
    unitName: unitNameOf(tour),
    requestedTime: relativeWhen(new Date(request.requestedStartsAt), now, tz),
    ...(reservation?.slotStart ? { currentTime: relativeWhen(new Date(reservation.slotStart), now, tz) } : {}),
    ...(request.proposedAlternativeAt ? { offeredTime: relativeWhen(new Date(request.proposedAlternativeAt), now, tz) } : {}),
    status: request.status === "PENDING" ? "waiting" : request.status.toLowerCase(),
    outsideHours: placement === "OUTSIDE_HOURS",
    regularTime: placement === "ON_GRID",
  };
}

function requireLive(tour: TourSnapshot) {
  if (!tour.live) throw new SetupInputError("TOUR_NOT_RUNNING", "That tour isn't running right now, so the time can't be changed.");
  return tour.live;
}

export async function listTourTimeRequests(ctx: Ctx, input: { property?: string; includeHandled?: boolean }) {
  const propertyId = input.property ? resolvePropertyId(ctx.services.workspace, input.property) : undefined;
  const requests = [];
  for (const tour of await tourSnapshots(ctx.services, { propertyId })) {
    for (const request of tour.bundle.tourTimeRequests) {
      if (!input.includeHandled && request.status !== "PENDING") continue;
      requests.push(requestView(tour, request, ctx.now()));
    }
  }
  const waiting = requests.filter((request) => request.status === "waiting").length;
  return {
    summary: waiting ? `${waiting} ${waiting === 1 ? "person is" : "people are"} waiting on a different tour time.` : "Nobody is waiting on a different tour time.",
    requests,
  };
}

export async function inspectTourTimeRequest(ctx: Ctx, tourTimeRequestId: string) {
  const found = await findTimeRequest(ctx.services, tourTimeRequestId);
  if (!found) throw new SetupInputError("REQUEST_NOT_FOUND", "I couldn't find that time request.");
  const view = requestView(found.tour, found.request, ctx.now());
  const note = view.outsideHours
    ? `${formatTime(new Date(found.request.requestedStartsAt), found.tour.config.property.timezone)} is outside the property's normal ${touringHoursLabel(found.tour.config)} touring hours.`
    : view.regularTime
      ? "That is one of the regular tour times."
      : "That isn't one of the regular tour times. Approving it doesn't change the regular schedule.";
  return { summary: `${view.visitorName} — ${view.requestedTime}. ${note}`, ...view, note };
}

export async function approveTourTimeRequest(ctx: Ctx, input: { tourTimeRequestId: string; confirmationCode?: string; acknowledgeOutsideHours?: boolean }) {
  const found = await findTimeRequest(ctx.services, input.tourTimeRequestId);
  if (!found) throw new SetupInputError("REQUEST_NOT_FOUND", "I couldn't find that time request.");
  if (found.request.status !== "PENDING") throw new SetupInputError("REQUEST_CLOSED", "That request has already been handled.");
  const session = requireLive(found.tour);
  const tz = found.tour.config.property.timezone;
  const start = new Date(found.request.requestedStartsAt);
  const outside = placementOf(found.tour.config, start) === "OUTSIDE_HOURS";
  const fingerprint = `${found.request.id}|${found.request.requestedStartsAt}|${outside}`;
  const name = who(found.tour);
  const reservation = found.tour.bundle.reservations.find((item) => item.id === found.request.reservationId);
  if (!input.confirmationCode) {
    const question = moveConfirmQuestion({
      who: name,
      ...(reservation?.slotStart ? { from: new Date(reservation.slotStart) } : {}),
      to: start,
      now: ctx.now(),
      tz,
      outside,
      confirm: false,
    });
    return ask(ctx, "approve-time", found.request.id, fingerprint, question, outside ? { outsideHours: true } : {});
  }
  if (outside && !input.acknowledgeOutsideHours) {
    throw new SetupInputError("OUTSIDE_HOURS", "Approving a time outside normal touring hours needs a clear yes to that specifically.");
  }
  redeem(ctx, input.confirmationCode, "approve-time", found.request.id, fingerprint);
  await session.approveTimeRequest(found.request.id, { outsideTourHours: outside });
  await persistSession(ctx.services, session);
  return {
    summary: `${name}'s tour is set for ${relativeWhen(start, ctx.now(), tz)}. They've been told. The regular tour times are unchanged.`,
    approved: true,
    tourTimeRequestId: found.request.id,
  };
}

export async function declineTourTimeRequest(ctx: Ctx, input: { tourTimeRequestId: string; note?: string }) {
  const found = await findTimeRequest(ctx.services, input.tourTimeRequestId);
  if (!found) throw new SetupInputError("REQUEST_NOT_FOUND", "I couldn't find that time request.");
  const session = requireLive(found.tour);
  await session.declineTimeRequest(found.request.id, input.note);
  await persistSession(ctx.services, session);
  const reservation = found.tour.bundle.reservations.find((item) => item.id === found.request.reservationId);
  const kept = reservation?.slotStart ? ` ${who(found.tour)}'s ${formatTime(new Date(reservation.slotStart), found.tour.config.property.timezone)} tour is still confirmed.` : "";
  return { summary: `Declined.${kept}`, tourTimeRequestId: found.request.id };
}

export async function proposeTourTime(ctx: Ctx, input: { tourTimeRequestId: string; newStartsAt: string }) {
  const found = await findTimeRequest(ctx.services, input.tourTimeRequestId);
  if (!found) throw new SetupInputError("REQUEST_NOT_FOUND", "I couldn't find that time request.");
  if (found.request.status !== "PENDING") throw new SetupInputError("REQUEST_CLOSED", "That request has already been handled.");
  const session = requireLive(found.tour);
  const tz = found.tour.config.property.timezone;
  const reservation = found.tour.bundle.reservations.find((item) => item.id === found.request.reservationId);
  const contextDay = reservation?.slotStart ? localDateOf(new Date(reservation.slotStart), tz) : localDateOf(new Date(found.request.requestedStartsAt), tz);
  const resolved = parseFlexibleTime(input.newStartsAt, found.tour.config, ctx.now(), contextDay);
  if (!resolved.ok) throw new SetupInputError("TIME_UNCLEAR", resolved.ask);
  await session.proposeAlternative(found.request.id, resolved.start.toISOString());
  await persistSession(ctx.services, session);
  return {
    summary: `I asked ${who(found.tour)} about ${resolved.label}. Their current booking stays until they say yes.`,
    tourTimeRequestId: found.request.id,
  };
}

async function tourForReschedule(services: OperatorServices, input: { reservationId?: string; tourRef?: string; visitor?: string }): Promise<TourSnapshot> {
  if (input.tourRef) return findTour(services, input.tourRef);
  const tours = await tourSnapshots(services);
  if (input.reservationId) {
    const tour = tours.find((item) => item.bundle.reservations.some((reservation) => reservation.id === input.reservationId));
    if (!tour) throw new SetupInputError("TOUR_NOT_FOUND", "I couldn't find that tour.");
    return tour;
  }
  if (input.visitor) {
    const needle = input.visitor.trim().toLowerCase();
    const matches = tours.filter((tour) => {
      const name = visitorNameOf(tour).toLowerCase();
      return name === needle || name.startsWith(`${needle} `) || name.split(/\s+/).includes(needle);
    });
    const booked = matches.filter((tour) => {
      const reservation = currentReservation(tour);
      return !!reservation?.slotStart && !TERMINAL.includes(reservation.status);
    });
    const pool = booked.length ? booked : matches;
    if (pool.length === 1) return pool[0]!;
    if (!pool.length) throw new SetupInputError("TOUR_NOT_FOUND", `I couldn't find a tour for ${input.visitor}.`);
    throw new SetupInputError("TOUR_AMBIGUOUS", `More than one tour matches ${input.visitor}.`);
  }
  throw new SetupInputError("TOUR_NOT_FOUND", "Which visitor's tour should move?");
}

export async function rescheduleTour(
  ctx: Ctx,
  input: { reservationId?: string; tourRef?: string; visitor?: string; newStartsAt: string; confirmationCode?: string; acknowledgeOutsideHours?: boolean },
) {
  const tour = await tourForReschedule(ctx.services, input);
  const session = requireLive(tour);
  const reservation = currentReservation(tour);
  if (!reservation?.slotStart) throw new SetupInputError("NO_TOUR", `${who(tour)} doesn't have a tour time to move yet.`);
  const tz = tour.config.property.timezone;
  const resolved = parseFlexibleTime(input.newStartsAt, tour.config, ctx.now(), localDateOf(new Date(reservation.slotStart), tz));
  if (!resolved.ok) throw new SetupInputError("TIME_UNCLEAR", resolved.ask);
  const outside = resolved.placement === "OUTSIDE_HOURS";
  const fingerprint = `${reservation.id}|${reservation.updatedAt}|${resolved.start.toISOString()}|${outside}`;
  const name = who(tour);
  if (!input.confirmationCode) {
    const question = moveConfirmQuestion({
      who: name,
      from: new Date(reservation.slotStart),
      to: resolved.start,
      now: ctx.now(),
      tz,
      outside,
      confirm: false,
    });
    return ask(ctx, "reschedule-tour", reservation.id, fingerprint, question, outside ? { outsideHours: true } : {});
  }
  if (outside && !input.acknowledgeOutsideHours) {
    throw new SetupInputError("OUTSIDE_HOURS", "Moving a tour outside normal touring hours needs a clear yes to that specifically.");
  }
  redeem(ctx, input.confirmationCode, "reschedule-tour", reservation.id, fingerprint);
  await session.reschedule(resolved.start.toISOString(), { customTime: true, outsideTourHours: outside, notice: "moved" });
  await persistSession(ctx.services, session);
  return {
    summary: `${name}'s tour is now ${relativeWhen(resolved.start, ctx.now(), tz)}. They've been told. The regular tour times are unchanged.`,
    rescheduled: true,
    tourRef: tourRef(tour.propertyId, tour.tourId),
  };
}

export async function scheduleOneOffTour(
  ctx: Ctx,
  input: { property?: string; phone: string; visitorName?: string; unit: string; startsAt: string; confirmationCode?: string; acknowledgeOutsideHours?: boolean },
) {
  await ctx.services.releaseUnconfirmedTours?.();
  const propertyId = resolvePropertyId(ctx.services.workspace, input.property);
  if (!ctx.services.workspace.has(propertyId)) throw new SetupInputError("PROPERTY_NOT_FOUND", "I couldn't find that property.");
  const { config, state } = ctx.services.workspace.load(propertyId);
  if (state.status !== "PUBLISHED_FOR_DEMO" || !isLiveMessaging(config.messagingMode)) {
    throw new SetupInputError("NOT_LIVE", "That property isn't published with live visitor texting, so I can't set up a tour.");
  }
  if (!ctx.services.openMessagingSession) {
    throw new SetupInputError("NOT_LIVE", "Visitor texting isn't live on that property, so I can't set up a tour.");
  }
  const phone = parsePhone(input.phone);
  if (!phone) throw new SetupInputError("PHONE_INVALID", "That phone number doesn't look complete.");
  const optedOut = new SmsConsentDirectory(ctx.services.workspace.root).get(propertyId, phone);
  if (optedOut?.status === "opted_out") {
    throw new SetupInputError("OPTED_OUT", "That number asked us not to text them (STOP), so I can't set up a tour.");
  }
  const unit = requireUnit(config, input.unit);
  const resolved = parseFlexibleTime(input.startsAt, config, ctx.now());
  if (!resolved.ok) throw new SetupInputError("TIME_UNCLEAR", resolved.ask);
  if (resolved.start.getTime() <= ctx.now().getTime()) throw new SetupInputError("SLOT_PAST", "That time has already passed.");
  const wanted = tourInterval(config, resolved.start);
  for (const tour of await tourSnapshots(ctx.services, { propertyId })) {
    const reservation = currentReservation(tour);
    if (!reservation?.slotStart || TERMINAL.includes(reservation.status)) continue;
    if (intervalsOverlap(wanted, tourInterval(config, new Date(reservation.slotStart)))) {
      throw new SetupInputError("SLOT_OVERLAP", "That time overlaps another tour.");
    }
  }
  const outside = resolved.placement === "OUTSIDE_HOURS";
  const tz = config.property.timezone;
  const whoLabel = input.visitorName?.trim() ? input.visitorName.trim().split(/\s+/)[0]! : formatPhone(phone);
  const whenLabel = `on ${formatWeekday(resolved.start, tz)} at ${formatTime(resolved.start, tz)}`;
  const fingerprint = `${propertyId}|${phone}|${unit.id}|${resolved.start.toISOString()}|${outside}`;
  if (!input.confirmationCode) {
    const extra = outside ? " That's outside your tour hours." : "";
    const question = `Set up a tour for ${whoLabel} at ${unit.name} ${whenLabel}? Only say yes if they asked for this tour.${extra} ${visitorTextNote(whoLabel, true, outside)} Book it?`;
    return ask(ctx, "schedule-one-off", `${propertyId}:${phone}`, fingerprint, question, outside ? { outsideHours: true } : {});
  }
  if (outside && !input.acknowledgeOutsideHours) {
    throw new SetupInputError("OUTSIDE_HOURS", "Setting up a tour outside normal touring hours needs a clear yes to that specifically.");
  }
  redeem(ctx, input.confirmationCode, "schedule-one-off", `${propertyId}:${phone}`, fingerprint);
  const session = await ctx.services.openMessagingSession(propertyId, phone);
  await session.scheduleOneOff({ unitId: unit.id, start: resolved.start, outsideHours: outside, name: input.visitorName });
  await persistSession(ctx.services, session);
  return {
    summary: `I texted ${whoLabel} to confirm a tour of ${unit.name} ${whenLabel}. The regular tour times are unchanged.`,
    scheduled: true,
    tourRef: tourRef(propertyId, session.tourId),
  };
}
