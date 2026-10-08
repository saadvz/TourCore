import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import {
  bookedTourCalledOffText,
  cannotCancelRunningOfferLater,
  laterCancelConfirm,
  laterCancelDone,
  laterCancelKept,
  moveLaterBookingInstead,
  moveLaterBookingOutsideHours,
  movedLaterBookingSummary,
  revokeConfirmQuestion,
  tourInProgressCannotMove,
  tourMovedToText,
} from "../src/core/availabilityCopy";
import { bookedForLine, TOUR_ENDED_REPLY, VISITOR_CANCEL_DONE, VisitorDenialCopy } from "../src/core/TourCore";
import { formatDay, formatTime, zonedTimeToUtc } from "../src/core/timezone";
import { MessagingEndpoints } from "../src/messaging/endpoints";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import { bookedTours, cancelBooked } from "../src/operator/availability";
import { persistSession } from "../src/operator/services";
import { tourRef } from "../src/operator/tours";
import { transition } from "../src/domain/stateMachine";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { MemoryRuntimeStore } from "../src/storage/runtimeStore";
import { handleVisitorText } from "../src/visitor/conversation";
import { MessagingConversations } from "../src/visitor/messagingRouter";
import { OverstayScheduler } from "../src/visitor/overstayScheduler";
import { VisitorDemoRegistry, VisitorDemoSession } from "../src/visitor/session";
import { VerificationLinks } from "../src/visitor/verificationLinks";
import { at, grokHarness } from "./grokHarness";
import { liveApp, PHONE as LIVE_PHONE } from "./liveApp";

const TZ = "America/New_York";
const PHONE = "+15550102000";
const LINE = "+15550001111";
const PROPERTY = "prop_100_alfred_way";
const TOUR_DAY = { year: 2026, month: 9, day: 28 };

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function lastFrom(session: VisitorDemoSession): string {
  return session.conversation.filter((c) => c.from === "tourcore").map((c) => c.text).at(-1) ?? "";
}

async function doorFailureVisitor(
  h: ReturnType<typeof grokHarness>,
  id: string,
  options: { name?: string; phone?: string } = {},
) {
  const v = await h.visitor(id, options);
  const [first, last] = (options.name ?? "Pat Smith").split(" ");
  await v.act("chooseTime", { slotStart: v.slot().toISOString() });
  await v.act("consent", { agree: true });
  await v.act("submitIdentity", {
    firstName: first,
    lastName: last,
    email: "pat@example.com",
    phone: options.phone ?? "555-010-2000",
  });
  h.setClock(v.slot().getTime());
  await v.act("arrive");
  v.session.durin.failNextRequest("door controller timeout");
  await v.act("atStop", { doorId: "unit_101_door" });
  expect((await v.session.reservation())!.status).toBe("PROVIDER_FAILURE");
  return v;
}

async function markProviderFailure(session: VisitorDemoSession) {
  const current = (await session.reservation())!;
  await session.store.put("reservations", transition(current, "PROVIDER_FAILURE", session.clock.now()));
}

async function holdNextSlot(session: VisitorDemoSession, slotStart: Date) {
  const current = (await session.reservation())!;
  session.rebookUnitId = current.unitId;
  await session.confirmRebook(slotStart.toISOString());
  const pending = (await session.pendingBooking())!;
  expect(pending.id).not.toBe(current.id);
  expect((await session.reservation())!.id).toBe(current.id);
  return pending;
}

async function touringWithRebook(label: string, later = zonedTimeToUtc({ year: 2026, month: 10, day: 2, hour: 14, minute: 0 }, TZ)) {
  const now = { t: zonedTimeToUtc({ ...TOUR_DAY, hour: 13, minute: 58 }, TZ).getTime() };
  const session = new VisitorDemoSession(PROPERTY, loadConfig(), label, {
    realNow: () => now.t,
    transport: new DemoMessagingAdapter(() => {}, "MESSAGING"),
    kind: "messaging",
  });
  session.overstay = new OverstayScheduler(new MemoryRuntimeStore(), { now: () => new Date(now.t) });
  let n = 0;
  const say = (text: string) => handleVisitorText(session, PHONE, text, { provider: "test", providerMessageId: `${label}_${++n}` });
  await say("TOUR");
  await say("YES");
  await say("1");
  await say("1");
  await say("1");
  await say("yes");
  await session.act("submitIdentity", { firstName: "Riley", lastName: "Tester", email: "riley@example.com", phone: PHONE });
  const booked = (await session.reservation())!;
  now.t = Date.parse(booked.slotStart!);
  session.clock.jumpTo(new Date(now.t));
  await say("I'm here");
  session.overstay.ensure((await session.reservation())!, session.propertyId, session.tourId);
  const pending = await holdNextSlot(session, later);
  return { session, say, now, runningId: booked.id, pending, later };
}

describe("defect 1: bare yes answers the latest question", () => {
  it("yes to a door check opens the door and leaves the later booking confirmed", async () => {
    const ctx = await touringWithRebook("d1-door-yes");
    expect(await ctx.session.pendingBookingNeedsConsent()).toBe(false);
    expect((await ctx.session.store.get("reservations", ctx.pending.id))!.consentId).toBeTruthy();
    await ctx.say("can you open 101?");
    expect(lastFrom(ctx.session)).toMatch(/^Are you at Unit 101 now\?/);
    const before = ctx.session.durin.requestCount;
    await ctx.say("yes");
    expect((await ctx.session.reservation())!.id).toBe(ctx.runningId);
    expect((await ctx.session.reservation())!.status).toBe("TOURING");
    expect(ctx.session.lastAccess).toMatchObject({ doorId: "unit_101", allowed: true });
    expect(ctx.session.durin.requestCount).toBeGreaterThan(before);
    expect(await ctx.session.pendingBookingNeedsConsent()).toBe(false);
    expect(lastFrom(ctx.session)).not.toMatch(/You're all set for your tour/);
    expect(lastFrom(ctx.session)).not.toContain("Is it OK if I text you");
  });

  it("a bare yes during the tour does not drop the later booking", async () => {
    const ctx = await touringWithRebook("d1-consent-yes");
    expect(await ctx.session.pendingBookingNeedsConsent()).toBe(false);
    const bookedBefore = (await ctx.session.store.get("reservations", ctx.pending.id))!;
    expect(bookedBefore.consentId).toBeTruthy();
    expect(bookedBefore.status).toBe("READY");
    await ctx.say("yes");
    expect((await ctx.session.reservation())!.id).toBe(ctx.runningId);
    expect((await ctx.session.reservation())!.status).toBe("TOURING");
    expect((await ctx.session.store.get("reservations", ctx.pending.id))!.status).toBe("READY");
  });

  it.each(["yes, no need to switch", "yes, no change needed", "yes, I won't need to reschedule", "yes but I might be 5 min late"])(
    "%s leaves the held Thursday booking confirmed",
    async (phrase) => {
      const thursday = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 14, minute: 0 }, TZ);
      const ctx = await touringWithRebook(`farewell-${phrase.length}`, thursday);
      expect(await ctx.session.pendingBookingNeedsConsent()).toBe(false);
      await ctx.say(phrase);
      expect((await ctx.session.reservation())!.id).toBe(ctx.runningId);
      expect((await ctx.session.reservation())!.status).toBe("TOURING");
      const booked = (await ctx.session.store.get("reservations", ctx.pending.id))!;
      expect(booked.consentId).toBeTruthy();
      expect(booked.status).toBe("READY");
      const thread = ctx.session.conversation.filter((c) => c.from === "tourcore").map((c) => c.text).join("\n");
      expect(thread).toContain("You're all set for your 2:00 PM tour on Thursday, Oct 1!");
      expect(thread).not.toContain("Is it OK if I text you");
    },
  );
});

