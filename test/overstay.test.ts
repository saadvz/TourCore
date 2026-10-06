import { describe, expect, it } from "vitest";
import { loadConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { SimulatedClock } from "../src/core/clock";
import {
  EARLY_EXTENSION_ASK_GRANTS,
  earlyExtensionAskDecision,
} from "../src/core/extensionPolicy";
import { extensionAvailability, occupantFromReservation } from "../src/core/extensionAvailability";
import {
  DOOR_AFTER_T,
  EXTENSION_AFTER_T,
  EXTENSION_ASK_DEFERRED,
  extensionAlreadyUsed,
  extensionGranted,
  extensionUnavailable,
  landlordExtensionGranted,
  landlordPlus15,
  landlordPlus5,
  plus15Closed,
  plus5CheckIn,
  T15_BARE_YES,
  T15_NO_OR_ALL_GOOD,
  T5_NO_OFFER_BARE_YES,
  t15Questions,
  t5NoOffer,
  t5Offering,
  tourEnded,
} from "../src/core/overstayCopy";
import { formatTime, zonedTimeToUtc } from "../src/core/timezone";
import { newId, UNNAMED_VISITOR, type Reservation } from "../src/domain/model";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
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

function busyReservation(ctx: ReturnType<typeof setup>, input: { start: Date; unitId?: string; doors?: string[]; oneOff?: boolean; pending?: boolean }): Reservation {
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
  it("defaults to T-5-only", () => {
    expect(EARLY_EXTENSION_ASK_GRANTS).toBe(false);
    expect(earlyExtensionAskDecision({ offeringT5Sent: false, nowMs: 1, windowEndMs: 10 })).toBe("defer");
    expect(earlyExtensionAskDecision({ offeringT5Sent: true, nowMs: 1, windowEndMs: 10 })).toBe("consider");
    expect(earlyExtensionAskDecision({ offeringT5Sent: false, nowMs: 1, windowEndMs: 10, earlyAskGrants: true })).toBe("consider");
    expect(earlyExtensionAskDecision({ offeringT5Sent: false, nowMs: 10, windowEndMs: 10 })).toBe("after-t");
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
    expect(await a.overstay.replyToVisitor(ask.core, a.reservation.id, "can I have more time?")).toBe(EXTENSION_ASK_DEFERRED);
    expect((await ask.core.getReservation(a.reservation.id))!.extensionGrantedAt).toBeUndefined();
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

  it("a natural ask before T-5 is deferred by default and does not use the extension", async () => {
    const ctx = setup();
    const started = await startTour(ctx);
    ctx.clock.set(minutesFrom(new Date(started.reservation.windowEnd!), -12));
    expect(await started.overstay.handleAsk(ctx.core, started.reservation.id, "natural")).toBe(EXTENSION_ASK_DEFERRED);
    expect((await ctx.core.getReservation(started.reservation.id))!.extensionGrantedAt).toBeUndefined();
    ctx.clock.set(minutesFrom(new Date(started.reservation.windowEnd!), -5));
    await started.overstay.tickCore(ctx.core, { propertyId: ctx.config.property.id });
    const granted = await started.overstay.handleAsk(ctx.core, started.reservation.id, "bare-yes");
    expect(granted).toBe(extensionGranted(await started.endLabel()));
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
    expect(alerts.filter((a) => a === landlordExtensionGranted("Jane", PLACE, await started.endLabel()))).toHaveLength(1);
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

  it("with early asks on, an early ask grants, uses the locked texts, and plus a T-5 yes is still only one extension", async () => {
    const granted = setup();
    const g = await startTour(granted);
    const early = new OverstayScheduler(g.runtime, { clock: granted.clock, earlyAskGrants: true });
    early.ensure((await granted.core.getReservation(g.reservation.id))!, granted.config.property.id);
    granted.clock.set(minutesFrom(new Date(g.reservation.windowEnd!), -12));
    const first = await early.handleAsk(granted.core, g.reservation.id, "natural");
    expect(first).toBe(extensionGranted(await g.endLabel()));
    granted.clock.set(minutesFrom(new Date((await granted.core.getReservation(g.reservation.id))!.windowEnd!), -5));
    await early.tickCore(granted.core, { propertyId: granted.config.property.id });
    expect(await early.handleAsk(granted.core, g.reservation.id, "bare-yes")).toBe(extensionAlreadyUsed(await g.endLabel()));
    expect((await granted.core.auditTrail()).filter((e) => e.type === "TOUR_EXTENDED" && e.reservationId === g.reservation.id)).toHaveLength(1);

    const taken = setup();
    const t = await startTour(taken);
    const earlyTaken = new OverstayScheduler(t.runtime, { clock: taken.clock, earlyAskGrants: true });
    earlyTaken.ensure((await taken.core.getReservation(t.reservation.id))!, taken.config.property.id);
    await taken.store.put("reservations", busyReservation(taken, { start: new Date(t.reservation.windowEnd!) }));
    taken.clock.set(minutesFrom(new Date(t.reservation.windowEnd!), -12));
    expect(await earlyTaken.handleAsk(taken.core, t.reservation.id, "natural")).toBe(extensionUnavailable(await t.endLabel()));
    expect((await taken.core.getReservation(t.reservation.id))!.extensionGrantedAt).toBeUndefined();
    taken.clock.set(minutesFrom(new Date(t.reservation.windowEnd!), -5));
    await earlyTaken.tickCore(taken.core, { propertyId: taken.config.property.id });
    expect(await earlyTaken.handleAsk(taken.core, t.reservation.id, "natural")).toBe(extensionUnavailable(await t.endLabel()));
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
    const { prospect, reservation } = await ctx.core.startInquiry({ name: UNNAMED_VISITOR, phone: "(555) 010-9999", unitId: "apt_101" });
    const slot = (await ctx.core.availableSlots(TOUR_DAY))[0]!;
    await ctx.core.reserveSlot(reservation.id, slot.start.toISOString());
    let current = await ctx.core.recordConsent(reservation.id, true);
    current = await ctx.core.submitVerification(current.id, { ...basicForm("(555) 010-9999"), answers: { governmentFirstName: "", governmentLastName: "", email: "x@example.com", phone: "(555) 010-9999" } });
    await ctx.store.put("prospects", { ...(await ctx.store.get("prospects", prospect.id))!, name: UNNAMED_VISITOR });
    ctx.clock.set(slot.start);
    await ctx.core.requestAccess({ reservationId: current.id, prospectId: prospect.id, doorId: "entrance" });
    const live = (await ctx.core.getReservation(current.id))!;
    const overstay = new OverstayScheduler(new MemoryRuntimeStore(), { clock: ctx.clock });
    overstay.ensure(live, ctx.config.property.id);
    ctx.clock.set(new Date(live.windowEnd!));
    await overstay.tickCore(ctx.core, { propertyId: ctx.config.property.id });
    const texts = await outbound(ctx, live.id);
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
    expect(session.conversation.filter((c) => c.from === "tourcore").map((c) => c.text).at(-1)).toContain("I don't have that information");
    await say("I'm out");
    expect((await session.reservation())!.status).toBe("COMPLETED");
  });
});
