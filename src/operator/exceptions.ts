import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HANDLER_FAILED_NEXT_STEP } from "../core/TourCore";
import { formatShortDateTime } from "../core/timezone";
import { profileFacts, questionTopic, structuredAnswer, type ProfileField, type UnitProfile } from "../config/unitProfile";
import { MAX_FACT_LENGTH } from "../config/validateConfig";
import type { AuditEvent, Reservation, ReservationStatus } from "../domain/model";
import { applySetupCommand } from "../setup/commands";
import { SetupInputError } from "../setup/setupActions";
import { statusLabel } from "../setup/workspace";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { resumeStep } from "../visitor/conversation";
import type { OperatorServices } from "./services";
import { persistSession } from "./services";
import { visitorSubject } from "../visitor/identity";
import { STATUS_LABELS } from "../visitor/views";
import {
  currentReservation,
  findTour,
  statusOf,
  tourRef,
  tourSnapshots,
  tourSummary,
  unitNameOf,
  visitorNameOf,
  type TourSnapshot,
} from "./tours";

/**
 * The operator's exception queue. Exceptions are derived from the canonical
 * tour records (append-only audit) plus conversations that couldn't be
 * restored; the only thing stored here is the operator's resolution, in an
 * append-only ledger next to the property. Resolving an exception never
 * changes a tour, a reservation or the setup.
 */

export type ExceptionKind =
  | "unanswered-question"
  | "handler-failed"
  | "needs-help"
  | "off-route-door"
  | "door-system"
  | "provider-failure"
  | "access-problem"
  | "verification-failed"
  | "operator-hold"
  | "message-failed"
  | "restore-conflict"
  | "overstay";

const TITLES: Record<ExceptionKind, string> = {
  "unanswered-question": "Question with no approved answer",
  "handler-failed": "Couldn't handle their text",
  "needs-help": "Visitor asked for help",
  "off-route-door": "Tried a door that isn't on their tour",
  "door-system": "Door system wasn't responding",
  "provider-failure": "Door system problem",
  "access-problem": "Couldn't get in",
  "verification-failed": "Identity check didn't pass",
  "operator-hold": "Tour paused by your team",
  "message-failed": "Message couldn't be delivered",
  "restore-conflict": "Tour couldn't be restored",
  overstay: "Visitor hasn't confirmed leaving",
};

export interface ExceptionResolution {
  exceptionId: string;
  resolvedAt: string;
  note: string;
  /** "answered": the operator supplied an approved fact and the visitor was sent it. */
  action: "resolved" | "answered";
  approvedFact?: string;
  visitorAnswered?: boolean;
}

export interface OperatorException {
  exceptionId: string;
  propertyId: string;
  property: string;
  kind: ExceptionKind;
  title: string;
  /** One plain sentence: what happened. */
  summary: string;
  visitorName: string;
  unitName?: string;
  tourRef?: string;
  happenedAt: string;
  when: string;
  /** Where the tour stands now, e.g. "Touring" or "Paused". */
  tourStatus: string;
  /** Doors won't open for this tour right now. */
  accessBlocked: boolean;
  /** The visitor's own words, for an unanswered question. */
  question?: string;
  /** The unit an unanswered question was about, when the visitor named one before booking. */
  questionUnitId?: string;
  /** The reservation the issue is about. A leaving issue is the closed tour, not a later held rebook. */
  reservationId?: string;
  /** open = needs a decision; cleared = no longer applies (e.g. the hold was lifted); resolved = the team closed it. */
  status: "open" | "cleared" | "resolved";
  resolution?: ExceptionResolution;
  /** What the team can do next, in plain language. */
  nextSteps: string[];
}

// -------------------------------------------------------------------- ledger

interface LedgerFile {
  schemaVersion: 1;
  resolutions: ExceptionResolution[];
}

function ledgerPath(services: OperatorServices, propertyId: string): string {
  if (!/^[a-z0-9_]+$/.test(propertyId)) throw new SetupInputError("PROPERTY_ID_INVALID", "That property label isn't valid.");
  return join(services.workspace.root, "properties", propertyId, "operator", "exception-resolutions.json");
}

export function readResolutions(services: OperatorServices, propertyId: string): ExceptionResolution[] {
  const path = ledgerPath(services, propertyId);
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, "utf8")) as LedgerFile).resolutions;
}