describe("defect 2: operator tools target the running tour", () => {
  async function touringRebookHarness() {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const pending = await holdNextSlot(v.session, new Date(at(10)));
    await persistSession(h.services, v.session);
    const ref = tourRef(id, v.session.tourId);
    return { h, id, v, pending, ref };
  }

  it("list_active_tours and inspect_tour show the running tour and the next booking", async () => {
    const { h, pending, ref } = await touringRebookHarness();
    const list = await h.ok("list_active_tours");
    expect(list.tours).toHaveLength(1);
    expect(list.tours[0]).toMatchObject({
      visitorName: "Riley Tester",
      status: "Touring",
      tourTime: "Monday, Sep 28, 9:00 AM\u20139:45 AM",
      nextBooking: { tourTime: "Monday, Sep 28, 10:00 AM\u201310:45 AM", status: "Ready, waiting for arrival" },
    });
    const inspected = await h.ok("inspect_tour", { tourRef: ref });
    expect(inspected.tour.status).toBe("Touring");
    expect(inspected.tour.tourTime).toBe("Monday, Sep 28, 9:00 AM\u20139:45 AM");
    expect(inspected.tour.nextBooking).toEqual({ tourTime: "Monday, Sep 28, 10:00 AM\u201310:45 AM", status: "Ready, waiting for arrival" });
    expect(inspected.tour.accessGrants.some((g: { doorName: string }) => g.doorName === "Lobby Entrance")).toBe(true);
    expect(pending.status).toBe("READY");
  });

  it("pause and resume the running tour while a rebook is held", async () => {
    const { h, v, ref } = await touringRebookHarness();
    const held = await h.approve("place_operator_hold", { tourRef: ref, reason: "Checking the lobby camera" });
    expect(held.done.summary).toMatch(/Riley Tester's tour is paused/);
    expect((await v.session.reservation())!.status).toBe("OPERATOR_HOLD");
    expect(v.session.pendingBookingId).toBeTruthy();
    const listed = await h.ok("list_active_tours");
    expect(listed.tours[0].status).toBe("Paused");
    expect(listed.tours[0].nextBooking?.status).toBe("Ready, waiting for arrival");
    const resumed = await h.approve("clear_operator_hold", { tourRef: ref });
    expect(resumed.done.summary).toMatch(/Riley Tester's tour is resumed/);
    expect((await v.session.reservation())!.status).toBe("TOURING");
    expect(await h.fails("clear_operator_hold", { tourRef: ref })).toMatch(/isn't paused/);
  });
});

describe("defect 3: ended running tour hands conversation to the held rebook", () => {
  it("called off: visitor can cancel the rebook, operator can revoke it", async () => {
    const ctx = await touringWithRebook("d3-revoked");
    await ctx.session.operatorChange((core, id) => core.revokeReservation(id, "called off"));
    expect((await ctx.session.store.get("reservations", ctx.runningId))!.status).toBe("REVOKED");
    expect(ctx.session.pendingBookingId).toBe(ctx.pending.id);
    await ctx.say("please cancel my Saturday tour");
    expect((await ctx.session.reservation())!.id).toBe(ctx.pending.id);
    expect(lastFrom(ctx.session)).toBe(
      `Cancel your ${formatTime(ctx.later, TZ)} tour on ${formatDay(ctx.later, TZ)}? Reply YES or NO.`,
    );
    await ctx.say("yes");
    expect(lastFrom(ctx.session)).toBe(VISITOR_CANCEL_DONE);
    expect((await ctx.session.store.get("reservations", ctx.pending.id))!.status).toBe("CANCELLED");
  });

  it("cancelled: held rebook takes over so HI is not the ended-tour loop", async () => {
    const ctx = await touringWithRebook("d3-cancelled");
    await ctx.session.core.cancelTourByVisitor(ctx.runningId);
    await ctx.say("HI");
    expect((await ctx.session.reservation())!.id).toBe(ctx.pending.id);
    expect(lastFrom(ctx.session)).not.toBe(TOUR_ENDED_REPLY);
    const start = new Date(ctx.pending.slotStart!);
    expect(ctx.session.conversation.filter((c) => c.from === "tourcore").map((c) => c.text)).toContain(
      bookedForLine(formatTime(start, TZ), formatDay(start, TZ)),
    );
    expect(ctx.session.conversation.filter((c) => c.from === "tourcore").map((c) => c.text).join("\n")).toContain("You're all set");
    expect(lastFrom(ctx.session)).not.toContain("Is it OK if I text you");
  });

  it("done: after follow-up, the held rebook is the active booking", async () => {
    const ctx = await touringWithRebook("d3-done");
    await ctx.say("DONE");
    expect((await ctx.session.reservation())!.id).toBe(ctx.runningId);
    await ctx.say("no");
    expect((await ctx.session.reservation())!.id).toBe(ctx.pending.id);
    expect(await ctx.session.pendingBookingNeedsConsent() || (await ctx.session.activeNeedsConsent())).toBe(false);
    expect((await ctx.session.reservation())!.consentId).toBeTruthy();
  });

  it("expired: after the leaving window, the held rebook takes over", async () => {
    const ctx = await touringWithRebook("d3-expired");
    ctx.now.t = Date.parse((await ctx.session.reservation())!.windowEnd!) + 15 * 60_000;
    ctx.session.clock.jumpTo(new Date(ctx.now.t));
    await ctx.session.overstay!.tickSession(ctx.session);
    expect((await ctx.session.reservation())!.status).toBe("EXPIRED");
    ctx.session.overstay!.closeAlertWindow(ctx.runningId);
    await ctx.say("HI");
    expect((await ctx.session.reservation())!.id).toBe(ctx.pending.id);
    expect(lastFrom(ctx.session)).not.toBe(TOUR_ENDED_REPLY);
  });

  it("operator can revoke the held rebook after the running tour is called off", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const thursday = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 14, minute: 0 }, TZ);
    const pending = await holdNextSlot(v.session, thursday);
    const ref = tourRef(id, v.session.tourId);
    await persistSession(h.services, v.session);
    await h.approve("revoke_tour_access", { tourRef: ref, reason: "Need the unit back" });
    expect((await v.session.store.get("reservations", (await v.session.store.list("reservations")).find((r) => r.status === "REVOKED")!.id))!.status).toBe("REVOKED");
    expect((await v.session.reservation())!.id).toBe(pending.id);
    const again = await h.approve("revoke_tour_access", { tourRef: ref, reason: "Visitor asked to cancel Thursday" });
    expect(again.asked.summary).toBe(revokeConfirmQuestion("Riley Tester", "Unit 101", { time: "2:00 PM", day: "Thursday, Oct 1" }));
    expect(again.done.summary).toMatch(/called off/);
    expect((await v.session.store.get("reservations", pending.id))!.status).toBe("REVOKED");
    expect(lastFrom(v.session)).toBe(
      `Your tour at 2:00 PM on Thursday, Oct 1 has been called off, so the doors won't open for it. ${VisitorDenialCopy.remote(v.session.config.operator.name, v.session.config.operator.visitorContact)}`,
    );
  });
});

