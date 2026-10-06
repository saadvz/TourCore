import { TourCoreConfigSchema, type TourCoreConfig } from "../config/tourCoreConfig";
import { SimulatedClock } from "../core/clock";
import { nextTourDay, slotsOn } from "../core/schedule";
import { formatLocalDate, formatTime } from "../core/timezone";
import { TourCore } from "../core/TourCore";
import { createDurin, createStore, createVerificationProvider } from "../createTourCore";
import type { AuditEvent } from "../domain/model";
import { countDurinCalls } from "../durin/countingDurin";
import type { ExportBundle } from "../export/exportBundle";
import type { Messenger } from "../messaging/Messenger";
import { MemoryRuntimeStore } from "../storage/runtimeStore";
import { isApartmentOrCondo, visitorSubject } from "../visitor/identity";
import { OverstayScheduler } from "../visitor/overstayScheduler";
import { extensionGranted, plus15Closed, plus5CheckIn, t15Questions, t5Offering, tourEnded } from "../core/overstayCopy";

export type DryTourGroup = "journey" | "safety" | "wrapup";

export interface DryTourCheck {
  /** Stable id, e.g. "early_arrival", "wrong_door". */
  id: string;
  group: DryTourGroup;
  /** What happened, e.g. "Visitor tries Unit 102 Door". */
  label: string;
  /** What Tour Core did, e.g. "Access correctly denied before Durin was contacted". */
  outcome?: string;
  ok: boolean;
  /** Plain-language reason when not ok. */
  detail?: string;
}

export interface DryTourMessage {
  time: string;
  audience: "PROSPECT" | "OPERATOR";
  body: string;
}

export type DryTourEvent =
  | { kind: "stage"; title: string }
  | { kind: "moment"; time: string; text: string }
  | { kind: "text"; audience: "PROSPECT" | "OPERATOR"; body: string }
  | ({ kind: "check" } & DryTourCheck)
  /** Technical adapter output, for dev mode. */
  | { kind: "dev"; line: string };

export interface DryTourResult {
  passed: boolean;
  ranAt: string;
  unitId?: string;
  checks: DryTourCheck[];
  /** Plain-language reason when the practice tour stopped early. */
  failure?: string;
  audit: AuditEvent[];
  messages?: DryTourMessage[];
  /** Mock Durin output and errors, for dev mode only. */
  devLines?: string[];
  bundle?: ExportBundle;
}

export interface DryTourOptions {
  /** Which unit to practice; defaults to the first one. */
  unitId?: string;
  now?: Date;
  onEvent?: (event: DryTourEvent) => void | Promise<void>;
}

export const PRACTICE_VISITOR = { name: "Pat Practice", phone: "+1 555 019 9999" };

class StopPractice extends Error {}

/**
 * Runs one complete simulated tour through the real Tour Core engine using
 * the operator's configuration, and checks every safety rule along the way.
 */