function appendResolution(services: OperatorServices, propertyId: string, entry: ExceptionResolution): void {
  const resolutions = readResolutions(services, propertyId);
  writeJsonAtomic(ledgerPath(services, propertyId), { schemaVersion: 1, resolutions: [...resolutions, entry] } satisfies LedgerFile);
}

// ------------------------------------------------------------------ derive

const id = (...parts: string[]) => `exc_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12)}`;
const PAUSED: ReservationStatus[] = ["OPERATOR_HOLD", "PROVIDER_FAILURE"];
const BLOCKING: ReservationStatus[] = ["OPERATOR_HOLD", "PROVIDER_FAILURE", "REVOKED", "CANCELLED", "VERIFICATION_FAILED", "EXPIRED"];
const ACCESS_KINDS: Record<string, ExceptionKind | undefined> = {
  DENY_WRONG_ROUTE: "off-route-door",
  DENY_DURIN_UNHEALTHY: "door-system",
  DENY_UNKNOWN: "access-problem",
  DENY_PROSPECT_MISMATCH: "access-problem",
  DENY_NO_RESERVATION: "access-problem",
};

function kindFor(e: AuditEvent): ExceptionKind | undefined {
  switch (e.type) {
    case "QUESTION_UNANSWERED":
      return "unanswered-question";
    case "HANDLER_FAILED":
      return "handler-failed";
    case "HELP_REQUESTED":
      return "needs-help";
    case "ACCESS_DENIED":
      return ACCESS_KINDS[e.code ?? ""];
    case "PROVIDER_FAILURE":
      return "provider-failure";
    case "VERIFICATION_FAILED":
      return "verification-failed";
    case "OPERATOR_HOLD_PLACED":
      return "operator-hold";
    case "MESSAGE_FAILED":
      return e.detail.startsWith("message") ? "message-failed" : undefined;
    case "TOUR_OVERSTAY_CLOSED":
      return "overstay";
    case "VISITOR_CONFIRMED_LEFT":
      return undefined;
    default:
      return undefined;
  }
}

function reservationOn(tour: TourSnapshot, reservationId?: string): Reservation | undefined {
  if (reservationId) return tour.bundle.reservations.find((x) => x.id === reservationId);
  return currentReservation(tour);
}

function unitNameOn(tour: TourSnapshot, reservationId?: string): string | undefined {
  const r = reservationOn(tour, reservationId);
  const unit = tour.config.units.find((u) => u.id === r?.unitId);
  return unit ? visitorSubject(tour.config.property, unit.name) : undefined;
}

function summaryFor(kind: ExceptionKind, e: AuditEvent, tour: TourSnapshot): string {
  const door = tour.config.doors.find((d) => d.id === e.doorId)?.name ?? "a door that isn't on file";
  switch (kind) {
    case "unanswered-question":
      return `Asked "${e.detail}". There's no approved answer yet.`;
    case "handler-failed":
      return e.detail;
    case "needs-help":
      return `Asked for help${e.detail ? ` near ${e.detail}` : ""}.`;
    case "off-route-door":
      return `Tried ${door}, which isn't on their tour. It stayed locked.`;
    case "door-system":
      return `The door system wasn't responding at ${door}, so it stayed locked.`;
    case "provider-failure":
      return e.code === "DENY_STORAGE_FAILURE"
        ? "Tour Core couldn't save the visit record, so the tour was paused."
        : `The door system couldn't open ${door}, so the tour was paused.`;
    case "access-problem":
      return `Couldn't get into ${door}.`;
    case "verification-failed":
      return "Their identity details didn't check out, so the tour was stopped.";
    case "operator-hold":
      return `Your team paused this tour${e.detail ? `: ${e.detail}` : ""}.`;
    case "message-failed":
      return "A message to the visitor couldn't be delivered.";
    case "restore-conflict":
      return "Couldn't be restored after a restart.";
    case "overstay":
      return `Hasn't confirmed leaving ${unitNameOn(tour, e.reservationId) ?? "the property"}.`;
  }
}

