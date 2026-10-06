import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMessenger } from "../createTourCore";
import { pauseConfirmQuestion, PROPERTY_REMOVED_REFUSE, REMOVE_REFUSED_LIVE_TOUR, removeConfirmQuestion, removedPropertySummary, removedSetupSummary, resumeConfirmQuestion, toursAreBackText } from "../core/availabilityCopy";
import { normalizePhone } from "../core/phone";
import { newId, type AuditEvent, type AuditEventType, type Reservation } from "../domain/model";
import { TERMINAL } from "../domain/stateMachine";
import { SetupInputError } from "../setup/setupActions";
import { isEffectivelyPaused, isRemoved, isUnitPaused } from "../setup/availability";
import { dropUnitWaiters, dropWaiters, rememberWaiter, uniquePhones, waitersFor } from "../setup/pauseWaiters";
import type { PropertyState, TourRecord } from "../setup/workspace";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { SmsConsentDirectory } from "../visitor/smsConsent";
import { VisitorDemoSession } from "../visitor/session";
import type { ConfirmationBook } from "./confirmations";
import { requireUnit, resolvePropertyId } from "./resolve";
import { persistSession, type OperatorServices } from "./services";
import { currentReservation, tourSnapshots, type TourSnapshot } from "./tours";

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

export function isBookedReservation(reservation: Reservation | undefined): reservation is Reservation {
  return !!reservation?.slotStart && reservation.status !== "TOURING" && !TERMINAL.includes(reservation.status);
}

function labelOf(services: OperatorServices, propertyId: string): string {
  return services.workspace.load(propertyId).config.property.name;
}

function unitIdsOf(services: OperatorServices, propertyId: string): string[] {
  return services.workspace.load(propertyId).config.units.map((unit) => unit.id);
}

export function availabilityEventsPath(root: string, propertyId: string): string {
  return join(root, "properties", propertyId, "operator", "availability-events.json");
}

export function readAvailabilityEvents(root: string, propertyId: string): AuditEvent[] {
  const path = availabilityEventsPath(root, propertyId);
  if (!existsSync(path)) return [];
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { events?: AuditEvent[] }).events ?? [];
  } catch {
    return [];
  }
}

export function appendAvailabilityEvent(root: string, propertyId: string, type: AuditEventType, detail: string, at: string, extra: Partial<AuditEvent> = {}): AuditEvent {
  const events = readAvailabilityEvents(root, propertyId);
  const event: AuditEvent = {
    id: extra.id ?? newId("aud"),
    seq: extra.seq ?? events.length + 1,
    type,
    at,
    detail,
    ...(extra.reservationId ? { reservationId: extra.reservationId } : {}),
    ...(extra.prospectId ? { prospectId: extra.prospectId } : {}),
    ...(extra.unitId ? { unitId: extra.unitId } : {}),
    ...(extra.code ? { code: extra.code } : {}),
  };
  writeJsonAtomic(availabilityEventsPath(root, propertyId), { schemaVersion: 1, events: [...events, event] });
  return event;
}

async function bookedTours(services: OperatorServices, propertyId: string, unitId?: string): Promise<TourSnapshot[]> {
  const tours = await tourSnapshots(services, { propertyId });
  return tours.filter((tour) => {
    const reservation = currentReservation(tour);
    if (!isBookedReservation(reservation)) return false;
    return !unitId || reservation.unitId === unitId;
  });
}

async function anyoneTouring(services: OperatorServices, propertyId: string): Promise<boolean> {
  return (await tourSnapshots(services, { propertyId })).some((tour) => currentReservation(tour)?.status === "TOURING");
}

async function sessionFor(services: OperatorServices, tour: TourSnapshot): Promise<VisitorDemoSession> {
  if (tour.live) return tour.live;
  const record: TourRecord = {
    schemaVersion: 1,
    tourId: tour.tourId,
    kind: tour.kind,
    ranAt: tour.startedAt,
    updatedAt: tour.updatedAt,
    outcome: tour.outcome,
    ...(tour.visitorPhone ? { visitorPhone: tour.visitorPhone } : {}),
    conversation: tour.conversation,
  };
  const session = new VisitorDemoSession(tour.propertyId, tour.config, tour.tourId, { kind: tour.kind, startedAt: new Date(tour.startedAt) });
  await session.hydrate(record, tour.bundle);
  services.visitors?.add(session);
  return session;
}

async function cancelBooked(
  services: OperatorServices,
  tours: TourSnapshot[],
  propertyWide: boolean,
  reason: string,
  removed = false,
): Promise<number> {
  let cancelled = 0;
  for (const tour of tours) {
    const reservation = currentReservation(tour);
    if (!isBookedReservation(reservation)) continue;
    const session = await sessionFor(services, tour);
    await session.operatorChange((core, id) => core.cancelBookedTour(id, { reason, propertyWide, ...(removed ? { removed: true } : {}) }));
    if (propertyWide && !removed) {
      const phone = session.visitor?.phone;
      if (phone) rememberWaiter(services.workspace.root, session.propertyId, { phone, at: (services.now?.() ?? new Date()).toISOString() });
    }
    await persistSession(services, session);
    cancelled += 1;
  }
  return cancelled;
}

