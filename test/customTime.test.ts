import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { slotsOn } from "../src/core/schedule";
import { SimulatedClock } from "../src/core/clock";
import { formatDay, formatTime, zonedTimeToUtc } from "../src/core/timezone";
import { LayeredIntentInterpreter } from "../src/intent";
import { MessagingEndpoints } from "../src/messaging/endpoints";
import { MemoryRuntimeStore } from "../src/storage/runtimeStore";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { HANDLER_SNAG_ALERTED, HANDLER_SNAG_RETRY, MessagingConversations } from "../src/visitor/messagingRouter";
import { VisitorDemoRegistry } from "../src/visitor/session";
import { VerificationLinks } from "../src/visitor/verificationLinks";
import { formatPhone } from "../src/core/phone";
import { operatorWhoLabel, sendOnlyUnreachableLine } from "../src/operator/exceptions";
import {
  alreadyAskedLine,
  bookedForLine,
  CONSENT_TEXT,
  customTimeAskedLine,
  HANDLER_FAILED_NEXT_STEP,
  handlerFailureAlertLine,
  PENDING_CUSTOM_TIME_REGULAR_OPTION,
  pendingCustomTimeLine,
  proposeVisitorLine,
  replacesTourLine,
  REQUEST_ALREADY_HANDLED,
  requestAlreadyExpiredLine,
  requestExpiredLine,
  requestProposePassedLine,
  requestTimePassedLine,
  SLOT_ALREADY_PASSED,
  TAKEN_SLOT_OTHER_DAY,
  takenSlotLine,
  VISITOR_TIME_PASSED,
  WITHDRAWN_FOR_REGULAR_BOOKING,
} from "../src/core/TourCore";
import { createTourCore } from "../src/createTourCore";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import { at, hillsideConfig, liveApp, PHONE, type LiveApp } from "./liveApp";