describe("defect 4: pause_tours cancel actually cancels the held rebook", () => {
  it("after the running tour is called off, cancel frees the Saturday slot", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const slot = new Date(at(10));
    const pending = await holdNextSlot(v.session, slot);
    await persistSession(h.services, v.session);
    const ref = tourRef(id, v.session.tourId);
    await h.approve("revoke_tour_access", { tourRef: ref, reason: "Need the unit back" });
    expect((await v.session.store.get("reservations", pending.id))!.status).toBe("READY");
    const asked = await h.ok("pause_tours", { property: id });
    expect(asked.bookedTours).toBe(1);
    const done = await h.ok("pause_tours", { property: id, bookedTours: "cancel", confirmationCode: asked.confirmation.code });
    expect(done.cancelled).toBe(1);
    expect(done.summary).toMatch(/1 booked tour was cancelled/);
    const cancelled = (await v.session.store.get("reservations", pending.id))!;
    expect(cancelled.status).toBe("CANCELLED");
    const audit = await v.session.store.listAudit();
    expect(audit.some((e) => e.type === "RESERVATION_CANCELLED" && e.reservationId === pending.id)).toBe(true);
    const { config } = h.workspace.load(id);
    expect(lastFrom(v.session)).toBe(
      bookedTourCalledOffText({
        team: config.operator.name,
        day: formatDay(slot, config.property.timezone),
        time: formatTime(slot, config.property.timezone),
        address: config.property.address,
        propertyWide: true,
      }),
    );
    const open = await v.session.core.availableSlots({ year: 2026, month: 9, day: 28 });
    expect(open.some((s) => s.start.getTime() === slot.getTime())).toBe(true);
  });

  it("mid-tour cancel cancels the held rebook, counts 1, texts once, and keeps the running tour", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const slot = new Date(at(10));
    const pending = await holdNextSlot(v.session, slot);
    const runningId = (await v.session.reservation())!.id;
    await persistSession(h.services, v.session);
    const beforeTexts = v.session.conversation.filter((c) => c.from === "tourcore").length;
    const asked = await h.ok("pause_tours", { property: id });
    expect(asked.bookedTours).toBe(1);
    const done = await h.ok("pause_tours", { property: id, bookedTours: "cancel", confirmationCode: asked.confirmation.code });
    expect(done.cancelled).toBe(1);
    expect(done.summary).toMatch(/1 booked tour was cancelled/);
    expect((await v.session.store.get("reservations", pending.id))!.status).toBe("CANCELLED");
    expect((await v.session.store.get("reservations", runningId))!.status).toBe("TOURING");
    expect((await v.session.reservation())!.id).toBe(runningId);
    const { config } = h.workspace.load(id);
    const expected = bookedTourCalledOffText({
      team: config.operator.name,
      day: formatDay(slot, config.property.timezone),
      time: formatTime(slot, config.property.timezone),
      address: config.property.address,
      propertyWide: true,
      touringNow: true,
    });
    expect(expected).toBe(
      "Sorry, the property team had to cancel your later tour at 10:00 AM on Monday, Sep 28. Your tour right now isn't affected. They'll text you when tours are back.",
    );
    const sent = v.session.conversation.filter((c) => c.from === "tourcore").slice(beforeTexts);
    expect(sent.filter((c) => c.text === expected)).toHaveLength(1);
    expect(lastFrom(v.session)).toBe(expected);
    const access = await v.session.core.requestAccess({
      reservationId: runningId,
      prospectId: v.session.prospectId!,
      doorId: "lobby_entrance",
    });
    expect(access.decision.allowed).toBe(true);
  });

  it("mid-tour cancel counts each visitor's future booking, not the running tour", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v1 = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const thursday = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 14, minute: 0 }, TZ);
    const held = await holdNextSlot(v1.session, thursday);
    const runningId = (await v1.session.reservation())!.id;
    const v2 = await h.visitor(id, { name: "Dana Visitor", phone: "555-010-3999" });
    const future = v2.session.offeredSlots.find((slot) => slot.start.getTime() > h.now()) ?? v2.session.offeredSlots.at(-1)!;
    await v2.act("chooseTime", { slotStart: future.start.toISOString() });
    await v2.act("consent", { agree: true });
    await v2.act("submitIdentity", { firstName: "Dana", lastName: "Visitor", email: "dana@example.com", phone: "555-010-3999" });
    const readyId = v2.session.reservationId!;
    await persistSession(h.services, v1.session);
    await persistSession(h.services, v2.session);
    const asked = await h.ok("pause_tours", { property: id });
    expect(asked.bookedTours).toBe(2);
    const done = await h.ok("pause_tours", { property: id, bookedTours: "cancel", confirmationCode: asked.confirmation.code });
    expect(done.cancelled).toBe(2);
    expect(done.summary).toMatch(/2 booked tours were cancelled/);
    expect((await v1.session.store.get("reservations", held.id))!.status).toBe("CANCELLED");
    expect((await v2.session.store.get("reservations", readyId))!.status).toBe("CANCELLED");
    expect((await v1.session.store.get("reservations", runningId))!.status).toBe("TOURING");
  });
});

