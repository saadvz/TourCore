import { z } from "zod";
import type { TourCoreConfig } from "../config/tourCoreConfig";
import type { Reservation } from "../domain/model";
import type { MessagingAdapter } from "../messaging/Messenger";
import type { PropertyWorkspace } from "../setup/workspace";
import type { RuntimeStore } from "../storage/runtimeStore";
import { localDateOf } from "../core/timezone";
import { parseIsoDate } from "../core/schedule";
import { VisitorDemoSession, type VisitorStage } from "./session";
import type { VerificationLinks } from "./verificationLinks";

/**
 * What a text-message conversation needs, beyond the canonical tour records,
 * to pick up exactly where it left off after a restart. It points at the
 * canonical records by id and never copies them: reservation status, consent,
 * verification, grants and audit are always read from the tour records, and
 * if the two disagree the tour records win.
 */

const Iso = z.iso.datetime({ offset: true });
const STAGES = ["intro", "choose-unit", "choose-date", "choose-time", "consent", "identity", "ready", "touring", "follow-up", "done", "stopped"] as const;

const StopRefSchema = z.object({
  doorName: z.string(),
  kind: z.enum(["ENTRANCE", "UNIT", "COMMON"]),
  unitName: z.string().optional(),
  label: z.string(),
});

const STEP_AWAITING = [
  z.object({ kind: z.literal("confirm-arrival") }),
  z.object({ kind: z.literal("confirm-stop"), stop: StopRefSchema }),
  z.object({ kind: z.literal("choose-stop"), stops: z.array(StopRefSchema).min(1) }),
  z.object({ kind: z.literal("confirm-finish") }),
  z.object({
    kind: z.literal("confirm-custom-time"),
    hour: z.number().int().min(1).max(12),
    minute: z.number().int().min(0).max(59),
    meridiem: z.enum(["AM", "PM"]).optional(),
    day: z.enum(["today", "tomorrow"]).optional(),
  }),
  z.object({ kind: z.literal("confirm-alternative"), requestId: z.string(), startsAt: Iso }),
  z.object({ kind: z.literal("accept-next-opening"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
] as const;
const StepAwaitingSchema = z.discriminatedUnion("kind", [...STEP_AWAITING]);

/** A question Tour Core asked back ("Which unit do you mean?"), and the step confirmation to restore after it. */
const AwaitingSchema = z.discriminatedUnion("kind", [
  ...STEP_AWAITING,
  z.object({ kind: z.literal("which-unit"), question: z.string().max(300), units: z.array(z.string()).min(1), resume: StepAwaitingSchema.optional() }),
]);

export const DurableSessionSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  propertyId: z.string(),
  /** Where this conversation's canonical tour records live. */
  tourId: z.string(),
  kind: z.literal("messaging"),
  /** active: resumes on the next text. completed / ended: kept for history, never reopened. needs-attention: couldn't be restored safely. */
  status: z.enum(["active", "completed", "ended", "needs-attention"]),
  /** The step when this was saved. Informational: the step is always recomputed from the tour records. */
  step: z.enum(STAGES),
  visitorPhone: z.string(),
  line: z.string().optional(),
  prospectId: z.string().optional(),
  reservationId: z.string().optional(),
  unitId: z.string().optional(),
  /** Tour times offered in the last menu, so "2" still means the same time. */
  offeredSlots: z.array(z.object({ start: Iso, label: z.string() })).default([]),
  offeredDates: z.array(z.object({ date: z.string(), label: z.string() })).default([]),
  selectedDate: z.string().optional(),
  /** A custom time named before a unit was chosen. */
  heldTime: z
    .object({
      hour: z.number().int().min(1).max(12),
      minute: z.number().int().min(0).max(59),
      meridiem: z.enum(["AM", "PM"]).optional(),
      day: z.enum(["today", "tomorrow"]).optional(),
    })
    .optional(),
  /** A question Tour Core asked and is waiting on ("Are you at the property now?"). */
  pending: z.object({ stage: z.enum(STAGES), awaiting: AwaitingSchema }).optional(),
  routeProgress: z.object({ opened: z.array(z.string()), next: z.string().optional() }).optional(),
  /** The identity-form link currently open (no token). */
  verification: z.object({ issuedAt: Iso, expiresAt: Iso }).optional(),
  followUp: z.enum(["asked", "answered"]).optional(),
  optedOut: z.boolean().default(false),
  createdAt: Iso,
  updatedAt: Iso,
  completedAt: Iso.optional(),
  recovery: z.object({ problem: z.string(), at: Iso, visitorTold: z.boolean().default(false) }).optional(),
});
export type DurableSession = z.infer<typeof DurableSessionSchema>;

const ENDED: Reservation["status"][] = ["CANCELLED", "REVOKED", "EXPIRED", "VERIFICATION_FAILED"];

function statusFor(stage: VisitorStage, r: Reservation | undefined): DurableSession["status"] {
  if (stage === "done") return "completed";
  if (stage === "stopped" && r && ENDED.includes(r.status)) return "ended";
  // Paused tours (operator hold, door-system problem) can resume, so they stay active.
  return "active";
}

export async function snapshotOf(session: VisitorDemoSession, links?: VerificationLinks, previous?: DurableSession): Promise<DurableSession> {
  const stage = await session.stage();
  const r = await session.reservation();
  const opened = r ? (await session.core.listGrants(r.id)).map((g) => g.doorId) : [];
  const now = session.clock.now().toISOString();
  const status = statusFor(stage, r);
  const link = r && links ? links.current(r.id) : undefined;
  return DurableSessionSchema.parse({
    schemaVersion: 1,
    sessionId: session.id,
    propertyId: session.propertyId,
    tourId: session.tourId,
    kind: "messaging",
    status,
    step: stage,
    visitorPhone: session.visitor?.phone ?? "",
    ...(session.line ? { line: session.line } : {}),
    ...(session.prospectId ? { prospectId: session.prospectId } : {}),
    ...(r ? { reservationId: r.id, unitId: r.unitId } : {}),
    offeredSlots: session.offeredSlots.map((s) => ({ start: s.start.toISOString(), label: s.label })),
    offeredDates: session.offeredDates,
    ...(session.selectedDate ? { selectedDate: session.selectedDate } : {}),
    ...(session.heldTime ? { heldTime: session.heldTime } : {}),
    ...(session.pendingClarification ? { pending: session.pendingClarification } : {}),
    ...(r ? { routeProgress: { opened, ...(r.allowedRoute.find((d) => !opened.includes(d)) ? { next: r.allowedRoute.find((d) => !opened.includes(d)) } : {}) } } : {}),
    ...(link ? { verification: { issuedAt: new Date(link.issuedAt).toISOString(), expiresAt: new Date(link.expiresAt).toISOString() } } : {}),
    ...(stage === "follow-up" ? { followUp: "asked" } : stage === "done" ? { followUp: "answered" } : {}),
    optedOut: session.optedOut,
    createdAt: previous?.createdAt ?? session.startedAt.toISOString(),
    updatedAt: now,
    ...(status !== "active" ? { completedAt: previous?.completedAt ?? now } : {}),
  });
}

/** Restoring would not be safe. The message is for the operator. */
export class RestoreError extends Error {}

export interface RestoreDeps {
  workspace: PropertyWorkspace;
  transport: MessagingAdapter;
  links?: VerificationLinks;
  realNow?: () => number;
  store?: import("../storage/Store").TourCoreStore;
  storageRead?: () => "live" | "cached" | "stale";
  beforeAccess?: () => Promise<void>;
}

/**
 * Rebuilds a conversation from its snapshot plus its canonical tour records,
 * checking that they agree. Anything that doesn't check out throws a
 * RestoreError: the tour isn't resumed, and nothing is opened. Minor gaps
 * (a stale confirmation, missing menu times) are dropped or rebuilt from the
 * canonical records instead, and listed in `notes`.
 */
export async function restoreSession(snapshot: DurableSession, deps: RestoreDeps): Promise<{ session: VisitorDemoSession; notes: string[] }> {
  const notes: string[] = [];
  const { workspace: ws } = deps;
  if (!ws.has(snapshot.propertyId)) throw new RestoreError("The property for this tour is no longer set up.");
  const { config } = ws.load(snapshot.propertyId);
  let tour: ReturnType<PropertyWorkspace["loadTour"]>;
  try {
    tour = ws.loadTour(snapshot.propertyId, snapshot.tourId);
  } catch {
    throw new RestoreError("This tour's records couldn't be read.");
  }
  if (!tour) throw new RestoreError("This tour's records are missing.");

  const session = new VisitorDemoSession(snapshot.propertyId, config, snapshot.tourId, {
    transport: deps.transport,
    kind: "messaging",
    verificationLinks: deps.links,
    realNow: deps.realNow,
    id: snapshot.sessionId,
    startedAt: new Date(snapshot.createdAt),
    store: deps.store,
    storageRead: deps.storageRead,
    beforeAccess: deps.beforeAccess,
  });
  await session.hydrate(tour.record, tour.bundle);
  session.line = snapshot.line;
  if (!session.visitor) session.identify(snapshot.visitorPhone);
  if (session.visitor!.phone !== snapshot.visitorPhone) throw new RestoreError("The visitor's number doesn't match this tour's records.");

  await validateCanonical(session, snapshot, config);

  session.offeredDates = snapshot.offeredDates ?? [];
  session.selectedDate = snapshot.selectedDate;
  if (!session.selectedDate && snapshot.offeredSlots[0]) {
    const local = localDateOf(new Date(snapshot.offeredSlots[0].start), config.property.timezone);
    session.selectedDate = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  }

  const stage = await session.stage();
  let pending = snapshot.pending;
  if (pending && (pending.stage !== stage || !stopsExist(pending.awaiting, config))) {
    notes.push("An unanswered question no longer fits where the tour is, so it was dropped.");
    pending = undefined;
  }
  let offeredSlots = snapshot.offeredSlots.map((s) => ({ start: new Date(s.start), label: s.label }));
  const selectedDate = session.selectedDate;
  if (stage === "choose-time" && offeredSlots.length === 0 && selectedDate) {
    const local = parseIsoDate(selectedDate);
    if (local) {
      offeredSlots = await session.core.availableSlots(local);
      notes.push("The tour-time menu was rebuilt from the schedule.");
    }
  }
  session.resume({
    offeredSlots,
    offeredDates: snapshot.offeredDates,
    ...(selectedDate ? { selectedDate } : {}),
    ...(pending ? { pending } : {}),
    ...(snapshot.heldTime ? { heldTime: snapshot.heldTime } : {}),
  });
  if (snapshot.step !== stage) notes.push(`Saved step "${snapshot.step}" was behind the tour records ("${stage}"); the tour records were used.`);
  return { session, notes };
}

function stopsExist(awaiting: z.infer<typeof AwaitingSchema>, config: TourCoreConfig): boolean {
  const names = new Set(config.doors.map((d) => d.name));
  if (awaiting.kind === "confirm-stop") return names.has(awaiting.stop.doorName);
  if (awaiting.kind === "choose-stop") return awaiting.stops.every((s) => names.has(s.doorName));
  if (awaiting.kind === "which-unit") return awaiting.units.every((u) => config.units.some((x) => x.name === u)) && (!awaiting.resume || stopsExist(awaiting.resume, config));
  return true;
}

async function validateCanonical(session: VisitorDemoSession, snapshot: DurableSession, config: TourCoreConfig): Promise<void> {
  const { store } = session;
  if (snapshot.prospectId && !(await store.get("prospects", snapshot.prospectId))) throw new RestoreError("The visitor's record is missing from this tour.");
  if (snapshot.reservationId) {
    if (!(await store.get("reservations", snapshot.reservationId))) throw new RestoreError("The reservation is missing from this tour's records.");
    if (session.reservationId !== snapshot.reservationId) throw new RestoreError("This tour's records show a different reservation than expected.");
  }
  const r = await session.reservation();
  if (!r) return;
  if (r.propertyId !== session.propertyId) throw new RestoreError("The reservation belongs to a different property.");
  if (r.prospectId !== session.prospectId || !(await store.get("prospects", r.prospectId))) throw new RestoreError("The reservation doesn't belong to this visitor.");
  if (!config.units.some((u) => u.id === r.unitId)) throw new RestoreError("The unit on this reservation is no longer set up.");
  if (!config.routes.some((route) => route.id === r.routeId)) throw new RestoreError("The route for this reservation is no longer set up.");
  const doors = new Set(config.doors.map((d) => d.id));
  if (!r.allowedRoute.every((d) => doors.has(d))) throw new RestoreError("A door on this reservation's route is no longer set up.");
  const grants = await session.core.listGrants(r.id);
  if (grants.some((g) => g.prospectId !== r.prospectId || !r.allowedRoute.includes(g.doorId))) throw new RestoreError("A door grant on file doesn't match this reservation.");

  // A tour past identity must have the consent and passing check that got it there.
  if (["READY", "TOURING", "COMPLETED"].includes(r.status) || (r.heldFromStatus && ["READY", "TOURING"].includes(r.heldFromStatus))) {
    const consent = r.consentId ? await store.get("consents", r.consentId) : undefined;
    const verification = r.verificationId ? await store.get("verifications", r.verificationId) : undefined;
    if (!consent?.granted || consent.reservationId !== r.id) throw new RestoreError("The consent record doesn't match this tour's status.");
    if (verification?.status !== "PASSED" || verification.prospectId !== r.prospectId) throw new RestoreError("The identity check on file doesn't match this tour's status.");
  }
}

/**
 * Saves one conversation: canonical tour records first, then the snapshot
 * that points at them. If the process stops between the two, the snapshot is
 * at worst one step behind, and restoring trusts the tour records.
 */
export class SessionPersistence {
  constructor(
    private readonly workspace: PropertyWorkspace,
    private readonly runtime: RuntimeStore,
    private readonly links?: VerificationLinks,
  ) {}

  async save(session: VisitorDemoSession): Promise<void> {
    const { record, bundle } = await session.record();
    this.workspace.recordVisitorDemo(session.propertyId, record, bundle);
    if (session.kind !== "messaging" || !session.visitor) return;
    const previous = this.load(session.id);
    this.runtime.put("sessions", session.id, await snapshotOf(session, this.links, previous));
  }

  load(sessionId: string): DurableSession | undefined {
    try {
      const raw = this.runtime.get<unknown>("sessions", sessionId);
      const parsed = raw === undefined ? undefined : DurableSessionSchema.safeParse(raw);
      return parsed?.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every saved snapshot; unreadable ones are reported by key so they can be flagged, never silently skipped. */
  all(): { snapshots: DurableSession[]; unreadable: string[] } {
    const { entries, damaged } = this.runtime.list<unknown>("sessions");
    const snapshots: DurableSession[] = [];
    const unreadable = [...damaged];
    for (const { key, value } of entries) {
      const parsed = DurableSessionSchema.safeParse(value);
      if (parsed.success) snapshots.push(parsed.data);
      else unreadable.push(key);
    }
    return { snapshots, unreadable };
  }

  markNeedsAttention(snapshot: DurableSession, problem: string, now = new Date()): DurableSession {
    const next: DurableSession = { ...snapshot, status: "needs-attention", updatedAt: now.toISOString(), recovery: { problem, at: now.toISOString(), visitorTold: snapshot.recovery?.visitorTold ?? false } };
    this.runtime.put("sessions", snapshot.sessionId, next);
    return next;
  }

  put(snapshot: DurableSession): void {
    this.runtime.put("sessions", snapshot.sessionId, DurableSessionSchema.parse(snapshot));
  }
}