function nextStepsFor(kind: ExceptionKind, tour: TourSnapshot | undefined, stillPaused: boolean): string[] {
  const canChange = !!tour?.live;
  switch (kind) {
    case "unanswered-question":
      return [
        "If you know the answer, tell me and I can add it to the approved facts and text the visitor (with your OK).",
        "Or mark it handled if you've already answered them another way.",
      ];
    case "handler-failed":
      return [HANDLER_FAILED_NEXT_STEP, "Mark it handled once you've dealt with it."];
    case "needs-help":
      return ["Reach out to the visitor.", "Mark it handled once they're sorted."];
    case "off-route-door":
      return ["Check in with the visitor if they seem lost.", ...(canChange ? ["You can pause or call off the tour if something looks wrong."] : []), "Mark it handled."];
    case "door-system":
    case "provider-failure":
      return [
        "Check the door system, then reach out to the visitor.",
        ...(stillPaused && canChange ? ["Once the doors are working, I can resume the tour (with your OK)."] : []),
        "Mark it handled.",
      ];
    case "operator-hold":
      return stillPaused && canChange ? ["I can resume the tour (with your OK) or call it off.", "Mark it handled once it's sorted."] : ["Mark it handled."];
    case "restore-conflict":
      return ["Reach out to the visitor; no doors will open for this tour.", "If they text HI again, a fresh tour starts.", "Mark it handled."];
    case "overstay":
      return ["Reach out to the visitor if they may still be inside.", "Mark it handled once you've confirmed."];
    default:
      return ["Reach out to the visitor.", "Mark it handled."];
  }
}

function tourStatusFor(tour: TourSnapshot | undefined, reservationId?: string): { tourStatus: string; accessBlocked: boolean } {
  const r = tour ? reservationOn(tour, reservationId) : undefined;
  if (!tour) return { tourStatus: "Access is blocked", accessBlocked: true };
  const status = r ? STATUS_LABELS[r.status] : statusOf(tour);
  const blocked = !!r && BLOCKING.includes(r.status);
  return { tourStatus: blocked ? `${status}. Access is blocked.` : r && r.status === "TOURING" ? "Tour still active" : status, accessBlocked: blocked };
}

/** Whether a pause from this event is still in force (nothing lifted or replaced it since). */
function stillApplies(e: AuditEvent, tour: TourSnapshot): boolean {
  const r: Reservation | undefined = tour.bundle.reservations.find((x) => x.id === e.reservationId);
  if (!r || !PAUSED.includes(r.status)) return false;
  return !tour.bundle.auditEvents.some((later) => later.seq > e.seq && later.reservationId === e.reservationId && (later.type === "RESERVATION_RESUMED" || later.type === "OPERATOR_HOLD_PLACED" || later.type === "PROVIDER_FAILURE"));
}

function unitSubject(tour: TourSnapshot, unitId?: string): string | undefined {
  const unit = tour.config.units.find((u) => u.id === unitId);
  return unit ? visitorSubject(tour.config.property, unit.name) : undefined;
}

function fromEvent(tour: TourSnapshot, e: AuditEvent, kind: ExceptionKind, resolutions: Map<string, ExceptionResolution>): OperatorException {
  const exceptionId = id(tour.propertyId, tour.tourId, e.id);
  const pauseKind = kind === "operator-hold" || kind === "provider-failure";
  const paused = pauseKind && stillApplies(e, tour);
  const leftAfterClose =
    kind === "overstay" &&
    tour.bundle.auditEvents.some((later) => later.reservationId === e.reservationId && later.type === "VISITOR_CONFIRMED_LEFT" && later.seq > e.seq);
  const resolution = resolutions.get(exceptionId);
  const status = resolution ? "resolved" : pauseKind && !paused ? "cleared" : leftAfterClose ? "cleared" : "open";
  const replies =
    kind === "overstay"
      ? tour.bundle.auditEvents.filter((later) => later.reservationId === e.reservationId && later.type === "OPERATOR_NOTIFIED" && later.detail.includes("replied after their tour"))
      : [];
  const extra = replies.map((later) => later.detail).join(" ");
  return {
    exceptionId,
    propertyId: tour.propertyId,
    property: tour.config.property.name,
    kind,
    title: TITLES[kind],
    summary: extra ? `${summaryFor(kind, e, tour)} ${extra}` : summaryFor(kind, e, tour),
    visitorName: visitorNameOf(tour),
    unitName: unitNameOn(tour, e.reservationId) ?? unitSubject(tour, e.unitId),
    tourRef: tourRef(tour.propertyId, tour.tourId),
    happenedAt: e.at,
    when: formatShortDateTime(new Date(e.at), tour.config.property.timezone),
    ...tourStatusFor(tour, e.reservationId),
    ...(kind === "unanswered-question" ? { question: e.detail, ...(e.unitId ? { questionUnitId: e.unitId } : {}) } : {}),
    ...(e.reservationId ? { reservationId: e.reservationId } : {}),
    status,
    ...(resolution ? { resolution } : {}),
    nextSteps: status === "open" ? nextStepsFor(kind, tour, paused) : [],
  };
}