function visitorUnreachable(services: OperatorServices, propertyId: string, phone: string): boolean {
  const sender = normalizePhone(phone);
  if (!sender || sender === "+") return true;
  if (new SmsConsentDirectory(services.workspace.root).get(propertyId, sender)?.status === "opted_out") return true;
  const session = services.visitors?.latestForPhone(propertyId, sender);
  return !!session?.optedOut || session?.smsConsent === "opted_out";
}

function reachableWaitingPhones(services: OperatorServices, propertyId: string, unitId?: string): string[] {
  return uniquePhones(waitersFor(services.workspace.root, propertyId, unitId)).filter((phone) => !visitorUnreachable(services, propertyId, phone));
}

function phonesToNotify(services: OperatorServices, propertyId: string, unitId?: string): string[] {
  if (unitId) {
    const { state } = services.workspace.load(propertyId);
    if (state.paused || isRemoved(state)) return [];
  }
  return reachableWaitingPhones(services, propertyId, unitId);
}

async function notifyWaiters(services: OperatorServices, propertyId: string, unitId: string | undefined, now: Date): Promise<number> {
  if (unitId) {
    const { state } = services.workspace.load(propertyId);
    if (state.paused || isRemoved(state)) return 0;
  }
  const phones = reachableWaitingPhones(services, propertyId, unitId);
  const { config } = services.workspace.load(propertyId);
  const body = toursAreBackText(config.property.address);
  let sent = 0;
  for (const phone of phones) {
    if (visitorUnreachable(services, propertyId, phone)) continue;
    const session = services.visitors?.latestForPhone(propertyId, phone);
    if (session) {
      await session.reply(body);
      await persistSession(services, session);
    } else {
      await createMessenger(config).send({ to: phone, audience: "PROSPECT", body }).catch(() => undefined);
    }
    appendAvailabilityEvent(services.workspace.root, propertyId, "TOURS_BACK_NOTIFIED", body, now.toISOString(), {
      ...(unitId ? { unitId } : {}),
      ...(session?.prospectId ? { prospectId: session.prospectId } : {}),
    });
    sent += 1;
  }
  if (unitId) dropUnitWaiters(services.workspace.root, propertyId, unitId);
  else dropWaiters(services.workspace.root, propertyId);
  return sent;
}

function pauseTarget(ctx: Ctx, property: string | undefined, unit?: string): { propertyId: string; unitId?: string; label: string; state: PropertyState } {
  const propertyId = resolvePropertyId(ctx.services.workspace, property);
  const { config, state } = ctx.services.workspace.load(propertyId);
  if (isRemoved(state)) throw new SetupInputError("PROPERTY_REMOVED", PROPERTY_REMOVED_REFUSE);
  if (!unit) return { propertyId, label: config.property.name, state };
  const matched = requireUnit(config, unit);
  return { propertyId, unitId: matched.id, label: matched.name, state };
}

export async function pauseTours(
  ctx: Ctx,
  input: { property?: string; unit?: string; bookedTours?: "keep" | "cancel"; confirmationCode?: string },
) {
  const target = pauseTarget(ctx, input.property, input.unit);
  const booked = await bookedTours(ctx.services, target.propertyId, target.unitId);
  const fingerprint = `${target.propertyId}|${target.unitId ?? ""}|${booked.map((tour) => `${currentReservation(tour)?.id}:${currentReservation(tour)?.status}`).join(",")}`;
  if (!input.confirmationCode) {
    return ask(ctx, "pause-tours", target.propertyId, fingerprint, pauseConfirmQuestion(target.label, booked.length), {
      bookedTours: booked.length,
      ...(target.unitId ? { unit: target.label } : {}),
    });
  }
  if (booked.length && input.bookedTours !== "keep" && input.bookedTours !== "cancel") {
    throw new SetupInputError("BOOKED_TOURS_CHOICE", "Say whether to keep the booked tours or cancel them with a text.");
  }
  redeem(ctx, input.confirmationCode, "pause-tours", target.propertyId, fingerprint);

  const { state } = ctx.services.workspace.load(target.propertyId);
  const next: Partial<PropertyState> = target.unitId
    ? { pausedUnitIds: [...new Set([...(state.pausedUnitIds ?? []), target.unitId])] }
    : { paused: true };
  ctx.services.workspace.patchState(target.propertyId, next);

  const after = ctx.services.workspace.load(target.propertyId);
  const propertyWide = isEffectivelyPaused(after.state, unitIdsOf(ctx.services, target.propertyId));
  let cancelled = 0;
  if (input.bookedTours === "cancel") {
    cancelled = await cancelBooked(ctx.services, booked, propertyWide, "tours paused");
  }

  const scope = target.unitId ? `unit ${target.label}` : labelOf(ctx.services, target.propertyId);
  appendAvailabilityEvent(ctx.services.workspace.root, target.propertyId, "TOURS_PAUSED", `${scope}; ${input.bookedTours === "cancel" ? "cancelled booked tours" : "kept booked tours"}`, ctx.now().toISOString(), {
    ...(target.unitId ? { unitId: target.unitId } : {}),
  });

  return {
    status: "paused",
    summary: target.unitId
      ? `Tours of ${target.label} are paused.${cancelled ? ` ${cancelled} booked ${cancelled === 1 ? "tour was" : "tours were"} cancelled.` : ""}`
      : `Tours at ${target.label} are paused.${cancelled ? ` ${cancelled} booked ${cancelled === 1 ? "tour was" : "tours were"} cancelled.` : ""}`,
    paused: true,
    bookedTours: booked.length,
    cancelled,
  };
}

