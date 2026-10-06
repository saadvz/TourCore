import { describe, expect, it } from "vitest";
import { loadConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { SimulatedClock } from "../src/core/clock";
import { extensionAvailability, occupantFromReservation } from "../src/core/extensionAvailability";
import {
  DOOR_AFTER_T,
  EXTENSION_AFTER_T,
  LATE_ARRIVAL_EXPIRED,
  extensionAlreadyUsed,
  extensionGranted,
  extensionUnavailable,
  landlordExtensionGranted,
  landlordPlus15,
  landlordPlus5,
  landlordRepliedAfterClose,
  plus15Closed,
  plus5CheckIn,
  T15_BARE_YES,
  T15_NO_OR_ALL_GOOD,
  T5_NO_OFFER_BARE_YES,
  t15Questions,
  t5NoOffer,
  t5Offering,
  tourEnded,
  tourFinishedFollowUp,
  visitorRepliedAfterClose,
} from "../src/core/overstayCopy";
import { TourCoreError, TOUR_ENDED_REPLY, VisitorDenialCopy } from "../src/core/TourCore";
import { runDryTour } from "../src/setup/dryTour";
import { formatTime, zonedTimeToUtc } from "../src/core/timezone";
import { newId, UNNAMED_VISITOR, type Reservation, type TourTimeRequest } from "../src/domain/model";
import { DemoMessagingAdapter, type DeliveryReceipt, type MessagingAdapter, type OutgoingMessage } from "../src/messaging/Messenger";
import { createTourCore } from "../src/createTourCore";
import { MockDurinAccessAdapter } from "../src/durin/MockDurinAccessAdapter";
import { InMemoryStore } from "../src/storage/Store";
import { occupiedWindowsFromRecords } from "../src/visitor/messagingRouter";
import type { OccupiedWindow } from "../src/core/customSlot";
import { VISITOR_SEND_ATTEMPTS } from "../src/visitor/overstayScheduler";
import { MemoryRuntimeStore } from "../src/storage/runtimeStore";
import { handleVisitorText } from "../src/visitor/conversation";
import { visitorSubject } from "../src/visitor/identity";
import { OverstayScheduler } from "../src/visitor/overstayScheduler";
import { VisitorDemoSession } from "../src/visitor/session";
import { basicForm, bookTour, minutesFrom, setup, TOUR_DAY } from "./helpers";

const TZ = "America/New_York";
const PLACE = "Unit 101";

function outbound(ctx: ReturnType<typeof setup>, reservationId?: string) {
  return ctx.store.list("messages").then((rows) =>
    rows
      .filter((m) => m.audience === "PROSPECT" && m.direction === "OUTBOUND" && m.deliveryStatus !== "SUPPRESSED")
      .filter((m) => !reservationId || m.reservationId === reservationId)
      .map((m) => m.body),
  );
}

function operatorAlerts(ctx: ReturnType<typeof setup>, reservationId?: string) {
  return ctx.store.list("messages").then((rows) =>
    rows.filter((m) => m.audience === "OPERATOR" && (!reservationId || m.reservationId === reservationId)).map((m) => m.body),
  );
}

async function startTour(ctx: ReturnType<typeof setup>) {
  const tour = await bookTour(ctx);
  ctx.clock.set(tour.slotStart);
  await tour.request("entrance");
  const reservation = (await ctx.core.getReservation(tour.reservation.id))!;
  const runtime = new MemoryRuntimeStore();
  const overstay = new OverstayScheduler(runtime, { clock: ctx.clock });
  overstay.ensure(reservation, ctx.config.property.id);
  return { tour, reservation, overstay, runtime, endLabel: async () => formatTime(new Date((await ctx.core.getReservation(reservation.id))!.windowEnd!), TZ) };
}

function busyReservation(ctx: { config: TourCoreConfig; clock: { now: () => Date } }, input: { start: Date; unitId?: string; doors?: string[]; oneOff?: boolean; pending?: boolean }): Reservation {
  const start = input.start;
  const early = ctx.config.tourHours.earlyArrivalMinutes * 60_000;
  const length = ctx.config.tourHours.tourLengthMinutes * 60_000;
  const now = ctx.clock.now().toISOString();
  const reservation: Reservation = {
    id: newId("rsv"),
    prospectId: newId("prs"),
    propertyId: ctx.config.property.id,
    unitId: input.unitId ?? "apt_101",
    routeId: input.unitId === "apt_102" ? "route_apt_102" : "route_apt_101",
    allowedRoute: input.doors ?? (input.unitId === "apt_102" ? ["entrance", "unit_102"] : ["entrance", "unit_101"]),
    status: "READY",
    slotStart: start.toISOString(),
    windowStart: new Date(start.getTime() - early).toISOString(),
    windowEnd: new Date(start.getTime() + length).toISOString(),
    createdAt: now,
    updatedAt: now,
    ...(input.oneOff ? { scheduleOverride: { kind: "OUTSIDE_HOURS" as const, approvedAt: now } } : {}),
  };
  return reservation;
}

describe("extension policy", () => {
  it("a T-15 bare yes never grants time; only an explicit more-time ask does", async () => {
    const ctx = setup();
    const started = await startTour(ctx);
    ctx.clock.set(minutesFrom(new Date(started.reservation.windowEnd!), -15));
    await started.overstay.tickCore(ctx.core, { propertyId: ctx.config.property.id });
    expect(await started.overstay.replyToVisitor(ctx.core, started.reservation.id, "yes")).toBe(T15_BARE_YES);
    expect((await ctx.core.getReservation(started.reservation.id))!.extensionGrantedAt).toBeUndefined();
  });
});

describe("overstay timeline", () => {
  it("sends T-15 after the tour has started, and skips when the tour is short or they arrived late", async () => {
    const onTime = setup();
    const started = await startTour(onTime);
    onTime.clock.set(minutesFrom(new Date(started.reservation.windowEnd!), -15));
    await started.overstay.tickCore(onTime.core, { propertyId: onTime.config.property.id });
    expect(await outbound(onTime, started.reservation.id)).toContain(t15Questions(PLACE, "Jane"));

    const short = setup();
    const shortCfg: TourCoreConfig = { ...short.config, tourHours: { ...short.config.tourHours, tourLengthMinutes: 15, slotEveryMinutes: 60, earlyArrivalMinutes: 0 } };
    short.core.useConfig(shortCfg);
    Object.assign(short, { config: shortCfg });
    const shortTour = await bookTour(short);
    short.clock.set(shortTour.slotStart);
    await shortTour.request("entrance");
    const shortRes = (await short.core.getReservation(shortTour.reservation.id))!;
    const shortSched = new OverstayScheduler(new MemoryRuntimeStore(), { clock: short.clock });
    shortSched.ensure(shortRes, shortCfg.property.id);
    short.clock.set(minutesFrom(new Date(shortRes.windowEnd!), -15));
    await shortSched.tickCore(short.core, { propertyId: shortCfg.property.id });
    expect(await outbound(short, shortRes.id)).not.toContainEqual(expect.stringContaining("15 minutes left"));

    const late = setup();
    const lateTour = await bookTour(late);
    late.clock.set(minutesFrom(new Date(lateTour.reservation.windowEnd!), -10));
    await lateTour.request("entrance");
    const lateRes = (await late.core.getReservation(lateTour.reservation.id))!;
    const lateSched = new OverstayScheduler(new MemoryRuntimeStore(), { clock: late.clock });
    lateSched.ensure(lateRes, late.config.property.id);
    late.clock.set(minutesFrom(new Date(lateRes.windowEnd!), -15));
    await lateSched.tickCore(late.core, { propertyId: late.config.property.id });
    expect((await outbound(late, lateRes.id)).some((b) => b.includes("15 minutes left"))).toBe(false);
  });

  it("never resends T-15 after an extension", async () => {
    const ctx = setup();
    const started = await startTour(ctx);
    ctx.clock.set(minutesFrom(new Date(started.reservation.windowEnd!), -5));
    await started.overstay.tickCore(ctx.core, { propertyId: ctx.config.property.id });
    await started.overstay.handleAsk(ctx.core, started.reservation.id, "natural");
    ctx.clock.set(minutesFrom(new Date((await ctx.core.getReservation(started.reservation.id))!.windowEnd!), -15));
    const before = await outbound(ctx, started.reservation.id);
    await started.overstay.tickCore(ctx.core, { propertyId: ctx.config.property.id });
    const after = await outbound(ctx, started.reservation.id);
    expect(after.filter((b) => b.includes("15 minutes left"))).toEqual(before.filter((b) => b.includes("15 minutes left")));
  });

  it("T-15 replies: a real question, a bare yes, and no / all good. None grant time", async () => {
    const yes = setup();
    const y = await startTour(yes);
    yes.clock.set(minutesFrom(new Date(y.reservation.windowEnd!), -15));
    await y.overstay.tickCore(yes.core, { propertyId: yes.config.property.id });
    expect(await y.overstay.replyToVisitor(yes.core, y.reservation.id, "yes")).toBe(T15_BARE_YES);
    expect((await yes.core.getReservation(y.reservation.id))!.extensionGrantedAt).toBeUndefined();

    const no = setup();
    const n = await startTour(no);
    no.clock.set(minutesFrom(new Date(n.reservation.windowEnd!), -15));
    await n.overstay.tickCore(no.core, { propertyId: no.config.property.id });
    expect(await n.overstay.replyToVisitor(no.core, n.reservation.id, "all good")).toBe(T15_NO_OR_ALL_GOOD);
    expect(await n.overstay.replyToVisitor(no.core, n.reservation.id, "is there a gym?")).toBeUndefined();
    expect((await no.core.getReservation(n.reservation.id))!.extensionGrantedAt).toBeUndefined();

    const ask = setup();
    const a = await startTour(ask);
    ask.clock.set(minutesFrom(new Date(a.reservation.windowEnd!), -15));
    await a.overstay.tickCore(ask.core, { propertyId: ask.config.property.id });
    expect(await a.overstay.replyToVisitor(ask.core, a.reservation.id, "can I have more time?")).toBe(extensionGranted(await a.endLabel()));
    expect((await ask.core.getReservation(a.reservation.id))!.extensionGrantedAt).toBeDefined();
  });

  it("T-5 offers extra time when the slot is free, and the no-offer copy when it is not", async () => {
    const free = setup();
    const started = await startTour(free);
    const end = await started.endLabel();
    free.clock.set(minutesFrom(new Date(started.reservation.windowEnd!), -5));
    await started.overstay.tickCore(free.core, { propertyId: free.config.property.id });
    expect(await outbound(free, started.reservation.id)).toContain(t5Offering(PLACE, end, "Jane"));

    const blocked = setup();
    const b = await startTour(blocked);
    await blocked.store.put("reservations", busyReservation(blocked, { start: new Date(b.reservation.windowEnd!) }));
    blocked.clock.set(minutesFrom(new Date(b.reservation.windowEnd!), -5));
    await b.overstay.tickCore(blocked.core, { propertyId: blocked.config.property.id });
    expect(await outbound(blocked, b.reservation.id)).toContain(t5NoOffer(PLACE, await b.endLabel(), "Jane"));
  });

  it("availability blockers: booked, one-off, pending, early-arrival, route-door, tour-hours, and the one-off exemption", async () => {
    const ctx = setup();
    const started = await startTour(ctx);
    const reservation = (await ctx.core.getReservation(started.reservation.id))!;
    const T = new Date(reservation.windowEnd!);

    const booked = busyReservation(ctx, { start: T });
    expect(extensionAvailability({ config: ctx.config, reservation, occupants: [occupantFromReservation(ctx.config, booked)!] }).blocker).toBe("booked");

    const oneOff = busyReservation(ctx, { start: T, oneOff: true });
    expect(extensionAvailability({ config: ctx.config, reservation, occupants: [occupantFromReservation(ctx.config, oneOff)!] }).blocker).toBe("one-off");

    const pendingStart = T;
    expect(
      extensionAvailability({
        config: ctx.config,
        reservation,
        occupants: [
          {
            start: pendingStart,
            windowStart: minutesFrom(pendingStart, -ctx.config.tourHours.earlyArrivalMinutes),
            windowEnd: minutesFrom(pendingStart, ctx.config.tourHours.tourLengthMinutes),
            unitId: "apt_101",
            doors: ["entrance", "unit_101"],
            kind: "pending",
          },
        ],
      }).blocker,
    ).toBe("pending");

    const nextStart = minutesFrom(T, 15);
    expect(
      extensionAvailability({
        config: ctx.config,
        reservation,
        occupants: [
          {
            start: nextStart,
            windowStart: minutesFrom(nextStart, -10),
            windowEnd: minutesFrom(nextStart, 45),
            unitId: "apt_101",
            doors: ["entrance", "unit_101"],
            kind: "booked",
          },
        ],
      }).blocker,
    ).toBe("early-arrival");

    const otherUnit = busyReservation(ctx, { start: T, unitId: "apt_102", doors: ["entrance", "unit_102"] });
    expect(extensionAvailability({ config: ctx.config, reservation, occupants: [occupantFromReservation(ctx.config, otherUnit)!] }).blocker).toBe("route-door");

    const tightHours: TourCoreConfig = { ...ctx.config, tourHours: { ...ctx.config.tourHours, end: "14:50" } };
    expect(extensionAvailability({ config: tightHours, reservation, occupants: [] }).blocker).toBe("tour-hours");

    const oneOffSelf = { ...reservation, scheduleOverride: { kind: "OUTSIDE_HOURS" as const, approvedAt: reservation.createdAt } };
    expect(extensionAvailability({ config: tightHours, reservation: oneOffSelf, occupants: [] }).available).toBe(true);
  });

  it("an explicit ask before T-5 grants when the slot is free and counts as the one extension", async () => {
    const ctx = setup();
    const started = await startTour(ctx);
    ctx.clock.set(minutesFrom(new Date(started.reservation.windowEnd!), -12));
    const granted = await started.overstay.handleAsk(ctx.core, started.reservation.id, "natural");
    expect(granted).toBe(extensionGranted(await started.endLabel()));
    expect((await ctx.core.getReservation(started.reservation.id))!.extensionGrantedAt).toBeDefined();
    expect(await started.overstay.handleAsk(ctx.core, started.reservation.id, "natural")).toBe(extensionAlreadyUsed(await started.endLabel()));
  });

  it("after an early extension, T-5 against the new end uses the no-offer wording", async () => {
    const ctx = setup();
    const started = await startTour(ctx);
    const originalEnd = new Date(started.reservation.windowEnd!);
    ctx.clock.set(minutesFrom(originalEnd, -12));
    expect(await started.overstay.handleAsk(ctx.core, started.reservation.id, "natural")).toBe(extensionGranted(await started.endLabel()));
    const newEnd = new Date((await ctx.core.getReservation(started.reservation.id))!.windowEnd!);
    expect(newEnd.getTime() - originalEnd.getTime()).toBe(10 * 60_000);
    ctx.clock.set(minutesFrom(newEnd, -5));
    await started.overstay.tickCore(ctx.core, { propertyId: ctx.config.property.id });
    const texts = await outbound(ctx, started.reservation.id);
    expect(texts).toContain(t5NoOffer(PLACE, await started.endLabel(), "Jane"));
    expect(texts.some((b) => b.includes("Want 10 more minutes?"))).toBe(false);
    expect(texts.filter((b) => b.includes("15 minutes left"))).toHaveLength(0);
    expect(await started.overstay.replyToVisitor(ctx.core, started.reservation.id, "yes")).toBe(T5_NO_OFFER_BARE_YES);
    expect((await ctx.core.auditTrail()).filter((e) => e.type === "TOUR_EXTENDED" && e.reservationId === started.reservation.id)).toHaveLength(1);
  });

  it("after an offering T-5, a natural ask or a bare yes grants when the slot is still free", async () => {
    const ctx = setup();
    const started = await startTour(ctx);
    ctx.clock.set(minutesFrom(new Date(started.reservation.windowEnd!), -5));
    await started.overstay.tickCore(ctx.core, { propertyId: ctx.config.property.id });
    const before = Date.parse(started.reservation.windowEnd!);
    const granted = await started.overstay.handleAsk(ctx.core, started.reservation.id, "natural");
    const updated = (await ctx.core.getReservation(started.reservation.id))!;
    expect(granted).toBe(extensionGranted(await started.endLabel()));
    expect(Date.parse(updated.windowEnd!) - before).toBe(10 * 60_000);
    expect(ctx.durin.calls.requestAccess.some((c) => c.idempotencyKey.includes(":ext:"))).toBe(true);
    const alerts = await operatorAlerts(ctx, started.reservation.id);
    const newEnd = await started.endLabel();
    expect(alerts.filter((a) => a === landlordExtensionGranted("Jane", PLACE, newEnd))).toHaveLength(1);
  });

  it("rechecks availability at ask time, one extension max, and ask after T", async () => {
    const taken = setup();
    const a = await startTour(taken);
    taken.clock.set(minutesFrom(new Date(a.reservation.windowEnd!), -5));
    await a.overstay.tickCore(taken.core, { propertyId: taken.config.property.id });
    await taken.store.put("reservations", busyReservation(taken, { start: new Date(a.reservation.windowEnd!) }));
    expect(await a.overstay.handleAsk(taken.core, a.reservation.id, "bare-yes")).toBe(extensionUnavailable(await a.endLabel()));

    const once = setup();
    const b = await startTour(once);
    once.clock.set(minutesFrom(new Date(b.reservation.windowEnd!), -5));
    await b.overstay.tickCore(once.core, { propertyId: once.config.property.id });
    await b.overstay.handleAsk(once.core, b.reservation.id, "bare-yes");
    expect(await b.overstay.handleAsk(once.core, b.reservation.id, "natural")).toBe(extensionAlreadyUsed(await b.endLabel()));

    const late = setup();
    const c = await startTour(late);
    late.clock.set(new Date(c.reservation.windowEnd!));
    expect(await c.overstay.handleAsk(late.core, c.reservation.id, "natural")).toBe(EXTENSION_AFTER_T);
  });

  it("an early ask uses granted / no-time / already-used, and a later T-5 yes never adds a second extension", async () => {
    const granted = setup();
    const g = await startTour(granted);
    granted.clock.set(minutesFrom(new Date(g.reservation.windowEnd!), -12));
    expect(await g.overstay.handleAsk(granted.core, g.reservation.id, "natural")).toBe(extensionGranted(await g.endLabel()));
    granted.clock.set(minutesFrom(new Date((await granted.core.getReservation(g.reservation.id))!.windowEnd!), -5));
    await g.overstay.tickCore(granted.core, { propertyId: granted.config.property.id });
    expect(await g.overstay.handleAsk(granted.core, g.reservation.id, "bare-yes")).toBe(extensionAlreadyUsed(await g.endLabel()));
    expect((await granted.core.auditTrail()).filter((e) => e.type === "TOUR_EXTENDED" && e.reservationId === g.reservation.id)).toHaveLength(1);

    const taken = setup();
    const t = await startTour(taken);
    await taken.store.put("reservations", busyReservation(taken, { start: new Date(t.reservation.windowEnd!) }));
    taken.clock.set(minutesFrom(new Date(t.reservation.windowEnd!), -12));
    expect(await t.overstay.handleAsk(taken.core, t.reservation.id, "natural")).toBe(extensionUnavailable(await t.endLabel()));
    expect((await taken.core.getReservation(t.reservation.id))!.extensionGrantedAt).toBeUndefined();
    taken.clock.set(minutesFrom(new Date(t.reservation.windowEnd!), -5));
    await t.overstay.tickCore(taken.core, { propertyId: taken.config.property.id });
    expect(await t.overstay.handleAsk(taken.core, t.reservation.id, "natural")).toBe(extensionUnavailable(await t.endLabel()));
    expect((await taken.core.auditTrail()).filter((e) => e.type === "TOUR_EXTENDED" && e.reservationId === t.reservation.id)).toHaveLength(0);
  });

  it("a bare yes after a no-offer T-5 is the ack, not the can't-add-time line", async () => {
    const ctx = setup();
    const started = await startTour(ctx);
    await ctx.store.put("reservations", busyReservation(ctx, { start: new Date(started.reservation.windowEnd!) }));
    ctx.clock.set(minutesFrom(new Date(started.reservation.windowEnd!), -5));
    await started.overstay.tickCore(ctx.core, { propertyId: ctx.config.property.id });
    expect(await started.overstay.replyToVisitor(ctx.core, started.reservation.id, "ok")).toBe(T5_NO_OFFER_BARE_YES);
    expect(await started.overstay.replyToVisitor(ctx.core, started.reservation.id, "ok")).not.toBe(extensionUnavailable(await started.endLabel()));
  });

  it("doors never open after T, and a door request gets the door-after-T line", async () => {
    const ctx = setup();
    const started = await startTour(ctx);
    ctx.clock.set(new Date(started.reservation.windowEnd!));
    const denied = await started.tour.request("unit_101");
    expect(denied.decision.code).toBe("DENY_EXPIRED");
    expect(denied.durinCalled).toBe(false);
    expect(await outbound(ctx, started.reservation.id)).toContain(DOOR_AFTER_T);
  });

  it("sends T, +5, and +15 texts, with and without a help number, exactly one alert each, and one overstay exception", async () => {
    const withHelp = setup({ visitorContact: "+15550109999" });
    const a = await startTour(withHelp);
    const T = new Date(a.reservation.windowEnd!);
    withHelp.clock.set(T);
    await a.overstay.tickCore(withHelp.core, { propertyId: withHelp.config.property.id });
    expect(await outbound(withHelp, a.reservation.id)).toContain(tourEnded(PLACE, "Jane"));

    withHelp.clock.set(minutesFrom(T, 5));
    await a.overstay.tickCore(withHelp.core, { propertyId: withHelp.config.property.id });
    expect(await outbound(withHelp, a.reservation.id)).toContain(plus5CheckIn(PLACE));
    expect((await operatorAlerts(withHelp, a.reservation.id)).filter((b) => b === landlordPlus5("Jane", PLACE))).toHaveLength(1);

    withHelp.clock.set(minutesFrom(T, 15));
    await a.overstay.tickCore(withHelp.core, { propertyId: withHelp.config.property.id });
    expect(await outbound(withHelp, a.reservation.id)).toContain(plus15Closed(PLACE, "+15550109999"));
    expect((await withHelp.core.getReservation(a.reservation.id))!.status).toBe("EXPIRED");
    expect((await withHelp.core.auditTrail()).filter((e) => e.type === "TOUR_OVERSTAY_CLOSED" && e.reservationId === a.reservation.id)).toHaveLength(1);
    expect((await operatorAlerts(withHelp, a.reservation.id)).filter((b) => b === landlordPlus15("Jane", PLACE))).toHaveLength(1);

    const noHelp = setup();
    const b = await startTour(noHelp);
    const T2 = new Date(b.reservation.windowEnd!);
    noHelp.clock.set(minutesFrom(T2, 15));
    await b.overstay.tickCore(noHelp.core, { propertyId: noHelp.config.property.id });
    expect(await outbound(noHelp, b.reservation.id)).toContain(plus15Closed(PLACE));
    expect(await outbound(noHelp, b.reservation.id)).not.toContain(tourEnded(PLACE, "Jane"));
    expect(await outbound(noHelp, b.reservation.id)).not.toContain(plus5CheckIn(PLACE));
  });

  it("DONE / I'm out cancels later steps, and STOP blocks visitor texts but not alerts", async () => {
    const done = setup();
    const a = await startTour(done);
    await done.core.completeTour(a.reservation.id);
    await a.overstay.tickCore(done.core, { propertyId: done.config.property.id });
    done.clock.set(minutesFrom(new Date(a.reservation.windowEnd!), 15));
    await a.overstay.tickCore(done.core, { propertyId: done.config.property.id });
    const doneTexts = await outbound(done, a.reservation.id);
    expect(doneTexts.some((b) => b.includes("just ended"))).toBe(false);
    expect(doneTexts.some((b) => b.includes("now closed"))).toBe(false);

    const stop = setup();
    const b = await startTour(stop);
    await stop.core.optOutOfMessaging("(555) 010-1234", "STOP");
    expect((await stop.core.getReservation(b.reservation.id))!.status).toBe("TOURING");
    const T = new Date(b.reservation.windowEnd!);
    stop.clock.set(T);
    await b.overstay.tickCore(stop.core, { propertyId: stop.config.property.id });
    stop.clock.set(minutesFrom(T, 5));
    await b.overstay.tickCore(stop.core, { propertyId: stop.config.property.id });
    stop.clock.set(minutesFrom(T, 15));
    await b.overstay.tickCore(stop.core, { propertyId: stop.config.property.id });
    expect(await outbound(stop, b.reservation.id)).not.toContain(tourEnded(PLACE, "Jane"));
    expect(await outbound(stop, b.reservation.id)).not.toContain(plus5CheckIn(PLACE));
    expect(await outbound(stop, b.reservation.id)).not.toContain(plus15Closed(PLACE));
    expect((await operatorAlerts(stop, b.reservation.id)).filter((x) => x === landlordPlus5("Jane", PLACE))).toHaveLength(1);
    expect((await operatorAlerts(stop, b.reservation.id)).filter((x) => x === landlordPlus15("Jane", PLACE))).toHaveLength(1);
    expect((await stop.core.auditTrail()).some((e) => e.type === "TOUR_OVERSTAY_CLOSED")).toBe(true);
  });

  it("a restart mid-timeline neither resends nor skips, and concurrent ticks are idempotent", async () => {
    const ctx = setup();
    const started = await startTour(ctx);
    const T = new Date(started.reservation.windowEnd!);
    ctx.clock.set(minutesFrom(T, -15));
    await started.overstay.tickCore(ctx.core, { propertyId: ctx.config.property.id });
    const afterT15 = await outbound(ctx, started.reservation.id);

    const resumed = new OverstayScheduler(started.runtime, { clock: ctx.clock });
    await Promise.all([resumed.tickCore(ctx.core, { propertyId: ctx.config.property.id }), resumed.tickCore(ctx.core, { propertyId: ctx.config.property.id })]);
    expect(await outbound(ctx, started.reservation.id)).toEqual(afterT15);

    ctx.clock.set(minutesFrom(T, 6));
    await resumed.tickCore(ctx.core, { propertyId: ctx.config.property.id });
    const texts = await outbound(ctx, started.reservation.id);
    expect(texts.filter((b) => b.includes("just ended"))).toHaveLength(0);
    expect(texts.filter((b) => b === plus5CheckIn(PLACE))).toHaveLength(1);
    expect(texts.filter((b) => b.includes("15 minutes left"))).toHaveLength(1);
  });

  it("unnamed visitors drop the name fragment, and copy never says Main Home", async () => {
    const ctx = setup();
    const started = await startTour(ctx);
    await ctx.store.put("prospects", { ...(await ctx.store.get("prospects", started.tour.prospect.id))!, name: UNNAMED_VISITOR });
    ctx.clock.set(new Date(started.reservation.windowEnd!));
    await started.overstay.tickCore(ctx.core, { propertyId: ctx.config.property.id });
    const texts = await outbound(ctx, started.reservation.id);
    expect(texts).toContain(tourEnded(PLACE));
    expect(texts.join("\n")).not.toMatch(/, Visitor/);
    expect(texts.join("\n")).not.toContain("Main Home");
    expect(visitorSubject({ ...ctx.config.property, propertyType: "SINGLE_FAMILY", canonicalAddress: { street: "1 QA Scratch Lane" }, address: "1 QA Scratch Lane, Tenafly, NJ" }, "Main Home")).not.toContain("Main Home");
  });
});

describe("overstay conversation", () => {
  it("DONE and I'm out end the tour, and a T-15 question uses normal question handling", async () => {
    const now = { t: zonedTimeToUtc({ ...TOUR_DAY, hour: 13, minute: 58 }, TZ).getTime() };
    const transport = new DemoMessagingAdapter(() => {}, "MESSAGING");
    const session = new VisitorDemoSession("prop_100_alfred_way", loadConfig(), "t", { realNow: () => now.t, transport, kind: "messaging" });
    const runtime = new MemoryRuntimeStore();
    session.overstay = new OverstayScheduler(runtime, { now: () => new Date(now.t) });
    let n = 0;
    const say = (text: string) => handleVisitorText(session, "+15550102000", text, { provider: "test", providerMessageId: `m_${++n}` });
    await say("TOUR");
    await say("YES");
    await say("1");
    await say("1");
    await say("1");
    await say("yes");
    await session.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "+15550102000" });
    const r = (await session.reservation())!;
    now.t = Date.parse(r.slotStart!);
    session.clock.jumpTo(new Date(now.t));
    await say("I'm here");
    session.overstay.ensure((await session.reservation())!, session.propertyId, session.tourId);
    now.t = Date.parse(r.windowEnd!) - 15 * 60_000;
    session.clock.jumpTo(new Date(now.t));
    await session.overstay.tickSession(session);
    await say("is there a gym?");
    expect(session.conversation.filter((c) => c.from === "tourcore").map((c) => c.text).at(-1)).toContain("I'll let the property team know about your question.");
    await say("I'm out");
    expect((await session.reservation())!.status).toBe("COMPLETED");
  });

  it("rebook after no-time stays secondary: door and DONE still hit the running tour", async () => {
    const now = { t: zonedTimeToUtc({ ...TOUR_DAY, hour: 13, minute: 58 }, TZ).getTime() };
    const transport = new DemoMessagingAdapter(() => {}, "MESSAGING");
    const session = new VisitorDemoSession("prop_100_alfred_way", loadConfig(), "t-rebook", { realNow: () => now.t, transport, kind: "messaging" });
    const runtime = new MemoryRuntimeStore();
    session.overstay = new OverstayScheduler(runtime, { now: () => new Date(now.t) });
    let n = 0;
    const say = (text: string) => handleVisitorText(session, "+15550102000", text, { provider: "test", providerMessageId: `rb_${++n}` });
    await say("TOUR");
    await say("YES");
    await say("1");
    await say("1");
    await say("1");
    await say("yes");
    await session.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "+15550102000" });
    const r = (await session.reservation())!;
    now.t = Date.parse(r.slotStart!);
    session.clock.jumpTo(new Date(now.t));
    await say("I'm here");
    session.overstay.ensure((await session.reservation())!, session.propertyId, session.tourId);
    const end = new Date(r.windowEnd!);
    await session.store.put("reservations", busyReservation({ config: session.config, clock: session.clock }, { start: end }));
    now.t = end.getTime() - 12 * 60_000;
    session.clock.jumpTo(new Date(now.t));
    await say("can I have more time?");
    expect(session.conversation.filter((c) => c.from === "tourcore").map((c) => c.text)).toContain(extensionUnavailable(formatTime(end, TZ)));
    expect((await session.reservation())!.status).toBe("TOURING");
    await say("sure, another time");
    const reply = session.conversation.filter((c) => c.from === "tourcore").map((c) => c.text).at(-1) ?? "";
    expect(reply).toContain("I have tours available. Which day works for you?");
    expect(reply).not.toContain("didn't catch that");
    expect((await session.reservation())!.status).toBe("TOURING");
    expect((await session.reservation())!.id).toBe(r.id);
    expect(session.overstay.get(r.id)?.pendingRebook).toBeFalsy();
    expect(session.pendingRebook).toBe(true);

    await say("open the unit door");
    const afterDoor = (await session.reservation())!;
    expect(afterDoor.id).toBe(r.id);
    expect(afterDoor.status).toBe("TOURING");
    expect(session.lastAccess?.doorId).toBe("unit_101");
    expect(session.lastAccess?.allowed).toBe(true);

    await say("DONE");
    expect((await session.reservation())!.status).toBe("COMPLETED");
    expect(session.overstay.get(r.id)?.cancelled).toBe(true);
    now.t = end.getTime() + 10 * 60_000;
    session.clock.jumpTo(new Date(now.t));
    await session.overstay.tickSession(session);
    const afterDone = await session.store.list("messages");
    expect(afterDone.some((m) => m.body === plus5CheckIn(PLACE))).toBe(false);

    await say("1");
    const afterDay = session.conversation.filter((c) => c.from === "tourcore").map((c) => c.text).at(-1) ?? "";
    expect(afterDay.toLowerCase()).toMatch(/which time|no tours|already passed|next opening/);
  });
});

