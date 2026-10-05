import { afterEach, describe, expect, it } from "vitest";
import {
  bookedTourCalledOffText,
  pauseConfirmQuestion,
  pausedPropertyVisitorText,
  pausedUnitVisitorText,
  REMOVE_REFUSED_LIVE_TOUR,
  removeConfirmQuestion,
  resumeConfirmQuestion,
} from "../src/core/availabilityCopy";
import { formatDay, formatTime } from "../src/core/timezone";
import { formatPhone } from "../src/core/phone";
import { createTourCore } from "../src/createTourCore";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import { MessagingEndpoints } from "../src/messaging/endpoints";
import { MemoryRuntimeStore } from "../src/storage/runtimeStore";
import { VisitorDemoSession } from "../src/visitor/session";
import { MessagingConversations } from "../src/visitor/messagingRouter";
import { VerificationLinks } from "../src/visitor/verificationLinks";
import { readAvailabilityEvents } from "../src/operator/availability";
import { tourRef } from "../src/operator/tours";
import { grokHarness, type GrokHarness } from "./grokHarness";
import { bookTour, setup } from "./helpers";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

function app(): GrokHarness {
  const h = grokHarness();
  cleanups.push(h.cleanup);
  return h;
}

function lastFrom(session: VisitorDemoSession, from: "tourcore" | "visitor" = "tourcore"): string {
  return [...session.conversation].reverse().find((item) => item.from === from)?.text ?? "";
}

async function readyVisitor(h: GrokHarness, propertyId: string, options: { name?: string; phone?: string; unitId?: string } = {}) {
  const v = await h.visitor(propertyId, options);
  const [first, last] = (options.name ?? "Pat Smith").split(" ");
  await v.act("chooseTime", { slotStart: v.slot().toISOString() });
  await v.act("consent", { agree: true });
  await v.act("submitIdentity", { firstName: first, lastName: last, email: "pat@example.com", phone: options.phone ?? "555-010-2000" });
  return v;
}

describe("availability copy", () => {
  it("uses the approved paused-property lines, with and without a visitor help number", () => {
    expect(pausedPropertyVisitorText("100 Alfred Way", "leasing team", "+15550109999")).toBe(
      "Tours at 100 Alfred Way are paused right now. The leasing team will text you when they're back, or call (555) 010-9999.",
    );
    expect(pausedPropertyVisitorText("100 Alfred Way", "leasing team")).toBe(
      "Tours at 100 Alfred Way are paused right now. The leasing team will text you when they're back.",
    );
    expect(pausedPropertyVisitorText("100 Alfred Way", "leasing team")).not.toContain("or call");
  });

  it("uses the approved paused-unit line", () => {
    expect(pausedUnitVisitorText("Unit 101")).toBe("Unit 101 isn't open for tours right now.");
  });

  it("uses the approved booked-tour cancel lines", () => {
    expect(bookedTourCalledOffText({ team: "leasing team", day: "Monday, Sep 28", time: "9:00 AM", address: "100 Alfred Way", propertyWide: false })).toBe(
      "Sorry, the leasing team had to cancel your Monday, Sep 28 at 9:00 AM tour at 100 Alfred Way. Text me anytime to book another.",
    );
    expect(bookedTourCalledOffText({ team: "leasing team", day: "Monday, Sep 28", time: "9:00 AM", address: "100 Alfred Way", propertyWide: true })).toBe(
      "Sorry, the leasing team had to cancel your Monday, Sep 28 at 9:00 AM tour at 100 Alfred Way. They'll text you when tours are back.",
    );
  });

  it("uses the approved operator pause and remove questions", () => {
    expect(pauseConfirmQuestion("100 Alfred Way", 2)).toBe(
      "Pause tours at 100 Alfred Way? New bookings stop now. 2 booked tours: keep them or cancel them with a text? Any tour in progress will finish.",
    );
    expect(pauseConfirmQuestion("100 Alfred Way", 1)).toBe(
      "Pause tours at 100 Alfred Way? New bookings stop now. 1 booked tour: keep them or cancel them with a text? Any tour in progress will finish.",
    );
    expect(pauseConfirmQuestion("100 Alfred Way", 0)).toBe(
      "Pause tours at 100 Alfred Way? New bookings stop now. Any tour in progress will finish. Pause it?",
    );
    expect(removeConfirmQuestion("100 Alfred Way", 2)).toBe(
      "Remove 100 Alfred Way? Tours stop, 2 booked visitors get a cancel text, and it leaves your list. Its records are kept. Remove it?",
    );
    expect(removeConfirmQuestion("100 Alfred Way", 1)).toBe(
      "Remove 100 Alfred Way? Tours stop, 1 booked visitor get a cancel text, and it leaves your list. Its records are kept. Remove it?",
    );
    expect(REMOVE_REFUSED_LIVE_TOUR).toBe("Someone is on a tour right now. Try again after it ends.");
    expect(resumeConfirmQuestion("100 Alfred Way")).toBe("Resume tours at 100 Alfred Way? New bookings can start again.");
  });

  it("never says archive in visitor or operator copy", () => {
    const lines = [
      pausedPropertyVisitorText("100 Alfred Way", "leasing team", "+15550109999"),
      pausedPropertyVisitorText("100 Alfred Way", "leasing team"),
      pausedUnitVisitorText("Unit 101"),
      bookedTourCalledOffText({ team: "leasing team", day: "Monday, Sep 28", time: "9:00 AM", address: "100 Alfred Way", propertyWide: true }),
      bookedTourCalledOffText({ team: "leasing team", day: "Monday, Sep 28", time: "9:00 AM", address: "100 Alfred Way", propertyWide: false }),
      pauseConfirmQuestion("100 Alfred Way", 2),
      pauseConfirmQuestion("100 Alfred Way", 0),
      removeConfirmQuestion("100 Alfred Way", 2),
      REMOVE_REFUSED_LIVE_TOUR,
      resumeConfirmQuestion("100 Alfred Way"),
    ];
    for (const line of lines) expect(line.toLowerCase()).not.toContain("archive");
  });
});

