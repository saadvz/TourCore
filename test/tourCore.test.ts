import { describe, expect, it } from "vitest";
import { ExportBundleSchema } from "../src/export/exportBundle";
import { basicForm, bookTour, minutesFrom, setup } from "./helpers";

describe("Tour Core journey", () => {
  it("happy path: Entrance -> Unit 101 succeeds and calls Durin for each door", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    expect(tour.reservation.status).toBe("READY");
    ctx.clock.set(minutesFrom(tour.slotStart, -3));

    const entrance = await tour.request("entrance");
    const unit = await tour.request("unit_101");

    expect(entrance).toMatchObject({ durinCalled: true, decision: { code: "ALLOW" } });
    expect(unit).toMatchObject({ durinCalled: true, decision: { code: "ALLOW" } });
    expect(ctx.durin.calls.requestAccess.map((c) => c.doorId)).toEqual(["entrance", "unit_101"]);
    expect((await ctx.core.getReservation(tour.reservation.id))?.status).toBe("TOURING");

    const done = await ctx.core.completeTour(tour.reservation.id);
    expect(done.status).toBe("COMPLETED");
    expect(ctx.durin.calls.revokeAccess).toHaveLength(2);

    const types = (await ctx.core.auditTrail()).map((e) => e.type);
    for (const t of ["PROSPECT_CREATED", "RESERVATION_CREATED", "CONSENT_RECORDED", "VERIFICATION_COMPLETED", "TOUR_READY", "ACCESS_REQUESTED", "ACCESS_ALLOWED", "TOUR_STARTED", "TOUR_COMPLETED", "FOLLOW_UP_SENT"] as const) {
      expect(types).toContain(t);
    }
    const bundle = ExportBundleSchema.parse(JSON.parse(JSON.stringify(await ctx.core.exportRecords())));
    expect(bundle.accessGrants.every((g) => g.status === "REVOKED")).toBe(true);
  });

  it("wrong route: Unit 102 is denied and Durin is not called", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    ctx.clock.set(tour.slotStart);
    await tour.request("entrance");

    const out = await tour.request("unit_102");
    expect(out).toMatchObject({ durinCalled: false, decision: { allowed: false, code: "DENY_WRONG_ROUTE" } });
    expect(ctx.durin.calls.requestAccess.map((c) => c.doorId)).toEqual(["entrance"]);
  });

  it("too early and expired are denied without calling Durin", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);

    ctx.clock.set(minutesFrom(tour.slotStart, -30));
    expect((await tour.request("entrance")).decision.code).toBe("DENY_TOO_EARLY");

    ctx.clock.set(minutesFrom(tour.slotStart, 60));
    expect((await tour.request("entrance")).decision.code).toBe("DENY_EXPIRED");
    expect(ctx.durin.calls.requestAccess).toHaveLength(0);
  });

  it("revoked reservation is denied and its grants are revoked in Durin", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    ctx.clock.set(tour.slotStart);
    await tour.request("entrance");

    await ctx.core.revokeReservation(tour.reservation.id, "operator cancelled");
    expect(ctx.durin.calls.revokeAccess).toHaveLength(1);
    expect((await tour.request("unit_101")).decision.code).toBe("DENY_REVOKED");
    expect(ctx.durin.calls.requestAccess).toHaveLength(1);
  });

  it("verification incomplete is denied", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx, "awaiting-verification");
    ctx.clock.set(tour.slotStart);
    expect((await tour.request("entrance")).decision.code).toBe("DENY_VERIFICATION_INCOMPLETE");
    expect(ctx.durin.calls.requestAccess).toHaveLength(0);
  });

  it("form with a different phone number fails verification", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx, "awaiting-verification");
    const r = await ctx.core.submitVerification(tour.reservation.id, basicForm("555-999-0000"));
    expect(r.status).toBe("VERIFICATION_FAILED");
  });

  it("operator hold is denied, and resuming restores access", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    ctx.clock.set(tour.slotStart);

    await ctx.core.placeOperatorHold(tour.reservation.id, "checking something");
    expect((await tour.request("entrance")).decision.code).toBe("DENY_OPERATOR_HOLD");
    expect(ctx.durin.calls.requestAccess).toHaveLength(0);

    await ctx.core.resumeReservation(tour.reservation.id);
    expect((await tour.request("entrance")).decision.code).toBe("ALLOW");
  });

  it("Durin unhealthy fails closed without sending a request", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    ctx.clock.set(tour.slotStart);
    ctx.durin.setHealthy(false, "controller offline");

    const out = await tour.request("entrance");
    expect(out).toMatchObject({ durinCalled: false, decision: { allowed: false, code: "DENY_DURIN_UNHEALTHY" } });
    expect(ctx.durin.calls.requestAccess).toHaveLength(0);
  });

  it("Durin failure becomes a safe denial and pauses the tour", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    ctx.clock.set(tour.slotStart);
    ctx.durin.failNextRequest("door controller timeout");

    expect((await tour.request("entrance")).decision.code).toBe("DENY_PROVIDER_FAILURE");
    expect((await ctx.core.getReservation(tour.reservation.id))?.status).toBe("PROVIDER_FAILURE");
    expect((await tour.request("entrance")).durinCalled).toBe(false);
  });

  it("duplicate access requests create one grant and one Durin call", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    ctx.clock.set(tour.slotStart);

    const [a, b, c] = await Promise.all([tour.request("entrance"), tour.request("entrance"), tour.request("entrance")]);
    const again = await tour.request("entrance");

    expect([a, b, c, again].every((o) => o.decision.allowed)).toBe(true);
    expect(again.reusedGrant).toBe(true);
    expect(ctx.durin.calls.requestAccess).toHaveLength(1);
    expect(await ctx.core.listGrants(tour.reservation.id)).toHaveLength(1);
  });

  it("duplicate booking replies create no second reservation", async () => {
    const ctx = setup();
    const first = await ctx.core.startInquiry({ name: "Jane Smith", phone: "5550101234", unitId: "apt_101" });
    const second = await ctx.core.startInquiry({ name: "Jane Smith", phone: "(555) 010-1234", unitId: "apt_101" });
    expect(second.reservation.id).toBe(first.reservation.id);

    const slot = (await ctx.core.availableSlots())[0]!;
    await ctx.core.reserveSlot(first.reservation.id, slot.start.toISOString());
    const replay = await ctx.core.reserveSlot(first.reservation.id, slot.start.toISOString());
    expect(replay.status).toBe("AWAITING_CONSENT");
    expect((await ctx.core.auditTrail()).filter((e) => e.type === "RESERVATION_CREATED")).toHaveLength(1);
  });

  it("repeat tour on another day reuses the prospect and prior verification", async () => {
    const ctx = setup();
    const first = await bookTour(ctx);
    ctx.clock.set(first.slotStart);
    await first.request("entrance");
    await ctx.core.completeTour(first.reservation.id);

    const second = await bookTour(ctx, "awaiting-verification", { year: 2026, month: 9, day: 29 });
    expect(second.prospect.id).toBe(first.prospect.id);
    expect(second.reservation.status).toBe("READY");
    expect(second.reservation.verificationId).toBe(first.reservation.verificationId);
  });
});