function inboundAt(event: AuditEvent): string | undefined {
  return event.code?.trim() || undefined;
}

/** Later asks stay on the same exception while it is open, or if they happened before it was marked handled. */
function belongsToCurrentHelp(current: OperatorException, event: AuditEvent): boolean {
  if (current.status === "open") return true;
  if (current.status !== "resolved" || !current.resolution) return false;
  return Date.parse(event.at) <= Date.parse(current.resolution.resolvedAt);
}

/**
 * One open help exception per reservation. Later HELP_REQUESTED events on the
 * same reservation append their time (and the visitor's words) until the
 * operator marks that exception handled; a later ask then opens a new one.
 */
function foldHelpExceptions(tour: TourSnapshot, events: AuditEvent[], resolutions: Map<string, ExceptionResolution>): OperatorException[] {
  const byReservation = new Map<string, AuditEvent[]>();
  for (const e of events) {
    const key = e.reservationId ?? e.id;
    const list = byReservation.get(key) ?? [];
    list.push(e);
    byReservation.set(key, list);
  }
  const out: OperatorException[] = [];
  for (const group of byReservation.values()) {
    let current: OperatorException | undefined;
    for (const e of group) {
      if (current && belongsToCurrentHelp(current, e)) {
        const when = formatShortDateTime(new Date(e.at), tour.config.property.timezone);
        const said = inboundAt(e);
        current.summary += said ? ` Asked again at ${when}: "${said}".` : ` Asked again at ${when}.`;
        current.happenedAt = e.at;
        current.when = when;
        continue;
      }
      current = fromEvent(tour, e, "needs-help", resolutions);
      out.push(current);
    }
  }
  return out;
}

/** Every exception for one property or all of them, newest first. Open ones only unless asked. */
export async function listExceptions(services: OperatorServices, options: { propertyId?: string; includeClosed?: boolean } = {}): Promise<OperatorException[]> {
  const tours = await tourSnapshots(services, { propertyId: options.propertyId });
  const ids = options.propertyId ? [options.propertyId] : services.workspace.list().map((p) => p.config.property.id);
  const out: OperatorException[] = [];
  for (const propertyId of ids) {
    if (!services.workspace.has(propertyId)) continue;
    const resolutions = new Map(readResolutions(services, propertyId).map((r) => [r.exceptionId, r]));
    const mine = tours.filter((t) => t.propertyId === propertyId);
    for (const tour of mine) {
      const help: AuditEvent[] = [];
      for (const e of tour.bundle.auditEvents) {
        const kind = kindFor(e);
        if (kind === "needs-help") help.push(e);
        else if (kind) out.push(fromEvent(tour, e, kind, resolutions));
      }
      out.push(...foldHelpExceptions(tour, help, resolutions));
    }
    const { config } = services.workspace.load(propertyId);
    for (const broken of services.needsAttention?.(propertyId) ?? []) {
      const at = broken.at ?? new Date(0).toISOString();
      const exceptionId = id(propertyId, "restore", broken.visitorPhone, at);
      const resolution = resolutions.get(exceptionId);
      const earlier = mine.find((t) => t.kind === "messaging" && t.visitorPhone === broken.visitorPhone);
      out.push({
        exceptionId,
        propertyId,
        property: config.property.name,
        kind: "restore-conflict",
        title: TITLES["restore-conflict"],
        summary: `Couldn't be restored after a restart (${broken.problem.replace(/\.$/, "")}). No doors will open for it.`,
        visitorName: earlier ? visitorNameOf(earlier) : `A visitor texting from ${broken.visitorPhone}`,
        unitName: earlier ? unitNameOf(earlier) : undefined,
        happenedAt: at,
        when: formatShortDateTime(new Date(at), config.property.timezone),
        tourStatus: "Access is blocked",
        accessBlocked: true,
        status: resolution ? "resolved" : "open",
        ...(resolution ? { resolution } : {}),
        nextSteps: resolution ? [] : nextStepsFor("restore-conflict", undefined, false),
      });
    }
  }
  const visible = options.includeClosed ? out : out.filter((x) => x.status === "open");
  return visible.sort((a, b) => b.happenedAt.localeCompare(a.happenedAt));
}

