import { afterEach, describe, expect, it } from "vitest";
import { slotsOn } from "../src/core/schedule";
import { zonedTimeToUtc } from "../src/core/timezone";
import { runReadinessCheck } from "../src/setup";
import { operatorScheduledFirstText } from "../src/visitor/session";
import { at, liveApp, PHONE, type LiveApp } from "./liveApp";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const OTHER = "+15550102001";
const PROPERTY = "prop_100_alfred_way";

function hoursOf(a: LiveApp) {
  return structuredClone(a.ws.load(PROPERTY).config.tourHours);
}

async function publish(a: LiveApp) {
  a.ws.recordDryTour(PROPERTY, { passed: true, ranAt: new Date(a.clock.t).toISOString(), checks: [], audit: [] });
  const result = await a.ws.publishDemoProperty(PROPERTY, new Date(a.clock.t));
  expect(result.published).toBe(true);
}

describe("operators can set up a one-time tour", () => {
  it("asks one confirmation, texts first, then YES goes through consent", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    const beforeHours = hoursOf(a);
    const beforeStatus = a.ws.load(PROPERTY).state.status;
    const beforeReadiness = a.ws.load(PROPERTY).state.readiness;

    const asked = await a.grok("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "3:15 PM today" });
    expect(asked.status).toBe("needs-confirmation");
    expect(asked.summary).toBe(
      "Set up a tour for Dana at Unit 1A on Monday at 3:15 PM? Only say yes if they asked for this tour. Dana gets a text to confirm. Book it?",
    );
    expect(asked.summary).not.toContain("Continue?");
    expect(asked.summary).not.toContain("create a one-time tour");
    expect(a.fake.sent.filter((message) => message.number === PHONE)).toHaveLength(0);

    const done = await a.grok("schedule_one_off_tour", {
      phone: PHONE,
      visitorName: "Dana",
      unit: "1A",
      startsAt: "3:15 PM today",
      confirmationCode: asked.confirmation.code,
    });
    expect(done.scheduled).toBe(true);
    expect(done.summary).toContain("Dana");
    expect(done.summary).toContain("regular tour times are unchanged");

    const first = a.fake.sent.filter((message) => message.number === PHONE).at(-1)!.content;
    expect(first).toBe(operatorScheduledFirstText(a.ws.load(PROPERTY).config, new Date("2026-09-28T19:15:00.000Z")));
    expect(first).toBe("Hi, this is the property team at 100 Alfred Way. We set up a tour for you at 3:15 PM on Monday. Reply YES to confirm, NO to cancel, or STOP to opt out.");

    const yes = await a.text("YES");
    expect(yes.join("\n")).toContain("Great, you're booked for 3:15 PM");
    expect(yes.join("\n")).toContain("please fill out this short form");

    const consent = await a.text("YES");
    expect(consent.join("\n")).toMatch(/identity|form|verify/i);

    expect(hoursOf(a)).toEqual(beforeHours);
    expect(a.ws.load(PROPERTY).state.status).toBe(beforeStatus);
    expect(a.ws.load(PROPERTY).state.readiness).toEqual(beforeReadiness);
    expect(slotsOn(a.ws.load(PROPERTY).config, { year: 2026, month: 9, day: 28 }).map((slot) => slot.label)).toEqual(["2:00 PM", "3:30 PM"]);
  });

  it("counts the reserved time as busy so another visitor is not offered it", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    await a.approve("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "2:00 PM today" });

    await a.textFrom(OTHER, "TOUR");
    await a.textFrom(OTHER, "YES");
    await a.textFrom(OTHER, "1");
    const times = await a.textFrom(OTHER, "1");
    expect(times.join("\n")).not.toContain("2:00 PM");
    expect(times.join("\n")).toContain("3:30 PM");
  });

  it("a time outside touring hours needs the stronger confirmation", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    const beforeHours = hoursOf(a);
    const asked = await a.grok("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "7:30 PM today" });
    expect(asked.outsideHours).toBe(true);
    expect(asked.summary).toContain("That's outside your tour hours.");
    expect(asked.summary).toContain("This is a one-off. Your regular tour hours stay the same, and Dana gets a text to confirm.");
    expect(asked.summary).toContain("Book it?");
    expect(asked.summary).not.toContain("create a one-time tour");
    await expect(
      a.grok("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "7:30 PM today", confirmationCode: asked.confirmation.code }),
    ).rejects.toThrow(/outside normal touring hours/);
    await a.grok("schedule_one_off_tour", {
      phone: PHONE,
      visitorName: "Dana",
      unit: "1A",
      startsAt: "7:30 PM today",
      confirmationCode: asked.confirmation.code,
      acknowledgeOutsideHours: true,
    });
    const tour = a.ws.listTours(PROPERTY).find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour(PROPERTY, tour.tourId)!.bundle;
    expect(bundle.reservations[0]).toMatchObject({ scheduleOverride: { kind: "OUTSIDE_HOURS" } });
    expect(hoursOf(a)).toEqual(beforeHours);
  });

  it("refuses an opted-out phone", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    await a.text("STOP");
    await expect(a.grok("schedule_one_off_tour", { phone: PHONE, unit: "1A", startsAt: "3:15 PM today" })).rejects.toThrow(/asked us not to text them \(STOP\)/);
    await expect(a.grok("schedule_one_off_tour", { phone: PHONE, unit: "1A", startsAt: "3:15 PM today" })).rejects.toThrow(
      "That number asked us not to text them (STOP), so I can't set up a tour.",
    );
  });

  it("replaces a leftover choosing-time conversation; later replies go to the one-off", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    await a.optInSms();
    await a.text("1");
    const menu = await a.text("1");
    expect(menu.join("\n")).toContain("2:00 PM");
    expect(menu.join("\n")).toContain("3:30 PM");

    const beforeVisitor = a.fake.sent.filter((message) => message.number === PHONE).length;
    const asked = await a.grok("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "3:15 PM today" });
    expect(asked.status).toBe("needs-confirmation");
    expect(asked.summary).toBe(
      "Set up a tour for Dana at Unit 1A on Monday at 3:15 PM? Only say yes if they asked for this tour. Dana gets a text to confirm. Book it?",
    );

    const done = await a.grok("schedule_one_off_tour", {
      phone: PHONE,
      visitorName: "Dana",
      unit: "1A",
      startsAt: "3:15 PM today",
      confirmationCode: asked.confirmation.code,
    });
    expect(done.scheduled).toBe(true);

    const visitor = a.fake.sent.filter((message) => message.number === PHONE);
    expect(visitor.length).toBe(beforeVisitor + 1);
    expect(visitor.at(-1)!.content).toBe(
      "Hi, this is the property team at 100 Alfred Way. We set up a tour for you at 3:15 PM on Monday. Reply YES to confirm, NO to cancel, or STOP to opt out.",
    );

    const tours = a.ws.listTours(PROPERTY).filter((item) => item.kind === "messaging" && item.visitorPhone === PHONE);
    expect(tours).toHaveLength(2);
    const bundles = tours.map((item) => ({ record: item, bundle: a.ws.loadTour(PROPERTY, item.tourId)!.bundle }));
    const stale = bundles.find((item) => item.bundle.auditEvents.some((event) => event.type === "RESERVATION_CANCELLED" && event.detail === "replaced by the operator's one-off tour"));
    const fresh = bundles.find((item) => item.bundle.reservations[0]?.awaitingVisitorConfirm?.kind === "OPERATOR_SCHEDULED");
    expect(stale).toBeDefined();
    expect(fresh).toBeDefined();
    expect(stale!.bundle.reservations[0]!.status).toBe("CANCELLED");
    expect(stale!.bundle.reservations[0]!.slotStart).toBeUndefined();
    expect(stale!.record.outcome).toBe("stopped");

    const yes = await a.text("YES");
    expect(yes.join("\n")).toContain("Great, you're booked for 3:15 PM");
    expect(yes.join("\n")).toContain("please fill out this short form");
    expect(yes.join("\n")).not.toContain("2:00 PM");

    const staleAfter = a.ws.loadTour(PROPERTY, stale!.record.tourId)!.bundle;
    expect(staleAfter.reservations[0]!.status).toBe("CANCELLED");
    expect(staleAfter.reservations[0]!.slotStart).toBeUndefined();
    const freshAfter = a.ws.loadTour(PROPERTY, fresh!.record.tourId)!.bundle;
    expect(freshAfter.reservations[0]!.slotStart).toBe("2026-09-28T19:15:00.000Z");
    expect(freshAfter.reservations[0]!.status).not.toBe("CANCELLED");
  });

  it("a leftover menu number after replacement is a one-off reply, not a stale booking", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    await a.approve("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "3:15 PM today" });

    const reply = await a.text("1");
    expect(reply).toEqual(["Reply YES to confirm, NO to cancel, or STOP to opt out."]);
    expect(reply.join("\n")).not.toContain("I'll check with the property team");
    expect(reply.join("\n")).not.toContain("Great, you're booked");
    expect(reply.join("\n")).not.toContain("2:00 PM");
    expect(reply.join("\n")).not.toContain("Which day");

    const tours = a.ws.listTours(PROPERTY).filter((item) => item.kind === "messaging" && item.visitorPhone === PHONE);
    expect(tours).toHaveLength(2);
    const bundles = tours.map((item) => a.ws.loadTour(PROPERTY, item.tourId)!.bundle);
    const stale = bundles.find((bundle) => bundle.auditEvents.some((event) => event.type === "RESERVATION_CANCELLED" && event.detail === "replaced by the operator's one-off tour"));
    const fresh = bundles.find((bundle) => bundle.reservations[0]?.awaitingVisitorConfirm?.kind === "OPERATOR_SCHEDULED");
    expect(stale).toBeDefined();
    expect(fresh).toBeDefined();
    expect(stale!.reservations[0]!.status).toBe("CANCELLED");
    expect(stale!.reservations[0]!.slotStart).toBeUndefined();
    expect(fresh!.reservations[0]).toMatchObject({ status: "RESERVED", awaitingVisitorConfirm: { kind: "OPERATOR_SCHEDULED" } });
    expect(fresh!.auditEvents.some((event) => event.type === "QUESTION_UNANSWERED")).toBe(false);
  });

  it("a leftover menu number before confirm only re-prompts; a real question still flags; YES still books", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    await a.approve("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "2:00 PM today" });
    const exceptionsBefore = a.routineEvents().filter((event) => event.eventType === "exception.created").length;

    const tap = await a.text("1");
    expect(tap).toEqual(["Reply YES to confirm, NO to cancel, or STOP to opt out."]);

    const tour = a.ws.listTours(PROPERTY).find((item) => item.kind === "messaging")!;
    let bundle = a.ws.loadTour(PROPERTY, tour.tourId)!.bundle;
    expect(bundle.reservations[0]).toMatchObject({ status: "RESERVED", awaitingVisitorConfirm: { kind: "OPERATOR_SCHEDULED" } });
    expect(bundle.auditEvents.some((event) => event.type === "QUESTION_UNANSWERED")).toBe(false);
    expect(bundle.auditEvents.some((event) => event.type === "OPERATOR_NOTIFIED" && event.detail.includes("asked"))).toBe(false);
    const afterTap = await a.grok("list_exceptions");
    expect(afterTap.exceptions.some((item: { summary: string }) => item.summary.includes('Asked "1"'))).toBe(false);
    expect(a.routineEvents().filter((event) => event.eventType === "exception.created")).toHaveLength(exceptionsBefore);

    const who = await a.text("Who is this?");
    expect(who).toEqual(["I'll check with the property team and get back to you."]);
    bundle = a.ws.loadTour(PROPERTY, tour.tourId)!.bundle;
    expect(bundle.reservations[0]).toMatchObject({ status: "RESERVED", awaitingVisitorConfirm: { kind: "OPERATOR_SCHEDULED" } });
    expect(bundle.auditEvents.some((event) => event.type === "QUESTION_UNANSWERED" && event.detail === "Who is this?")).toBe(true);
    const afterQuestion = await a.grok("list_exceptions");
    expect(afterQuestion.exceptions.some((item: { summary: string }) => item.summary.includes('Asked "Who is this?"'))).toBe(true);
    expect(a.routineEvents().filter((event) => event.eventType === "exception.created").length).toBeGreaterThan(exceptionsBefore);

    const yes = await a.text("YES");
    expect(yes.join("\n")).toContain("Great, you're booked for 2:00 PM");
    expect(yes.join("\n")).toContain("please fill out this short form");
  });

  it("refuses a booked tour with the reschedule or revoke wording", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    await a.book();
    await expect(a.grok("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "3:15 PM today" })).rejects.toThrow(
      "They already have a booked tour. I can move it or call it off.",
    );
  });

  it("refuses a pending one-off waiting for YES or NO", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    await a.approve("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "2:00 PM today" });
    await expect(a.grok("schedule_one_off_tour", { phone: PHONE, visitorName: "Pat", unit: "2B", startsAt: "3:15 PM today" })).rejects.toThrow(
      "They already have a tour waiting for them to reply YES or NO. I can call it off, or we can wait for them to answer.",
    );
  });

  it("STOP opts out, cancels, releases the time, and sends only the opt-out confirmation", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    await a.approve("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "2:00 PM today" });
    const before = a.fake.sent.filter((message) => message.number === PHONE).length;
    const stop = await a.text("STOP");
    expect(stop.join("\n")).toMatch(/opted out/i);
    expect(a.fake.sent.filter((message) => message.number === PHONE).length).toBe(before + 1);

    const tour = a.ws.listTours(PROPERTY).find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour(PROPERTY, tour.tourId)!.bundle;
    expect(bundle.reservations[0]!.status).toBe("CANCELLED");
    expect(bundle.auditEvents.some((event) => event.type === "RESERVATION_CANCELLED")).toBe(true);

    await a.textFrom(OTHER, "TOUR");
    await a.textFrom(OTHER, "YES");
    await a.textFrom(OTHER, "1");
    const times = await a.textFrom(OTHER, "1");
    expect(times.join("\n")).toContain("2:00 PM");
  });

  it("flags a question before they confirm and does not loop the YES prompt", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    await a.approve("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "2:00 PM today" });
    const asked = await a.text("Which unit?");
    expect(asked).toEqual(["I'll check with the property team and get back to you."]);
    expect(asked.join("\n")).not.toContain("Reply YES");
    const who = await a.text("Who is this?");
    expect(who).toEqual(["I'll check with the property team and get back to you."]);

    const tour = a.ws.listTours(PROPERTY).find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour(PROPERTY, tour.tourId)!.bundle;
    expect(bundle.reservations[0]).toMatchObject({ status: "RESERVED", awaitingVisitorConfirm: { kind: "OPERATOR_SCHEDULED" } });
    expect(bundle.auditEvents.some((event) => event.type === "QUESTION_UNANSWERED" && event.detail === "Which unit?")).toBe(true);
    expect(bundle.auditEvents.some((event) => event.type === "QUESTION_UNANSWERED" && event.detail === "Who is this?")).toBe(true);
    const queue = await a.grok("list_exceptions");
    expect(queue.exceptions.some((item: { summary: string }) => item.summary.includes('Asked "Which unit?"'))).toBe(true);

    const yes = await a.text("YES");
    expect(yes.join("\n")).toContain("Great, you're booked for 2:00 PM");
  });

  it("a question before confirm does not stop the no-reply release", async () => {
    const a = await liveApp({ cleanups });
    a.clock.t = at(13, 25);
    await publish(a);
    await a.approve("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "2:00 PM today" });
    await a.text("Which unit?");
    const afterQuestion = a.fake.sent.filter((message) => message.number === PHONE).length;

    a.clock.t = at(13, 56);
    await a.textFrom(OTHER, "TOUR");
    const visitor = a.fake.sent.filter((message) => message.number === PHONE);
    expect(visitor.length).toBe(afterQuestion + 1);
    expect(visitor.at(-1)!.content).toBe("I didn't hear back, so I released your 2:00 PM tour. Text me anytime to book another.");
    const tour = a.ws.listTours(PROPERTY).find((item) => item.kind === "messaging" && item.visitorPhone === PHONE)!;
    expect(a.ws.loadTour(PROPERTY, tour.tourId)!.bundle.reservations[0]!.status).toBe("CANCELLED");
  });

  it("NO cancels and tells the team", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    await a.approve("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "3:15 PM today" });
    const no = await a.text("NO");
    expect(no.join("\n")).toBe("No problem. I cancelled that tour. Text me anytime to book another.");
    const tour = a.ws.listTours(PROPERTY).find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour(PROPERTY, tour.tourId)!.bundle;
    expect(bundle.reservations[0]!.status).toBe("CANCELLED");
    expect(bundle.auditEvents.some((event) => event.type === "OPERATOR_NOTIFIED" && event.detail.includes("said no"))).toBe(true);
  });

  it("releases the time if the visitor never replies, texts them once, and alerts the team", async () => {
    const a = await liveApp({ cleanups });
    a.clock.t = at(13, 25);
    await publish(a);
    await a.approve("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "2:00 PM today" });
    const beforeVisitor = a.fake.sent.filter((message) => message.number === PHONE).length;

    a.clock.t = at(13, 56);
    await a.textFrom(OTHER, "TOUR");
    await a.textFrom(OTHER, "YES");
    await a.textFrom(OTHER, "1");
    const times = await a.textFrom(OTHER, "1");
    expect(times.join("\n")).toContain("2:00 PM");

    const visitor = a.fake.sent.filter((message) => message.number === PHONE);
    expect(visitor.length).toBe(beforeVisitor + 1);
    expect(visitor.at(-1)!.content).toBe("I didn't hear back, so I released your 2:00 PM tour. Text me anytime to book another.");

    const tour = a.ws.listTours(PROPERTY).find((item) => item.kind === "messaging" && item.visitorPhone === PHONE)!;
    const bundle = a.ws.loadTour(PROPERTY, tour.tourId)!.bundle;
    expect(bundle.reservations[0]!.status).toBe("CANCELLED");
    expect(bundle.auditEvents.some((event) => event.type === "RESERVATION_CANCELLED" && event.detail.includes("didn't confirm"))).toBe(true);
    expect(bundle.auditEvents.some((event) => event.type === "OPERATOR_NOTIFIED" && event.detail.includes("didn't confirm the 2:00 PM tour, so I released it"))).toBe(true);

    await a.textFrom(OTHER, "any other times?");
    expect(a.fake.sent.filter((message) => message.number === PHONE)).toHaveLength(visitor.length);

    const later = await a.text("YES");
    expect(later.join("\n")).not.toContain("Reply YES to confirm this tour");
    expect(later.join("\n")).not.toContain("I didn't hear back");
    expect(a.fake.sent.filter((message) => message.number === PHONE && message.content.includes("I didn't hear back"))).toHaveLength(1);
  });

  it("names the weekday in the release text when the tour isn't today", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    await a.approve("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "Tuesday at 2:00 PM" });
    a.clock.t = zonedTimeToUtc({ year: 2026, month: 9, day: 30, hour: 7, minute: 0 }, "America/New_York").getTime();
    await a.textFrom(OTHER, "TOUR");
    const visitor = a.fake.sent.filter((message) => message.number === PHONE);
    expect(visitor.at(-1)!.content).toBe("I didn't hear back, so I released your Tuesday at 2:00 PM tour. Text me anytime to book another.");
  });

  it("YES still confirms the reserved one-off after published hours change", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    await a.approve("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "3:15 PM today" });
    const current = a.ws.load(PROPERTY).config;
    a.ws.save({ ...current, tourHours: { ...current.tourHours, start: "20:00", end: "23:00" } });

    const yes = await a.text("YES");
    expect(yes.join("\n")).toContain("Great, you're booked for 3:15 PM");
    const tour = a.ws.listTours(PROPERTY).find((item) => item.kind === "messaging")!;
    expect(a.ws.loadTour(PROPERTY, tour.tourId)!.bundle.reservations[0]!.slotStart).toBe("2026-09-28T19:15:00.000Z");
  });

  it("uses the latest published hours to decide if a one-off is outside hours", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    const current = a.ws.load(PROPERTY).config;
    const { config } = a.ws.save({ ...current, tourHours: { ...current.tourHours, start: "18:00", end: "21:00" } });
    a.ws.recordReadiness(PROPERTY, await runReadinessCheck(config, { now: new Date(a.clock.t) }));
    await publish(a);

    const evening = await a.grok("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "7:30 PM today" });
    expect(evening.summary).toBe(
      "Set up a tour for Dana at Unit 1A on Monday at 7:30 PM? Only say yes if they asked for this tour. Dana gets a text to confirm. Book it?",
    );
    expect(evening.summary).not.toContain("That's outside your tour hours");
    expect(evening.outsideHours).not.toBe(true);

    const afternoon = await a.grok("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "3:15 PM today" });
    expect(afternoon.summary).toContain("That's outside your tour hours.");
    expect(afternoon.summary).toContain("This is a one-off. Your regular tour hours stay the same, and Dana gets a text to confirm.");
    expect(afternoon.outsideHours).toBe(true);
  });

  it("after they cancel, the next-opening copy and 'that' booking still work", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    await a.approve("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "3:15 PM today" });
    await a.text("NO");

    await a.text("TOUR");
    await a.text("YES");
    await a.text("1");
    const saturday = await a.text("Saturday");
    expect(saturday.join("\n")).toContain("Tours don't run on Saturdays. The next opening is Monday, Sep 28 at 2:00 PM. Reply yes to take it, or pick a day:");
    expect(saturday.join("\n")).toContain("1) Monday, Sep 28");
    expect(saturday.join("\n")).not.toContain("Want that, or another day?");
    expect(saturday.join("\n")).not.toContain("I have tours available");

    const booked = await a.text("that");
    expect(booked.join("\n")).toContain("Great, you're booked for 2:00 PM");
    expect(booked.join("\n")).toContain("please fill out this short form");
  });

  it("taking the offered next opening re-checks after a one-off reserves that start", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    await a.textFrom(OTHER, "TOUR");
    await a.textFrom(OTHER, "YES");
    await a.textFrom(OTHER, "1");
    const saturday = await a.textFrom(OTHER, "Saturday");
    expect(saturday.join("\n")).toContain("The next opening is Monday, Sep 28 at 2:00 PM. Reply yes to take it, or pick a day:");
    expect(saturday.join("\n")).not.toContain("Want that, or another day?");

    await a.approve("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "2:00 PM today" });
    const that = await a.textFrom(OTHER, "that");
    expect(that.join("\n")).toContain("Someone just grabbed that time. Here's what's left:");
    expect(that.join("\n")).toContain("3:30 PM");
    expect(that.join("\n")).not.toContain("2:00 PM");
  });

  it("refuses when the property isn't published, the time is in the past, or it overlaps another tour", async () => {
    const a = await liveApp({ cleanups });
    a.ws.patchState(PROPERTY, { status: "DRAFT" });
    await expect(a.grok("schedule_one_off_tour", { phone: PHONE, unit: "1A", startsAt: "3:15 PM today" })).rejects.toThrow(/isn't published with live visitor texting/);
    const landlord = await a.grok("schedule_tour", { phone: PHONE, unit: "1A", startsAt: "3:15 PM today" });
    expect(landlord).toMatchObject({
      status: "blocked",
      code: "NOT_LIVE",
      message: "That property isn't published with live visitor texting, so I can't set up a tour.",
    });
    expect(landlord.confirmation).toBeUndefined();
    expect(JSON.stringify(landlord)).not.toMatch(/Book it\?/);

    await publish(a);
    a.clock.t = at(16);
    await expect(a.grok("schedule_one_off_tour", { phone: PHONE, unit: "1A", startsAt: "3:15 PM today" })).rejects.toThrow(/already passed/);

    a.clock.t = at(7);
    await a.book();
    await expect(a.grok("schedule_one_off_tour", { phone: OTHER, visitorName: "Pat", unit: "2B", startsAt: "2:00 PM today" })).rejects.toThrow(/overlaps another tour/);
  });
});

describe("tour time confirmation wording", () => {
  it("names the move and ends with Move it?, never Continue?", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    const asked = await a.grok("reschedule_tour", { visitor: "Testy", newStartsAt: "3:15 PM today" });
    expect(asked.summary).toBe(
      "Move Testy's tour from 2:00 PM on Monday, Sep 28 to 3:15 PM on Monday, Sep 28? Testy gets a text with the new time. Move it?",
    );
    const outside = await a.grok("reschedule_tour", { visitor: "Testy", newStartsAt: "7:30 PM today" });
    expect(outside.summary).toBe(
      "Move Testy's tour from 2:00 PM on Monday, Sep 28 to 7:30 PM on Monday, Sep 28? That's outside your tour hours. This is a one-off. Your regular tour hours stay the same, and Testy gets a text with the new time. Move it?",
    );
  });
});