describe("QA review blocking items", () => {
  it("an extended tour holds the next slot so 2:45 cannot be booked after Jane is extended to 2:55", async () => {
    const ctx = setup();
    const hours = { ...ctx.config.tourHours, start: "14:00", end: "17:00", tourLengthMinutes: 45, slotEveryMinutes: 45, earlyArrivalMinutes: 0 };
    const cfg = { ...ctx.config, tourHours: hours };
    ctx.core.useConfig(cfg);
    Object.assign(ctx, { config: cfg });
    const started = await startTour(ctx);
    ctx.clock.set(minutesFrom(new Date(started.reservation.windowEnd!), -5));
    await started.overstay.handleAsk(ctx.core, started.reservation.id, "natural");
    const jane = (await ctx.core.getReservation(started.reservation.id))!;
    expect(formatTime(new Date(jane.windowEnd!), TZ)).toBe("2:55 PM");
    const other = await ctx.core.startInquiry({ name: "Alex Other", phone: "(555) 010-9999", unitId: "apt_101" });
    const twoFortyFive = (await ctx.core.availableSlots(TOUR_DAY)).find((s) => formatTime(s.start, TZ) === "2:45 PM");
    expect(twoFortyFive).toBeUndefined();
    await expect(ctx.core.reserveSlot(other.reservation.id, zonedTimeToUtc({ ...TOUR_DAY, hour: 14, minute: 45 }, TZ).toISOString())).rejects.toBeInstanceOf(TourCoreError);
  });

  it("door-after-T after they entered, another-time line if they never got in", async () => {
    const entered = setup();
    const a = await startTour(entered);
    entered.clock.set(new Date(a.reservation.windowEnd!));
    const denied = await a.tour.request("unit_101");
    expect(denied.decision.code).toBe("DENY_EXPIRED");
    expect(await outbound(entered, a.reservation.id)).toContain(DOOR_AFTER_T);

    const neverIn = setup();
    const late = await bookTour(neverIn);
    neverIn.clock.set(minutesFrom(late.slotStart, 120));
    const missed = await late.request("entrance");
    expect(missed.decision.code).toBe("DENY_EXPIRED");
    expect(await outbound(neverIn, late.reservation.id)).toContain(LATE_ARRIVAL_EXPIRED);
    expect(await outbound(neverIn, late.reservation.id)).not.toContain(DOOR_AFTER_T);
  });

  it("replies after the +15 close alert the team; DONE after close uses the tour-ended thanks", async () => {
    const withHelp = setup({ visitorContact: "+15550109999" });
    const a = await startTour(withHelp);
    const T = new Date(a.reservation.windowEnd!);
    withHelp.clock.set(minutesFrom(T, 15));
    await a.overstay.tickCore(withHelp.core, { propertyId: withHelp.config.property.id });
    await withHelp.core.replyAfterOverstayClose(a.reservation.id, "I'm still inside, the door won't open");
    expect(await outbound(withHelp, a.reservation.id)).toContain(visitorRepliedAfterClose("+15550109999"));
    expect(await operatorAlerts(withHelp, a.reservation.id)).toContain(landlordRepliedAfterClose("Jane", PLACE, "I'm still inside, the door won't open"));
    expect((await withHelp.core.auditTrail()).some((e) => e.type === "VISITOR_CONFIRMED_LEFT")).toBe(false);

    const noHelp = setup();
    const b = await startTour(noHelp);
    noHelp.clock.set(minutesFrom(new Date(b.reservation.windowEnd!), 15));
    await b.overstay.tickCore(noHelp.core, { propertyId: noHelp.config.property.id });
    await noHelp.core.replyAfterOverstayClose(b.reservation.id, "HELP");
    expect(await outbound(noHelp, b.reservation.id)).toContain(visitorRepliedAfterClose());

    const left = setup();
    const c = await startTour(left);
    left.clock.set(minutesFrom(new Date(c.reservation.windowEnd!), 15));
    await c.overstay.tickCore(left.core, { propertyId: left.config.property.id });
    await left.core.confirmLeftAfterClose(c.reservation.id);
    expect((await outbound(left, c.reservation.id)).some((b) => b.startsWith(tourFinishedFollowUp(PLACE, "Jane", "Two-bedroom, first floor, south-facing.")))).toBe(true);
    expect((await left.core.auditTrail()).some((e) => e.type === "VISITOR_CONFIRMED_LEFT" && e.reservationId === c.reservation.id)).toBe(true);
    expect((await operatorAlerts(left, c.reservation.id)).some((x) => x.includes("replied after their tour"))).toBe(false);
  });

  it("STOP during a tour tells the landlord and does not end the tour", async () => {
    const ctx = setup();
    const started = await startTour(ctx);
    const result = await ctx.core.optOutOfMessaging("(555) 010-1234", "STOP");
    expect(result.endedTour).toBe(false);
    expect((await ctx.core.getReservation(started.reservation.id))!.status).toBe("TOURING");
    const alerts = await operatorAlerts(ctx, started.reservation.id);
    expect(alerts).toContain("Jane Smith replied STOP and won't get more messages.");
    expect(alerts.some((a) => a.includes("Their tour was ended"))).toBe(false);
  });

  it("practice tour passes for a 15-minute tour and for the last slot of the day", async () => {
    const base = loadConfig();
    const short: TourCoreConfig = { ...base, tourHours: { ...base.tourHours, tourLengthMinutes: 15, slotEveryMinutes: 60, earlyArrivalMinutes: 0 } };
    const fifteen = await runDryTour(short, { now: zonedTimeToUtc({ ...TOUR_DAY, hour: 7, minute: 0 }, TZ) });
    expect(fifteen.passed).toBe(true);
    expect(fifteen.checks.find((c) => c.id === "t15_questions")).toMatchObject({ ok: true, skipped: true });
    expect(fifteen.checks.find((c) => c.id === "t15_questions")?.detail).toContain("15 minutes");

    const lastSlot: TourCoreConfig = {
      ...base,
      tourHours: { ...base.tourHours, start: "16:00", end: "17:00", slotEveryMinutes: 90, tourLengthMinutes: 45, earlyArrivalMinutes: 10 },
    };
    const last = await runDryTour(lastSlot, { now: zonedTimeToUtc({ ...TOUR_DAY, hour: 7, minute: 0 }, TZ) });
    expect(last.passed).toBe(true);
    expect(last.checks.every((c) => c.ok)).toBe(true);
    expect(last.failure).toBeUndefined();
  });

  it("no thanks to a T-5 offer then a later yes does not grant", async () => {
    const ctx = setup();
    const started = await startTour(ctx);
    ctx.clock.set(minutesFrom(new Date(started.reservation.windowEnd!), -5));
    await started.overstay.tickCore(ctx.core, { propertyId: ctx.config.property.id });
    expect(await started.overstay.replyToVisitor(ctx.core, started.reservation.id, "no thanks")).toBe(T5_NO_OFFER_BARE_YES);
    expect(await started.overstay.replyToVisitor(ctx.core, started.reservation.id, "is there a gym?")).toBeUndefined();
    ctx.clock.set(minutesFrom(new Date(started.reservation.windowEnd!), -1));
    expect(await started.overstay.replyToVisitor(ctx.core, started.reservation.id, "yes")).toBeUndefined();
    expect((await ctx.core.getReservation(started.reservation.id))!.extensionGrantedAt).toBeUndefined();
  });

  it("after a T-5 extension, T-5 against the new end uses the no-offer wording", async () => {
    const ctx = setup();
    const started = await startTour(ctx);
    ctx.clock.set(minutesFrom(new Date(started.reservation.windowEnd!), -5));
    await started.overstay.tickCore(ctx.core, { propertyId: ctx.config.property.id });
    expect(await started.overstay.handleAsk(ctx.core, started.reservation.id, "bare-yes")).toBe(extensionGranted(await started.endLabel()));
    const newEnd = new Date((await ctx.core.getReservation(started.reservation.id))!.windowEnd!);
    ctx.clock.set(minutesFrom(newEnd, -5));
    await started.overstay.tickCore(ctx.core, { propertyId: ctx.config.property.id });
    const texts = await outbound(ctx, started.reservation.id);
    expect(texts).toContain(t5NoOffer(PLACE, await started.endLabel(), "Jane"));
    expect(texts.filter((b) => b.includes("Want 10 more minutes?"))).toHaveLength(1);
  });

  it("entering at T-3 does not send a catch-up T-5", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    ctx.clock.set(minutesFrom(new Date(tour.reservation.windowEnd!), -3));
    await tour.request("entrance");
    const reservation = (await ctx.core.getReservation(tour.reservation.id))!;
    const overstay = new OverstayScheduler(new MemoryRuntimeStore(), { clock: ctx.clock });
    overstay.ensure(reservation, ctx.config.property.id);
    await overstay.tickCore(ctx.core, { propertyId: ctx.config.property.id });
    const texts = await outbound(ctx, reservation.id);
    expect(texts.some((b) => b.includes("ends in 5 minutes"))).toBe(false);
    expect(await overstay.handleAsk(ctx.core, reservation.id, "natural")).toBe(extensionGranted(formatTime(new Date((await ctx.core.getReservation(reservation.id))!.windowEnd!), TZ)));
  });

  it("concurrent more-time asks grant only once", async () => {
    const ctx = setup();
    const started = await startTour(ctx);
    ctx.clock.set(minutesFrom(new Date(started.reservation.windowEnd!), -8));
    const [a, b] = await Promise.all([
      started.overstay.handleAsk(ctx.core, started.reservation.id, "natural"),
      started.overstay.handleAsk(ctx.core, started.reservation.id, "natural"),
    ]);
    const granted = [a, b].filter((x) => x.startsWith("You've got 10 more minutes"));
    expect(granted).toHaveLength(1);
    expect([a, b].filter((x) => x.startsWith("You've already used"))).toHaveLength(1);
    expect((await ctx.core.auditTrail()).filter((e) => e.type === "TOUR_EXTENDED" && e.reservationId === started.reservation.id)).toHaveLength(1);
    expect((await operatorAlerts(ctx, started.reservation.id)).filter((x) => x.includes("was extended"))).toHaveLength(1);
  });

  it("held extended and operator-created windows are shared across conversations so 2:45 cannot be booked after a 2:55 end", async () => {
    const hours = { start: "14:00", end: "17:00", tourLengthMinutes: 45, slotEveryMinutes: 45, earlyArrivalMinutes: 0 } as const;
    const twoPm = zonedTimeToUtc({ ...TOUR_DAY, hour: 14, minute: 0 }, TZ);
    const twoFortyFive = zonedTimeToUtc({ ...TOUR_DAY, hour: 14, minute: 45 }, TZ);
    const twoFiftyFive = zonedTimeToUtc({ ...TOUR_DAY, hour: 14, minute: 55 }, TZ);
    const extraReservations: Reservation[] = [];
    const extraRequests: TourTimeRequest[] = [];
    const sessions: VisitorDemoSession[] = [];
    const windowsFor = async (exceptTourId: string): Promise<OccupiedWindow[]> => {
      const out: OccupiedWindow[] = [];
      for (const session of sessions) {
        if (session.tourId === exceptTourId) continue;
        out.push(...occupiedWindowsFromRecords(hours.tourLengthMinutes, await session.store.list("reservations"), await session.store.list("tourTimeRequests")));
      }
      out.push(...occupiedWindowsFromRecords(hours.tourLengthMinutes, extraReservations, extraRequests));
      return out;
    };

    const nowA = { t: twoPm.getTime() };
    const jane = new VisitorDemoSession("prop_100_alfred_way", { ...loadConfig(), tourHours: { ...loadConfig().tourHours, ...hours } }, "t-jane", {
      realNow: () => nowA.t,
      transport: new DemoMessagingAdapter(() => {}, "MESSAGING"),
      kind: "messaging",
      otherBusyWindows: () => windowsFor("t-jane"),
    });
    jane.core.useConfig({ ...jane.config, tourHours: { ...jane.config.tourHours, ...hours } });
    sessions.push(jane);

    const nowB = { t: zonedTimeToUtc({ ...TOUR_DAY, hour: 10, minute: 0 }, TZ).getTime() };
    const alex = new VisitorDemoSession("prop_100_alfred_way", { ...loadConfig(), tourHours: { ...loadConfig().tourHours, ...hours } }, "t-alex", {
      realNow: () => nowB.t,
      transport: new DemoMessagingAdapter(() => {}, "MESSAGING"),
      kind: "messaging",
      otherBusyWindows: () => windowsFor("t-alex"),
    });
    alex.core.useConfig({ ...alex.config, tourHours: { ...alex.config.tourHours, ...hours } });
    sessions.push(alex);

    extraReservations.push(
      busyReservation({ config: jane.config, clock: jane.clock }, { start: twoPm, oneOff: true }),
    );
    extraReservations[0]!.windowEnd = twoFiftyFive.toISOString();
    extraRequests.push({
      id: newId("ttr"),
      propertyId: jane.config.property.id,
      prospectId: newId("prs"),
      requestedStartsAt: twoPm.toISOString(),
      requestedEndsAt: twoFiftyFive.toISOString(),
      requestSource: "OPERATOR",
      status: "APPROVED",
      createdAt: twoPm.toISOString(),
    });

    const alexInquiry = await alex.core.startInquiry({ name: "Alex Other", phone: "(555) 010-9999", unitId: "apt_101" });
    expect((await alex.core.availableSlots(TOUR_DAY)).find((s) => formatTime(s.start, TZ) === "2:45 PM")).toBeUndefined();
    await expect(alex.core.reserveSlot(alexInquiry.reservation.id, twoFortyFive.toISOString())).rejects.toBeInstanceOf(TourCoreError);

    extraReservations.length = 0;
    extraRequests.length = 0;
    const janeBooked = await bookOnSession(jane, twoPm);
    nowA.t = twoPm.getTime();
    jane.clock.jumpTo(twoPm);
    await jane.core.requestAccess({ reservationId: janeBooked.id, prospectId: janeBooked.prospectId, doorId: "entrance" });
    const janeOverstay = new OverstayScheduler(new MemoryRuntimeStore(), { now: () => new Date(nowA.t) });
    jane.overstay = janeOverstay;
    janeOverstay.ensure((await jane.core.getReservation(janeBooked.id))!, jane.propertyId, jane.tourId);
    nowA.t = twoPm.getTime() + 40 * 60_000;
    jane.clock.jumpTo(new Date(nowA.t));
    await janeOverstay.handleAsk(jane.core, janeBooked.id, "natural");
    expect(formatTime(new Date((await jane.core.getReservation(janeBooked.id))!.windowEnd!), TZ)).toBe("2:55 PM");
    const alexAgain = await alex.core.startInquiry({ name: "Alex Other", phone: "(555) 010-9999", unitId: "apt_101" });
    expect((await alex.core.availableSlots(TOUR_DAY)).find((s) => formatTime(s.start, TZ) === "2:45 PM")).toBeUndefined();
    await expect(alex.core.reserveSlot(alexAgain.reservation.id, twoFortyFive.toISOString())).rejects.toBeInstanceOf(TourCoreError);
  });

  it("T-5 offer across conversations respects another visitor's existing booking", async () => {
    const hours = { start: "14:00", end: "17:00", tourLengthMinutes: 45, slotEveryMinutes: 45, earlyArrivalMinutes: 0 } as const;
    const twoPm = zonedTimeToUtc({ ...TOUR_DAY, hour: 14, minute: 0 }, TZ);
    const twoFortyFive = zonedTimeToUtc({ ...TOUR_DAY, hour: 14, minute: 45 }, TZ);
    const sessions: VisitorDemoSession[] = [];
    const extras: Reservation[] = [];
    const windowsFor = async (exceptTourId: string): Promise<OccupiedWindow[]> => {
      const out: OccupiedWindow[] = [];
      for (const session of sessions) {
        if (session.tourId === exceptTourId) continue;
        out.push(...occupiedWindowsFromRecords(hours.tourLengthMinutes, await session.store.list("reservations"), await session.store.list("tourTimeRequests")));
      }
      out.push(...occupiedWindowsFromRecords(hours.tourLengthMinutes, extras, []));
      return out;
    };
    const now = { t: twoPm.getTime() };
    const jane = new VisitorDemoSession("prop_100_alfred_way", { ...loadConfig(), tourHours: { ...loadConfig().tourHours, ...hours } }, "t-jane-t5", {
      realNow: () => now.t,
      transport: new DemoMessagingAdapter(() => {}, "MESSAGING"),
      kind: "messaging",
      otherBusyWindows: () => windowsFor("t-jane-t5"),
    });
    jane.core.useConfig({ ...jane.config, tourHours: { ...jane.config.tourHours, ...hours } });
    sessions.push(jane);
    extras.push(busyReservation({ config: jane.config, clock: jane.clock }, { start: twoFortyFive }));
    const janeBooked = await bookOnSession(jane, twoPm);
    now.t = twoPm.getTime();
    jane.clock.jumpTo(twoPm);
    await jane.core.requestAccess({ reservationId: janeBooked.id, prospectId: janeBooked.prospectId, doorId: "entrance" });
    const overstay = new OverstayScheduler(new MemoryRuntimeStore(), { now: () => new Date(now.t) });
    jane.overstay = overstay;
    overstay.ensure((await jane.core.getReservation(janeBooked.id))!, jane.propertyId, jane.tourId);
    now.t = twoPm.getTime() + 40 * 60_000;
    jane.clock.jumpTo(new Date(now.t));
    await overstay.tickCore(jane.core, { session: jane, propertyId: jane.propertyId, tourId: jane.tourId });
    const texts = (await jane.store.list("messages")).filter((m) => m.audience === "PROSPECT").map((m) => m.body);
    expect(texts).toContain(t5NoOffer(PLACE, formatTime(new Date((await jane.core.getReservation(janeBooked.id))!.windowEnd!), TZ), "Jane"));
    expect(texts.some((b) => b.includes("Want 10 more minutes?"))).toBe(false);
  });

  it("failed visitor texts still send T+5 and T+15 alerts once, close the tour, and cap retries", async () => {
    const visitorAttempts: string[] = [];
    const failing: MessagingAdapter = {
      provider: "fail-visitor",
      presentation: "MESSAGING",
      async send(message: OutgoingMessage): Promise<DeliveryReceipt> {
        if (message.audience === "PROSPECT") {
          visitorAttempts.push(message.body);
          return { provider: "fail-visitor", channel: "SMS", status: "FAILED", sentAt: new Date().toISOString(), error: { code: "SEND_FAILED", message: "visitor send failed" } };
        }
        return { provider: "fail-visitor", channel: "SMS", status: "SENT", sentAt: new Date().toISOString() };
      },
    };
    const loaded = loadConfig();
    const clock = new SimulatedClock(zonedTimeToUtc({ ...TOUR_DAY, hour: 10, minute: 0 }, TZ));
    const store = new InMemoryStore();
    const durin = new MockDurinAccessAdapter({ doorNames: Object.fromEntries(loaded.doors.map((d) => [d.id, d.name])), log: () => {}, now: () => clock.now() });
    const core = createTourCore(loaded, { clock, durin, messenger: failing, store });
    const ctx = { config: loaded, clock, durin, core, store };
    const tour = await bookTour(ctx);
    clock.set(tour.slotStart);
    await tour.request("entrance");
    const reservation = (await core.getReservation(tour.reservation.id))!;
    const overstay = new OverstayScheduler(new MemoryRuntimeStore(), { clock });
    overstay.ensure(reservation, loaded.property.id);
    clock.set(minutesFrom(new Date(reservation.windowEnd!), 5));
    await overstay.tickCore(core, { propertyId: loaded.property.id });
    clock.set(minutesFrom(new Date(reservation.windowEnd!), 15));
    await overstay.tickCore(core, { propertyId: loaded.property.id });
    const alerts = (await store.list("messages")).filter((m) => m.audience === "OPERATOR").map((m) => m.body);
    expect(alerts.filter((b) => b === landlordPlus5("Jane", PLACE))).toHaveLength(1);
    expect(alerts.filter((b) => b === landlordPlus15("Jane", PLACE))).toHaveLength(1);
    expect((await core.getReservation(reservation.id))!.status).toBe("EXPIRED");
    expect((await core.auditTrail()).some((e) => e.type === "TOUR_OVERSTAY_CLOSED" && e.reservationId === reservation.id)).toBe(true);
    expect(visitorAttempts.filter((b) => b === plus5CheckIn(PLACE)).length).toBe(VISITOR_SEND_ATTEMPTS);
    expect(visitorAttempts.filter((b) => b.startsWith("Your tour of Unit 101 is now closed")).length).toBe(VISITOR_SEND_ATTEMPTS);
    await overstay.tickCore(core, { propertyId: loaded.property.id });
    expect(alerts.filter((b) => b === landlordPlus5("Jane", PLACE))).toHaveLength(1);
    expect((await store.list("messages")).filter((m) => m.audience === "OPERATOR" && m.body === landlordPlus15("Jane", PLACE))).toHaveLength(1);
  });

  it("follow-up yes after a normal tour and after a closed tour use the same visitor reply and landlord alert", async () => {
    const followUpAlert = "Jane Smith toured Unit 101 and would like someone to follow up.";
    const normal = setup();
    const a = await startTour(normal);
    await normal.core.completeTour(a.reservation.id);
    await normal.core.recordFollowUpResponse(a.reservation.id, true, { text: "yes" });
    expect(await outbound(normal, a.reservation.id)).toContain(VisitorDenialCopy.followUpYes(normal.config.operator.name));
    expect(await operatorAlerts(normal, a.reservation.id)).toContain(followUpAlert);

    const closed = setup();
    const b = await startTour(closed);
    closed.clock.set(minutesFrom(new Date(b.reservation.windowEnd!), 15));
    await b.overstay.tickCore(closed.core, { propertyId: closed.config.property.id });
    await closed.core.confirmLeftAfterClose(b.reservation.id);
    await closed.core.recordFollowUpResponse(b.reservation.id, true, { text: "yes" });
    expect(await outbound(closed, b.reservation.id)).toContain(VisitorDenialCopy.followUpYes(closed.config.operator.name));
    expect(await operatorAlerts(closed, b.reservation.id)).toContain(followUpAlert);
    expect(await outbound(closed, b.reservation.id).then((rows) => rows.filter((x) => x === visitorRepliedAfterClose()))).toHaveLength(0);
  });

  it("follow-up no after a closed tour uses the same ack as a normal finish", async () => {
    const closed = setup();
    const b = await startTour(closed);
    closed.clock.set(minutesFrom(new Date(b.reservation.windowEnd!), 15));
    await b.overstay.tickCore(closed.core, { propertyId: closed.config.property.id });
    await closed.core.confirmLeftAfterClose(b.reservation.id);
    await closed.core.recordFollowUpResponse(b.reservation.id, false, { text: "no" });
    expect(await outbound(closed, b.reservation.id)).toContain("No problem. Thanks again for visiting!");
  });

  it("HI or a booking intent after the +15 close starts booking instead of the after-close alert", async () => {
    const now = { t: zonedTimeToUtc({ ...TOUR_DAY, hour: 13, minute: 58 }, TZ).getTime() };
    const session = new VisitorDemoSession("prop_100_alfred_way", loadConfig(), "t-hi-close", {
      realNow: () => now.t,
      transport: new DemoMessagingAdapter(() => {}, "MESSAGING"),
      kind: "messaging",
    });
    const runtime = new MemoryRuntimeStore();
    session.overstay = new OverstayScheduler(runtime, { now: () => new Date(now.t) });
    let n = 0;
    const say = (text: string) => handleVisitorText(session, "+15550102000", text, { provider: "test", providerMessageId: `hi_${++n}` });
    await say("TOUR");
    await say("YES");
    await say("1");
    await say("1");
    await say("1");
    await say("yes");
    await session.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "+15550102000" });
    const r = (await session.reservation())!;
    now.t = Date.parse(r.slotStart!);
    session.clock.jumpTo(new Date(now.t));
    await say("I'm here");
    session.overstay.ensure((await session.reservation())!, session.propertyId, session.tourId);
    now.t = Date.parse(r.windowEnd!) + 15 * 60_000;
    session.clock.jumpTo(new Date(now.t));
    await session.overstay.tickSession(session);
    expect((await session.reservation())!.status).toBe("EXPIRED");
    await say("I'd like to book another tour");
    const afterBook = session.conversation.filter((c) => c.from === "tourcore").map((c) => c.text).at(-1) ?? "";
    expect(afterBook).not.toBe(visitorRepliedAfterClose());
    expect(afterBook).toMatch(/Which unit|I have tours available|Welcome|self-guided/);
    expect((await operatorAlertsFromSession(session)).some((x) => x.includes("replied after their tour"))).toBe(false);
  });

  it("after-close alerts stop after DONE, operator resolve, or 24 hours", async () => {
    async function closedSession() {
      const now = { t: zonedTimeToUtc({ ...TOUR_DAY, hour: 13, minute: 58 }, TZ).getTime() };
      const session = new VisitorDemoSession("prop_100_alfred_way", loadConfig(), `t-window-${Math.random().toString(16).slice(2)}`, {
        realNow: () => now.t,
        transport: new DemoMessagingAdapter(() => {}, "MESSAGING"),
        kind: "messaging",
      });
      const runtime = new MemoryRuntimeStore();
      session.overstay = new OverstayScheduler(runtime, { now: () => new Date(now.t) });
      let n = 0;
      const say = (text: string) => handleVisitorText(session, "+15550102000", text, { provider: "test", providerMessageId: `w_${session.tourId}_${++n}` });
      await say("TOUR");
      await say("YES");
      await say("1");
      await say("1");
      await say("1");
      await say("yes");
      await session.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "+15550102000" });
      const r = (await session.reservation())!;
      now.t = Date.parse(r.slotStart!);
      session.clock.jumpTo(new Date(now.t));
      await say("I'm here");
      session.overstay.ensure((await session.reservation())!, session.propertyId, session.tourId);
      now.t = Date.parse(r.windowEnd!) + 15 * 60_000;
      session.clock.jumpTo(new Date(now.t));
      await session.overstay.tickSession(session);
      return { session, say, now, reservationId: r.id };
    }

    const stillInside = await closedSession();
    await stillInside.say("the door is stuck");
    expect(stillInside.session.conversation.filter((c) => c.from === "tourcore").map((c) => c.text).at(-1)).toBe(visitorRepliedAfterClose());
    expect((await operatorAlertsFromSession(stillInside.session)).filter((x) => x.includes("replied after their tour"))).toHaveLength(1);

    const afterDone = await closedSession();
    await afterDone.say("DONE");
    const before = (await operatorAlertsFromSession(afterDone.session)).filter((x) => x.includes("replied after their tour")).length;
    await afterDone.say("the door is stuck");
    expect(afterDone.session.conversation.filter((c) => c.from === "tourcore").map((c) => c.text).at(-1)).not.toBe(visitorRepliedAfterClose());
    expect((await operatorAlertsFromSession(afterDone.session)).filter((x) => x.includes("replied after their tour"))).toHaveLength(before);

    const resolved = await closedSession();
    resolved.session.overstay!.closeAlertWindow(resolved.reservationId);
    await resolved.say("the door is stuck");
    expect(resolved.session.conversation.filter((c) => c.from === "tourcore").map((c) => c.text).at(-1)).toBe(TOUR_ENDED_REPLY);
    expect((await operatorAlertsFromSession(resolved.session)).some((x) => x.includes("replied after their tour"))).toBe(false);

    const expired = await closedSession();
    expired.now.t = expired.now.t + 24 * 60 * 60_000;
    expired.session.clock.jumpTo(new Date(expired.now.t));
    await expired.say("the door is stuck");
    expect(expired.session.conversation.filter((c) => c.from === "tourcore").map((c) => c.text).at(-1)).toBe(TOUR_ENDED_REPLY);
    expect((await operatorAlertsFromSession(expired.session)).some((x) => x.includes("replied after their tour"))).toBe(false);
  });
});

async function bookOnSession(session: VisitorDemoSession, start: Date) {
  const { prospect, reservation } = await session.core.startInquiry({ name: "Jane Smith", phone: "(555) 010-1234", unitId: "apt_101" });
  session.prospectId = prospect.id;
  session.reservationId = reservation.id;
  await session.core.reserveSlot(reservation.id, start.toISOString());
  await session.core.recordConsent(reservation.id, true);
  const ready = await session.core.submitVerification(reservation.id, basicForm());
  return ready;
}

async function operatorAlertsFromSession(session: VisitorDemoSession) {
  return (await session.store.list("messages")).filter((m) => m.audience === "OPERATOR").map((m) => m.body);
}