export async function findException(services: OperatorServices, exceptionId: string): Promise<OperatorException> {
  const found = (await listExceptions(services, { includeClosed: true })).find((x) => x.exceptionId === exceptionId);
  if (!found) throw new SetupInputError("EXCEPTION_NOT_FOUND", "I couldn't find that issue.");
  return found;
}

/** One exception with its tour's context. */
export async function inspectException(services: OperatorServices, exceptionId: string) {
  const exception = await findException(services, exceptionId);
  const tour = exception.tourRef ? await findTour(services, exception.tourRef) : undefined;
  return {
    ...exception,
    tour: tour ? tourSummary(tour) : undefined,
    recentMessages: (tour?.conversation ?? []).slice(-6).map((m) => ({ from: m.from === "tourcore" ? "Tour Core" : m.from === "visitor" ? "Visitor" : "Demo note", text: m.text })),
  };
}

// ----------------------------------------------------------------- actions

/** Closes an exception with the team's note. Changes nothing else. Resolving twice keeps the first resolution. */
export async function resolveException(services: OperatorServices, exceptionId: string, note: string, now: Date) {
  const exception = await findException(services, exceptionId);
  const clean = note.trim().slice(0, 500);
  if (!clean) throw new SetupInputError("NOTE_MISSING", "Add a short note about how it was handled.");
  if (exception.status === "resolved") return { alreadyResolved: true, exception };
  appendResolution(services, exception.propertyId, { exceptionId, resolvedAt: now.toISOString(), note: clean, action: "resolved" });
  if (exception.kind === "overstay" && exception.tourRef) {
    try {
      const tour = await findTour(services, exception.tourRef);
      const reservationId = exception.reservationId;
      if (reservationId) tour.live?.overstay?.closeAlertWindow(reservationId);
    } catch {
      /* saved tours without a live conversation still clear via the ledger */
    }
  }
  return { alreadyResolved: false, exception: await findException(services, exceptionId) };
}

/** A tour this process is running, ready for an operator change. */
async function liveTour(services: OperatorServices, ref: string) {
  const tour = await findTour(services, ref);
  const r = currentReservation(tour);
  if (!tour.live || !r) throw new SetupInputError("TOUR_NOT_RUNNING", "That tour isn't running right now, so there's nothing to change.");
  return { tour, session: tour.live, reservation: r };
}

const HOLDABLE: ReservationStatus[] = ["RESERVED", "AWAITING_CONSENT", "AWAITING_VERIFICATION", "READY", "TOURING"];
const REVOCABLE: ReservationStatus[] = [...HOLDABLE, ...PAUSED];

export type TourChange = "hold" | "resume" | "revoke";

/** Refuses a change the tour can't make from where it is, before anyone is asked to approve it. */
function assertCanChange(tour: TourSnapshot, reservation: Reservation, change: TourChange): void {
  const name = visitorNameOf(tour);
  const now = statusOf(tour).toLowerCase();
  if (change === "hold" && !HOLDABLE.includes(reservation.status)) throw new SetupInputError("NOT_HOLDABLE", `${name}'s tour is ${now}, so it can't be paused.`);
  if (change === "resume" && !PAUSED.includes(reservation.status)) throw new SetupInputError("NOT_PAUSED", `${name}'s tour isn't paused.`);
  if (change === "revoke" && !REVOCABLE.includes(reservation.status)) throw new SetupInputError("NOT_REVOCABLE", `${name}'s tour is already ${now}, so there's nothing to call off.`);
}

/** The running tour an operator change is about, checked for that change. */
export async function describeChangeTarget(services: OperatorServices, ref: string, change: TourChange) {
  const { tour, reservation } = await liveTour(services, ref);
  assertCanChange(tour, reservation, change);
  return { tour, reservation, name: visitorNameOf(tour), unit: unitNameOf(tour) ?? "their unit" };
}

/** Pauses a tour: its doors are switched off and none open until the team resumes it. */
export async function placeHold(services: OperatorServices, ref: string, reason: string) {
  const { tour, session, reservation } = await liveTour(services, ref);
  assertCanChange(tour, reservation, "hold");
  const why = reason.trim().slice(0, 300) || "paused by the property team";
  await session.operatorChange((core, id) => core.placeOperatorHold(id, why));
  await persistSession(services, session);
  return tourSummary(await findTour(services, ref));
}