/**
 * Regular slots stay on the property's schedule. Any other minute is a
 * request the landlord approves, declines, or counters. One-off times do
 * not change that schedule, and access follows the approved time.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const atTime = (hour: number, minute = 0) => zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour, minute }, "America/New_York");

async function chooseUnit(a: LiveApp) {
  await a.optInSms();
  await a.text("1");
  await a.text("1");
}

async function ask(a: LiveApp, message: string) {
  await chooseUnit(a);
  return a.text(message);
}

function hoursOf(a: LiveApp) {
  return structuredClone(a.ws.load("prop_100_alfred_way").config.tourHours);
}

describe("a visitor can ask for a time that isn't a regular slot", () => {
  it("before a booking, an off-grid time becomes a pending request and does not confirm a tour", async () => {
    const a = await liveApp({ cleanups });
    const before = hoursOf(a);
    const replies = await ask(a, "Can I tour at 3:15?");
    expect(replies[0]).toContain("3:15 PM isn't one of the regular tour times");
    expect(replies[0]).toContain("ask the property team");
    expect(replies.join("\n")).not.toContain("you're booked");
    const reservation = a.ws.listTours("prop_100_alfred_way").find((tour) => tour.kind === "messaging");
    const bundle = a.ws.loadTour("prop_100_alfred_way", reservation!.tourId)!.bundle;
    expect(bundle.reservations[0]).toMatchObject({ status: "INQUIRY" });
    expect(bundle.reservations[0]!.slotStart).toBeUndefined();
    expect(bundle.tourTimeRequests).toHaveLength(1);
    expect(bundle.tourTimeRequests[0]).toMatchObject({ status: "PENDING", requestSource: "VISITOR" });
    expect(hoursOf(a)).toEqual(before);
    expect(slotsOn(a.ws.load("prop_100_alfred_way").config, { year: 2026, month: 9, day: 28 }).map((slot) => slot.label)).toEqual(["2:00 PM", "3:30 PM"]);
  });

  it("keeps an existing booking while the request is pending", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    const replies = await a.text("Can I move it to 3:15?");
    expect(replies[0]).toBe(
      "I've asked the property team about 3:15 PM on Monday, Sep 28 instead. Your 2:00 PM tour on Monday, Sep 28 stays booked unless they approve the change.",
    );
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    expect(bundle.reservations[0]!.slotStart).toBe(atTime(14).toISOString());
    expect(bundle.reservations[0]!.status).toBe("READY");
    expect(bundle.tourTimeRequests[0]!.status).toBe("PENDING");
  });

  it("understands 2:30, tomorrow at 11:15, and asks when AM/PM can't be known", async () => {
    const a = await liveApp({ cleanups });
    await chooseUnit(a);
    expect((await a.text("How about 2:30?"))[0]).toContain("2:30 PM isn't one of the regular tour times");
    expect((await a.text("Could I do 11:15 tomorrow?"))[0]).toContain("11:15 AM");
    const unclear = await a.text("Can I come at 7:30?");
    expect(unclear[0]).toContain("7:30 AM or 7:30 PM");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const pending = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.tourTimeRequests.filter((request) => request.status === "PENDING");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.requestedStartsAt).toBe(zonedTimeToUtc({ year: 2026, month: 9, day: 29, hour: 11, minute: 15 }, "America/New_York").toISOString());
  });

  it("a repeated text and a retried webhook do not open a second request", async () => {
    const a = await liveApp({ cleanups });
    await chooseUnit(a);
    await a.text("Can I do 3:15?", "same-delivery");
    const again = await a.text("Can I do 3:15?", "same-delivery");
    expect(again).toEqual([]);
    const repeat = await a.text("Can I do 3:15 again?");
    expect(repeat[0]).toBe(alreadyAskedLine("3:15 PM", "Monday, Sep 28"));
    const listed = await a.grok("list_tour_time_requests");
    expect(listed.requests).toHaveLength(1);
  });

  it("a question and a time in one text answers the question and does not file the time until they confirm", async () => {
    const a = await liveApp({ cleanups });
    await chooseUnit(a);
    const replies = await a.text("Does it have laundry, and could I come at 3:15?");
    expect(replies[0]).toContain("In-unit laundry");
    expect(replies.join("\n")).toContain("3:15 PM");
    expect(replies.join("\n")).toContain("reply YES");
    expect((await a.grok("list_tour_time_requests")).requests).toHaveLength(0);
    const filed = await a.text("YES");
    expect(filed[0]).toContain("ask the property team");
    expect((await a.grok("list_tour_time_requests")).requests).toHaveLength(1);
  });
});

describe("the landlord decides", () => {
  it("approves an off-grid time without changing the regular schedule", async () => {
    const a = await liveApp({ cleanups });
    const before = hoursOf(a);
    await a.book();
    await a.text("Can I change it to 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    const done = await a.approve("approve_tour_time_request", { tourTimeRequestId: id });
    expect(done.summary).toContain("3:15 PM");
    expect(a.fake.sent.filter((message) => message.number === PHONE).at(-1)!.content).toContain("moved to today at 3:15 PM");
    expect(hoursOf(a)).toEqual(before);
    expect(slotsOn(a.ws.load("prop_100_alfred_way").config, { year: 2026, month: 9, day: 28 }).map((slot) => slot.label)).toEqual(["2:00 PM", "3:30 PM"]);
  });

  it("declines and leaves the current booking confirmed", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await a.text("Can I change it to 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    expect((await a.grok("decline_tour_time_request", { tourTimeRequestId: id })).summary).toBe(
      "Declined. Testy's 2:00 PM tour on Monday, Sep 28 is still confirmed.",
    );
    const last = a.fake.sent.filter((message) => message.number === PHONE).at(-1)!.content;
    expect(last).toBe("The property team couldn't approve 3:15 PM on Monday, Sep 28. Your 2:00 PM tour on Monday, Sep 28 is still confirmed.");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.slotStart).toBe(atTime(14).toISOString());
  });

  it("a proposed alternative waits for the visitor, and no keeps the current time", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await a.text("Can I change it to 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    expect((await a.grok("propose_tour_time", { tourTimeRequestId: id, newStartsAt: "3:30 PM" })).summary).toBe(
      "I asked Testy about 3:30 PM. Their current booking stays until they say yes.",
    );
    const proposed = a.fake.sent.filter((message) => message.number === PHONE).at(-1)!.content;
    expect(proposed).toBe(
      proposeVisitorLine({
        requestedTime: "3:15 PM",
        requestedDay: "Monday, Sep 28",
        proposedTime: "3:30 PM",
        proposedDay: "Monday, Sep 28",
        time: "2:00 PM",
        day: "Monday, Sep 28",
      }),
    );
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.slotStart).toBe(atTime(14).toISOString());
    const refused = await a.text("no");
    expect(refused.join("\n")).toContain("2:00 PM tour on Monday, Sep 28 is still confirmed");
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.slotStart).toBe(atTime(14).toISOString());
  });

  it("yes to a proposed alternative moves the tour", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await a.text("Can I change it to 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    await a.grok("propose_tour_time", { tourTimeRequestId: id, newStartsAt: "3:30 PM" });
    const yes = await a.text("yeah 3:30 works");
    expect(yes.join("\n")).toContain("3:30 PM");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.slotStart).toBe(atTime(15, 30).toISOString());
  });

  it("reschedule before a time is booked keeps The visitor at the start of the error", async () => {
    const a = await liveApp({ cleanups });
    await ask(a, "Can I tour at 3:15?");
    const [tour] = (await a.grok("list_active_tours")).tours;
    await expect(a.grok("reschedule_tour", { tourRef: tour.tourRef, newStartsAt: "3:30 PM" })).rejects.toThrow(
      /The visitor doesn't have a tour time to move yet/,
    );
  });

  it("the landlord can move the tour directly, and access follows the new time", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    a.clock.t = at(7);
    const asked = await a.grok("reschedule_tour", { visitor: "Testy", newStartsAt: "3:15 PM today" });
    expect(asked.summary).toContain("Move Testy's tour from 2:00 PM on Monday, Sep 28 to 3:15 PM on Monday, Sep 28?");
    expect(asked.summary).toContain("Testy gets a text with the new time.");
    expect(asked.summary).not.toContain("This is a one-off.");
    expect(asked.summary).toContain("Move it?");
    expect(asked.summary).not.toContain("Continue?");
    const done = await a.grok("reschedule_tour", { visitor: "Testy", newStartsAt: "3:15 PM today", confirmationCode: asked.confirmation.code });
    expect(done.summary).toContain("3:15 PM");
    expect(a.fake.sent.filter((message) => message.number === PHONE).at(-1)!.content).toContain("moved to today at 3:15 PM");

    a.clock.t = at(13, 58);
    const early = await a.text("I'm here");
    expect(early.join("\n")).toContain("3:05 PM");
    a.clock.t = at(15, 10);
    const open = await a.text("I'm here");
    expect(open.join("\n")).toContain("Entrance is open");
  });

  it("a time outside touring hours needs an explicit override and does not change the hours", async () => {
    const a = await liveApp({ cleanups });
    const before = hoursOf(a);
    await a.book();
    await a.text("Can we do 7:30 PM?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    const asked = await a.grok("approve_tour_time_request", { tourTimeRequestId: id });
    expect(asked.outsideHours).toBe(true);
    expect(asked.summary).toContain("That's outside your tour hours.");
    expect(asked.summary).toContain("Move it?");
    expect(asked.summary).not.toContain("Continue?");
    expect(asked.summary).not.toContain("create a one-time tour");
    await expect(a.grok("approve_tour_time_request", { tourTimeRequestId: id, confirmationCode: asked.confirmation.code })).rejects.toThrow(/outside normal touring hours/);
    await a.grok("approve_tour_time_request", { tourTimeRequestId: id, confirmationCode: asked.confirmation.code, acknowledgeOutsideHours: true });
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    expect(bundle.reservations[0]).toMatchObject({ scheduleOverride: { kind: "OUTSIDE_HOURS" } });
    expect(bundle.auditEvents.some((event) => event.type === "TOUR_TIME_OVERRIDE_APPROVED")).toBe(true);
    expect(hoursOf(a)).toEqual(before);
  });

  it("refuses a custom time that overlaps another tour and names the nearest regular times", async () => {
    const clock = new SimulatedClock(atTime(7));
    const core = createTourCore(loadConfig(), { clock, messenger: new DemoMessagingAdapter(() => {}) });
    const first = await core.startInquiry({ name: "A", phone: "5550100001", unitId: "apt_101" });
    await core.reserveSlot(first.reservation.id, atTime(14).toISOString());
    const second = await core.startInquiry({ name: "B", phone: "5550100002", unitId: "apt_102" });
    const created = await core.createTourTimeRequest({
      prospectId: second.prospect.id,
      reservationId: second.reservation.id,
      unitId: "apt_102",
      requestedStartsAt: atTime(14, 15).toISOString(),
      requestSource: "VISITOR",
    });
    await expect(core.approveTourTimeRequest(created.request.id)).rejects.toMatchObject({ code: "SLOT_OVERLAP" });
    await expect(core.approveTourTimeRequest(created.request.id)).rejects.toThrow(
      "2:15 PM overlaps another tour. The closest available options are 3:30 PM and Tuesday, Sep 29 2:00 PM.",
    );
    expect((await core.getReservation(second.reservation.id))!.slotStart).toBeUndefined();
  });
});

describe("the request is durable, audited, and wakes the landlord", () => {
  it("survives a restart, stays approved, and the webhook carries no personal details", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await a.text("Can I move it to 3:15?");
    const events = a.routineEvents().filter((event) => event.eventType === "tour.time_requested");
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!).sort()).toEqual(["eventId", "eventType", "occurredAt", "propertyId", "schemaVersion", "tourTimeRequestId"]);
    for (const leak of ["Testy", "McTest", PHONE, "testy@example.com", "Unit 1A"]) expect(JSON.stringify(events[0])).not.toContain(leak);
    const update = await a.grok("get_operator_update", { eventId: events[0]!.eventId });
    expect(update.summary).toContain("Testy");
    expect(update.summary).toContain("3:15 PM");
    expect(update.summary).toContain("2:00 PM");
    const id = update.request.tourTimeRequestId as string;

    a.close();
    const b = await liveApp({ root: a.root, clock: a.clock, net: a.net, fake: a.fake, cleanups });
    expect((await b.grok("list_tour_time_requests")).requests.map((request: { tourTimeRequestId: string }) => request.tourTimeRequestId)).toEqual([id]);
    await b.approve("approve_tour_time_request", { tourTimeRequestId: id });
    b.close();
    const c = await liveApp({ root: a.root, clock: a.clock, net: a.net, fake: a.fake, cleanups });
    const tour = c.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const bundle = c.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    expect(bundle.tourTimeRequests.find((request) => request.id === id)!.status).toBe("APPROVED");
    expect(bundle.reservations[0]!.slotStart).toBe(atTime(15, 15).toISOString());
    expect(bundle.auditEvents.map((event) => event.type)).toEqual(expect.arrayContaining(["TOUR_TIME_REQUESTED", "TOUR_TIME_REQUEST_APPROVED", "TOUR_RESCHEDULED"]));
    expect((await c.grok("list_tour_time_requests")).requests).toHaveLength(0);
  });
});

const TZ = "America/New_York";

async function tourThenCustomTime(a: LiveApp, start: Date) {
  await a.book();
  a.clock.t = at(13, 58);
  await a.text("I'm here");
  await a.text("at unit 1A");
  await a.text(`Can I come Thursday at ${formatTime(start, TZ)}?`);
  const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
  expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.tourTimeRequests.some((request) => request.status === "PENDING")).toBe(true);
  await a.text("I'm done");
  return a.text("no");
}

describe("a pending custom-time request does not block regular booking", () => {
  it("sends the pending line once after DONE and follow-up; a second hi does not repeat it", async () => {
    const a = await liveApp({ cleanups });
    const later = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 15, minute: 15 }, TZ);
    const follow = await tourThenCustomTime(a, later);
    const expected = pendingCustomTimeLine(formatTime(later, TZ), formatDay(later, TZ));
    expect(expected).toContain("If you'd rather pick one of the regular times instead, just reply with a day.");
    expect(follow.at(-1)).toBe(expected);
    expect(follow.filter((line) => line === expected)).toHaveLength(1);

    const hi = await a.text("hi");
    expect(hi.join("\n")).not.toContain("still with the property team");
    expect(hi.join("\n")).toMatch(/Which day works for you\?|I have tours available/);
    expect(hi.some((line) => line === expected)).toBe(false);
  });

  it("a day reply or 2 after the pending line shows or books regular slots", async () => {
    const a = await liveApp({ cleanups });
    const later = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 15, minute: 15 }, TZ);
    const follow = await tourThenCustomTime(a, later);
    expect(follow.at(-1)).toBe(pendingCustomTimeLine(formatTime(later, TZ), formatDay(later, TZ)));

    const day = await a.text("Tuesday");
    expect(day.join("\n")).toMatch(/2:00 PM|3:30 PM|Which time/);
    expect(day.join("\n")).not.toContain("still with the property team");

    const b = await liveApp({ cleanups });
    await tourThenCustomTime(b, later);
    const numbered = await b.text("2");
    expect(numbered.join("\n")).toMatch(/Which day works for you\?|I have tours available/);
    expect(numbered.join("\n")).not.toContain("you're booked");
    expect(numbered.join("\n")).not.toContain("still with the property team");
  });

  it("booking a regular slot withdraws the request; list, inspect, approve, and decline show They booked a regular time instead.", async () => {
    const a = await liveApp({ cleanups });
    const later = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 15, minute: 15 }, TZ);
    await tourThenCustomTime(a, later);
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    expect(id).toBeTruthy();

    await a.text("Tuesday");
    const beforeVisitor = a.fake.sent.filter((message) => message.number === PHONE).length;
    const booked = await a.text("1");
    expect(booked.join("\n")).toContain("Great, you're booked for 2:00 PM");
    expect(booked.join("\n")).toMatch(/Tuesday/);
    expect(booked.join("\n")).not.toContain(WITHDRAWN_FOR_REGULAR_BOOKING);
    expect(booked.join("\n")).not.toContain("still with the property team");
    expect(a.fake.sent.filter((message) => message.number === PHONE).length).toBe(beforeVisitor + booked.length);

    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    const request = bundle.tourTimeRequests.find((item) => item.id === id)!;
    expect(request.status).toBe("WITHDRAWN");
    expect(request.operatorNote).toBe(WITHDRAWN_FOR_REGULAR_BOOKING);
    expect(bundle.reservations.some((item) => item.slotStart === later.toISOString())).toBe(false);
    expect(bundle.reservations.some((item) => item.slotStart === zonedTimeToUtc({ year: 2026, month: 9, day: 29, hour: 14, minute: 0 }, TZ).toISOString())).toBe(true);

    const listed = await a.grok("list_tour_time_requests");
    expect(listed.requests.find((item: { tourTimeRequestId: string }) => item.tourTimeRequestId === id)).toBeUndefined();
    const withdrawnList = await a.grok("list_tour_time_requests", { status: "withdrawn" });
    const listedRequest = withdrawnList.requests.find((item: { tourTimeRequestId: string }) => item.tourTimeRequestId === id);
    expect(listedRequest.status).toBe("withdrawn");
    expect(listedRequest.reason).toBe(WITHDRAWN_FOR_REGULAR_BOOKING);
    expect(JSON.stringify(withdrawnList)).toContain(WITHDRAWN_FOR_REGULAR_BOOKING);
    const all = await a.grok("list_tour_time_requests", { status: "all" });
    expect(all.requests.find((item: { tourTimeRequestId: string }) => item.tourTimeRequestId === id)?.status).toBe("withdrawn");

    const inspected = await a.grok("inspect_tour_time_request", { tourTimeRequestId: id });
    expect(inspected.status).toBe("withdrawn");
    expect(inspected.reason).toBe(WITHDRAWN_FOR_REGULAR_BOOKING);
    expect(inspected.summary).toContain(WITHDRAWN_FOR_REGULAR_BOOKING);
    expect(inspected.note).toBe(WITHDRAWN_FOR_REGULAR_BOOKING);

    const afterBookVisitor = a.fake.sent.filter((message) => message.number === PHONE).length;
    const approved = await a.grok("approve_tour_time_request", { tourTimeRequestId: id });
    expect(approved.summary).toBe(WITHDRAWN_FOR_REGULAR_BOOKING);
    expect(approved.status).toBe("withdrawn");
    expect(approved.reason).toBe(WITHDRAWN_FOR_REGULAR_BOOKING);
    expect(approved.withdrawn).toBe(true);
    const declined = await a.grok("decline_tour_time_request", { tourTimeRequestId: id });
    expect(declined.summary).toBe(WITHDRAWN_FOR_REGULAR_BOOKING);
    expect(declined.status).toBe("withdrawn");
    expect(declined.reason).toBe(WITHDRAWN_FOR_REGULAR_BOOKING);
    expect(a.fake.sent.filter((message) => message.number === PHONE).length).toBe(afterBookVisitor);

    const after = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    expect(after.reservations.filter((item) => item.slotStart === later.toISOString())).toHaveLength(0);
    expect(after.tourTimeRequests.find((item) => item.id === id)!.status).toBe("WITHDRAWN");
    expect(after.auditEvents.some((event) => event.type === "TOUR_TIME_REQUEST_WITHDRAWN" && event.detail === WITHDRAWN_FOR_REGULAR_BOOKING)).toBe(true);

    const eventId = a.routineEvents().find((event) => event.eventType === "tour.time_requested")!.eventId;
    const update = await a.grok("get_operator_update", { eventId });
    expect(update.summary).toContain(WITHDRAWN_FOR_REGULAR_BOOKING);
    expect(update.instructions).not.toMatch(/decision is required/i);
    expect(update.request.status).toBe("withdrawn");
  });

  it("a second custom request supersedes the first and is still told once after DONE", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    await a.text("at unit 1A");
    await a.text("Can I come Thursday at 3:15?");
    await a.text("Can I come Thursday at 4:15?");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const pending = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.tourTimeRequests.filter((request) => request.status === "PENDING");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.requestedStartsAt).toBe(zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 16, minute: 15 }, TZ).toISOString());
    await a.text("I'm done");
    const follow = await a.text("no");
    expect(follow.at(-1)).toBe(pendingCustomTimeLine("4:15 PM", formatDay(zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 16, minute: 15 }, TZ), TZ)));
  });

  it("a pre-tour custom request can be approved, and picking a day then abandoning still sends the pending line once", async () => {
    const a = await liveApp({ cleanups });
    await chooseUnit(a);
    await a.text("Can I tour at 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    const times = await a.text("Tuesday");
    expect(times.join("\n")).toMatch(/2:00 PM|3:30 PM|Which time/);
    const abandon = await a.text("actually never mind");
    expect(abandon.join("\n")).not.toContain("you're booked");
    expect((await a.grok("list_tour_time_requests")).requests).toHaveLength(1);
    await a.approve("approve_tour_time_request", { tourTimeRequestId: id });
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.slotStart).toBe(
      zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 15, minute: 15 }, TZ).toISOString(),
    );
  });

  it("approving mid-booking while they still have no regular slot books the custom time", async () => {
    const a = await liveApp({ cleanups });
    await chooseUnit(a);
    await a.text("Can I tour at 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    await a.approve("approve_tour_time_request", { tourTimeRequestId: id });
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const reservation = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!;
    expect(reservation.slotStart).toBe(zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 15, minute: 15 }, TZ).toISOString());
    expect(reservation.status).toBe("AWAITING_CONSENT");
  });

  it("I'm locked in after the pending line alerts the landlord like a +15 close", async () => {
    const a = await liveApp({ cleanups });
    const later = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 15, minute: 15 }, TZ);
    await tourThenCustomTime(a, later);
    const replies = await a.text("I'm locked in");
    expect(replies.join("\n")).toContain("Thanks, I've let the property team know");
    expect(replies.join("\n")).not.toContain("still with the property team");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    expect(bundle.auditEvents.some((event) => event.type === "OPERATOR_NOTIFIED" && /locked in/i.test(event.detail ?? ""))).toBe(true);
  });

  it("a day name before the pending line has gone out books normally", async () => {
    const a = await liveApp({ cleanups });
    await chooseUnit(a);
    await a.text("Can I tour at 3:15?");
    const day = await a.text("Tuesday");
    expect(day.join("\n")).toMatch(/2:00 PM|3:30 PM|Which time/);
    expect(day.join("\n")).not.toContain("still with the property team");
  });
});

function slotLockControl() {
  const entered = new Map<string, () => void>();
  const ready = new Map<string, Promise<void>>();
  const releaseByOp = new Map<string, () => void>();
  const holdByOp = new Map<string, Promise<void>>();
  for (const op of ["reserve", "approve", "decline", "propose", "declineProposed"] as const) {
    ready.set(op, new Promise<void>((resolve) => entered.set(op, resolve)));
    holdByOp.set(op, new Promise<void>((resolve) => releaseByOp.set(op, resolve)));
  }
  let holdOp: string | undefined;
  return {
    hold(op: "reserve" | "approve" | "decline" | "propose" | "declineProposed") {
      holdOp = op;
    },
    ready(op: "reserve" | "approve" | "decline" | "propose" | "declineProposed") {
      return ready.get(op)!;
    },
    release(op: "reserve" | "approve" | "decline" | "propose" | "declineProposed") {
      releaseByOp.get(op)!();
    },
    barrier: async (op: "reserve" | "approve" | "decline" | "propose" | "declineProposed") => {
      entered.get(op)!();
      if (holdOp === op) await holdByOp.get(op);
    },
  };
}

async function inquiryWithCustomRequest(barrier: (op: "reserve" | "approve" | "decline" | "propose" | "declineProposed") => Promise<void>) {
  const clock = new SimulatedClock(atTime(7));
  const core = createTourCore(loadConfig(), { clock, messenger: new DemoMessagingAdapter(() => {}), slotLockBarrier: barrier });
  const started = await core.startInquiry({ name: "Pat Race", phone: "5550100999", unitId: "apt_101" }, { announce: false });
  const created = await core.createTourTimeRequest({
    prospectId: started.prospect.id,
    reservationId: started.reservation.id,
    unitId: "apt_101",
    requestedStartsAt: atTime(15, 15).toISOString(),
    requestSource: "VISITOR",
  });
  return { core, started, requestId: created.request.id, slot: atTime(14).toISOString() };
}

describe("a slot pick and an operator decision cannot race", () => {
  it("reserve then approve: approve sees They booked a regular time instead.", async () => {
    const ctrl = slotLockControl();
    ctrl.hold("reserve");
    const { core, started, requestId, slot } = await inquiryWithCustomRequest(ctrl.barrier);
    const reserveP = core.reserveSlot(started.reservation.id, slot);
    await ctrl.ready("reserve");
    const approveP = core.approveTourTimeRequest(requestId);
    ctrl.release("reserve");
    await reserveP;
    await expect(approveP).rejects.toMatchObject({ code: "REQUEST_WITHDRAWN", message: WITHDRAWN_FOR_REGULAR_BOOKING });
    expect((await core.getReservation(started.reservation.id))!.slotStart).toBe(slot);
  });

  it("approve then reserve: approve wins and reserve does not create a second booking", async () => {
    const ctrl = slotLockControl();
    ctrl.hold("approve");
    const { core, started, requestId, slot } = await inquiryWithCustomRequest(ctrl.barrier);
    const approveP = core.approveTourTimeRequest(requestId);
    await ctrl.ready("approve");
    const reserveP = core.reserveSlot(started.reservation.id, slot);
    ctrl.release("approve");
    await approveP;
    await expect(reserveP).rejects.toMatchObject({ code: "ALREADY_BOOKED" });
    expect((await core.getReservation(started.reservation.id))!.slotStart).toBe(atTime(15, 15).toISOString());
  });

  it("reserve then decline: decline sees They booked a regular time instead. and does not text", async () => {
    const ctrl = slotLockControl();
    ctrl.hold("reserve");
    const sent: string[] = [];
    const clock = new SimulatedClock(atTime(7));
    const core = createTourCore(loadConfig(), {
      clock,
      messenger: new DemoMessagingAdapter((line) => sent.push(line)),
      slotLockBarrier: ctrl.barrier,
    });
    const started = await core.startInquiry({ name: "Pat Race", phone: "5550100888", unitId: "apt_101" }, { announce: false });
    const created = await core.createTourTimeRequest({
      prospectId: started.prospect.id,
      reservationId: started.reservation.id,
      unitId: "apt_101",
      requestedStartsAt: atTime(15, 15).toISOString(),
      requestSource: "VISITOR",
    });
    const reserveP = core.reserveSlot(started.reservation.id, atTime(14).toISOString());
    await ctrl.ready("reserve");
    const declineP = core.declineTourTimeRequest(created.request.id);
    ctrl.release("reserve");
    await reserveP;
    const before = sent.length;
    await expect(declineP).rejects.toMatchObject({ code: "REQUEST_WITHDRAWN" });
    expect(sent.length).toBe(before);
  });

  it("decline then reserve: decline finishes, then the regular slot books", async () => {
    const ctrl = slotLockControl();
    ctrl.hold("decline");
    const { core, started, requestId, slot } = await inquiryWithCustomRequest(ctrl.barrier);
    const declineP = core.declineTourTimeRequest(requestId);
    await ctrl.ready("decline");
    const reserveP = core.reserveSlot(started.reservation.id, slot);
    ctrl.release("decline");
    await declineP;
    await reserveP;
    expect((await core.getReservation(started.reservation.id))!.slotStart).toBe(slot);
  });

  it("reserve then propose: propose sees They booked a regular time instead. and does not text", async () => {
    const ctrl = slotLockControl();
    ctrl.hold("reserve");
    const { core, started, requestId, slot } = await inquiryWithCustomRequest(ctrl.barrier);
    const reserveP = core.reserveSlot(started.reservation.id, slot);
    await ctrl.ready("reserve");
    const proposeP = core.proposeTourTime(requestId, atTime(15, 30).toISOString());
    ctrl.release("reserve");
    await reserveP;
    await expect(proposeP).rejects.toMatchObject({ code: "REQUEST_WITHDRAWN" });
  });

  it("propose then reserve: propose finishes, then the regular slot books and withdraws", async () => {
    const ctrl = slotLockControl();
    ctrl.hold("propose");
    const { core, started, requestId, slot } = await inquiryWithCustomRequest(ctrl.barrier);
    const proposeP = core.proposeTourTime(requestId, atTime(15, 30).toISOString());
    await ctrl.ready("propose");
    const reserveP = core.reserveSlot(started.reservation.id, slot);
    ctrl.release("propose");
    await proposeP;
    await reserveP;
    expect((await core.getReservation(started.reservation.id))!.slotStart).toBe(slot);
  });
});

async function tourThenRebookFridayThenCustom(a: LiveApp) {
  await a.book();
  a.clock.t = at(13, 58);
  await a.text("I'm here");
  await a.text("at unit 1A");
  const friday = zonedTimeToUtc({ year: 2026, month: 10, day: 2, hour: 14, minute: 0 }, TZ);
  await a.text("Can I come Friday at 2:00?");
  await a.text("Can I come Friday at 3:15?");
  await a.text("I'm done");
  const follow = await a.text("no");
  return { follow, friday, custom: zonedTimeToUtc({ year: 2026, month: 10, day: 2, hour: 15, minute: 15 }, TZ) };
}

describe("a held rebook and a custom-time request stay one booking", () => {
  it("after DONE and follow-up, the Friday hold takes over with booked-for then consent, not the regular-times sentence", async () => {
    const a = await liveApp({ cleanups });
    const { follow, friday } = await tourThenRebookFridayThenCustom(a);
    const texts = follow.join("\n");
    expect(texts).toContain(bookedForLine(formatTime(friday, TZ), formatDay(friday, TZ)));
    expect(texts).toContain(CONSENT_TEXT);
    expect(texts).toContain("Reply YES or NO.");
    expect(texts).not.toContain(PENDING_CUSTOM_TIME_REGULAR_OPTION);
    expect(texts).not.toContain("still with the property team");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    const live = bundle.reservations.filter((item) => item.slotStart && item.status !== "COMPLETED" && item.status !== "CANCELLED");
    expect(live).toHaveLength(1);
    expect(live[0]!.slotStart).toBe(friday.toISOString());
    expect(bundle.tourTimeRequests.some((request) => request.status === "PENDING")).toBe(true);
  });

  it("picking Tuesday replaces the Friday hold, releases that slot, and sends That replaces your 2:00 PM tour on Friday, Oct 2.", async () => {
    const a = await liveApp({ cleanups });
    const { friday } = await tourThenRebookFridayThenCustom(a);
    await a.text("Tuesday");
    const booked = await a.text("1");
    const texts = booked.join("\n");
    const tuesday = zonedTimeToUtc({ year: 2026, month: 9, day: 29, hour: 14, minute: 0 }, TZ);
    expect(texts).toContain(bookedForLine(formatTime(tuesday, TZ), formatDay(tuesday, TZ)));
    expect(texts).toContain(replacesTourLine(formatTime(friday, TZ), formatDay(friday, TZ)));
    expect(texts).toContain(CONSENT_TEXT);
    expect(texts).toContain("Reply YES or NO.");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    expect(bundle.reservations.some((item) => item.slotStart === friday.toISOString() && item.status !== "CANCELLED")).toBe(false);
    expect(bundle.reservations.some((item) => item.slotStart === tuesday.toISOString())).toBe(true);
    expect(bundle.tourTimeRequests.every((request) => request.status !== "PENDING")).toBe(true);
  });

  it("approving the custom time moves an unconfirmed Friday hold with the full booked-for then consent ask", async () => {
    const a = await liveApp({ cleanups });
    await tourThenRebookFridayThenCustom(a);
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    const before = a.fake.sent.filter((message) => message.number === PHONE).map((message) => message.content);
    await a.approve("approve_tour_time_request", { tourTimeRequestId: id });
    const after = a.fake.sent.filter((message) => message.number === PHONE).map((message) => message.content).slice(before.length);
    const custom = zonedTimeToUtc({ year: 2026, month: 10, day: 2, hour: 15, minute: 15 }, TZ);
    expect(after).toEqual([
      bookedForLine(formatTime(custom, TZ), formatDay(custom, TZ)),
      `${CONSENT_TEXT}\nReply YES or NO.`,
    ]);
    expect(after.join("\n")).not.toMatch(/moved to|rescheduled/i);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    const live = bundle.reservations.filter((item) => item.slotStart && item.status !== "COMPLETED" && item.status !== "CANCELLED");
    expect(live).toHaveLength(1);
    expect(live[0]!.slotStart).toBe(custom.toISOString());
  });

  it("approving the custom time on an already-confirmed booking uses the moved wording", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await a.text("Can I move it to 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    await a.approve("approve_tour_time_request", { tourTimeRequestId: id });
    const last = a.fake.sent.filter((message) => message.number === PHONE).at(-1)!.content;
    expect(last).toContain("moved to today at 3:15 PM");
    expect(last).not.toContain(CONSENT_TEXT);
  });
});

async function firstBookingConsent(a: LiveApp) {
  await a.optInSms();
  await a.text("1");
  await a.text("1");
  const booked = await a.text("1");
  expect(booked.join("\n")).toContain(bookedForLine("2:00 PM", "Monday, Sep 28"));
  expect(booked.join("\n")).toContain("Reply YES or NO.");
  return booked;
}

describe("consent is not hijacked by a regular-slot pick", () => {
  it("Yes, 2:00 PM works records consent on a first booking", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("Yes, 2:00 PM works");
    expect(replies.join("\n")).toBeTruthy();
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const reservation = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!;
    expect(reservation.consentId).toBeTruthy();
    expect(reservation.slotStart).toBe(atTime(14).toISOString());
  });

  it("yes 2pm records consent on a first booking", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    await a.text("yes 2pm");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeTruthy();
  });

  it("a bare 1 in the consent step re-asks consent and does not stay silent", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("1");
    expect(replies.join("\n")).toMatch(/Is it OK if I text you about this tour|Reply YES or NO/);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeFalsy();
  });

  it("yes see you tuesday and ok tuesday record consent, not Tuesday's menu", async () => {
    for (const phrase of ["yes see you tuesday", "ok tuesday"]) {
      const a = await liveApp({ cleanups });
      await firstBookingConsent(a);
      const replies = await a.text(phrase);
      expect(replies.join("\n")).not.toMatch(/Which time|2:00 PM|3:30 PM/);
      const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
      expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeTruthy();
    }
  });

  it("Monday works, yes records consent, not Monday's menu", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("Monday works, yes");
    expect(replies.join("\n")).not.toMatch(/Which time works/);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeTruthy();
  });

  it("a bare 2 in the consent step re-asks consent and does not book 3:30 or send a replace line", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("2");
    expect(replies.join("\n")).toMatch(/Is it OK if I text you about this tour|Reply YES or NO/);
    expect(replies.join("\n")).not.toContain("That replaces your");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.slotStart).toBe(atTime(14).toISOString());
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeFalsy();
  });

  it("yes see you friday after a held takeover records consent, not Friday's menu", async () => {
    const a = await liveApp({ cleanups });
    await tourThenRebookFridayThenCustom(a);
    const replies = await a.text("yes see you friday");
    expect(replies.join("\n")).not.toMatch(/Which time works|I have tours available/);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const live = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations.find((item) => item.slotStart && item.status !== "COMPLETED" && item.status !== "CANCELLED")!;
    expect(live.consentId).toBeTruthy();
  });

  it("yes, but can I do Tuesday instead? is a change request and is not recorded as consent", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("yes, but can I do Tuesday instead?");
    expect(replies.join("\n")).toMatch(/Which time|2:00 PM|3:30 PM/);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeFalsy();
  });

  it("yes but can we do 3:30 instead replaces the 2:00 booking and is not recorded as consent first", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("yes but can we do 3:30 instead");
    expect(replies.join("\n")).toContain(replacesTourLine("2:00 PM", "Monday, Sep 28"));
    expect(replies.join("\n")).toContain(bookedForLine("3:30 PM", "Monday, Sep 28"));
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const reservation = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations.find((item) => item.slotStart && item.status !== "CANCELLED")!;
    expect(reservation.slotStart).toBe(atTime(15, 30).toISOString());
    expect(reservation.consentId).toBeFalsy();
  });
});

describe("an operator proposal wins over held-booking consent", () => {
  it("YES to a proposed time during a tour moves the unconfirmed hold and asks consent", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    await a.text("at unit 1A");
    await a.text("Can I come Friday at 2:00?");
    await a.text("Can I come Friday at 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    await a.grok("propose_tour_time", { tourTimeRequestId: id, newStartsAt: "3:30 PM" });
    const before = a.fake.sent.filter((message) => message.number === PHONE).length;
    const replies = await a.text("YES");
    expect(replies.join("\n")).not.toContain("You're all set for your tour on Friday");
    const friday330 = zonedTimeToUtc({ year: 2026, month: 10, day: 2, hour: 15, minute: 30 }, TZ);
    expect(replies.join("\n")).toContain(bookedForLine(formatTime(friday330, TZ), formatDay(friday330, TZ)));
    expect(replies.join("\n")).toContain(CONSENT_TEXT);
    expect(replies.join("\n")).toContain("Reply YES or NO.");
    expect(a.fake.sent.filter((message) => message.number === PHONE).length).toBeGreaterThan(before);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    expect(bundle.tourTimeRequests[0]!.status).toBe("APPROVED");
    const hold = bundle.reservations.find((item) => item.id !== bundle.reservations.find((r) => r.status === "TOURING")?.id && item.slotStart && item.status !== "CANCELLED")!;
    expect(hold.slotStart).toBe(friday330.toISOString());
    expect(hold.consentId).toBeFalsy();
  });

  it("NO to a proposed time during a tour keeps the hold and resolves the request", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    await a.text("at unit 1A");
    await a.text("Can I come Friday at 2:00?");
    await a.text("Can I come Friday at 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    await a.grok("propose_tour_time", { tourTimeRequestId: id, newStartsAt: "3:30 PM" });
    await a.text("NO");
    const friday2 = zonedTimeToUtc({ year: 2026, month: 10, day: 2, hour: 14, minute: 0 }, TZ);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    expect(bundle.tourTimeRequests[0]!.status).toBe("DECLINED");
    const hold = bundle.reservations.find((item) => item.slotStart === friday2.toISOString() && item.status !== "CANCELLED");
    expect(hold).toBeTruthy();
  });
});

describe("decline and request copy names booked vs confirmed and includes the day", () => {
  it("declining an unconfirmed Friday hold uses the booked wording with both days", async () => {
    const a = await liveApp({ cleanups });
    await tourThenRebookFridayThenCustom(a);
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    const asked = await a.grok("approve_tour_time_request", { tourTimeRequestId: id });
    expect(asked.summary).toContain("Move Testy's tour from 2:00 PM on Friday, Oct 2 to 3:15 PM on Friday, Oct 2?");
    expect((await a.grok("decline_tour_time_request", { tourTimeRequestId: id })).summary).toBe(
      "Declined. Testy is still booked for 2:00 PM on Friday, Oct 2.",
    );
    const last = a.fake.sent.filter((message) => message.number === PHONE).at(-1)!.content;
    expect(last).toBe("The property team couldn't approve 3:15 PM on Friday, Oct 2. You're still booked for 2:00 PM on Friday, Oct 2.");
  });

  it("a first during-tour request acknowledgement says booked and includes the day", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    await a.text("at unit 1A");
    const friday = zonedTimeToUtc({ year: 2026, month: 10, day: 2, hour: 14, minute: 0 }, TZ);
    await a.text("Can I come Friday at 2:00?");
    const replies = await a.text("Can I come Friday at 3:15?");
    expect(replies[0]).toBe(customTimeAskedLine("3:15 PM", formatDay(friday, TZ), "2:00 PM", formatDay(friday, TZ)));
    expect(replies[0]).not.toMatch(/confirmed/);
  });
});

describe("a second regular time during a tour replaces the held booking", () => {
  it("Thursday at 2:00 after a confirmed Friday hold sends That replaces your 2:00 PM tour on Friday and keeps one booking", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    await a.text("at unit 1A");
    await a.text("Can I come Friday at 2:00?");
    await a.text("yes");
    const replies = await a.text("Can I come Thursday at 2:00?");
    const friday = zonedTimeToUtc({ year: 2026, month: 10, day: 2, hour: 14, minute: 0 }, TZ);
    const thursday = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 14, minute: 0 }, TZ);
    expect(replies.join("\n")).toContain(replacesTourLine(formatTime(friday, TZ), formatDay(friday, TZ)));
    expect(replies.join("\n")).toContain(bookedForLine(formatTime(thursday, TZ), formatDay(thursday, TZ)));
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    expect(bundle.reservations.some((item) => item.slotStart === friday.toISOString() && item.status !== "CANCELLED")).toBe(false);
    expect(bundle.reservations.some((item) => item.slotStart === thursday.toISOString() && item.status !== "CANCELLED")).toBe(true);
    expect(bundle.auditEvents.some((event) => event.type === "RESERVATION_RESCHEDULED")).toBe(true);
  });
});

describe("a request whose time has passed expires", () => {
  it("approving 3:15 at 3:20 expires the request, texts the visitor they are still booked, and tells the operator the time passed", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await a.text("Can I change it to 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    a.clock.t = at(15, 20);
    const before = a.fake.sent.filter((message) => message.number === PHONE).length;
    const result = await a.grok("approve_tour_time_request", { tourTimeRequestId: id });
    expect(result.summary).toBe(requestTimePassedLine("Testy"));
    expect(result.status).toBe("expired");
    const after = a.fake.sent.filter((message) => message.number === PHONE).map((message) => message.content).slice(before);
    expect(after.join("\n")).toContain(requestExpiredLine("3:15 PM", "Monday, Sep 28", { time: "2:00 PM", day: "Monday, Sep 28" }));
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.tourTimeRequests[0]!.status).toBe("EXPIRED");
  });

  it("proposing after the requested time has passed expires, does not send the proposal, and uses the propose-only operator line", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await a.text("Can I change it to 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    a.clock.t = at(15, 20);
    const before = a.fake.sent.filter((message) => message.number === PHONE).length;
    const result = await a.grok("propose_tour_time", { tourTimeRequestId: id, newStartsAt: "3:30 PM" });
    expect(result.summary).toBe(requestProposePassedLine("Testy", "3:30 PM", "Monday, Sep 28"));
    expect(result.status).toBe("expired");
    const after = a.fake.sent.filter((message) => message.number === PHONE).map((message) => message.content).slice(before);
    expect(after.join("\n")).toContain(requestExpiredLine("3:15 PM", "Monday, Sep 28", { time: "2:00 PM", day: "Monday, Sep 28" }));
    expect(after.join("\n")).not.toContain("The property team can't do");
    expect(after.join("\n")).not.toContain("Reply YES to switch");
    expect(after.filter((line) => line.includes("couldn't get to your request")).length).toBe(1);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.tourTimeRequests[0]!.status).toBe("EXPIRED");
  });

  it("declining after the requested time has passed expires with the ran-out line, not a decline", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await a.text("Can I change it to 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    a.clock.t = at(15, 20);
    const before = a.fake.sent.filter((message) => message.number === PHONE).length;
    const result = await a.grok("decline_tour_time_request", { tourTimeRequestId: id });
    expect(result.summary).toBe(requestTimePassedLine("Testy"));
    expect(result.status).toBe("expired");
    const after = a.fake.sent.filter((message) => message.number === PHONE).map((message) => message.content).slice(before);
    expect(after.join("\n")).toContain(requestExpiredLine("3:15 PM", "Monday, Sep 28", { time: "2:00 PM", day: "Monday, Sep 28" }));
    expect(after.join("\n")).not.toContain("couldn't approve");
  });

  it("expiring a request with no held booking offers another time", async () => {
    const a = await liveApp({ cleanups });
    await chooseUnit(a);
    await a.text("Can I tour at 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    a.clock.t = at(15, 20);
    const before = a.fake.sent.filter((message) => message.number === PHONE).length;
    const result = await a.grok("approve_tour_time_request", { tourTimeRequestId: id });
    expect(result.summary).toBe(requestTimePassedLine("The visitor"));
    const after = a.fake.sent.filter((message) => message.number === PHONE).map((message) => message.content).slice(before);
    expect(after.join("\n")).toContain(requestExpiredLine("3:15 PM", "Monday, Sep 28"));
    expect(after.join("\n")).toContain("If you'd like another time, just reply with a day.");
  });

  it("already-expired approve, propose, and decline return already handled and do not text again", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await a.text("Can I change it to 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    a.clock.t = at(15, 20);
    await a.server.tourCore.tickOverstay();
    const before = a.fake.sent.filter((message) => message.number === PHONE).length;
    for (const result of [
      await a.grok("approve_tour_time_request", { tourTimeRequestId: id }),
      await a.grok("propose_tour_time", { tourTimeRequestId: id, newStartsAt: "3:30 PM" }),
      await a.grok("decline_tour_time_request", { tourTimeRequestId: id }),
    ]) {
      expect(result.summary).toBe(requestAlreadyExpiredLine("Testy"));
    }
    expect(a.fake.sent.filter((message) => message.number === PHONE).length).toBe(before);
  });

  it("the reminder scheduler expires a nobody-touches request once", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await a.text("Can I change it to 3:15?");
    a.clock.t = at(15, 20);
    const before = a.fake.sent.filter((message) => message.number === PHONE).length;
    await a.server.tourCore.tickOverstay();
    const afterTick = a.fake.sent.filter((message) => message.number === PHONE).map((message) => message.content).slice(before);
    expect(afterTick.join("\n")).toContain(requestExpiredLine("3:15 PM", "Monday, Sep 28", { time: "2:00 PM", day: "Monday, Sep 28" }));
    expect(afterTick.filter((line) => line.includes("couldn't get to your request")).length).toBe(1);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.tourTimeRequests[0]!.status).toBe("EXPIRED");
    await a.server.tourCore.tickOverstay();
    const thanks = await a.text("thanks");
    expect(thanks.join("\n")).not.toContain("couldn't get to your request");
    expect(thanks.join("\n")).not.toContain("still with the property team");
    const all = a.fake.sent.filter((message) => message.number === PHONE && message.content.includes("couldn't get to your request"));
    expect(all).toHaveLength(1);
  });

  it("list and inspect expire a past request and drop it from waiting", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await a.text("Can I change it to 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    a.clock.t = at(15, 20);
    const before = a.fake.sent.filter((message) => message.number === PHONE).length;
    const listed = await a.grok("list_tour_time_requests");
    expect(listed.requests).toHaveLength(0);
    const expiredList = await a.grok("list_tour_time_requests", { status: "expired" });
    expect(expiredList.requests[0].status).toBe("expired");
    const inspected = await a.grok("inspect_tour_time_request", { tourTimeRequestId: id });
    expect(inspected.status).toBe("expired");
    expect(inspected.reason).toBe(requestTimePassedLine("Testy"));
    const after = a.fake.sent.filter((message) => message.number === PHONE).map((message) => message.content).slice(before);
    expect(after.filter((line) => line.includes("couldn't get to your request")).length).toBe(1);
  });
});

describe("custom-time nits", () => {
  it("declineProposedTime racing approve: approve wins and a later NO does not flip it to declined", async () => {
    const ctrl = slotLockControl();
    ctrl.hold("approve");
    const { core, started, requestId } = await inquiryWithCustomRequest(ctrl.barrier);
    await core.proposeTourTime(requestId, atTime(15, 30).toISOString());
    const approveP = core.approveTourTimeRequest(requestId);
    await ctrl.ready("approve");
    const declineP = core.declineProposedTime(requestId);
    ctrl.release("approve");
    await approveP;
    await expect(declineP).rejects.toMatchObject({ code: "REQUEST_CLOSED", message: REQUEST_ALREADY_HANDLED });
    expect((await core.getReservation(started.reservation.id))!.slotStart).toBe(atTime(15, 15).toISOString());
  });

  it("I'm locked in after a +15 close with a pending custom request alerts the landlord", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    await a.text("at unit 1A");
    await a.text("Can I come Thursday at 3:15?");
    a.clock.t = at(15);
    await a.text("hello");
    const replies = await a.text("I'm locked in");
    expect(replies.join("\n")).toContain("Thanks, I've let the property team know");
    expect(replies.join("\n")).not.toContain("still with the property team");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    expect(bundle.auditEvents.some((event) => event.type === "OPERATOR_NOTIFIED" && /locked in/i.test(event.detail ?? ""))).toBe(true);
  });

  it("Can I tour Thursday at 3:15? before a tour files Thursday, not Monday", async () => {
    const a = await liveApp({ cleanups });
    await chooseUnit(a);
    await a.text("Can I tour Thursday at 3:15?");
    const thursday = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 15, minute: 15 }, TZ);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.tourTimeRequests[0]!.requestedStartsAt).toBe(thursday.toISOString());
  });

  it("approve_tour_time_request racing a slot pick returns They booked a regular time instead.", async () => {
    const ctrl = slotLockControl();
    ctrl.hold("reserve");
    const a = await liveApp({ cleanups, slotLockBarrier: ctrl.barrier });
    await chooseUnit(a);
    await a.text("Can I tour at 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    const asked = await a.grok("approve_tour_time_request", { tourTimeRequestId: id });
    const reserveP = a.text("Tuesday").then(() => a.text("1"));
    await ctrl.ready("reserve");
    const approveP = a.grok("approve_tour_time_request", { tourTimeRequestId: id, confirmationCode: asked.confirmation.code });
    ctrl.release("reserve");
    await reserveP;
    const approved = await approveP;
    expect(approved.summary).toBe(WITHDRAWN_FOR_REGULAR_BOOKING);
    expect(approved.status).toBe("withdrawn");
  });
});

describe("a proposed time names both days", () => {
  it("the no-booking proposal keeps looking instead of naming a current tour", async () => {
    const a = await liveApp({ cleanups });
    await chooseUnit(a);
    await a.text("Can I tour at 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    await a.grok("propose_tour_time", { tourTimeRequestId: id, newStartsAt: "3:30 PM" });
    const last = a.fake.sent.filter((message) => message.number === PHONE).at(-1)!.content;
    expect(last).toBe(
      proposeVisitorLine({
        requestedTime: "3:15 PM",
        requestedDay: "Monday, Sep 28",
        proposedTime: "3:30 PM",
        proposedDay: "Monday, Sep 28",
      }),
    );
    expect(last).toBe(
      "The property team can't do 3:15 PM on Monday, Sep 28, but 3:30 PM on Monday, Sep 28 works. Reply YES to switch, or NO to keep looking.",
    );
  });
});

describe("yes plus extra words stays consent unless it is a real change", () => {
  it.each([
    "yes but I might be 5 min late",
    "yes, no change needed",
    "yes, I'd rather not wait",
    "ok but I'll be a little late",
    "yes but I'm bringing my partner",
  ])("%s records consent", async (phrase) => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    await a.text(phrase);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeTruthy();
  });

  it("yes but where do I park? records consent and answers parking", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("yes but where do I park?");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeTruthy();
    expect(replies.join("\n")).toMatch(/parking/i);
    expect(replies.join("\n")).not.toContain("Sorry, I didn't catch that");
  });

  it("Yes, different entrance? records consent and answers the question", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("Yes, different entrance?");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeTruthy();
    expect(replies.join("\n")).not.toContain("Sorry, I didn't catch that");
  });

  it("yes, switch to wednesday is a change and is not recorded as consent", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("yes, switch to wednesday");
    expect(replies.join("\n")).toMatch(/Which time|2:00 PM|3:30 PM/);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeFalsy();
  });
});

describe("a held booking still gets a reply when they ask for another time", () => {
  it("Can I come Tuesday at 2:00? on an operator hold files a request and is never silent", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    const [tour] = (await a.grok("list_active_tours")).tours;
    await a.approve("place_operator_hold", { tourRef: tour.tourRef, reason: "Checking the lobby" });
    const replies = await a.text("Can I come Tuesday at 2:00?");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.join("\n")).toMatch(/asked the property team|Tuesday|2:00/);
    const record = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour("prop_100_alfred_way", record.tourId)!.bundle;
    expect(bundle.tourTimeRequests.some((request) => request.status === "PENDING")).toBe(true);
    expect(bundle.tourTimeRequests[0]!.requestedStartsAt).toBe(zonedTimeToUtc({ year: 2026, month: 9, day: 29, hour: 14, minute: 0 }, TZ).toISOString());
  });
});

describe("a named day on a move is kept", () => {
  it("Can I move it to Tuesday at 2:00? replaces with Tuesday and does not re-ask consent", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    const replies = await a.text("Can I move it to Tuesday at 2:00?");
    expect(replies.join("\n")).toContain(bookedForLine("2:00 PM", "Tuesday, Sep 29"));
    expect(replies.join("\n")).toContain(replacesTourLine("2:00 PM", "Monday, Sep 28"));
    expect(replies.join("\n")).not.toContain(CONSENT_TEXT);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const reservation = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations.find((item) => item.slotStart && item.status !== "CANCELLED")!;
    expect(reservation.slotStart).toBe(zonedTimeToUtc({ year: 2026, month: 9, day: 29, hour: 14, minute: 0 }, TZ).toISOString());
    expect(reservation.consentId).toBeTruthy();
  });

  it("Can I move it to Tuesday at 3:15? files Tuesday custom and does not re-ask consent", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    const replies = await a.text("Can I move it to Tuesday at 3:15?");
    expect(replies.join("\n")).toContain(customTimeAskedLine("3:15 PM", "Tuesday, Sep 29", "2:00 PM", "Monday, Sep 28"));
    expect(replies.join("\n")).not.toContain(CONSENT_TEXT);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.tourTimeRequests[0]!.requestedStartsAt).toBe(
      zonedTimeToUtc({ year: 2026, month: 9, day: 29, hour: 15, minute: 15 }, TZ).toISOString(),
    );
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeTruthy();
  });
});

const OTHER = "+15550102001";
const OTHER2 = "+15550102002";

async function occupyMondaySlot(a: LiveApp, phone: string, pick: "1" | "2") {
  await a.textFrom(phone, "TOUR");
  await a.textFrom(phone, "YES");
  await a.textFrom(phone, "1");
  await a.textFrom(phone, "1");
  await a.textFrom(phone, pick);
}

async function bookMonday330(a: LiveApp) {
  await a.optInSms();
  await a.text("1");
  await a.text("1");
  await a.text("1");
  await a.fillForm(await a.text("YES"));
}

describe("a taken regular slot never files a custom-time request", () => {
  it("a booked visitor moving to a taken slot keeps the current booking and sees what's left", async () => {
    const a = await liveApp({ cleanups });
    await occupyMondaySlot(a, OTHER, "1");
    await bookMonday330(a);
    for (const phrase of ["Can I move it to 2:00?", "Can I change it to 2:00?"]) {
      const replies = await a.text(phrase);
      expect(replies.join("\n")).toContain(takenSlotLine("2:00 PM", "Monday, Sep 28", { time: "3:30 PM", day: "Monday, Sep 28" }));
      expect(replies.join("\n")).toContain(TAKEN_SLOT_OTHER_DAY);
      expect((await a.grok("list_tour_time_requests")).requests).toHaveLength(0);
    }
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.visitorPhone === PHONE)!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations.find((item) => item.slotStart && item.status !== "CANCELLED")!.slotStart).toBe(atTime(15, 30).toISOString());
  });

  it("a waiting-to-confirm hold moving to a taken slot keeps the hold", async () => {
    const a = await liveApp({ cleanups });
    await occupyMondaySlot(a, OTHER, "1");
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    await a.text("1");
    const replies = await a.text("Can I change it to 2:00?");
    expect(replies.join("\n")).toContain(takenSlotLine("2:00 PM", "Monday, Sep 28", { time: "3:30 PM", day: "Monday, Sep 28" }));
    expect(replies.join("\n")).not.toContain("You're still booked for 2:00 PM");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.visitorPhone === PHONE)!;
    const reservation = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations.find((item) => item.slotStart && item.status !== "CANCELLED")!;
    expect(reservation.slotStart).toBe(atTime(15, 30).toISOString());
    expect(reservation.consentId).toBeFalsy();
    expect((await a.grok("list_tour_time_requests")).requests).toHaveLength(0);
  });

  it("an operator hold moving to a taken slot keeps the hold", async () => {
    const a = await liveApp({ cleanups });
    await occupyMondaySlot(a, OTHER, "1");
    await bookMonday330(a);
    const [tour] = (await a.grok("list_active_tours")).tours;
    await a.approve("place_operator_hold", { tourRef: tour.tourRef, reason: "Checking the lobby" });
    const replies = await a.text("Can I move it to 2:00?");
    expect(replies.join("\n")).toContain(takenSlotLine("2:00 PM", "Monday, Sep 28", { time: "3:30 PM", day: "Monday, Sep 28" }));
    expect((await a.grok("list_tour_time_requests")).requests).toHaveLength(0);
  });

  it("confirmRebook of a taken slot during a tour keeps the current tour", async () => {
    const a = await liveApp({ cleanups });
    await a.textFrom(OTHER, "TOUR");
    await a.textFrom(OTHER, "YES");
    await a.textFrom(OTHER, "1");
    await a.textFrom(OTHER, "Friday");
    await a.textFrom(OTHER, "1");
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    await a.text("at unit 1A");
    const replies = await a.text("Can I come Friday at 2:00?");
    expect(replies.join("\n")).toContain(takenSlotLine("2:00 PM", "Friday, Oct 2"));
    expect(replies.join("\n")).not.toContain("You're still booked");
    expect((await a.grok("list_tour_time_requests")).requests).toHaveLength(0);
  });

  it("a taken slot during a tour names a held future booking, not the tour in progress", async () => {
    const a = await liveApp({ cleanups });
    await a.textFrom(OTHER, "TOUR");
    await a.textFrom(OTHER, "YES");
    await a.textFrom(OTHER, "1");
    await a.textFrom(OTHER, "Friday");
    await a.textFrom(OTHER, "1");
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    await a.text("at unit 1A");
    const held = await a.text("Can I come Friday at 3:30?");
    expect(held.join("\n")).toMatch(/3:30 PM|booked|asked/);
    const replies = await a.text("Can I come Friday at 2:00?");
    expect(replies.join("\n")).toContain(takenSlotLine("2:00 PM", "Friday, Oct 2", { time: "3:30 PM", day: "Friday, Oct 2" }));
    expect(replies.join("\n")).not.toContain("You're still booked for 2:00 PM on Monday, Sep 28");
    expect((await a.grok("list_tour_time_requests")).requests).toHaveLength(0);
  });

  it("a taken-slot menu pick works for booked, on-hold, and during-tour visitors", async () => {
    const a = await liveApp({ cleanups });
    await occupyMondaySlot(a, OTHER, "1");
    await a.optInSms();
    await a.text("1");
    await a.text("Tuesday");
    await a.text("1");
    const taken = await a.text("Can I move it to Monday at 2:00?");
    expect(taken.join("\n")).toContain("I have these times available Monday, Sep 28:");
    const picked = await a.text("1");
    expect(picked.join("\n")).toMatch(/3:30 PM|booked/);
    expect(picked.join("\n")).not.toContain("Sorry, I didn't catch that.");

    const b = await liveApp({ cleanups });
    await occupyMondaySlot(b, OTHER, "1");
    await bookMonday330(b);
    const [heldTour] = (await b.grok("list_active_tours")).tours;
    await b.approve("place_operator_hold", { tourRef: heldTour.tourRef, reason: "Checking the lobby" });
    const holdTaken = await b.text("Can I move it to Tuesday at 2:00?");
    expect(holdTaken.join("\n")).toMatch(/2:00 PM|already taken/);
    expect(holdTaken.join("\n")).not.toContain("these times available");
    expect(holdTaken.join("\n")).not.toContain("Reply 1");

    const c = await liveApp({ cleanups });
    await c.textFrom(OTHER, "TOUR");
    await c.textFrom(OTHER, "YES");
    await c.textFrom(OTHER, "1");
    await c.textFrom(OTHER, "Friday");
    await c.textFrom(OTHER, "1");
    await c.book();
    c.clock.t = at(13, 58);
    await c.text("I'm here");
    await c.text("at unit 1A");
    const tourTaken = await c.text("Can I come Friday at 2:00?");
    expect(tourTaken.join("\n")).toContain("I have these times available Friday, Oct 2:");
    const tourPick = await c.text("1");
    expect(tourPick.join("\n")).not.toContain("Sorry, I didn't catch that.");
    const tour = c.ws.listTours("prop_100_alfred_way").find((item) => item.visitorPhone === PHONE)!;
    const reservations = c.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations;
    expect(reservations.some((item) => item.status === "INQUIRY" && !item.slotStart)).toBe(false);
  });

  it("a taken-slot rebook during a tour does not leave an empty inquiry", async () => {
    const a = await liveApp({ cleanups });
    await a.textFrom(OTHER, "TOUR");
    await a.textFrom(OTHER, "YES");
    await a.textFrom(OTHER, "1");
    await a.textFrom(OTHER, "Friday");
    await a.textFrom(OTHER, "1");
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    await a.text("at unit 1A");
    await a.text("Can I come Friday at 2:00?");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.visitorPhone === PHONE)!;
    const reservations = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations;
    expect(reservations.filter((item) => item.status === "INQUIRY")).toHaveLength(0);
    expect(reservations.some((item) => item.status === "TOURING")).toBe(true);
  });

  it("confirmRebook while tours are paused uses the pause line", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    await a.text("at unit 1A");
    await a.approve("pause_tours", { property: "prop_100_alfred_way", bookedTours: "keep" });
    const replies = await a.text("Can I come Friday at 2:00?");
    expect(replies.join("\n")).toMatch(/paused/i);
    expect(replies.join("\n")).not.toContain(HANDLER_SNAG_RETRY);
    expect(replies.join("\n")).not.toContain(HANDLER_SNAG_ALERTED);
  });

  it("a booked visitor moving to a taken slot still sees other open times that day", async () => {
    const a = await liveApp({ cleanups });
    await occupyMondaySlot(a, OTHER, "1");
    await a.optInSms();
    await a.text("1");
    await a.text("Tuesday");
    await a.text("1");
    await a.fillForm(await a.text("YES"));
    const replies = await a.text("Can I move it to Monday at 2:00?");
    expect(replies.join("\n")).toContain(takenSlotLine("2:00 PM", "Monday, Sep 28", { time: "2:00 PM", day: "Tuesday, Sep 29" }));
    expect(replies.join("\n")).toContain("I have these times available Monday, Sep 28:");
    expect(replies.join("\n")).toContain("3:30 PM");
    expect((await a.grok("list_tour_time_requests")).requests).toHaveLength(0);
  });

  it("a visitor with no booking yet does not get the still-booked sentence", async () => {
    const a = await liveApp({ cleanups });
    await occupyMondaySlot(a, OTHER, "1");
    await chooseUnit(a);
    const replies = await a.text("Can I come at 2:00?");
    expect(replies.join("\n")).toContain(takenSlotLine("2:00 PM", "Monday, Sep 28"));
    expect(replies.join("\n")).not.toContain("You're still booked");
    expect(replies.join("\n")).toContain("I have these times available Monday, Sep 28:");
    expect(replies.join("\n")).toContain("3:30 PM");
    expect((await a.grok("list_tour_time_requests")).requests).toHaveLength(0);
  });

  it("a taken slot with no open times that day asks them to reply with a day", async () => {
    const a = await liveApp({ cleanups });
    await occupyMondaySlot(a, OTHER, "1");
    await occupyMondaySlot(a, OTHER2, "1");
    await a.optInSms();
    await a.text("1");
    const replies = await a.text("Can I come Monday at 2:00?");
    expect(replies.join("\n")).toContain(takenSlotLine("2:00 PM", "Monday, Sep 28"));
    expect(replies.join("\n")).not.toContain("You're still booked");
    expect(replies.join("\n")).toContain(TAKEN_SLOT_OTHER_DAY);
    expect((await a.grok("list_tour_time_requests")).requests).toHaveLength(0);
  });
});

describe("yes-but change vs consent", () => {
  it.each(["yes but make it later", "yes but earlier if possible", "yes, different day maybe?"])(
    "%s is a change and is not recorded as consent or flagged as a question",
    async (phrase) => {
      const a = await liveApp({ cleanups });
      await firstBookingConsent(a);
      const replies = await a.text(phrase);
      expect(replies.join("\n")).toMatch(/Which day works for you\?|I have tours available|3:30 PM|2:00 PM/);
      expect(replies.join("\n")).not.toContain("Sorry, I didn't catch that.");
      const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
      const bundle = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
      expect(bundle.reservations[0]!.consentId).toBeFalsy();
      expect(bundle.auditEvents.some((event) => event.type === "QUESTION_UNANSWERED")).toBe(false);
    },
  );

  it("sure but 4pm better uses 4 PM and is not Sorry", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("sure but 4pm better");
    expect(replies.join("\n")).toContain("4:00 PM");
    expect(replies.join("\n")).not.toContain("Sorry, I didn't catch that.");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeFalsy();
  });

  it("yes but I'd rather do tuesday uses Tuesday and is not Sorry", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("yes but I'd rather do tuesday");
    expect(replies.join("\n")).toMatch(/Tuesday|2:00 PM|3:30 PM/);
    expect(replies.join("\n")).not.toContain("Sorry, I didn't catch that.");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeFalsy();
  });

  it.each([
    "yes, but later in the week would be better",
    "yes, sooner would be better",
    "yes, can we do it later?",
    "yes, anything later?",
    "yes, is there anything earlier?",
    "can we do it sooner",
    "anything sooner",
    "is there anything sooner",
    "something sooner",
    "yes, sooner tuesday",
  ])("%s is a change and is not recorded as consent or flagged as a question", async (phrase) => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text(phrase);
    expect(replies.join("\n")).toMatch(/Which day works for you\?|I have tours available|I have these times available|2:00 PM|3:30 PM/);
    expect(replies.join("\n")).not.toContain("Sorry, I didn't catch that.");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    expect(bundle.reservations[0]!.consentId).toBeFalsy();
    expect(bundle.auditEvents.some((event) => event.type === "QUESTION_UNANSWERED")).toBe(false);
    expect(bundle.auditEvents.some((event) => event.type === "HANDLER_FAILED")).toBe(false);
  });

  it("yes, but later in the week would be better shows the rest of the week, not Monday's times only", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("yes, but later in the week would be better");
    expect(replies.join("\n")).toMatch(/Which day works for you\?|Tuesday|Wednesday/);
    expect(replies.join("\n")).not.toContain("I have these times available Monday, Sep 28:");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeFalsy();
  });

  it("yes but tuesday works better shows Tuesday's times", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("yes but tuesday works better");
    expect(replies.join("\n")).toMatch(/Tuesday|2:00 PM|3:30 PM/);
    expect(replies.join("\n")).not.toContain("Which day works for you?");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeFalsy();
  });

  it("no need, I'll switch to Wednesday shows Wednesday's times", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("no need, I'll switch to Wednesday");
    expect(replies.join("\n")).toMatch(/Wednesday|2:00 PM|3:30 PM/);
    expect(replies.join("\n")).not.toContain("Which day works for you?");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeFalsy();
  });

  it("yes but not monday does not show Monday's times", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("yes but not monday");
    expect(replies.join("\n")).not.toContain("Monday, Sep 28");
    expect(replies.join("\n")).toMatch(/Which day works for you\?|Tuesday/);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeFalsy();
  });

  it("yes, but tomorrow I'm busy does not show tomorrow's times", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("yes, but tomorrow I'm busy");
    expect(replies.join("\n")).not.toContain("Tuesday, Sep 29");
    expect(replies.join("\n")).toMatch(/Which day works for you\?|Monday, Sep 28|Wednesday/);
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeFalsy();
  });

  it.each([
    "yes, see you later",
    "yes later",
    "yes, talk later",
    "yes but I'll be there a bit earlier",
    "yes, I'll arrive earlier",
    "yes but I might be 5 min late",
    "yes, no need to switch",
    "yes, I won't need to reschedule",
    "yes, no reason to change",
    "yes, no need to reschedule",
    "yes, I won't need to switch anything",
    "yes, sooner the better!",
    "yes, the sooner the better",
    "yes, the sooner I see it the better",
    "yes, see you sooner rather than later",
  ])("%s records consent", async (phrase) => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text(phrase);
    expect(replies.join("\n")).not.toContain("Sorry, I didn't catch that.");
    expect(replies.join("\n")).not.toContain("Great, you're booked for");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeTruthy();
  });

  it("yes but earlier if possible offers earlier open times that day", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    const booked = await a.text("2");
    expect(booked.join("\n")).toContain(bookedForLine("3:30 PM", "Monday, Sep 28"));
    const replies = await a.text("yes but earlier if possible");
    expect(replies.join("\n")).toContain("I have these times available Monday, Sep 28:");
    expect(replies.join("\n")).toContain("2:00 PM");
    expect(replies.join("\n")).not.toContain("Great, you're booked for 2:00 PM");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeFalsy();
  });

  it("yes but make it later offers later open times and does not book", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("yes but make it later");
    expect(replies.join("\n")).toContain("I have these times available Monday, Sep 28:");
    expect(replies.join("\n")).toContain("3:30 PM");
    expect(replies.join("\n")).not.toContain(bookedForLine("3:30 PM", "Monday, Sep 28"));
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const reservation = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!;
    expect(reservation.consentId).toBeFalsy();
    expect(reservation.slotStart).toBe(atTime(14).toISOString());
  });

  it("monday is fine but not tuesday is consent on a Monday booking", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("monday is fine but not tuesday");
    expect(replies.join("\n")).not.toContain("Which day works for you?");
    expect(replies.join("\n")).not.toContain("I have tours available");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.consentId).toBeTruthy();
  });

  it("yes, can I do anything to prepare? records consent and answers or flags the question", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("yes, can I do anything to prepare?");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    expect(bundle.reservations[0]!.consentId).toBeTruthy();
    expect(replies.join("\n")).not.toContain("Sorry, I didn't catch that.");
    expect(replies.join("\n").length).toBeGreaterThan(0);
  });
});

describe("past-time copy", () => {
  it("a visitor naming a past time gets the later-time ask", async () => {
    const a = await liveApp({ cleanups });
    await chooseUnit(a);
    const replies = await a.text("Can I come today at 6:00 AM?");
    expect(replies[0]).toBe(VISITOR_TIME_PASSED);
  });

  it("a same-day weekday or full date in the past is rejected up front", async () => {
    const a = await liveApp({ cleanups });
    await chooseUnit(a);
    a.clock.t = at(15);
    const weekday = await a.text("Can I come Monday at 2:30?");
    expect(weekday[0]).toBe(VISITOR_TIME_PASSED);
    expect((await a.grok("list_tour_time_requests")).requests).toHaveLength(0);
    const dated = await a.text("Can I come September 28 at 2:30?");
    expect(dated[0]).toBe(VISITOR_TIME_PASSED);
    expect((await a.grok("list_tour_time_requests")).requests).toHaveLength(0);
  });

  it("an operator proposing a past time gets the pick-later line", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await a.text("Can I change it to 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    await expect(a.grok("propose_tour_time", { tourTimeRequestId: id, newStartsAt: "6:00 AM" })).rejects.toThrow(SLOT_ALREADY_PASSED);
  });
});

describe("a handler throw never leaves the visitor in silence", () => {
  async function throwingApp(options: { failAlert?: boolean } = {}) {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "tourcore-snag-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const clock = { t: at(7) };
    const ws = new PropertyWorkspace(root);
    const { config } = ws.save(hillsideConfig());
    ws.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(clock.t) }));
    const runtime = new MemoryRuntimeStore();
    const endpoints = new MessagingEndpoints(runtime);
    endpoints.attach({ address: "+15550001111", provider: "demo", propertyId: "prop_100_alfred_way" });
    const registry = new VisitorDemoRegistry();
    const sent: Array<{ to: string; body: string; audience: string }> = [];
    const inner = new DemoMessagingAdapter(() => {}, "MESSAGING");
    const transport = {
      provider: inner.provider,
      presentation: inner.presentation,
      send: async (message: { to: string; body: string; audience: string }) => {
        sent.push({ to: message.to, body: message.body, audience: message.audience });
        return inner.send(message as never);
      },
    };
    const rules = new LayeredIntentInterpreter();
    let explode = false;
    const router = new MessagingConversations({
      workspace: ws,
      registry,
      runtime,
      endpoints,
      transport: () => transport as never,
      links: new VerificationLinks({ baseUrl: () => undefined }),
      realNow: () => clock.t,
      defaultLine: () => "+15550001111",
      consentMode: () => "disabled",
      interpreter: {
        description: "test-throw",
        interpret: async (ctx) => {
          if (explode) throw new Error("forced handler failure");
          return rules.interpret(ctx);
        },
      },
    });
    let n = 0;
    const text = async (body: string) => {
      const before = sent.length;
      await router.receive({
        provider: "test",
        providerMessageId: `m_${++n}`,
        from: PHONE,
        to: "+15550001111",
        text: body,
        channel: "SMS",
        receivedAt: new Date(clock.t).toISOString(),
      });
      return sent.slice(before).filter((item) => item.to === PHONE).map((item) => item.body);
    };
    const session = () => registry.latestForPhone("prop_100_alfred_way", PHONE, "messaging")!;
    if (options.failAlert) {
      /* patched after a reservation exists */
    }
    return { text, session, explode: () => { explode = true; } };
  }

  it("sends the team-notified line when the operator alert goes out", async () => {
    const app = await throwingApp();
    await app.text("Hi");
    await app.text("1");
    app.explode();
    const replies = await app.text("hello");
    expect(replies.at(-1)).toBe(HANDLER_SNAG_ALERTED);
    expect(replies.length).toBeGreaterThan(0);
  });

  it("sends the retry line when the alert record cannot be created", async () => {
    const app = await throwingApp();
    await app.text("Hi");
    await app.text("1");
    const store = app.session().store;
    const append = store.appendAudit.bind(store);
    store.appendAudit = async (event) => {
      if (event.type === "HANDLER_FAILED") throw new Error("disk full");
      return append(event);
    };
    app.explode();
    const replies = await app.text("hello");
    expect(replies.at(-1)).toBe(HANDLER_SNAG_RETRY);
    expect(replies.length).toBeGreaterThan(0);
  });

  it("a handler that already replied does not send a second snag line", async () => {
    const app = await throwingApp();
    await app.text("Hi");
    await app.text("1");
    app.session().bookOffered = async () => {
      await app.session().reply("I found a time that works.");
      throw new Error("No reservation res_forced");
    };
    const replies = await app.text("Can I come at 3:30?");
    expect(replies).toContain("I found a time that works.");
    expect(replies).not.toContain(HANDLER_SNAG_ALERTED);
    expect(replies).not.toContain(HANDLER_SNAG_RETRY);
    const events = await app.session().store.listAudit();
    expect(
      events.some(
        (event) =>
          event.type === "HANDLER_FAILED" &&
          event.detail === handlerFailureAlertLine("(555) 010-2000", "Can I come at 3:30?", { alreadyReplied: true }),
      ),
    ).toBe(true);
    expect(events.some((event) => event.detail.includes("I told them you'd reply as soon as you can."))).toBe(false);
  });

  it("an empty visitor text uses the sent-a-text landlord line", async () => {
    const app = await throwingApp();
    await app.text("Hi");
    await app.text("1");
    app.explode();
    await app.text("   ");
    const events = await app.session().store.listAudit();
    expect(events.some((event) => event.type === "HANDLER_FAILED" && event.detail === handlerFailureAlertLine("(555) 010-2000", ""))).toBe(true);
  });

  it("a partial reply plus empty text uses the finish-handling empty line", async () => {
    const app = await throwingApp();
    await app.text("Hi");
    await app.text("1");
    const session = app.session();
    const reply = session.reply.bind(session);
    let once = true;
    session.reply = async (...args: Parameters<typeof reply>) => {
      const sent = await reply(...args);
      if (once) {
        once = false;
        throw new Error("after a partial reply");
      }
      return sent;
    };
    const replies = await app.text("   ");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies).not.toContain(HANDLER_SNAG_ALERTED);
    const events = await session.store.listAudit();
    expect(
      events.some(
        (event) =>
          event.type === "HANDLER_FAILED" &&
          event.detail === handlerFailureAlertLine("(555) 010-2000", "", { alreadyReplied: true }),
      ),
    ).toBe(true);
  });

  it("a failed record step does not count an older identical event as this alert", async () => {
    const app = await throwingApp();
    await app.text("Hi");
    await app.text("1");
    await app.text("Is there a gym?");
    const store = app.session().store;
    const append = store.appendAudit.bind(store);
    store.appendAudit = async (event) => {
      if (event.type === "HANDLER_FAILED") throw new Error("disk full");
      return append(event);
    };
    app.explode();
    const replies = await app.text("Is there a gym?");
    expect(replies.at(-1)).toBe(HANDLER_SNAG_RETRY);
    expect(replies).not.toContain(HANDLER_SNAG_ALERTED);
  });

  it("a handler that returns without a reply gets the fallback line", async () => {
    const app = await throwingApp();
    await app.text("Hi");
    app.session().welcome = async () => {};
    const replies = await app.text("tour");
    expect(replies.at(-1)).toBe("Sorry, I didn't catch that.");
  });
});