export async function resumeTours(ctx: Ctx, input: { property?: string; unit?: string; confirmationCode?: string }) {
  const target = pauseTarget(ctx, input.property, input.unit);
  const waiting = phonesToNotify(ctx.services, target.propertyId, target.unitId);
  const fingerprint = `${target.propertyId}|${target.unitId ?? ""}|resume|${waiting.join(",")}`;
  if (!input.confirmationCode) {
    return ask(ctx, "resume-tours", target.propertyId, fingerprint, resumeConfirmQuestion(target.label, waiting.length), {
      waitingVisitors: waiting.length,
    });
  }
  redeem(ctx, input.confirmationCode, "resume-tours", target.propertyId, fingerprint);

  const { state } = ctx.services.workspace.load(target.propertyId);
  if (target.unitId) {
    ctx.services.workspace.patchState(target.propertyId, {
      pausedUnitIds: (state.pausedUnitIds ?? []).filter((id) => id !== target.unitId),
    });
  } else {
    ctx.services.workspace.patchState(target.propertyId, { paused: false, pausedUnitIds: [] });
  }

  const notified = await notifyWaiters(ctx.services, target.propertyId, target.unitId, ctx.now());
  appendAvailabilityEvent(ctx.services.workspace.root, target.propertyId, "TOURS_RESUMED", target.unitId ? `unit ${target.label}` : labelOf(ctx.services, target.propertyId), ctx.now().toISOString(), {
    ...(target.unitId ? { unitId: target.unitId } : {}),
  });

  return {
    status: "resumed",
    summary: target.unitId ? `Tours of ${target.label} can be booked again.` : `Tours at ${target.label} can be booked again.`,
    paused: false,
    notified,
  };
}

export async function removeProperty(ctx: Ctx, input: { property?: string; confirmationCode?: string }) {
  const propertyId = resolvePropertyId(ctx.services.workspace, input.property);
  const inProgress = !ctx.services.workspace.has(propertyId);
  const name = inProgress
    ? ctx.services.workspace.openDraft(propertyId).draft.property.name
    : ctx.services.workspace.load(propertyId).config.property.name;
  if (!inProgress && isRemoved(ctx.services.workspace.load(propertyId).state)) {
    throw new SetupInputError("PROPERTY_REMOVED", "That property has already been removed.");
  }
  if (await anyoneTouring(ctx.services, propertyId)) {
    throw new SetupInputError("TOUR_IN_PROGRESS", REMOVE_REFUSED_LIVE_TOUR);
  }

  const booked = await bookedTours(ctx.services, propertyId);
  const fingerprint = `${propertyId}|${booked.map((tour) => `${currentReservation(tour)?.id}:${currentReservation(tour)?.status}`).join(",")}`;
  if (!input.confirmationCode) {
    return ask(ctx, "remove-property", propertyId, fingerprint, removeConfirmQuestion(name, booked.length), { bookedTours: booked.length });
  }
  redeem(ctx, input.confirmationCode, "remove-property", propertyId, fingerprint);

  if (inProgress) {
    ctx.services.workspace.removeInProgressSetup(propertyId);
    return { status: "removed", summary: removedSetupSummary(name), cancelled: 0, removed: true };
  }

  const cancelled = await cancelBooked(ctx.services, booked, true, "property removed", true);
  ctx.services.workspace.patchState(propertyId, { removedAt: ctx.now().toISOString(), paused: true });
  dropWaiters(ctx.services.workspace.root, propertyId);
  appendAvailabilityEvent(ctx.services.workspace.root, propertyId, "PROPERTY_REMOVED", name, ctx.now().toISOString());

  return {
    status: "removed",
    summary: removedPropertySummary(name),
    cancelled,
    removed: true,
  };
}

export function pauseFlags(state: PropertyState, unitIds: string[]): { paused: boolean; removed: boolean; pausedUnitIds: string[] } {
  return {
    paused: isEffectivelyPaused(state, unitIds),
    removed: isRemoved(state),
    pausedUnitIds: state.pausedUnitIds ?? [],
  };
}

export function unitPausedFlag(state: PropertyState | undefined, unitId: string): boolean {
  return isUnitPaused(state, unitId);
}