/** Resumes a paused tour. Access is still decided by policy on every request. */
export async function clearHold(services: OperatorServices, ref: string) {
  const { tour, session, reservation } = await liveTour(services, ref);
  assertCanChange(tour, reservation, "resume");
  await session.operatorChange((core, id) => core.resumeReservation(id));
  await persistSession(services, session);
  return tourSummary(await findTour(services, ref));
}

/** Calls a tour off for good: every door is switched off and the visitor is told. */
export async function revokeTour(services: OperatorServices, ref: string, reason: string) {
  const { tour, session, reservation } = await liveTour(services, ref);
  assertCanChange(tour, reservation, "revoke");
  const why = reason.trim().slice(0, 300) || "called off by the property team";
  await session.operatorChange((core, id) => core.revokeReservation(id, why));
  await persistSession(services, session);
  return tourSummary(await findTour(services, ref));
}

export function cleanFact(fact: string): string {
  const clean = fact.trim().replace(/\s+/g, " ");
  if (!clean) throw new SetupInputError("FACT_MISSING", "I need the answer in your own words before I can add it.");
  if (clean.length > MAX_FACT_LENGTH) throw new SetupInputError("FACT_TOO_LONG", `Please keep it under ${MAX_FACT_LENGTH} characters.`);
  return clean;
}

/** What the visitor receives: the approved fact itself, conversationally. */
export function visitorAnswerText(_question: string, fact: string): string {
  return `${fact} Let me know if you have any other questions.`;
}

/** An operator's answer to a flagged question, as Tour Core will save it. */
export interface FlaggedAnswerPlan {
  exception: OperatorException;
  appliesTo: "property" | "unit";
  unitId?: string;
  /** Saved as a structured unit detail (e.g. bedrooms) rather than free text. */
  field?: ProfileField;
  value?: NonNullable<UnitProfile[ProfileField]>;
  /** The approved fact exactly as it will be saved and sent. */
  fact: string;
  where: string;
  /** Handler-failure reply: text the visitor, never save an approved fact. */
  sendOnly?: boolean;
}

/**
 * Works out how an operator's answer will be saved, without saving anything.
 * An answer to a question about a unit detail ("How many bedrooms?" / "2
 * bedrooms") becomes that unit's structured value, and the visitor gets the
 * canonical sentence ("Unit 1A has 2 bedrooms."). Anything else is kept in the
 * operator's own words as a unit or property fact.
 */
export async function planFlaggedAnswer(services: OperatorServices, input: { exceptionId: string; approvedFact: string; appliesTo?: "property" | "unit" }, now: Date): Promise<FlaggedAnswerPlan> {
  const exception = await findException(services, input.exceptionId);
  if (exception.status === "resolved") throw new SetupInputError("ALREADY_RESOLVED", "That question has already been handled.");
  if (exception.kind === "handler-failed") {
    const words = cleanFact(input.approvedFact);
    return { exception, appliesTo: "property", fact: words, where: exception.property, sendOnly: true };
  }
  if (exception.kind !== "unanswered-question" || !exception.question) throw new SetupInputError("NOT_A_QUESTION", "That issue isn't an unanswered question.");
  const words = cleanFact(input.approvedFact);
  const tour = exception.tourRef ? await findTour(services, exception.tourRef) : undefined;
  const unitId = exception.questionUnitId ?? (tour ? reservationOn(tour, exception.reservationId)?.unitId : undefined);
  const { draft } = services.workspace.openDraft(exception.propertyId);
  const unit = draft.units.find((u) => u.id === unitId);
  const topic = questionTopic(exception.question);
  if (unit && topic && input.appliesTo !== "property") {
    const value = structuredAnswer(topic, words, now);
    if (value) {
      const fact = profileFacts({ name: visitorSubject(draft.property, unit.name), profile: { [topic]: value } }).find((f) => f.field === topic)!.text;
      return { exception, appliesTo: "unit", unitId: unit.id, field: topic, value, fact, where: visitorSubject(draft.property, unit.name) };
    }
  }
  const unitTopic = !!topic && ["bedrooms", "bathrooms", "monthlyRent", "availability", "squareFeet", "floor", "furnished", "features"].includes(topic);
  const appliesTo = input.appliesTo ?? (unit && unitTopic ? "unit" : "property");
  if (appliesTo === "unit" && !unit) throw new SetupInputError("UNIT_NOT_FOUND", "I couldn't tell which unit that question was about. Add it as a property fact instead.");
  const fact = /[.!?]$/.test(words) ? words : `${words}.`;
  return { exception, appliesTo, unitId: unit?.id, fact: fact.charAt(0).toUpperCase() + fact.slice(1), where: appliesTo === "unit" ? visitorSubject(draft.property, unit!.name) : exception.property };
}