describe("a Sendblue handler throw raises a real landlord alert", () => {
  it("records an exception and texts the team-notified line", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    const session = a.visitors.latestForPhone("prop_100_alfred_way", PHONE, "messaging")!;
    session.bookOffered = async () => {
      throw new Error(`No reservation ${session.reservationId}`);
    };
    const replies = await a.text("Can I move it to 3:30?");
    expect(replies).toContain(HANDLER_SNAG_ALERTED);
    const queue = await a.grok("list_exceptions");
    expect(queue.exceptions.length).toBeGreaterThan(0);
    expect(queue.exceptions[0].what).toBe("Couldn't handle their text");
    expect(queue.exceptions[0].what).not.toBe("Question with no approved answer");
    expect(a.routineEvents().some((event) => event.eventType === "exception.created")).toBe(true);
    const [active] = (await a.grok("list_active_tours")).tours;
    const inspect = JSON.stringify(await a.grok("inspect_tour", { tourRef: active.tourRef }));
    expect(inspect).not.toContain(`No reservation ${session.reservationId}`);
    expect(inspect).not.toMatch(/TypeError|No prospect /);
    const saved = a.ws.loadTour("prop_100_alfred_way", a.ws.listTours("prop_100_alfred_way").find((item) => item.visitorPhone === PHONE)!.tourId)!.bundle;
    expect(saved.auditEvents.some((event) => event.type === "OPERATOR_NOTIFIED" && event.detail === handlerFailureAlertLine("Testy", "Can I move it to 3:30?"))).toBe(true);
    expect(saved.auditEvents.every((event) => !/No reservation |No prospect |Reservation is |TypeError/.test(event.detail))).toBe(true);
  });

  it("sends the retry line when the alert record cannot be written", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    const session = a.visitors.latestForPhone("prop_100_alfred_way", PHONE, "messaging")!;
    const append = session.store.appendAudit.bind(session.store);
    session.store.appendAudit = async (event) => {
      if (event.type === "HANDLER_FAILED") throw new Error("disk full");
      return append(event);
    };
    session.bookOffered = async () => {
      throw new Error("No reservation res_xyz");
    };
    const replies = await a.text("Can I move it to 3:30?");
    expect(replies).toContain(HANDLER_SNAG_RETRY);
    expect(replies).not.toContain(HANDLER_SNAG_ALERTED);
  });

  it("a handler failure is its own issue, not a flagged question, and a reply does not save a fact", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    const session = a.visitors.latestForPhone("prop_100_alfred_way", PHONE, "messaging")!;
    session.bookOffered = async () => {
      throw new Error(`No reservation ${session.reservationId}`);
    };
    await a.text("Can I move it to 3:30?");
    const queue = await a.grok("list_exceptions");
    const issue = queue.exceptions.find((item: { what: string }) => item.what === "Couldn't handle their text");
    expect(issue).toBeTruthy();
    expect(issue.what).not.toBe("Question with no approved answer");
    expect(issue.summary).toBe(handlerFailureAlertLine("Testy", "Can I move it to 3:30?"));
    expect(issue.nextSteps).toContain(HANDLER_FAILED_NEXT_STEP);
    expect(issue.nextSteps.join(" ")).not.toMatch(/approved fact/i);
    const opened = await a.grok("inspect_exception", { exceptionId: issue.exceptionId });
    expect(opened.issue.what).toBe("Couldn't handle their text");
    expect(opened.issue.summary).toBe(handlerFailureAlertLine("Testy", "Can I move it to 3:30?"));
    expect(opened.issue.nextSteps).toContain(HANDLER_FAILED_NEXT_STEP);
    expect(opened.issue.question).toBeUndefined();
    const event = a.routineEvents().find((item) => item.eventType === "exception.created");
    expect(event).toBeTruthy();
    const update = await a.grok("get_operator_update", { eventId: event!.eventId });
    expect(update.issue.nextSteps).toContain(HANDLER_FAILED_NEXT_STEP);
    expect(JSON.stringify(update)).not.toMatch(/approved facts|Future visitors who ask the same thing/);
    const before = a.fake.sent.filter((item) => item.number === PHONE).length;
    const asked = await a.grok("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "The lobby door is on the left." });
    expect(asked.summary).toBe('Send "The lobby door is on the left." to Testy?');
    expect(asked.confirmation.question).toBe('Send "The lobby door is on the left." to Testy?');
    expect(asked.summary).not.toContain("Future visitors who ask the same thing will get it too");
    expect(asked.summary).not.toBe("Sent to Testy.");
    expect(a.fake.sent.filter((item) => item.number === PHONE)).toHaveLength(before);
    expect((await a.grok("list_exceptions")).exceptions.find((item: { exceptionId: string }) => item.exceptionId === issue.exceptionId)).toBeTruthy();
    const done = await a.grok("answer_flagged_question", {
      exceptionId: issue.exceptionId,
      approvedFact: "The lobby door is on the left.",
      confirmationCode: asked.confirmation.code,
    });
    expect(done.savedToSetup).toBe(false);
    expect(done.summary).toBe("Sent to Testy.");
    expect(done.approvedFact).toBeUndefined();
    expect(done.addedTo).toBeUndefined();
    expect(a.fake.sent.some((item) => item.number === PHONE && item.content === "The lobby door is on the left.")).toBe(true);
    const facts = a.ws.load("prop_100_alfred_way").config.property.facts;
    expect(facts).not.toContain("The lobby door is on the left.");
    expect((await a.grok("list_exceptions")).exceptions.find((item: { exceptionId: string }) => item.exceptionId === issue.exceptionId)).toBeUndefined();
  });

  it("resolve_exception closes a handler-failure issue", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    const session = a.visitors.latestForPhone("prop_100_alfred_way", PHONE, "messaging")!;
    session.bookOffered = async () => {
      throw new Error("No reservation res_resolve");
    };
    await a.text("Can I move it to 3:30?");
    const [issue] = (await a.grok("list_exceptions")).exceptions;
    const resolved = await a.grok("resolve_exception", { exceptionId: issue.exceptionId, resolutionNote: "Called them." });
    expect(resolved.issue.status).toBe("resolved");
    expect((await a.grok("list_exceptions")).exceptions).toHaveLength(0);
  });

  it("an unnamed visitor uses the phone label, never A, on Send and Sent to", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    await a.text("1");
    const session = a.visitors.latestForPhone("prop_100_alfred_way", PHONE, "messaging")!;
    session.bookOffered = async () => {
      throw new Error(`No reservation ${session.reservationId}`);
    };
    await a.text("Can I move it to 3:30?");
    const issue = (await a.grok("list_exceptions")).exceptions.find((item: { what: string }) => item.what === "Couldn't handle their text");
    expect(issue).toBeTruthy();
    const who = formatPhone(PHONE);
    expect(operatorWhoLabel(issue.visitorName, PHONE)).toBe(who);
    const asked = await a.grok("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "The lobby door is on the left." });
    expect(asked.confirmation.question).toBe(`Send "The lobby door is on the left." to ${who}?`);
    expect(asked.summary).toBe(`Send "The lobby door is on the left." to ${who}?`);
    expect(asked.summary).not.toMatch(/\bA\b/);
    const done = await a.grok("answer_flagged_question", {
      exceptionId: issue.exceptionId,
      approvedFact: "The lobby door is on the left.",
      confirmationCode: asked.confirmation.code,
    });
    expect(done.summary).toBe(`Sent to ${who}.`);
    expect(done.summary).not.toBe("Sent to A.");
  });

  it("send-only leaves the issue open when the visitor cannot be texted", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    const session = a.visitors.latestForPhone("prop_100_alfred_way", PHONE, "messaging")!;
    session.bookOffered = async () => {
      throw new Error(`No reservation ${session.reservationId}`);
    };
    await a.text("Can I move it to 3:30?");
    const [issue] = (await a.grok("list_exceptions")).exceptions;
    a.visitors.clear();
    const asked = await a.grok("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "Call you shortly." });
    expect(asked.confirmation.question).toBe('Send "Call you shortly." to Testy?');
    const before = a.fake.sent.filter((item) => item.number === PHONE && item.content === "Call you shortly.").length;
    await expect(
      a.grok("answer_flagged_question", {
        exceptionId: issue.exceptionId,
        approvedFact: "Call you shortly.",
        confirmationCode: asked.confirmation.code,
      }),
    ).rejects.toThrow(sendOnlyUnreachableLine("Testy"));
    expect(a.fake.sent.filter((item) => item.number === PHONE && item.content === "Call you shortly.")).toHaveLength(before);
    expect((await a.grok("list_exceptions")).exceptions.find((item: { exceptionId: string }) => item.exceptionId === issue.exceptionId)).toBeTruthy();
  });

  it("answer_flagged_question still saves an approved fact for a real question", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await a.text("Is there a gym?");
    const [issue] = (await a.grok("list_exceptions")).exceptions;
    expect(issue.what).toBe("Question with no approved answer");
    const asked = await a.grok("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "There's a gym on the roof." });
    expect(asked.summary).toContain("Future visitors who ask the same thing will get it too");
    const done = await a.approve("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "There's a gym on the roof." });
    expect(done.savedToSetup).toBe(true);
  });
});