describe("heal persisted called-off tour plus held rebook", () => {
  it("operator can revoke the held rebook and visitor texts route to it", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const pending = await holdNextSlot(v.session, new Date(at(10)));
    const runningId = v.session.reservationId!;
    await v.session.operatorChange((core, id) => core.revokeReservation(id, "called off"));
    expect(v.session.reservationId).toBe(runningId);
    expect(v.session.pendingBookingId).toBe(pending.id);
    expect((await v.session.store.get("reservations", runningId))!.status).toBe("REVOKED");
    await persistSession(h.services, v.session);
    const ref = tourRef(id, v.session.tourId);
    const inspected = await h.ok("inspect_tour", { tourRef: ref });
    expect(inspected.tour.status).toBe("Ready, waiting for arrival");
    expect(inspected.tour.tourTime).toBe("Monday, Sep 28, 10:00 AM\u201310:45 AM");
    await h.approve("revoke_tour_access", { tourRef: ref, reason: "Cancel the Saturday booking" });
    expect((await v.session.store.get("reservations", pending.id))!.status).toBe("REVOKED");
  });

  it("visitor texts on persisted stuck state go to the held rebook, or a new conversation if none", async () => {
    const withHeld = await touringWithRebook("heal-held");
    await withHeld.session.operatorChange((core, id) => core.revokeReservation(id, "called off"));
    expect(withHeld.session.reservationId).toBe(withHeld.runningId);
    expect(withHeld.session.pendingBookingId).toBe(withHeld.pending.id);
    await withHeld.say("HI");
    expect((await withHeld.session.reservation())!.id).toBe(withHeld.pending.id);
    expect(lastFrom(withHeld.session)).not.toBe(TOUR_ENDED_REPLY);

    const path = await smsStuckTour({ held: false });
    const beforeId = path.session.id;
    await path.text("HI");
    expect(path.session.id).not.toBe(beforeId);
    expect(lastFrom(path.session)).not.toBe(TOUR_ENDED_REPLY);
    expect(lastFrom(path.session).toLowerCase()).toMatch(/welcome|which unit|which day/);
  });
});

describe("nit: inspect_tour shows the extended end time", () => {
  it("after a 10-minute extension, tour time ends at 9:55 AM", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    await v.session.core.extendTourWindow(v.session.reservationId!, 10);
    await persistSession(h.services, v.session);
    const inspected = await h.ok("inspect_tour", { tourRef: tourRef(id, v.session.tourId) });
    expect(inspected.tour.tourTime).toBe("Monday, Sep 28, 9:00 AM\u20139:55 AM");
    expect(inspected.tour.accessGrants.every((g: { validUntil: string }) => g.validUntil === "Monday, Sep 28, 9:55 AM")).toBe(true);
  });
});

describe("should-fix: one-off overlap sees a held rebook", () => {
  it("refuses Dana for Testy's held Thursday slot and leaves no stray tour", async () => {
    const a = await liveApp({ cleanups });
    a.ws.recordDryTour(PROPERTY, { passed: true, ranAt: new Date(a.clock.t).toISOString(), checks: [], audit: [] });
    expect((await a.ws.publishDemoProperty(PROPERTY, new Date(a.clock.t))).published).toBe(true);
    await a.book();
    a.clock.t = at(14);
    await a.text("I'm here");
    const session = a.visitors.latestForPhone(PROPERTY, LIVE_PHONE, "messaging")!;
    const thursday = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 14, minute: 0 }, TZ);
    await holdNextSlot(session, thursday);
    await expect(
      a.grok("schedule_one_off_tour", {
        phone: "+15550109999",
        visitorName: "Dana",
        unit: "1A",
        startsAt: "Thursday, Oct 1 at 2:00 PM",
      }),
    ).rejects.toThrow("That time overlaps another tour.");
    const listed = await a.grok("list_active_tours");
    expect(listed.tours.map((t: { visitorName: string }) => t.visitorName)).not.toContain("Dana");
    expect(JSON.stringify(listed)).not.toMatch(/Choosing a time/);
    expect(listed.tours.some((t: { visitorName: string; status: string }) => t.visitorName.includes("Dana"))).toBe(false);
  });
});