/**
 * The operator supplied the answer to a flagged question. It becomes approved
 * content through the normal setup edit (content changes keep the property
 * published), the visitor is sent exactly that fact, and the exception is
 * resolved. Tour Core never writes the answer itself.
 */
export async function answerFlaggedQuestion(
  services: OperatorServices,
  input: { exceptionId: string; approvedFact: string; appliesTo?: "property" | "unit" },
  now: Date,
) {
  const plan = await planFlaggedAnswer(services, input, now);
  const { exception, fact } = plan;
  const ws = services.workspace;
  const tour = exception.tourRef ? await findTour(services, exception.tourRef) : undefined;
  const wasPublished = ws.has(exception.propertyId) && ws.load(exception.propertyId).state.status === "PUBLISHED_FOR_DEMO";

  if (plan.sendOnly) {
    let visitorAnswered = false;
    if (tour?.live) {
      await tour.live.reply(fact);
      await persistSession(services, tour.live);
      visitorAnswered = true;
    }
    appendResolution(services, exception.propertyId, {
      exceptionId: exception.exceptionId,
      resolvedAt: now.toISOString(),
      note: visitorAnswered ? "Sent a reply." : "The visitor's tour wasn't running, so they weren't texted.",
      action: "answered",
    });
    const after = ws.has(exception.propertyId) ? ws.load(exception.propertyId) : undefined;
    return {
      approvedFact: fact,
      addedTo: plan.where,
      savedToSetup: false,
      visitorAnswered,
      visitorMessage: visitorAnswered ? fact : undefined,
      setupStatus: after ? statusLabel(after) : "Setup in progress",
      stillPublished: wasPublished && after?.state.status === "PUBLISHED_FOR_DEMO",
      needsRecheck: false,
    };
  }

  const { draft } = ws.openDraft(exception.propertyId);
  let next;
  if (plan.field && plan.unitId && plan.value) {
    next = structuredClone(draft);
    const unit = next.units.find((u) => u.id === plan.unitId)!;
    unit.profile = { ...(unit.profile ?? {}), [plan.field]: plan.value };
  } else if (plan.appliesTo === "unit") {
    const unit = draft.units.find((u) => u.id === plan.unitId)!;
    next = applySetupCommand(draft, "setUnitDetails", { unitId: unit.id, facts: [...unit.facts, fact] });
  } else {
    next = applySetupCommand(draft, "setPropertyDetails", { facts: [...draft.property.facts, fact] });
  }
  const saved = ws.persistEdit(next, now);

  let visitorAnswered = false;
  if (tour?.live) {
    await tour.live.reply(visitorAnswerText(exception.question!, fact));
    // Then back to where the visitor is now: the same menu, times or confirmation they were on.
    await resumeStep(tour.live);
    await persistSession(services, tour.live);
    visitorAnswered = true;
  }
  appendResolution(services, exception.propertyId, {
    exceptionId: exception.exceptionId,
    resolvedAt: now.toISOString(),
    note: visitorAnswered ? "Answered with a new approved fact." : "Added a new approved fact; the visitor's tour wasn't running, so they weren't texted.",
    action: "answered",
    approvedFact: fact,
    visitorAnswered,
  });
  const after = ws.has(exception.propertyId) ? ws.load(exception.propertyId) : undefined;
  return {
    approvedFact: fact,
    addedTo: plan.where,
    savedToSetup: saved === "saved",
    visitorAnswered,
    visitorMessage: visitorAnswered ? visitorAnswerText(exception.question!, fact) : undefined,
    setupStatus: after ? statusLabel(after) : "Setup in progress",
    stillPublished: wasPublished && after?.state.status === "PUBLISHED_FOR_DEMO",
    /** Only if something structural changed (never for an approved fact). */
    needsRecheck: wasPublished && after?.state.status !== "PUBLISHED_FOR_DEMO",
  };
}