describe("a leftover booking menu is not live", () => {
  it("READY leftover 2, later, or 3:30 does not move Monday 2:00", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    for (const phrase of ["2", "later", "3:30"]) {
      const replies = await a.text(phrase);
      expect(replies.join("\n")).toContain("Sorry, I didn't catch that.");
      expect(replies.join("\n")).not.toContain("That replaces your");
      expect(replies.join("\n")).not.toContain(bookedForLine("3:30 PM", "Monday, Sep 28"));
    }
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.visitorPhone === PHONE)!;
    const reservation = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations.find((item) => item.status === "READY")!;
    expect(reservation.slotStart).toBe(atTime(14).toISOString());
  });

  it("touring leftover 2 or later does not create a second booking", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    await a.text("at unit 1A");
    for (const phrase of ["2", "later"]) {
      const replies = await a.text(phrase);
      expect(replies.join("\n")).toContain("Sorry, I didn't catch that.");
    }
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.visitorPhone === PHONE)!;
    const reservations = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations;
    expect(reservations.filter((item) => item.status === "AWAITING_CONSENT")).toHaveLength(0);
    expect(reservations.some((item) => item.status === "TOURING" && item.slotStart === atTime(14).toISOString())).toBe(true);
  });

  it("on hold, a leftover 1 keeps the hold message", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    const [tour] = (await a.grok("list_active_tours")).tours;
    await a.approve("place_operator_hold", { tourRef: tour.tourRef, reason: "Checking the lobby" });
    const replies = await a.text("1");
    expect(replies.join("\n")).toMatch(/on hold/i);
    expect(replies.join("\n")).not.toContain("Great, you're booked for 2:00 PM on Monday");
    const saved = a.ws.listTours("prop_100_alfred_way").find((item) => item.visitorPhone === PHONE)!;
    expect(a.ws.loadTour("prop_100_alfred_way", saved.tourId)!.bundle.reservations.some((item) => item.status === "OPERATOR_HOLD")).toBe(true);
  });

  it("at consent, a bare later does not move 2:00 to 3:30", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("later");
    expect(replies.join("\n")).toContain("Sorry, I didn't catch that.");
    expect(replies.join("\n")).not.toContain(bookedForLine("3:30 PM", "Monday, Sep 28"));
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const reservation = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!;
    expect(reservation.slotStart).toBe(atTime(14).toISOString());
    expect(reservation.consentId).toBeFalsy();
  });

  it("at consent, a bare sooner does not open a day menu or move the booking", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const replies = await a.text("sooner");
    expect(replies.join("\n")).toContain("Sorry, I didn't catch that.");
    expect(replies.join("\n")).not.toContain("Which day works for you?");
    expect(replies.join("\n")).not.toContain("I have tours available");
    expect(replies.join("\n")).not.toContain(bookedForLine("3:30 PM", "Monday, Sep 28"));
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const reservation = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!;
    expect(reservation.slotStart).toBe(atTime(14).toISOString());
    expect(reservation.consentId).toBeFalsy();
  });

  it("yes but make it later then a menu pick still moves the booking", async () => {
    const a = await liveApp({ cleanups });
    await firstBookingConsent(a);
    const offered = await a.text("yes but make it later");
    expect(offered.join("\n")).toContain("I have these times available Monday, Sep 28:");
    const picked = await a.text("1");
    expect(picked.join("\n")).toMatch(/3:30 PM|booked/);
    expect(picked.join("\n")).not.toContain("Sorry, I didn't catch that.");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.slotStart).toBe(atTime(15, 30).toISOString());
  });
});

