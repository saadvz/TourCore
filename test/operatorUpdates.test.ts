import { afterEach, describe, expect, it } from "vitest";
import { choosePreferences, describeUpdates, RECOMMENDED_UPDATES, wants } from "../src/alerts/preferences";
import { tourEvent } from "../src/alerts/operatorEvents";
import { ROUTINE_KEY } from "./installHarness";
import { at, liveApp, PHONE } from "./liveApp";

/**
 * Operator updates beyond exceptions: a real visitor's booking, tour start
 * and finish wake Grok (when the landlord asked for them) with a minimal,
 * PII-free event; Grok reads the details over MCP. Durable, deduplicated,
 * and never in the visitor's way.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const tourTypes = (events: Array<{ eventType: string }>) => events.map((e) => e.eventType).filter((t) => t.startsWith("tour."));

async function withDefaults() {
  const a = await liveApp({ cleanups });
  const chosen = await a.grok("set_notification_preferences", { preset: "recommended" });
  expect(chosen.summary).toBe("Got it. I'll keep you posted on bookings, tour starts and completions, and anything that needs your attention.");
  a.clock.t += 60_000;
  return a;
}

describe("tour lifecycle updates", () => {
  it("a real booking wakes Grok once with no visitor details; Grok reads who, which unit and when over MCP", async () => {
    const a = await withDefaults();
    await a.book();
    const events = a.routineEvents();
    expect(tourTypes(events)).toEqual(["tour.booked"]);
    const booked = events.find((e) => e.eventType === "tour.booked")!;
    expect(Object.keys(booked).sort()).toEqual(["eventId", "eventType", "occurredAt", "propertyId", "schemaVersion", "tourId"]);
    for (const leak of ["Testy", "McTest", "5550102000", "testy@example.com", "Unit 1A", ROUTINE_KEY]) expect(JSON.stringify(booked)).not.toContain(leak);

    const update = await a.grok("get_operator_update", { eventId: booked.eventId });
    expect(update.summary).toBe("New tour booked: Testy is scheduled to tour Unit 1A today at 2:00 PM.");
    expect(update.tour).toMatchObject({ visitorName: "Testy McTest", unitName: "Unit 1A", status: "Ready, waiting for arrival" });
    expect(JSON.stringify(update)).not.toContain(ROUTINE_KEY);

    // More texts, rescans and restarts of the scan never announce the booking again.
    await a.text("How many bedrooms?");
    expect(await a.server.tourCore.alerts.scan()).toBe(0);
    await a.installation.outbox.drain();
    expect(tourTypes(a.routineEvents())).toEqual(["tour.booked"]);
  });

  it("start and finish are announced once each; route steps, questions and repeated deliveries aren't", async () => {
    const a = await withDefaults();
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here", "same_delivery");
    await a.text("I'm here", "same_delivery");
    await a.text("I'm here");
    await a.text("at unit 1A");
    await a.text("Is there parking?");
    expect(tourTypes(a.routineEvents())).toEqual(["tour.booked", "tour.started"]);
    const started = a.routineEvents().find((e) => e.eventType === "tour.started")!;
    expect((await a.grok("get_operator_update", { eventId: started.eventId })).summary).toBe("Testy's Unit 1A tour has started.");

    await a.text("I'm done");
    await a.text("yes");
    expect(tourTypes(a.routineEvents())).toEqual(["tour.booked", "tour.started", "tour.completed"]);
    const done = a.routineEvents().find((e) => e.eventType === "tour.completed")!;
    expect((await a.grok("get_operator_update", { eventId: done.eventId })).summary).toBe("Testy's Unit 1A tour is complete.");
  });

  it("preferences are respected: without tour updates chosen, only what needs the landlord is sent", async () => {
    const a = await liveApp({ cleanups });
    expect((await a.grok("get_notification_preferences")).summary).toBe("I'll keep you posted on anything that needs your attention.");
    await a.book();
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    await a.text("Is there a pool?");
    expect(a.routineEvents().map((e) => e.eventType)).toEqual(["exception.created"]);
    expect(a.outbox("tour.booked")).toEqual([]);
  });

  it("turning updates on later never announces a booking that already happened", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await a.grok("set_notification_preferences", { preset: "recommended" });
    a.clock.t = at(13, 58);
    await a.text("I'm here");
    expect(tourTypes(a.routineEvents())).toEqual(["tour.started"]);
  });

  it("a notification outage never touches the visitor, and the pending update survives a restart", async () => {
    const first = await withDefaults();
    first.net.state.routineDown = true;
    const ready = await first.book();
    expect(ready).toContain("You're all set for your tour");
    expect(first.outbox("tour.booked")).toEqual([expect.objectContaining({ status: "pending", attempts: 1 })]);
    const eventId = first.outbox("tour.booked")[0]!.event.eventId;
    first.close();

    first.clock.t += 60_000;
    const second = await liveApp({ cleanups, root: first.root, clock: first.clock, fake: first.fake });
    await second.server.tourCore.settled();
    expect(second.routineEvents().filter((e) => e.eventType === "tour.booked").map((e) => e.eventId)).toEqual([eventId]);
    expect(second.outbox("tour.booked")).toEqual([expect.objectContaining({ status: "delivered" })]);
    // The visitor carries on with the new process.
    second.clock.t = at(13, 58);
    expect((await second.text("I'm here"))[0]).toContain("Entrance is open for you now.");
  });

  it("problems use their own update types and still point at the issue", async () => {
    const a = await withDefaults();
    await a.text("Hi");
    await a.text("1");
    await a.text("1");
    await a.text("1");
    await a.text("YES");
    a.clock.t = at(13, 58);
    const issues = a.routineEvents().filter((e) => !e.eventType.startsWith("tour."));
    expect(issues).toEqual([]);
    await a.text("Is there a pool?");
    const [question] = a.routineEvents().filter((e) => e.eventType === "exception.created");
    const update = await a.grok("get_operator_update", { eventId: question!.eventId });
    expect(update).toMatchObject({ eventType: "exception.created", stillOpen: true, issue: { what: "Question with no approved answer", question: "Is there a pool?" } });
    expect(update.summary).toContain('Asked "Is there a pool?"');
    expect(JSON.stringify(question)).not.toContain(PHONE.slice(2));
  });
});

describe("notification preferences", () => {
  it("start each kind when it's turned on and keep earlier starts", () => {
    const t0 = new Date("2026-09-28T12:00:00.000Z");
    const t1 = new Date("2026-09-28T13:00:00.000Z");
    const first = choosePreferences(undefined, RECOMMENDED_UPDATES, t0);
    expect(first.since).toEqual({ TOUR_BOOKED: t0.toISOString(), TOUR_STARTED: t0.toISOString(), TOUR_COMPLETED: t0.toISOString() });
    const later = choosePreferences(first, [...RECOMMENDED_UPDATES, "TOUR_CANCELLED"], t1);
    expect(later.since).toMatchObject({ TOUR_BOOKED: t0.toISOString(), TOUR_CANCELLED: t1.toISOString() });
    const e = (occurredAt: string) => tourEvent({ eventType: "tour.booked", propertyId: "prop_x", tourRef: "prop_x~t1", reservationId: "res_1", occurredAt });
    expect(wants(first, e("2026-09-28T11:59:00.000Z"))).toBe(false);
    expect(wants(first, e("2026-09-28T12:01:00.000Z"))).toBe(true);
    expect(wants(undefined, e("2026-09-28T12:01:00.000Z"))).toBe(false);
    expect(describeUpdates(["TOUR_BOOKED", "ACCESS_PROBLEM"])).toBe("bookings, and when a visitor has trouble with a door");
  });
});