describe("should-fix: reschedule_tour refuses a tour in progress", () => {
  it("refuses with a plain line when there is no later booking", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    expect(await h.fails("reschedule_tour", { visitor: "Riley", newStartsAt: "Friday, Oct 2 at 3:30 PM" })).toBe(
      tourInProgressCannotMove("Riley"),
    );
  });

  it("offers the later booking, and a yes moves that booking not the running tour", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const thursday = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 14, minute: 0 }, TZ);
    const pending = await holdNextSlot(v.session, thursday);
    const runningId = (await v.session.reservation())!.id;
    await persistSession(h.services, v.session);
    const asked = await h.ok("reschedule_tour", { visitor: "Riley", newStartsAt: "Friday, Oct 2 at 3:30 PM" });
    expect(asked.summary).toBe(moveLaterBookingInstead("Riley", "2:00 PM", "Thursday, Oct 1", "3:30 PM", "Friday, Oct 2"));
    const done = await h.ok("reschedule_tour", {
      visitor: "Riley",
      newStartsAt: "Friday, Oct 2 at 3:30 PM",
      confirmationCode: asked.confirmation.code,
    });
    expect(done.rescheduled).toBe(true);
    expect(done.summary).toBe(movedLaterBookingSummary("Riley", "3:30 PM", "Friday, Oct 2"));
    expect((await v.session.reservation())!.id).toBe(runningId);
    expect((await v.session.reservation())!.status).toBe("TOURING");
    const moved = (await v.session.store.get("reservations", pending.id))!;
    expect(new Date(moved.slotStart!).getTime()).toBe(zonedTimeToUtc({ year: 2026, month: 10, day: 2, hour: 15, minute: 30 }, TZ).getTime());
    const sent = v.session.conversation.filter((c) => c.from === "tourcore").map((c) => c.text);
    expect(sent.at(-1)).toContain("Your tour of Unit 101 has been moved to 3:30 PM on Friday, Oct 2.");
    expect(sent.at(-1)).toContain("You're all set.");
    expect(sent.join("\n")).not.toContain("Is it OK if I text you");
  });

  it("refuses a tour on operator hold the same way as a tour in progress", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    await v.session.operatorChange((core, reservationId) => core.placeOperatorHold(reservationId, "checking something"));
    await persistSession(h.services, v.session);
    expect(await h.fails("reschedule_tour", { visitor: "Riley", newStartsAt: "Friday, Oct 2 at 3:30 PM" })).toBe(
      tourInProgressCannotMove("Riley"),
    );
  });

  it("offers the later booking when the running tour is on operator hold", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const thursday = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 14, minute: 0 }, TZ);
    const pending = await holdNextSlot(v.session, thursday);
    await v.session.operatorChange((core, reservationId) => core.placeOperatorHold(reservationId, "checking something"));
    const runningId = (await v.session.reservation())!.id;
    await persistSession(h.services, v.session);
    const asked = await h.ok("reschedule_tour", { visitor: "Riley", newStartsAt: "Friday, Oct 2 at 3:30 PM" });
    expect(asked.summary).toBe(moveLaterBookingInstead("Riley", "2:00 PM", "Thursday, Oct 1", "3:30 PM", "Friday, Oct 2"));
    const done = await h.ok("reschedule_tour", {
      visitor: "Riley",
      newStartsAt: "Friday, Oct 2 at 3:30 PM",
      confirmationCode: asked.confirmation.code,
    });
    expect(done.summary).toBe(movedLaterBookingSummary("Riley", "3:30 PM", "Friday, Oct 2"));
    expect((await v.session.reservation())!.id).toBe(runningId);
    expect((await v.session.reservation())!.status).toBe("OPERATOR_HOLD");
    expect(new Date((await v.session.store.get("reservations", pending.id))!.slotStart!).getTime()).toBe(
      zonedTimeToUtc({ year: 2026, month: 10, day: 2, hour: 15, minute: 30 }, TZ).getTime(),
    );
  });

  it("refuses a tour on door failure the same way as a tour in progress", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await doorFailureVisitor(h, id, { name: "Riley Tester", phone: "555-010-2000" });
    await persistSession(h.services, v.session);
    expect(await h.fails("reschedule_tour", { visitor: "Riley", newStartsAt: "Friday, Oct 2 at 3:30 PM" })).toBe(
      tourInProgressCannotMove("Riley"),
    );
  });

  it("offers the later booking when the running tour is on door failure", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const thursday = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 14, minute: 0 }, TZ);
    const pending = await holdNextSlot(v.session, thursday);
    await markProviderFailure(v.session);
    const runningId = (await v.session.reservation())!.id;
    await persistSession(h.services, v.session);
    const asked = await h.ok("reschedule_tour", { visitor: "Riley", newStartsAt: "Friday, Oct 2 at 3:30 PM" });
    expect(asked.summary).toBe(moveLaterBookingInstead("Riley", "2:00 PM", "Thursday, Oct 1", "3:30 PM", "Friday, Oct 2"));
    const done = await h.ok("reschedule_tour", {
      visitor: "Riley",
      newStartsAt: "Friday, Oct 2 at 3:30 PM",
      confirmationCode: asked.confirmation.code,
    });
    expect(done.summary).toBe(movedLaterBookingSummary("Riley", "3:30 PM", "Friday, Oct 2"));
    expect((await v.session.reservation())!.id).toBe(runningId);
    expect((await v.session.reservation())!.status).toBe("PROVIDER_FAILURE");
    expect(new Date((await v.session.store.get("reservations", pending.id))!.slotStart!).getTime()).toBe(
      zonedTimeToUtc({ year: 2026, month: 10, day: 2, hour: 15, minute: 30 }, TZ).getTime(),
    );
  });

  it("names the destination and warns when the later move is outside hours", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const thursday = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 14, minute: 0 }, TZ);
    const pending = await holdNextSlot(v.session, thursday);
    const runningId = (await v.session.reservation())!.id;
    await persistSession(h.services, v.session);
    const asked = await h.ok("reschedule_tour", { visitor: "Riley", newStartsAt: "Friday, Oct 2 at 8:00 PM" });
    expect(asked.summary).toBe(moveLaterBookingOutsideHours("Riley", "2:00 PM", "Thursday, Oct 1", "8:00 PM", "Friday, Oct 2"));
    expect(asked.outsideHours).toBe(true);
    const done = await h.ok("reschedule_tour", {
      visitor: "Riley",
      newStartsAt: "Friday, Oct 2 at 8:00 PM",
      confirmationCode: asked.confirmation.code,
    });
    expect(done.rescheduled).toBe(true);
    expect(done.summary).toBe(movedLaterBookingSummary("Riley", "8:00 PM", "Friday, Oct 2"));
    expect((await v.session.reservation())!.id).toBe(runningId);
    expect((await v.session.reservation())!.status).toBe("TOURING");
    expect(new Date((await v.session.store.get("reservations", pending.id))!.slotStart!).getTime()).toBe(
      zonedTimeToUtc({ year: 2026, month: 10, day: 2, hour: 20, minute: 0 }, TZ).getTime(),
    );
  });

  it("YES after the running tour ends still moves the later booking the confirm targeted", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const thursday = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 14, minute: 0 }, TZ);
    const pending = await holdNextSlot(v.session, thursday);
    const ref = tourRef(id, v.session.tourId);
    await persistSession(h.services, v.session);
    const asked = await h.ok("reschedule_tour", { visitor: "Riley", newStartsAt: "Friday, Oct 2 at 3:30 PM" });
    await h.approve("revoke_tour_access", { tourRef: ref, reason: "Need the unit back" });
    const done = await h.ok("reschedule_tour", {
      visitor: "Riley",
      newStartsAt: "Friday, Oct 2 at 3:30 PM",
      confirmationCode: asked.confirmation.code,
    });
    expect(done.rescheduled).toBe(true);
    expect(done.summary).toBe(movedLaterBookingSummary("Riley", "3:30 PM", "Friday, Oct 2"));
    expect(new Date((await v.session.store.get("reservations", pending.id))!.slotStart!).getTime()).toBe(
      zonedTimeToUtc({ year: 2026, month: 10, day: 2, hour: 15, minute: 30 }, TZ).getTime(),
    );
  });
});

describe("should-fix: revoke result describes the called-off tour", () => {
  it("puts the held booking on nextBooking, not tour", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    await holdNextSlot(v.session, new Date(at(10)));
    await persistSession(h.services, v.session);
    const ref = tourRef(id, v.session.tourId);
    const done = await h.approve("revoke_tour_access", { tourRef: ref, reason: "Need the unit back" });
    expect(done.done.summary).toMatch(/called off/);
    expect(done.done.tour).toMatchObject({
      visitorName: "Riley Tester",
      status: "Called off",
      tourTime: "Monday, Sep 28, 9:00 AM\u20139:45 AM",
      nextBooking: { tourTime: "Monday, Sep 28, 10:00 AM\u201310:45 AM", status: "Ready, waiting for arrival" },
    });
    expect(done.done.tour.status).not.toBe("Ready, waiting for arrival");
  });
});

