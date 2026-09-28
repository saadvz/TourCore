import { parseFlexibleTime, placementOf, relativeWhen, touringHoursLabel } from "../core/customSlot";
import { formatTime, localDateOf } from "../core/timezone";
import type { TourTimeRequest } from "../domain/model";
import { TERMINAL } from "../domain/stateMachine";
import { SetupInputError } from "../setup/setupActions";
import type { ConfirmationBook } from "./confirmations";
import { resolvePropertyId } from "./resolve";
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
    const question = outside
      ? `Approving ${formatTime(start, tz)} will create a one-time tour outside the property's normal ${touringHoursLabel(found.tour.config)} touring hours. Continue?`
      : reservation?.slotStart
        ? `I'll move ${name}'s tour from ${formatTime(new Date(reservation.slotStart), tz)} to ${relativeWhen(start, ctx.now(), tz)}. Continue?`
        : `I'll book ${name} for ${relativeWhen(start, ctx.now(), tz)}. Continue?`;
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
    const question = outside
      ? `Moving ${name}'s tour to ${formatTime(resolved.start, tz)} will create a one-time tour outside the property's normal ${touringHoursLabel(tour.config)} touring hours. Continue?`
      : `I'll move ${name}'s tour from ${formatTime(new Date(reservation.slotStart), tz)} to ${relativeWhen(resolved.start, ctx.now(), tz)}. Continue?`;
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