export async function runDryTour(input: TourCoreConfig, options: DryTourOptions = {}): Promise<DryTourResult> {
  const realNow = options.now ?? new Date();
  const checks: DryTourCheck[] = [];
  const messages: DryTourMessage[] = [];
  const devLines: string[] = [];
  const emit = async (e: DryTourEvent) => options.onEvent?.(e);

  const parsed = TourCoreConfigSchema.safeParse(input);
  if (!parsed.success) {
    return { passed: false, ranAt: realNow.toISOString(), checks, failure: "The setup has problems. Run the readiness check to see them.", audit: [] };
  }
  const config = parsed.data;
  const tz = config.property.timezone;
  const unit = config.units.find((u) => u.id === (options.unitId ?? config.units[0]?.id)) ?? config.units[0]!;
  const route = config.routes.find((r) => r.unitId === unit.id)!;
  const doorName = (id: string) => config.doors.find((d) => d.id === id)?.name ?? "a door that isn't on this tour";

  const day = nextTourDay(config, realNow);
  const slot = slotsOn(config, day).find((s) => s.start > realNow)!;
  const clock = new SimulatedClock(new Date(slot.start.getTime() - 3 * 60 * 60_000));
  const now = () => formatTime(clock.now(), tz);
  const at = (text: string) => emit({ kind: "moment", time: now(), text });

  const check = async (c: Omit<DryTourCheck, "ok" | "detail">, ok: boolean, detail?: string) => {
    const entry: DryTourCheck = { ...c, ok, ...(!ok && detail ? { detail } : {}) };
    checks.push(entry);
    await emit({ kind: "check", ...entry });
    if (!ok) throw new StopPractice(detail ?? `${c.label} didn't work as expected.`);
  };

  const pending: DryTourEvent[] = [];
  // Practice tours never text anyone, whatever messaging the property uses; they read like a messaging thread.
  const messenger: Messenger = {
    provider: "practice",
    presentation: "MESSAGING",
    async send(message) {
      messages.push({ time: now(), audience: message.audience, body: message.body });
      pending.push({ kind: "text", audience: message.audience, body: message.body });
      return { provider: "practice", channel: "DEMO", status: "SENT", sentAt: clock.now().toISOString() };
    },
  };
  const flush = async () => {
    for (const e of pending.splice(0)) await emit(e);
  };
  const durin = countDurinCalls(
    createDurin(config, clock, (line) => {
      devLines.push(line.trim());
      pending.push({ kind: "dev", line: line.trim() });
    }),
  );
  const core = new TourCore({ config, clock, messenger, durin, store: createStore(config), verification: createVerificationProvider(config) });

  try {
    await emit({ kind: "stage", title: "The visitor's journey" });
    await at(`${PRACTICE_VISITOR.name} texts: "Hi! Can I tour ${unit.name}?"`);
    const { prospect, reservation: inquiry } = await core.startInquiry({ ...PRACTICE_VISITOR, unitId: unit.id });
    await core.recordInbound(prospect.id, inquiry.id, `Hi! Can I tour ${unit.name}?`);
    await flush();
    await check({ id: "inquiry", group: "journey", label: "Inquiry received" }, inquiry.status === "INQUIRY");

    await at(`Visitor picks ${slot.label} on ${formatLocalDate(day, tz)}`);
    let reservation = await core.reserveSlot(inquiry.id, slot.start.toISOString());
    await flush();
    await check(
      { id: "reserved", group: "journey", label: "Tour reserved", outcome: `${slot.label}, ${formatLocalDate(day, tz)}` },
      reservation.status === "AWAITING_CONSENT",
    );
    const request = (doorId: string) => core.requestAccess({ reservationId: reservation.id, prospectId: prospect.id, doorId });

    await at('Visitor replies "YES"');
    reservation = await core.recordConsent(reservation.id, true);
    await flush();
    await check({ id: "consent", group: "journey", label: "Consent recorded" }, !!reservation.consentId);

    if (reservation.status === "AWAITING_VERIFICATION") {
      await at("Visitor fills out the identity form");
      clock.advanceMinutes(2);
      const [first = "Pat", last = "Practice"] = PRACTICE_VISITOR.name.split(" ");
      reservation = await core.submitVerification(reservation.id, {
        responseId: `practice_form_${realNow.getTime()}`,
        submittedAt: clock.now().toISOString(),
        answers: { governmentFirstName: first, governmentLastName: last, email: "pat.practice@example.com", phone: PRACTICE_VISITOR.phone },
      });
    }
    await flush();
    const identityLabel = config.verificationMode === "mock" ? "Identity check skipped (practice verification)" : "Identity form completed";
    await check({ id: "identity", group: "journey", label: identityLabel }, !!reservation.verificationId);
    await check({ id: "ready", group: "journey", label: "Reservation ready" }, reservation.status === "READY");

    await emit({ kind: "stage", title: "Safety test" });
    const entranceId = route.stops[0]!.doorId;
    clock.set(new Date(Date.parse(reservation.windowStart!) - 20 * 60_000));
    await at(`Visitor shows up early and asks for ${doorName(entranceId)}`);
    let before = durin.requestCount;
    const early = await request(entranceId);
    await flush();
    await check(
      { id: "early_arrival", group: "safety", label: "Visitor arrives too early", outcome: "Access correctly denied" },
      !early.decision.allowed && durin.requestCount === before,
      "The door opened before the tour window.",
    );

    clock.set(new Date(slot.start));
    const noBuildingEntranceOnRoute = !route.stops.some((s) => config.doors.find((d) => d.id === s.doorId)?.kind === "ENTRANCE");
    const firstIsUnitDoor = isApartmentOrCondo(config.property) && noBuildingEntranceOnRoute && entranceId === unit.doorId;
    await at(`Visitor arrives on time and asks for ${doorName(entranceId)}`);
    const entrance = await request(entranceId);
    await flush();
    await check(
      {
        id: firstIsUnitDoor ? "unit_door" : "entrance",
        group: "safety",
        label: firstIsUnitDoor ? `Visitor enters ${unit.name}` : "Visitor arrives on time",
        outcome: firstIsUnitDoor ? "Access approved" : "Entrance access approved",
      },
      entrance.decision.allowed && !!entrance.grant,
      `${doorName(entranceId)} didn't open for a visitor who was on time.`,
    );

    before = durin.requestCount;
    const retry = await request(entranceId);
    await check(
      { id: "duplicate", group: "safety", label: "The same request is sent twice", outcome: "No duplicate access was created" },
      retry.decision.allowed && durin.requestCount === before,
      "A repeated request created a second door grant.",
    );

    for (const [i, stop] of route.stops.slice(1).entries()) {
      clock.advanceMinutes(2);
      const isUnitDoor = stop.doorId === unit.doorId;
      await at(`Visitor asks for ${doorName(stop.doorId)}`);
      const out = await request(stop.doorId);
      await flush();
      await check(
        {
          id: isUnitDoor ? "unit_door" : `route_door_${i + 1}`,
          group: "safety",
          label: isUnitDoor ? `Visitor enters ${unit.name}` : `Visitor reaches ${doorName(stop.doorId)}`,
          outcome: "Access approved",
        },
        out.decision.allowed && !!out.grant,
        `${doorName(stop.doorId)} didn't open even though it's on the route.`,
      );
    }

    const offRoute = config.doors.find((d) => !route.stops.some((s) => s.doorId === d.id))?.id ?? "practice_door_not_on_file";
    clock.advanceMinutes(5);
    await at(`Visitor tries ${doorName(offRoute)}, which isn't on this tour`);
    before = durin.requestCount;
    const wrong = await request(offRoute);
    await flush();
    await check(
      { id: "wrong_door", group: "safety", label: `Visitor tries ${doorName(offRoute)}`, outcome: "Access correctly denied before Durin was contacted" },
      !wrong.decision.allowed && wrong.decision.code === "DENY_WRONG_ROUTE" && durin.requestCount === before,
      "A door outside the route was not blocked correctly.",
    );

    await emit({ kind: "stage", title: "Overstay and extra time" });
    const overstay = new OverstayScheduler(new MemoryRuntimeStore(), { clock });
    const place = visitorSubject(config.property, unit.name);
    const endLabel = async () => formatTime(new Date((await core.getReservation(reservation.id))!.windowEnd!), tz);
    overstay.ensure((await core.getReservation(reservation.id))!, config.property.id);

    clock.set(new Date(Date.parse(reservation.windowEnd!) - 15 * 60_000));
    await at("15 minutes left");
    await overstay.tickCore(core, { propertyId: config.property.id });
    await flush();
    const t15 = messages.some((m) => m.audience === "PROSPECT" && m.body === t15Questions(place, "Pat"));
    await check({ id: "t15_questions", group: "wrapup", label: "T-15 any-questions text", outcome: "Sent after the tour started" }, t15);

    clock.set(new Date(Date.parse(reservation.windowEnd!) - 5 * 60_000));
    await at("5 minutes left");
    await overstay.tickCore(core, { propertyId: config.property.id });
    await flush();
    const offered = messages.some((m) => m.audience === "PROSPECT" && m.body === t5Offering(place, await endLabel(), "Pat"));
    await check({ id: "t5_warning", group: "wrapup", label: "T-5 extra-time offer", outcome: "Offered 10 more minutes" }, offered);

    await at('Visitor asks for 10 more minutes');
    const granted = await overstay.handleAsk(core, reservation.id, "natural");
    reservation = (await core.getReservation(reservation.id))!;
    await flush();
    await check(
      { id: "extension_granted", group: "wrapup", label: "One-time extension", outcome: "Tour end moved 10 minutes" },
      granted === extensionGranted(await endLabel()) && !!reservation.extensionGrantedAt,
      "The extra 10 minutes were not granted.",
    );

    await emit({ kind: "stage", title: "Finishing up" });
    clock.set(new Date(Date.parse(reservation.windowEnd!) - 8 * 60_000));
    await at("Visitor finishes the tour");
    const activeBefore = (await core.listGrants(reservation.id)).filter((g) => g.status === "ACTIVE").length;
    reservation = await core.completeTour(reservation.id);
    await flush();
    const stillActive = (await core.listGrants(reservation.id)).filter((g) => g.status === "ACTIVE").length;
    await check({ id: "completed", group: "wrapup", label: "Tour completed" }, reservation.status === "COMPLETED");
    await check(
      { id: "revoked", group: "wrapup", label: "Access revoked", outcome: "Every door is locked again" },
      activeBefore > 0 && stillActive === 0,
      "Some doors were still open after the tour.",
    );
    const audit = await core.auditTrail();
    await check({ id: "follow_up", group: "wrapup", label: "Follow-up sent" }, audit.some((e) => e.type === "FOLLOW_UP_SENT"));

    const later = slotsOn(config, day).find((s) => s.start.getTime() > slot.start.getTime());
    if (later) {
      await emit({ kind: "stage", title: "Overstay without extra time" });
      const other = { name: "Sam Practice", phone: "+1 555 019 8888" };
      const second = await core.startInquiry({ ...other, unitId: unit.id });
      let otherRes = await core.reserveSlot(second.reservation.id, later.start.toISOString());
      otherRes = await core.recordConsent(otherRes.id, true);
      if (otherRes.status === "AWAITING_VERIFICATION") {
        otherRes = await core.submitVerification(otherRes.id, {
          responseId: `practice_overstay_${realNow.getTime()}`,
          submittedAt: clock.now().toISOString(),
          answers: { governmentFirstName: "Sam", governmentLastName: "Practice", email: "sam.practice@example.com", phone: other.phone },
        });
      }
      clock.set(later.start);
      await core.requestAccess({ reservationId: otherRes.id, prospectId: second.prospect.id, doorId: entranceId });
      await flush();
      const otherOverstay = new OverstayScheduler(new MemoryRuntimeStore(), { clock });
      otherOverstay.ensure((await core.getReservation(otherRes.id))!, config.property.id);
      const otherT = new Date((await core.getReservation(otherRes.id))!.windowEnd!);
      const otherPlace = visitorSubject(config.property, unit.name);

      clock.set(otherT);
      await at("Tour end, no extra time");
      await otherOverstay.tickCore(core, { propertyId: config.property.id });
      await flush();
      await check(
        { id: "overstay_end", group: "wrapup", label: "Tour-end text without extension" },
        messages.some((m) => m.audience === "PROSPECT" && m.body === tourEnded(otherPlace, "Sam")),
      );

      clock.set(new Date(otherT.getTime() + 5 * 60_000));
      await at("5 minutes after the tour");
      await otherOverstay.tickCore(core, { propertyId: config.property.id });
      await flush();
      await check(
        { id: "overstay_plus5", group: "wrapup", label: "T+5 leave check-in" },
        messages.some((m) => m.audience === "PROSPECT" && m.body === plus5CheckIn(otherPlace)) &&
          messages.some((m) => m.audience === "OPERATOR" && m.body.includes("hasn't confirmed leaving")),
      );

      clock.set(new Date(otherT.getTime() + 15 * 60_000));
      await at("15 minutes after the tour");
      await otherOverstay.tickCore(core, { propertyId: config.property.id });
      await flush();
      const closed = await core.getReservation(otherRes.id);
      await check(
        { id: "overstay_closed", group: "wrapup", label: "T+15 close", outcome: "Tour closed and the team was alerted" },
        messages.some((m) => m.audience === "PROSPECT" && m.body === plus15Closed(otherPlace)) &&
          closed?.status === "EXPIRED" &&
          (await core.auditTrail()).some((e) => e.type === "TOUR_OVERSTAY_CLOSED" && e.reservationId === otherRes.id),
      );
    }

    const bundle = await core.exportRecords();
    const finalAudit = await core.auditTrail();
    await check({ id: "records", group: "wrapup", label: "Tour records saved" }, bundle.auditEvents.length === finalAudit.length);
    return { passed: true, ranAt: realNow.toISOString(), unitId: unit.id, checks, audit: finalAudit, messages, devLines, bundle };
  } catch (err) {
    await flush();
    const failure = err instanceof StopPractice ? err.message : "Something unexpected stopped the practice tour.";
    if (!(err instanceof StopPractice)) {
      const line = String(err instanceof Error ? err.stack : err);
      devLines.push(line);
      await emit({ kind: "dev", line });
    }
    return { passed: false, ranAt: realNow.toISOString(), unitId: unit.id, checks, failure, audit: await core.auditTrail(), messages, devLines };
  }
}