describe("a taken slot while on hold does not show a menu", () => {
  it("keeps the hold, replies, and does not offer a numbered pick", async () => {
    const a = await liveApp({ cleanups });
    await a.textFrom(OTHER, "TOUR");
    await a.textFrom(OTHER, "YES");
    await a.textFrom(OTHER, "1");
    await a.textFrom(OTHER, "Tuesday");
    await a.textFrom(OTHER, "1");
    await a.book();
    const tours = (await a.grok("list_active_tours")).tours as Array<{ tourRef: string; visitorName: string }>;
    const tour = tours.find((item) => item.visitorName.startsWith("Testy"));
    expect(tour).toBeTruthy();
    await a.approve("place_operator_hold", { tourRef: tour!.tourRef, reason: "Checking the lobby" });
    const replies = await a.text("Can I come Tuesday at 2:00?");
    expect(replies.join("\n")).toContain(takenSlotLine("2:00 PM", "Tuesday, Sep 29", { time: "2:00 PM", day: "Monday, Sep 28" }));
    expect(replies.join("\n")).not.toContain("these times available");
    expect(replies.join("\n")).not.toContain("Reply 1");
    expect(replies.length).toBeGreaterThan(0);
    const saved = a.ws.listTours("prop_100_alfred_way").find((item) => item.visitorPhone === PHONE)!;
    expect(a.ws.loadTour("prop_100_alfred_way", saved.tourId)!.bundle.reservations.some((item) => item.status === "OPERATOR_HOLD")).toBe(true);
    const follow = await a.text("1");
    expect(follow.join("\n")).toMatch(/on hold|Sorry, I didn't catch that/);
    expect(follow.join("\n")).not.toContain(bookedForLine("3:30 PM", "Tuesday, Sep 29"));
  });
});

describe("handlerFailureAlertLine branches", () => {
  it("covers no-reply empty, partial empty, and partial with text", () => {
    expect(handlerFailureAlertLine("Testy", "")).toBe(
      "Testy sent a text I couldn't handle, so they're waiting on you. I told them you'd reply as soon as you can.",
    );
    expect(handlerFailureAlertLine("Testy", "  ", { alreadyReplied: true })).toBe(
      "Testy sent a text I couldn't finish handling. They got part of a reply, so they may still be waiting on you.",
    );
    expect(handlerFailureAlertLine("Testy", "Can I come at 3:30?", { alreadyReplied: true })).toBe(
      'Testy texted "Can I come at 3:30?" and I couldn\'t finish handling it. They got part of a reply, so they may still be waiting on you.',
    );
  });
});

describe("an operator booking change stale-dates a leftover menu", () => {
  async function takenTuesdayMenu(a: LiveApp) {
    await a.textFrom(OTHER, "TOUR");
    await a.textFrom(OTHER, "YES");
    await a.textFrom(OTHER, "1");
    await a.textFrom(OTHER, "Tuesday");
    await a.textFrom(OTHER, "1");
    await a.book();
    const taken = await a.text("Can I come Tuesday at 2:00?");
    expect(taken.join("\n")).toContain("Reply 1 for 3:30 PM");
    return taken;
  }

  it("reschedule to Friday then 1 does not move the booking", async () => {
    const a = await liveApp({ cleanups });
    await takenTuesdayMenu(a);
    await a.approve("reschedule_tour", { visitor: "Testy", newStartsAt: "Friday at 3:30 PM" });
    const friday = zonedTimeToUtc({ year: 2026, month: 10, day: 2, hour: 15, minute: 30 }, "America/New_York");
    const replies = await a.text("1");
    expect(replies.join("\n")).toContain("Sorry, I didn't catch that.");
    expect(replies.join("\n")).not.toContain("That replaces your");
    expect(replies.join("\n")).not.toContain(bookedForLine("3:30 PM", "Tuesday, Sep 29"));
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.visitorPhone === PHONE)!;
    const reservation = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations.find((item) => item.slotStart && item.status !== "CANCELLED")!;
    expect(reservation.slotStart).toBe(friday.toISOString());
  });

  it("approving a 3:15 request then 1 does not move the booking", async () => {
    const a = await liveApp({ cleanups });
    await takenTuesdayMenu(a);
    await a.text("Can I move it to 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    await a.approve("approve_tour_time_request", { tourTimeRequestId: id });
    const replies = await a.text("1");
    expect(replies.join("\n")).toContain("Sorry, I didn't catch that.");
    expect(replies.join("\n")).not.toContain("That replaces your");
    expect(replies.join("\n")).not.toContain(bookedForLine("3:30 PM", "Tuesday, Sep 29"));
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.visitorPhone === PHONE)!;
    const reservation = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations.find((item) => item.slotStart && item.status !== "CANCELLED")!;
    expect(reservation.slotStart).toBe(atTime(15, 15).toISOString());
  });
});