describe("pause and remove", () => {
  it("asks the approved pause question, then stops new bookings", async () => {
    const h = app();
    const id = await h.publish();
    const { config } = h.workspace.load(id);
    const asked = await h.ok("pause_tours", { property: id });
    expect(asked.status).toBe("needs-confirmation");
    expect(asked.summary).toBe(pauseConfirmQuestion(config.property.name, 0));
    await h.ok("pause_tours", { property: id, confirmationCode: asked.confirmation.code });

    const listed = await h.ok("list_properties");
    expect(listed.properties[0].paused).toBe(true);
    const setup = (await h.ok("get_property_setup", { property: id })).setup;
    expect(setup.paused).toBe(true);
    expect(setup.removed).toBe(false);

    const session = h.visitors.add(new VisitorDemoSession(id, config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }));
    await session.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    expect(lastFrom(session)).toBe(pausedPropertyVisitorText(config.property.address, config.operator.name, config.operator.visitorContact));
  });

  it("texts the paused-property line with a visitor help number when one is set", async () => {
    const h = app();
    const id = await h.publish();
    await h.ok("update_property_details", { property: id, visitorContact: "555-010-9999" });
    const { asked } = await h.approve("pause_tours", { property: id });
    expect(asked.summary).toBe(pauseConfirmQuestion(h.workspace.load(id).config.property.name, 0));
    const { config } = h.workspace.load(id);
    const session = h.visitors.add(new VisitorDemoSession(id, config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }));
    await session.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    expect(lastFrom(session)).toBe(
      pausedPropertyVisitorText(config.property.address, config.operator.name, config.operator.visitorContact),
    );
    expect(lastFrom(session)).toContain(`or call ${formatPhone(config.operator.visitorContact!)}`);
  });

  it("tells a visitor the unit is paused and offers the other open units", async () => {
    const h = app();
    const id = await h.publish();
    await h.approve("pause_tours", { property: id, unit: "Unit 101" });
    const { config } = h.workspace.load(id);
    const units = (await h.ok("list_units", { property: id })).units as Array<{ name: string; paused?: boolean }>;
    expect(units.find((unit) => unit.name === "Unit 101")?.paused).toBe(true);
    expect(units.find((unit) => unit.name === "Unit 102")?.paused).toBe(false);

    const session = h.visitors.add(new VisitorDemoSession(id, config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }));
    await session.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    expect(lastFrom(session)).toContain("Which unit would you like to see?");
    expect(lastFrom(session)).not.toContain("Unit 101 isn't open");
    await session.act("chooseUnit", { unitId: "unit_101" });
    expect(lastFrom(session).split("\n")[0]).toBe(pausedUnitVisitorText("Unit 101"));
    expect(lastFrom(session)).toContain("Which unit would you like to see?");
    expect(session.conversation.some((item) => item.from === "tourcore" && item.text.includes("archive"))).toBe(false);
  });

  it("treats every unit paused as a paused property", async () => {
    const h = app();
    const id = await h.publish();
    await h.approve("pause_tours", { property: id, unit: "Unit 101" });
    await h.approve("pause_tours", { property: id, unit: "Unit 102" });
    const { config } = h.workspace.load(id);
    const session = h.visitors.add(new VisitorDemoSession(id, config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }));
    await session.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    expect(lastFrom(session)).toBe(pausedPropertyVisitorText(config.property.address, config.operator.name, config.operator.visitorContact));
  });

  it("refuses booking on every path while a property is paused", async () => {
    const h = app();
    const id = await h.publish();
    const booked = await readyVisitor(h, id, { phone: "(555) 010-2001" });
    const start = (await booked.session.reservation())!.slotStart!;
    const inquiry = await h.visitor(id, { name: "Jamie Lee", phone: "(555) 010-2003" });
    await h.approve("pause_tours", { property: id, bookedTours: "keep" });

    const { config } = h.workspace.load(id);
    const fresh = h.visitors.add(new VisitorDemoSession(id, config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }));
    await fresh.act("begin", { name: "Alex Reed", phone: "(555) 010-2002" });
    expect(lastFrom(fresh)).toBe(pausedPropertyVisitorText(config.property.address, config.operator.name, config.operator.visitorContact));
    await expect(fresh.core.startInquiry({ name: "Alex Reed", phone: "(555) 010-2002", unitId: "unit_101" })).rejects.toMatchObject({ code: "TOURS_PAUSED" });

    await expect(inquiry.session.core.reserveSlot((await inquiry.session.reservation())!.id, inquiry.slot().toISOString())).rejects.toMatchObject({
      code: "TOURS_PAUSED",
    });
    await expect(inquiry.session.core.bookCustomSlot((await inquiry.session.reservation())!.id, inquiry.slot().toISOString())).rejects.toMatchObject({
      code: "TOURS_PAUSED",
    });
    await expect(
      inquiry.session.core.createTourTimeRequest({
        prospectId: inquiry.session.prospectId!,
        reservationId: inquiry.session.reservationId,
        unitId: "unit_101",
        requestedStartsAt: inquiry.slot().toISOString(),
        requestSource: "VISITOR",
      }),
    ).rejects.toMatchObject({ code: "TOURS_PAUSED" });

    const later = new Date(new Date(start).getTime() + 60 * 60_000).toISOString();
    await expect(booked.session.core.rescheduleReservation({ reservationId: booked.session.reservationId!, newStartsAt: later, customTime: true })).rejects.toMatchObject({
      code: "TOURS_PAUSED",
    });
  });

  it("keeps booked tours when asked, and cancels them with the approved text when asked", async () => {
    const h = app();
    const id = await h.publish();
    const kept = await readyVisitor(h, id, { name: "Pat Smith", phone: "(555) 010-2001" });
    const askedKeep = await h.ok("pause_tours", { property: id });
    expect(askedKeep.summary).toBe(pauseConfirmQuestion(h.workspace.load(id).config.property.name, 1));
    await h.ok("pause_tours", { property: id, bookedTours: "keep", confirmationCode: askedKeep.confirmation.code });
    expect((await kept.session.reservation())!.status).toBe("READY");
    expect(kept.session.conversation.map((item) => item.text).join("\n")).not.toContain("had to cancel your");

    await h.approve("resume_tours", { property: id });
    const cancelled = await readyVisitor(h, id, { name: "Alex Reed", phone: "(555) 010-2002" });
    const reservation = (await cancelled.session.reservation())!;
    const { config } = h.workspace.load(id);
    const askedCancel = await h.ok("pause_tours", { property: id });
    await h.ok("pause_tours", { property: id, bookedTours: "cancel", confirmationCode: askedCancel.confirmation.code });
    expect((await cancelled.session.reservation())!.status).toBe("CANCELLED");
    expect(lastFrom(cancelled.session)).toBe(
      bookedTourCalledOffText({
        team: config.operator.name,
        day: formatDay(new Date(reservation.slotStart!), config.property.timezone),
        time: formatTime(new Date(reservation.slotStart!), config.property.timezone),
        address: config.property.address,
        propertyWide: true,
      }),
    );
  });

  it("lets an in-progress tour finish while the property is paused", async () => {
    const h = app();
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    expect((await v.session.reservation())!.status).toBe("TOURING");
    await h.approve("pause_tours", { property: id, bookedTours: "cancel" });
    expect((await v.session.reservation())!.status).toBe("TOURING");
    await v.act("finish");
    expect((await v.session.reservation())!.status).toBe("COMPLETED");
  });

  it("resumes bookings after a pause", async () => {
    const h = app();
    const id = await h.publish();
    const asked = await h.ok("pause_tours", { property: id });
    await h.ok("pause_tours", { property: id, confirmationCode: asked.confirmation.code });
    const resumeAsked = await h.ok("resume_tours", { property: id });
    expect(resumeAsked.summary).toBe(resumeConfirmQuestion(h.workspace.load(id).config.property.name));
    await h.ok("resume_tours", { property: id, confirmationCode: resumeAsked.confirmation.code });
    const v = await readyVisitor(h, id);
    expect((await v.session.reservation())!.status).toBe("READY");
    expect((await h.ok("list_properties")).properties[0].paused).toBe(false);
  });

  it("refuses to remove a property while someone is on a tour", async () => {
    const h = app();
    const id = await h.publish();
    await h.touringVisitor(id);
    expect(await h.fails("remove_property", { property: id })).toBe(REMOVE_REFUSED_LIVE_TOUR);
  });

  it("removes a property: cancels booked tours, texts visitors, revokes pending access, and keeps history", async () => {
    const h = app();
    const id = await h.publish();
    const v = await readyVisitor(h, id);
    const reservation = (await v.session.reservation())!;
    await v.session.store.put("accessGrants", {
      id: "grt_pending",
      reservationId: reservation.id,
      prospectId: reservation.prospectId,
      doorId: reservation.allowedRoute[0]!,
      durinGrantRef: "durin_pending",
      status: "ACTIVE",
      validFrom: reservation.windowStart!,
      validUntil: reservation.windowEnd!,
      createdAt: reservation.createdAt,
    });
    const ref = tourRef(id, v.session.tourId);
    const { config } = h.workspace.load(id);
    const asked = await h.ok("remove_property", { property: id });
    expect(asked.summary).toBe(removeConfirmQuestion(config.property.name, 1));
    await h.ok("remove_property", { property: id, confirmationCode: asked.confirmation.code });

    expect((await v.session.reservation())!.status).toBe("CANCELLED");
    expect(lastFrom(v.session)).toBe(
      bookedTourCalledOffText({
        team: config.operator.name,
        day: formatDay(new Date(reservation.slotStart!), config.property.timezone),
        time: formatTime(new Date(reservation.slotStart!), config.property.timezone),
        address: config.property.address,
        propertyWide: true,
      }),
    );
    expect((await v.session.store.get("accessGrants", "grt_pending"))?.status).toBe("REVOKED");
    expect(v.session.durin.revokeCount).toBeGreaterThan(0);
    expect((await h.ok("list_properties")).properties).toEqual([]);
    expect(h.workspace.list().map((saved) => saved.config.property.id)).not.toContain(id);

    const inspected = await h.ok("inspect_tour", { tourRef: ref });
    expect(inspected.tour.tourRef).toBe(ref);
    const exported = await h.ok("export_audit", { property: id, day: "2026-09-28" });
    expect(exported.totals.tours).toBeGreaterThan(0);
    const events = readAvailabilityEvents(h.root, id);
    expect(events.some((event) => event.type === "PROPERTY_REMOVED")).toBe(true);
    expect(events.some((event) => event.detail.toLowerCase().includes("archive"))).toBe(false);
    expect(JSON.stringify(v.session.conversation).toLowerCase()).not.toContain("archive");
  });

  it("does not let an inbound text reach a removed property", async () => {
    const h = app();
    const id = await h.publish();
    const runtime = new MemoryRuntimeStore();
    const endpoints = new MessagingEndpoints(runtime);
    endpoints.attach({ address: "+15550109999", provider: "demo", propertyId: id }, new Date(h.now()));
    h.services.endpoints = endpoints;

    const asked = await h.ok("remove_property", { property: id });
    await h.ok("remove_property", { property: id, confirmationCode: asked.confirmation.code });
    expect(endpoints.resolve("+15550109999")).toBeUndefined();

    endpoints.attach({ address: "+15550109999", provider: "demo", propertyId: id }, new Date(h.now()));
    const sent: string[] = [];
    const router = new MessagingConversations({
      workspace: h.workspace,
      registry: h.visitors,
      endpoints,
      transport: () => new DemoMessagingAdapter((line) => sent.push(line), "MESSAGING"),
      links: new VerificationLinks({ baseUrl: () => undefined }),
      realNow: () => h.now(),
    });
    await router.receive({
      provider: "demo",
      providerMessageId: "msg_removed",
      from: "+15550102000",
      to: "+15550109999",
      text: "Hi",
      channel: "SMS",
      receivedAt: new Date(h.now()).toISOString(),
    });
    expect(sent.join("\n")).not.toMatch(/book|Which unit|tours available/i);
    expect(h.visitors.all().filter((session) => session.kind === "messaging")).toHaveLength(0);
  });

  it("writes audit events for pause, resume, remove and each cancellation", async () => {
    const h = app();
    const id = await h.publish();
    const v = await readyVisitor(h, id);
    await h.approve("pause_tours", { property: id, bookedTours: "cancel" });
    await h.approve("resume_tours", { property: id });
    const other = await readyVisitor(h, id, { name: "Alex Reed", phone: "(555) 010-2010" });
    await h.approve("remove_property", { property: id });
    const propertyEvents = readAvailabilityEvents(h.root, id);
    expect(propertyEvents.map((event) => event.type)).toEqual(expect.arrayContaining(["TOURS_PAUSED", "TOURS_RESUMED", "PROPERTY_REMOVED"]));
    const cancelled = [...(await v.session.store.listAudit()), ...(await other.session.store.listAudit())].filter((event) => event.type === "RESERVATION_CANCELLED");
    expect(cancelled.length).toBeGreaterThanOrEqual(2);
  });
});

describe("TourCore booking gates", () => {
  it("refuses every booking method when availability says no", async () => {
    const ctx = setup();
    const message = pausedPropertyVisitorText(ctx.config.property.address, ctx.config.operator.name);
    const core = createTourCore(ctx.config, {
      clock: ctx.clock,
      durin: ctx.durin,
      store: ctx.store,
      availability: () => ({ allowed: false, message }),
    });
    await expect(core.startInquiry({ name: "Jane Smith", phone: "(555) 010-1234", unitId: "apt_101" })).rejects.toMatchObject({
      code: "TOURS_PAUSED",
      message,
    });
  });

  it("still books when availability is unset", async () => {
    const ctx = setup();
    const booked = await bookTour(ctx);
    expect(booked.reservation.status).toBe("READY");
  });
});
