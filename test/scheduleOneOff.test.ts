import { afterEach, describe, expect, it } from "vitest";
import { slotsOn } from "../src/core/schedule";
import { zonedTimeToUtc } from "../src/core/timezone";
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
      "Set up a tour for Dana at Unit 1A on Monday at 3:15 PM? Only say yes if they asked for this tour. This is a one-off. Your regular tour hours stay the same, and Dana gets a text to confirm. Book it?",
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
    expect(first).toBe("Hi, this is the leasing team at 100 Alfred Way. We set up a tour for you on Monday at 3:15 PM. Reply YES to confirm, or STOP to opt out.");

    const yes = await a.text("YES");
    expect(yes.join("\n")).toContain("Great, you're booked for 3:15 PM");
    expect(yes.join("\n")).toContain("Is it OK if I text you about this tour");

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

  it("NO cancels and tells the team", async () => {
    const a = await liveApp({ cleanups });
    await publish(a);
    await a.approve("schedule_one_off_tour", { phone: PHONE, visitorName: "Dana", unit: "1A", startsAt: "3:15 PM today" });
    const no = await a.text("NO");
    expect(no.join("\n")).toContain("cancelled");
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

  it("refuses when the property isn't published, the time is in the past, or it overlaps another tour", async () => {
    const a = await liveApp({ cleanups });
    await expect(a.grok("schedule_one_off_tour", { phone: PHONE, unit: "1A", startsAt: "3:15 PM today" })).rejects.toThrow(/isn't published with live visitor texting/);

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
      "Move Testy's tour to today at 3:15 PM? This is a one-off. Your regular tour hours stay the same, and Testy gets a text with the new time. Move it?",
    );
    const outside = await a.grok("reschedule_tour", { visitor: "Testy", newStartsAt: "7:30 PM today" });
    expect(outside.summary).toBe(
      "Move Testy's tour from Mon, Sep 28 at 2:00 PM to Mon, Sep 28 at 7:30 PM? That's outside your tour hours. This is a one-off. Your regular tour hours stay the same, and Testy gets a text with the new time. Move it?",
    );
  });
});
