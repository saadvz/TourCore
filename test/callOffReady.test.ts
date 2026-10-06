import { afterEach, describe, expect, it } from "vitest";
import { TOUR_ENDED_REPLY } from "../src/core/TourCore";
import { zonedTimeToUtc } from "../src/core/timezone";
import { persistSession } from "../src/operator/services";
import { tourRef } from "../src/operator/tours";
import { handleVisitorText } from "../src/visitor/conversation";
import { at, grokHarness } from "./grokHarness";

const TZ = "America/New_York";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function lastFrom(session: { conversation: readonly { from: string; text: string }[] }): string {
  return session.conversation.filter((c) => c.from === "tourcore").map((c) => c.text).at(-1) ?? "";
}

describe("call-off and Ready cannot disagree", () => {
  it("revoke of a Ready booking stays called off, and hi is the ended-tour reply", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.visitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const [first, last] = "Riley Tester".split(" ");
    await v.act("chooseTime", { slotStart: v.slot().toISOString() });
    await v.act("consent", { agree: true });
    await v.act("submitIdentity", { firstName: first, lastName: last, email: "riley@example.com", phone: "555-010-2000" });
    const ready = (await v.session.reservation())!;
    expect(ready.status).toBe("READY");
    const ref = tourRef(id, v.session.tourId);
    await persistSession(h.services, v.session);
    await h.approve("revoke_tour_access", { tourRef: ref, reason: "Called off" });
    expect((await v.session.store.get("reservations", ready.id))!.status).toBe("REVOKED");
    const inspected = await h.ok("inspect_tour", { tourRef: ref });
    expect(inspected.tour.status).toBe("Called off");
    expect(inspected.tour.status).not.toMatch(/Ready/);
    const listed = await h.ok("list_active_tours");
    expect(listed.tours.some((tour: { status: string }) => /Ready/.test(tour.status))).toBe(false);
    await handleVisitorText(v.session, "555-010-2000", "hi", { provider: "test", providerMessageId: "hi-ready" });
    expect(lastFrom(v.session)).toBe(TOUR_ENDED_REPLY);
    expect((await v.session.store.get("reservations", ready.id))!.status).toBe("REVOKED");
  });

  it("a Saturday Ready booking that is not the held rebook is called off with the running tour", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const current = (await v.session.reservation())!;
    const saturday = zonedTimeToUtc({ year: 2026, month: 10, day: 10, hour: 10, minute: 0 }, TZ);
    const length = v.session.config.tourHours.tourLengthMinutes * 60_000;
    const early = v.session.config.tourHours.earlyArrivalMinutes * 60_000;
    await v.session.store.put("reservations", {
      ...current,
      id: "rsv_sat_ready",
      status: "READY",
      slotStart: saturday.toISOString(),
      windowStart: new Date(saturday.getTime() - early).toISOString(),
      windowEnd: new Date(saturday.getTime() + length).toISOString(),
      updatedAt: new Date(at(9)).toISOString(),
    });
    expect(v.session.pendingBookingId).toBeUndefined();
    const ref = tourRef(id, v.session.tourId);
    await persistSession(h.services, v.session);
    await h.approve("revoke_tour_access", { tourRef: ref, reason: "Called off" });
    expect((await v.session.store.get("reservations", current.id))!.status).toBe("REVOKED");
    expect((await v.session.store.get("reservations", "rsv_sat_ready"))!.status).toBe("REVOKED");
    const inspected = await h.ok("inspect_tour", { tourRef: ref });
    expect(inspected.tour.status).toBe("Called off");
    expect(inspected.tour.status).not.toMatch(/Ready/);
    expect(inspected.tour.tourTime ?? "").not.toContain("Saturday, Oct 10");
    const listed = await h.ok("list_active_tours");
    expect(listed.tours.some((tour: { status: string }) => /Ready/.test(tour.status))).toBe(false);
    await handleVisitorText(v.session, "555-010-2000", "hi", { provider: "test", providerMessageId: "hi-sat" });
    expect(lastFrom(v.session)).toBe(TOUR_ENDED_REPLY);
    expect((await v.session.store.get("reservations", "rsv_sat_ready"))!.status).not.toBe("READY");
  });

  it("a held rebook that is already Ready stays, and hi is not the ended-tour reply", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const current = (await v.session.reservation())!;
    const later = new Date(at(10));
    v.session.rebookUnitId = current.unitId;
    await v.session.confirmRebook(later.toISOString());
    const pending = (await v.session.pendingBooking())!;
    await v.session.answerPendingConsent(true, { text: "yes" });
    expect((await v.session.store.get("reservations", pending.id))!.status).toBe("READY");
    const ref = tourRef(id, v.session.tourId);
    await persistSession(h.services, v.session);
    await h.approve("revoke_tour_access", { tourRef: ref, reason: "Need the unit back" });
    expect((await v.session.store.get("reservations", current.id))!.status).toBe("REVOKED");
    expect((await v.session.store.get("reservations", pending.id))!.status).toBe("READY");
    expect((await v.session.reservation())!.id).toBe(pending.id);
    const inspected = await h.ok("inspect_tour", { tourRef: ref });
    expect(inspected.tour.status).toBe("Ready, waiting for arrival");
    await handleVisitorText(v.session, "555-010-2000", "hi", { provider: "test", providerMessageId: "hi-held" });
    expect(lastFrom(v.session)).not.toBe(TOUR_ENDED_REPLY);
    expect((await v.session.reservation())!.status).toBe("READY");
  });

  it("a stale consent write cannot bring a called-off booking back to Ready", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id, { name: "Riley Tester", phone: "555-010-2000" });
    const current = (await v.session.reservation())!;
    v.session.rebookUnitId = current.unitId;
    await v.session.confirmRebook(new Date(at(10)).toISOString());
    const pending = (await v.session.pendingBooking())!;
    expect(pending.status).toBe("AWAITING_CONSENT");
    const stale = { ...pending };
    await v.session.operatorChange((core, reservationId) => core.revokeReservation(reservationId, "called off"), pending.id);
    expect((await v.session.store.get("reservations", pending.id))!.status).toBe("REVOKED");
    const store = v.session.store;
    const realGet = store.get.bind(store);
    let reads = 0;
    store.get = (async (collection, reservationId) => {
      if (collection === "reservations" && reservationId === pending.id && reads++ === 0) return stale;
      return realGet(collection, reservationId);
    }) as typeof store.get;
    const before = (await store.list("messages")).length;
    await v.session.core.recordConsent(pending.id, true);
    store.get = realGet;
    expect((await realGet("reservations", pending.id))!.status).toBe("REVOKED");
    const added = (await store.list("messages")).slice(before).map((message) => message.body).join("\n");
    expect(added).not.toContain("You're all set");
  });
});