describe("blocker: mid-tour cancel-by-text targets the later booking", () => {
  async function testyMondayWithThursday() {
    const a = await liveApp({ cleanups });
    a.ws.recordDryTour(PROPERTY, { passed: true, ranAt: new Date(a.clock.t).toISOString(), checks: [], audit: [] });
    expect((await a.ws.publishDemoProperty(PROPERTY, new Date(a.clock.t))).published).toBe(true);
    await a.book();
    a.clock.t = at(14);
    await a.text("I'm here");
    const session = a.visitors.latestForPhone(PROPERTY, LIVE_PHONE, "messaging")!;
    const thursday = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 14, minute: 0 }, TZ);
    const pending = await holdNextSlot(session, thursday);
    return { a, session, pending, thursday, runningId: session.reservationId! };
  }

  async function runningUntouched(session: VisitorDemoSession, runningId: string, pendingId: string, pendingStatus: string) {
    const running = (await session.store.get("reservations", runningId))!;
    expect(running.id).toBe(runningId);
    expect(running.status).toBe("TOURING");
    expect((await session.reservation())!.id).toBe(runningId);
    expect((await session.store.get("reservations", pendingId))!.status).toBe(pendingStatus);
  }

  it("cancel my thursday tour asks the later confirm and leaves the running tour", async () => {
    const { a, session, pending, runningId } = await testyMondayWithThursday();
    const replies = await a.text("cancel my thursday tour");
    expect(replies.at(-1)).toBe(laterCancelConfirm("2:00 PM", "Thursday, Oct 1"));
    await runningUntouched(session, runningId, pending.id, "READY");
  });

  it("YES cancels only the later Thursday booking", async () => {
    const { a, session, pending, runningId } = await testyMondayWithThursday();
    await a.text("cancel my thursday tour");
    const replies = await a.text("YES");
    expect(replies.at(-1)).toBe(laterCancelDone("2:00 PM", "Thursday, Oct 1"));
    await runningUntouched(session, runningId, pending.id, "CANCELLED");
  });

  it("NO keeps the later Thursday booking", async () => {
    const { a, session, pending, runningId } = await testyMondayWithThursday();
    await a.text("cancel my thursday tour");
    const replies = await a.text("NO");
    expect(replies.at(-1)).toBe(laterCancelKept("2:00 PM", "Thursday, Oct 1"));
    await runningUntouched(session, runningId, pending.id, "READY");
  });

  it("bare cancel also targets the later booking", async () => {
    const { a, session, pending, runningId } = await testyMondayWithThursday();
    const replies = await a.text("cancel");
    expect(replies.at(-1)).toBe(laterCancelConfirm("2:00 PM", "Thursday, Oct 1"));
    await runningUntouched(session, runningId, pending.id, "READY");
  });

  it.each(["cancel my monday tour", "cancel today's tour", "cancel my 2pm tour", "cancel this tour", "cancel my current tour"])(
    "%s offers the later booking instead of cancelling the running tour",
    async (phrase) => {
      const { a, session, pending, runningId } = await testyMondayWithThursday();
      const replies = await a.text(phrase);
      expect(replies.at(-1)).toBe(cannotCancelRunningOfferLater("2:00 PM", "Thursday, Oct 1"));
      await runningUntouched(session, runningId, pending.id, "READY");
    },
  );

  it("YES after naming the running tour cancels only the later booking", async () => {
    const { a, session, pending, runningId } = await testyMondayWithThursday();
    await a.text("cancel this tour");
    const replies = await a.text("YES");
    expect(replies.at(-1)).toBe(laterCancelDone("2:00 PM", "Thursday, Oct 1"));
    await runningUntouched(session, runningId, pending.id, "CANCELLED");
  });

  it("NO after naming the running tour keeps the later booking", async () => {
    const { a, session, pending, runningId } = await testyMondayWithThursday();
    await a.text("cancel my current tour");
    const replies = await a.text("NO");
    expect(replies.at(-1)).toBe(laterCancelKept("2:00 PM", "Thursday, Oct 1"));
    await runningUntouched(session, runningId, pending.id, "READY");
  });

  it("YES after a door that opened directly cancels the later booking, not consent", async () => {
    const { a, session, pending, runningId } = await testyMondayWithThursday();
    await a.text("cancel");
    expect((await a.text("at unit 1a?")).at(-1)).not.toMatch(/Are you at/);
    expect((await session.reservation())!.status).toBe("TOURING");
    const replies = await a.text("YES");
    expect(replies.at(-1)).toBe(laterCancelDone("2:00 PM", "Thursday, Oct 1"));
    expect(replies.at(-1)).not.toMatch(/You're all set for your tour/);
    await runningUntouched(session, runningId, pending.id, "CANCELLED");
    expect((await session.store.get("reservations", pending.id))!.status).not.toBe("READY");
  });

  it("YES while a newer door question is open opens the door and does not cancel", async () => {
    const ctx = await touringWithRebook("cancel-door-yes");
    const later = new Date(ctx.pending.slotStart!);
    await ctx.say("cancel");
    expect(lastFrom(ctx.session)).toBe(laterCancelConfirm(formatTime(later, TZ), formatDay(later, TZ)));
    await ctx.say("can you open 101?");
    expect(lastFrom(ctx.session)).toMatch(/^Are you at Unit 101 now\?/);
    const before = ctx.session.durin.requestCount;
    await ctx.say("YES");
    expect((await ctx.session.reservation())!.id).toBe(ctx.runningId);
    expect((await ctx.session.reservation())!.status).toBe("TOURING");
    expect(ctx.session.lastAccess).toMatchObject({ doorId: "unit_101", allowed: true });
    expect(ctx.session.durin.requestCount).toBeGreaterThan(before);
    expect((await ctx.session.store.get("reservations", ctx.pending.id))!.status).toBe("READY");
  });
});

describe("nit: one-off overlap uses the extended window end", () => {
  it("refuses Dana at 2:45 and 2:50 after the tour now ends at 2:55 PM", async () => {
    const a = await liveApp({ cleanups });
    a.ws.recordDryTour(PROPERTY, { passed: true, ranAt: new Date(a.clock.t).toISOString(), checks: [], audit: [] });
    expect((await a.ws.publishDemoProperty(PROPERTY, new Date(a.clock.t))).published).toBe(true);
    await a.book();
    a.clock.t = at(14);
    await a.text("I'm here");
    const session = a.visitors.latestForPhone(PROPERTY, LIVE_PHONE, "messaging")!;
    await session.core.extendTourWindow(session.reservationId!, 10);
    expect(formatTime(new Date((await session.reservation())!.windowEnd!), TZ)).toBe("2:55 PM");
    await expect(
      a.grok("schedule_one_off_tour", { phone: "+15550109999", visitorName: "Dana", unit: "1A", startsAt: "today at 2:45 PM" }),
    ).rejects.toThrow("That time overlaps another tour.");
    await expect(
      a.grok("schedule_one_off_tour", { phone: "+15550109999", visitorName: "Dana", unit: "1A", startsAt: "today at 2:50 PM" }),
    ).rejects.toThrow("That time overlaps another tour.");
  });
});