describe("a held rebook leftover menu number does not move the booking", () => {
  it("bare 2 before consent, after consent, and while arrival is pending leaves Thursday 2:00 held", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    await a.text("at unit 1A");
    const booked = await a.text("Can I come Thursday at 2:00?");
    expect(booked.join("\n")).toMatch(/2:00 PM|Thursday/);
    const session = a.visitors.latestForPhone("prop_100_alfred_way", PHONE, "messaging")!;
    expect(session.pendingBookingId).toBeTruthy();
    const thursday = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 14, minute: 0 }, "America/New_York");
    const heldSlot = async () => {
      const pending = session.pendingBookingId ?? session.reservationId;
      const reservation = pending ? await session.store.get("reservations", pending) : undefined;
      return reservation?.slotStart;
    };
    expect(await heldSlot()).toBe(thursday.toISOString());

    const before = await a.text("2");
    expect(before.join("\n")).toContain("Sorry, I didn't catch that.");
    expect(before.join("\n")).not.toContain("That replaces your");
    expect(await heldSlot()).toBe(thursday.toISOString());

    await a.text("yes");
    const after = await a.text("2");
    expect(after.join("\n")).toContain("Sorry, I didn't catch that.");
    expect(after.join("\n")).not.toContain("That replaces your");
    expect(await heldSlot()).toBe(thursday.toISOString());

    session.expect("touring", { kind: "confirm-stop", stop: { doorName: "Unit 1A", kind: "UNIT", unitName: "Unit 1A", label: "Unit 1A" } });
    const pendingArrival = await a.text("2");
    expect(pendingArrival.join("\n")).toMatch(/Sorry, I didn't catch that|Are you at Unit 1A now/);
    expect(pendingArrival.join("\n")).not.toContain("That replaces your");
    expect(await heldSlot()).toBe(thursday.toISOString());
  });
});
