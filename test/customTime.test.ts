import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { slotsOn } from "../src/core/schedule";
import { SimulatedClock } from "../src/core/clock";
import { formatDay, formatTime, zonedTimeToUtc } from "../src/core/timezone";
import {
  bookedForLine,
  CONSENT_TEXT,
  PENDING_CUSTOM_TIME_REGULAR_OPTION,
  pendingCustomTimeLine,
  replacesTourLine,
  WITHDRAWN_FOR_REGULAR_BOOKING,
} from "../src/core/TourCore";
import { createTourCore } from "../src/createTourCore";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import { at, liveApp, PHONE, type LiveApp } from "./liveApp";

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
    expect(replies[0]).toContain("moving your tour to 3:15 PM");
    expect(replies[0]).toContain("2:00 PM tour is still confirmed");
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
    expect(repeat[0]).toContain("already asked the property team");
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
      "Declined. Testy's 2:00 PM tour is still confirmed.",
    );
    const last = a.fake.sent.filter((message) => message.number === PHONE).at(-1)!.content;
    expect(last).toContain("couldn't approve 3:15 PM");
    expect(last).toContain("2:00 PM tour is still confirmed");
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
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle.reservations[0]!.slotStart).toBe(atTime(14).toISOString());
    const refused = await a.text("no");
    expect(refused.join("\n")).toContain("2:00 PM tour is still confirmed");
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
    expect(asked.summary).toContain("Move Testy's tour from 2:00 PM to 3:15 PM today?");
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

  it("I'm locked in after the pending line gets HELP with no operator alert", async () => {
    const a = await liveApp({ cleanups });
    const later = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 15, minute: 15 }, TZ);
    await tourThenCustomTime(a, later);
    const beforeAlerts = a.fake.sent.filter((message) => message.number !== PHONE).length;
    const replies = await a.text("I'm locked in");
    expect(replies.join("\n")).toMatch(/HELP|help/i);
    expect(replies.join("\n")).not.toContain("still with the property team");
    expect(a.fake.sent.filter((message) => message.number !== PHONE).length).toBe(beforeAlerts);
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
  for (const op of ["reserve", "approve", "decline", "propose"] as const) {
    ready.set(op, new Promise<void>((resolve) => entered.set(op, resolve)));
    holdByOp.set(op, new Promise<void>((resolve) => releaseByOp.set(op, resolve)));
  }
  let holdOp: string | undefined;
  return {
    hold(op: "reserve" | "approve" | "decline" | "propose") {
      holdOp = op;
    },
    ready(op: "reserve" | "approve" | "decline" | "propose") {
      return ready.get(op)!;
    },
    release(op: "reserve" | "approve" | "decline" | "propose") {
      releaseByOp.get(op)!();
    },
    barrier: async (op: "reserve" | "approve" | "decline" | "propose") => {
      entered.get(op)!();
      if (holdOp === op) await holdByOp.get(op);
    },
  };
}

async function inquiryWithCustomRequest(barrier: (op: "reserve" | "approve" | "decline" | "propose") => Promise<void>) {
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

  it("picking Tuesday replaces the Friday hold, releases that slot, and sends That replaces your Friday 2:00 PM tour.", async () => {
    const a = await liveApp({ cleanups });
    const { friday } = await tourThenRebookFridayThenCustom(a);
    await a.text("Tuesday");
    const booked = await a.text("1");
    const texts = booked.join("\n");
    const tuesday = zonedTimeToUtc({ year: 2026, month: 9, day: 29, hour: 14, minute: 0 }, TZ);
    expect(texts).toContain(bookedForLine(formatTime(tuesday, TZ), formatDay(tuesday, TZ)));
    expect(texts).toContain(replacesTourLine(formatDay(friday, TZ), formatTime(friday, TZ)));
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