describe("blocker: bare cancel on hold or door failure is cancel, not STOP", () => {
  const HOLD_LATER =
    "You can't cancel the tour you're on, but you're free to wrap up whenever you like. The property team is still working on the problem and will text you here. Your later tour at 2:00 PM on Friday, Oct 2 is still booked. Want me to cancel that one instead? Reply YES or NO.";

  it("bare cancel on hold with a later booking asks the later-cancel line", async () => {
    const ctx = await touringWithRebook("cancel-hold-later");
    await ctx.session.operatorChange((core, id) => core.placeOperatorHold(id, "checking something"));
    expect((await ctx.session.reservation())!.status).toBe("OPERATOR_HOLD");
    await ctx.say("cancel");
    expect(lastFrom(ctx.session)).toBe(laterCancelConfirm("2:00 PM", "Friday, Oct 2"));
    expect((await ctx.session.reservation())!.status).toBe("OPERATOR_HOLD");
    expect((await ctx.session.store.get("reservations", ctx.pending.id))!.status).toBe("READY");
    expect(ctx.session.optedOut).toBe(false);
    await ctx.say("hi");
    expect(lastFrom(ctx.session).length).toBeGreaterThan(0);
    expect(ctx.session.optedOut).toBe(false);
  });

  it("naming the running tour on hold offers the later booking with the working-on-problem sentence", async () => {
    const ctx = await touringWithRebook("cancel-hold-named");
    await ctx.session.operatorChange((core, id) => core.placeOperatorHold(id, "checking something"));
    await ctx.say("cancel this tour");
    expect(lastFrom(ctx.session)).toBe(HOLD_LATER);
    expect(lastFrom(ctx.session)).toBe(cannotCancelRunningOfferLater("2:00 PM", "Friday, Oct 2", "property team"));
    expect((await ctx.session.reservation())!.status).toBe("OPERATOR_HOLD");
    expect((await ctx.session.store.get("reservations", ctx.pending.id))!.status).toBe("READY");
    expect(ctx.session.optedOut).toBe(false);
  });

  it("bare cancel on door failure with a later booking asks the later-cancel line", async () => {
    const ctx = await touringWithRebook("cancel-fail-later");
    ctx.session.durin.failNextRequest("door controller timeout");
    await ctx.say("I'm at 101");
    expect((await ctx.session.reservation())!.status).toBe("PROVIDER_FAILURE");
    await ctx.say("cancel");
    expect(lastFrom(ctx.session)).toBe(laterCancelConfirm("2:00 PM", "Friday, Oct 2"));
    expect((await ctx.session.reservation())!.status).toBe("PROVIDER_FAILURE");
    expect((await ctx.session.store.get("reservations", ctx.pending.id))!.status).toBe("READY");
    expect(ctx.session.optedOut).toBe(false);
    await ctx.say("hi");
    expect(lastFrom(ctx.session).length).toBeGreaterThan(0);
    expect(ctx.session.optedOut).toBe(false);
  });

  it("naming the running tour on door failure offers the later booking with the working-on-problem sentence", async () => {
    const ctx = await touringWithRebook("cancel-fail-named");
    ctx.session.durin.failNextRequest("door controller timeout");
    await ctx.say("I'm at 101");
    expect((await ctx.session.reservation())!.status).toBe("PROVIDER_FAILURE");
    await ctx.say("cancel this tour");
    expect(lastFrom(ctx.session)).toBe(HOLD_LATER);
    expect((await ctx.session.reservation())!.status).toBe("PROVIDER_FAILURE");
    expect((await ctx.session.store.get("reservations", ctx.pending.id))!.status).toBe("READY");
    expect(ctx.session.optedOut).toBe(false);
  });
});

describe("should-fix: pause_tours counts each cancelled booking, not each tour", () => {
  it("skips a past no-show sitting next to a later booking that is cancelled", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const missedVisitor = await h.visitor(id, { name: "Pat Smith", phone: "555-010-2000" });
    const two = missedVisitor.session.offeredSlots.find((slot) => slot.label.includes("2:00"));
    await missedVisitor.act("chooseTime", { slotStart: (two?.start ?? missedVisitor.slot()).toISOString() });
    await missedVisitor.act("consent", { agree: true });
    await missedVisitor.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "555-010-2000" });
    const missed = (await missedVisitor.session.reservation())!;
    expect(missed.status).toBe("READY");
    const kept = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2111" });
    const thursday = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 14, minute: 0 }, TZ);
    const later = await holdNextSlot(kept.session, thursday);
    h.setClock(at(15, 30));
    await persistSession(h.services, missedVisitor.session);
    await persistSession(h.services, kept.session);
    const asked = await h.ok("pause_tours", { property: id });
    expect(asked.bookedTours).toBe(1);
    const done = await h.ok("pause_tours", { property: id, bookedTours: "cancel", confirmationCode: asked.confirmation.code });
    expect(done.cancelled).toBe(1);
    expect((await missedVisitor.session.store.get("reservations", missed.id))!.status).toBe("READY");
    expect((await kept.session.store.get("reservations", later.id))!.status).toBe("CANCELLED");
  });

  it("counts 0 for a booking cancelled after the snapshot and 1 for another visitor's real cancel", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const stale = await h.visitor(id, { name: "Pat Smith", phone: "555-010-2000" });
    const two = stale.session.offeredSlots.find((slot) => slot.label.includes("2:00"));
    await stale.act("chooseTime", { slotStart: (two?.start ?? stale.slot()).toISOString() });
    await stale.act("consent", { agree: true });
    await stale.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "555-010-2000" });
    const staleId = (await stale.session.reservation())!.id;
    const real = await h.visitor(id, { name: "Riley Tester", phone: "555-010-2111" });
    const three = real.session.offeredSlots.find((slot) => slot.label.includes("3:00"));
    await real.act("chooseTime", { slotStart: (three?.start ?? real.slot()).toISOString() });
    await real.act("consent", { agree: true });
    await real.act("submitIdentity", { firstName: "Riley", lastName: "Tester", email: "riley@example.com", phone: "555-010-2111" });
    const realId = (await real.session.reservation())!.id;
    await persistSession(h.services, stale.session);
    await persistSession(h.services, real.session);
    const snapshot = await bookedTours(h.services, id);
    expect(snapshot).toHaveLength(2);
    await stale.session.operatorChange((core, reservationId) =>
      core.cancelBookedTour(reservationId, { reason: "cancelled after snapshot", propertyWide: false }),
    );
    expect((await stale.session.store.get("reservations", staleId))!.status).toBe("CANCELLED");
    const cancelled = await cancelBooked(h.services, snapshot, true, "tours paused");
    expect(cancelled).toBe(1);
    expect((await stale.session.store.get("reservations", staleId))!.status).toBe("CANCELLED");
    expect((await real.session.store.get("reservations", realId))!.status).toBe("CANCELLED");
  });
});

describe("nit: pause-cancel mid-tour copy covers hold and provider failure", () => {
  it("uses the touring-now cancel text while the running tour is on operator hold", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const slot = new Date(at(10));
    const pending = await holdNextSlot(v.session, slot);
    const runningId = (await v.session.reservation())!.id;
    await v.session.operatorChange((core, reservationId) => core.placeOperatorHold(reservationId, "checking something"));
    expect((await v.session.store.get("reservations", runningId))!.status).toBe("OPERATOR_HOLD");
    await persistSession(h.services, v.session);
    const asked = await h.ok("pause_tours", { property: id });
    const done = await h.ok("pause_tours", { property: id, bookedTours: "cancel", confirmationCode: asked.confirmation.code });
    expect(done.cancelled).toBe(1);
    expect((await v.session.store.get("reservations", pending.id))!.status).toBe("CANCELLED");
    expect((await v.session.store.get("reservations", runningId))!.status).toBe("OPERATOR_HOLD");
    const { config } = h.workspace.load(id);
    expect(lastFrom(v.session)).toBe(
      bookedTourCalledOffText({
        team: config.operator.name,
        day: formatDay(slot, config.property.timezone),
        time: formatTime(slot, config.property.timezone),
        address: config.property.address,
        propertyWide: true,
        touringNow: true,
      }),
    );
  });

  it("uses the touring-now cancel text while the running tour is on door failure", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const slot = new Date(at(10));
    const pending = await holdNextSlot(v.session, slot);
    const runningId = (await v.session.reservation())!.id;
    await markProviderFailure(v.session);
    expect((await v.session.store.get("reservations", runningId))!.status).toBe("PROVIDER_FAILURE");
    await persistSession(h.services, v.session);
    const asked = await h.ok("pause_tours", { property: id });
    const done = await h.ok("pause_tours", { property: id, bookedTours: "cancel", confirmationCode: asked.confirmation.code });
    expect(done.cancelled).toBe(1);
    expect((await v.session.store.get("reservations", pending.id))!.status).toBe("CANCELLED");
    expect((await v.session.store.get("reservations", runningId))!.status).toBe("PROVIDER_FAILURE");
    const { config } = h.workspace.load(id);
    expect(lastFrom(v.session)).toBe(
      bookedTourCalledOffText({
        team: config.operator.name,
        day: formatDay(slot, config.property.timezone),
        time: formatTime(slot, config.property.timezone),
        address: config.property.address,
        propertyWide: true,
        touringNow: true,
      }),
    );
    expect(lastFrom(v.session)).toContain("Your tour right now isn't affected.");
  });
});

describe("nit: pause_tours cancel skips a READY no-show", () => {
  it("does not cancel or text a 2:00 booking when the clock is 3:30", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.visitor(id, { name: "Pat Smith", phone: "555-010-2000" });
    const two = v.session.offeredSlots.find((slot) => slot.label.includes("2:00"));
    await v.act("chooseTime", { slotStart: (two?.start ?? v.slot()).toISOString() });
    await v.act("consent", { agree: true });
    await v.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "555-010-2000" });
    expect((await v.session.reservation())!.status).toBe("READY");
    h.setClock(at(15, 30));
    await persistSession(h.services, v.session);
    const before = lastFrom(v.session);
    const asked = await h.ok("pause_tours", { property: id });
    expect(asked.bookedTours).toBe(0);
    const done = await h.ok("pause_tours", { property: id, confirmationCode: asked.confirmation.code });
    expect(done.cancelled ?? 0).toBe(0);
    expect((await v.session.reservation())!.status).toBe("READY");
    expect(lastFrom(v.session)).toBe(before);
  });
});

describe("should-fix: visitor moved-to copy is time then day", () => {
  it("texts Your tour of Unit 1A has been moved to 3:30 PM on Friday, Oct 2", async () => {
    const a = await liveApp({ cleanups });
    a.ws.recordDryTour(PROPERTY, { passed: true, ranAt: new Date(a.clock.t).toISOString(), checks: [], audit: [] });
    expect((await a.ws.publishDemoProperty(PROPERTY, new Date(a.clock.t))).published).toBe(true);
    await a.book();
    const asked = await a.grok("reschedule_tour", { visitor: "Testy", newStartsAt: "Friday, Oct 2 at 3:30 PM" });
    await a.grok("reschedule_tour", {
      visitor: "Testy",
      newStartsAt: "Friday, Oct 2 at 3:30 PM",
      confirmationCode: asked.confirmation.code,
    });
    expect(a.fake.sent.filter((message) => message.number === LIVE_PHONE).at(-1)!.content).toBe(
      `${tourMovedToText("Unit 1A", "3:30 PM", "Friday, Oct 2")} You're all set.`,
    );
  });
});

async function smsStuckTour(options: { held: boolean }) {
  const clock = { t: zonedTimeToUtc({ ...TOUR_DAY, hour: 9, minute: 0 }, TZ).getTime() };
  const root = mkdtempSync(join(tmpdir(), "tourcore-heal-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const ws = new PropertyWorkspace(root);
  const { config } = ws.save(loadConfig());
  ws.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(clock.t) }));
  const runtime = new MemoryRuntimeStore();
  const endpoints = new MessagingEndpoints(runtime);
  endpoints.attach({ address: LINE, provider: "demo", propertyId: PROPERTY });
  const registry = new VisitorDemoRegistry();
  const router = new MessagingConversations({
    workspace: ws,
    registry,
    runtime,
    endpoints,
    transport: () => new DemoMessagingAdapter(() => {}, "MESSAGING"),
    links: new VerificationLinks({ baseUrl: () => undefined }),
    realNow: () => clock.t,
    now: () => new Date(clock.t),
    defaultLine: () => LINE,
    consentMode: () => "disabled",
  });
  let n = 0;
  const text = async (body: string) => {
    await router.receive({
      provider: "test",
      providerMessageId: `heal_${++n}`,
      from: PHONE,
      to: LINE,
      text: body,
      channel: "SMS",
      receivedAt: new Date(clock.t).toISOString(),
    });
  };
  await text("TOUR");
  await text("YES");
  await text("1");
  await text("1");
  await text("1");
  await text("yes");
  const session = () => registry.latestForPhone(PROPERTY, PHONE, "messaging")!;
  await session().act("submitIdentity", { firstName: "Riley", lastName: "Tester", email: "riley@example.com", phone: PHONE });
  const booked = (await session().reservation())!;
  clock.t = Date.parse(booked.slotStart!);
  await text("I'm here");
  if (options.held) {
    await holdNextSlot(session(), zonedTimeToUtc({ year: 2026, month: 10, day: 2, hour: 14, minute: 0 }, TZ));
  }
  await session().operatorChange((core, id) => core.revokeReservation(id, "called off"));
  await router.save(session());
  return {
    get session() {
      return session();
    },
    text,
  };
}
