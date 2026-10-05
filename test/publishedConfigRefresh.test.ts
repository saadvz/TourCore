import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type TourCoreConfig, type TourHours } from "../src/config/tourCoreConfig";
import { zonedTimeToUtc } from "../src/core/timezone";
import { MessagingEndpoints } from "../src/messaging/endpoints";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { MemoryRuntimeStore } from "../src/storage/runtimeStore";
import { handleVisitorText, SCHEDULE_CHANGED_LEAD } from "../src/visitor/conversation";
import { MessagingConversations } from "../src/visitor/messagingRouter";
import { VisitorDemoRegistry, VisitorDemoSession } from "../src/visitor/session";
import { VerificationLinks } from "../src/visitor/verificationLinks";

const PHONE = "+15550102000";
const LINE = "+15550001111";
const PROPERTY = "prop_100_alfred_way";
const at = (hour: number, minute = 0) => zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour, minute }, "America/New_York");

const EVENING: TourHours = {
  days: ["MON", "TUE", "WED", "THU", "FRI"],
  start: "20:15",
  end: "23:45",
  slotEveryMinutes: 60,
  tourLengthMinutes: 45,
  earlyArrivalMinutes: 10,
};

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function propertyConfig(hours: TourHours = loadConfig().tourHours): TourCoreConfig {
  return { ...loadConfig(), tourHours: hours };
}

async function textApp(options: { clock: number; hours?: TourHours }) {
  const root = mkdtempSync(join(tmpdir(), "tourcore-hours-"));
  roots.push(root);
  const ws = new PropertyWorkspace(root);
  const { config } = ws.save(propertyConfig(options.hours));
  ws.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(options.clock) }));
  const runtime = new MemoryRuntimeStore();
  const endpoints = new MessagingEndpoints(runtime);
  endpoints.attach({ address: LINE, provider: "demo", propertyId: PROPERTY });
  const registry = new VisitorDemoRegistry();
  const transport = new DemoMessagingAdapter(() => {}, "MESSAGING");
  const router = new MessagingConversations({
    workspace: ws,
    registry,
    runtime,
    endpoints,
    transport: () => transport,
    links: new VerificationLinks({ baseUrl: () => undefined }),
    realNow: () => options.clock,
    defaultLine: () => LINE,
    consentMode: () => "disabled",
  });
  let n = 0;
  const text = async (body: string) => {
    await router.receive({
      provider: "test",
      providerMessageId: `m_${++n}`,
      from: PHONE,
      to: LINE,
      text: body,
      channel: "SMS",
      receivedAt: new Date(options.clock).toISOString(),
    });
    const session = registry.latestForPhone(PROPERTY, PHONE, "messaging")!;
    return [...session.conversation].reverse().find((item) => item.from === "tourcore")!.text;
  };
  const session = () => registry.latestForPhone(PROPERTY, PHONE, "messaging")!;
  const republishHours = (start: string) => {
    const current = ws.load(PROPERTY).config;
    ws.save({ ...current, tourHours: { ...current.tourHours, start } });
  };
  const restart = async () => {
    const next = new VisitorDemoRegistry();
    const restored = new MessagingConversations({
      workspace: ws,
      registry: next,
      runtime,
      endpoints: new MessagingEndpoints(runtime),
      transport: () => transport,
      links: new VerificationLinks({ baseUrl: () => undefined }),
      realNow: () => options.clock,
      defaultLine: () => LINE,
      consentMode: () => "disabled",
    });
    expect(await restored.restoreSaved()).toBe(1);
    let m = 0;
    const text = async (body: string) => {
      await restored.receive({
        provider: "test",
        providerMessageId: `m_restored_${++m}`,
        from: PHONE,
        to: LINE,
        text: body,
        channel: "SMS",
        receivedAt: new Date(options.clock).toISOString(),
      });
      const session = next.latestForPhone(PROPERTY, PHONE, "messaging")!;
      return [...session.conversation].reverse().find((item) => item.from === "tourcore")!.text;
    };
    return { registry: next, router: restored, session: () => next.latestForPhone(PROPERTY, PHONE, "messaging")!, text };
  };
  return { ws, registry, text, session, republishHours, restart };
}

describe("open text conversations pick up republished settings", () => {
  it("a session in choose-date sees a new tonight slot after hours change, including after restore", async () => {
    const clock = at(22, 53).getTime();
    const app = await textApp({ clock, hours: EVENING });
    await app.text("Hi");
    const days = await app.text("1");
    expect(await app.session().stage()).toBe("choose-date");
    expect(days).toContain("Which day works for you?");
    expect(days).not.toContain("Monday, Sep 28");
    expect(days).toContain("Tuesday, Sep 29");
    expect(app.session().offeredDates[0]).toMatchObject({ date: "2026-09-29" });

    app.republishHours("20:00");
    const today = await app.text("today");
    expect(today).toContain("I have these times available Monday, Sep 28:");
    expect(today).toContain("11:00 PM");
    expect(today).toContain("Reply 1 for 11:00 PM");
    expect(app.session().offeredDates[0]).toMatchObject({ date: "2026-09-28" });
    expect(await app.session().stage()).toBe("choose-time");

    const restored = await textApp({ clock, hours: EVENING });
    await restored.text("Hi");
    await restored.text("1");
    expect(restored.session().offeredDates[0]?.date).toBe("2026-09-29");
    restored.republishHours("20:00");
    const afterRestart = await restored.restart();
    expect(afterRestart.session().config.tourHours.start).toBe("20:00");
    expect(afterRestart.session().core.config.tourHours.start).toBe("20:00");
    expect(afterRestart.session().offeredDates[0]).toMatchObject({ date: "2026-09-28" });
    expect(afterRestart.session().offeredDates[0]?.label).toContain("Monday, Sep 28");
    const numbered = await afterRestart.text("1");
    expect(numbered).toContain(SCHEDULE_CHANGED_LEAD);
    expect(numbered).toContain("I have tours available. Which day works for you?");
    expect(numbered).toContain("Monday, Sep 28");
    expect(numbered).not.toContain("you're booked");
    expect(await afterRestart.session().stage()).toBe("choose-date");
    const todayAfterRestore = await afterRestart.text("today");
    expect(todayAfterRestore).toContain("I have these times available Monday, Sep 28:");
    expect(todayAfterRestore).toContain("11:00 PM");
    expect(todayAfterRestore).toContain("Reply 1 for 11:00 PM");
  });

  it("a numbered reply after an hours change is not remapped onto the new menu", async () => {
    const clock = at(22, 53).getTime();
    const app = await textApp({ clock, hours: EVENING });
    await app.text("Hi");
    await app.text("1");
    expect(app.session().offeredDates[0]).toMatchObject({ date: "2026-09-29" });
    expect(app.session().offeredDates.map((day) => day.date)).not.toContain("2026-09-28");
    expect(await app.session().stage()).toBe("choose-date");

    app.republishHours("20:00");
    const remapped = await app.text("2");
    expect(remapped).toContain(SCHEDULE_CHANGED_LEAD);
    expect(remapped).toContain("I have tours available. Which day works for you?");
    expect(remapped).toContain("Monday, Sep 28");
    expect(remapped).toContain("Tuesday, Sep 29");
    expect(remapped).not.toContain("I have these times available");
    expect(remapped).not.toContain("you're booked");
    expect(await app.session().stage()).toBe("choose-date");
    expect((await app.session().reservation())!.slotStart).toBeUndefined();
    expect(app.session().offeredDates[0]).toMatchObject({ date: "2026-09-28" });

    const afterReshow = await app.text("1");
    expect(afterReshow).toContain("I have these times available Monday, Sep 28:");
    expect(afterReshow).toContain("11:00 PM");
    expect(await app.session().stage()).toBe("choose-time");
  });

  it("'Tour' in choose-date and choose-time re-offers fresh days and keeps the unit", async () => {
    const clock = at(7).getTime();
    const app = await textApp({ clock });
    await app.text("Hi");
    await app.text("1");
    const reservationId = app.session().reservationId;
    expect(await app.session().stage()).toBe("choose-date");

    const fromDate = await app.text("Tour");
    expect(fromDate).toContain("I have tours available. Which day works for you?");
    expect(fromDate).toContain("Monday, Sep 28");
    expect(fromDate).toContain("Friday, Oct 2");
    expect(fromDate).not.toContain("Sorry, I didn't catch that");
    expect(await app.session().stage()).toBe("choose-date");
    expect((await app.session().reservation())!.unitId).toBe("apt_101");
    expect(app.session().reservationId).toBe(reservationId);

    await app.text("1");
    expect(await app.session().stage()).toBe("choose-time");
    const fromTime = await app.text("Tour");
    expect(fromTime).toContain("I have tours available. Which day works for you?");
    expect(fromTime).toContain("Monday, Sep 28");
    expect(fromTime).not.toContain("Sorry, I didn't catch that");
    expect(await app.session().stage()).toBe("choose-date");
    expect((await app.session().reservation())!.unitId).toBe("apt_101");
    expect(app.session().reservationId).toBe(reservationId);

    const bookAgain = await app.text("book a tour");
    expect(bookAgain).toContain("I have tours available. Which day works for you?");
    expect(bookAgain).not.toContain("Sorry, I didn't catch that");
  });

  it("a booked reservation keeps its tour window after an hours change", async () => {
    const clock = at(7).getTime();
    const app = await textApp({ clock });
    await app.text("Hi");
    await app.text("1");
    await app.text("1");
    const booked = await app.text("1");
    expect(booked).toContain("you're booked for 2:00 PM");
    const before = (await app.session().reservation())!;
    expect(before.slotStart).toBe(at(14).toISOString());

    app.republishHours("15:00");
    await app.text("how many bedrooms?");
    expect(app.session().conversation.some((item) => item.from === "tourcore" && item.text === "Unit 101 has 2 bedrooms.")).toBe(true);
    const reservation = (await app.session().reservation())!;
    expect(reservation.id).toBe(before.id);
    expect(reservation.slotStart).toBe(before.slotStart);
    expect(reservation.windowStart).toBe(before.windowStart);
    expect(reservation.windowEnd).toBe(before.windowEnd);
    expect(reservation.status).toBe(before.status);
  });
});

describe("START_INQUIRY at the day and time steps", () => {
  it("recomputes days from the current hours without creating a new reservation", async () => {
    const session = new VisitorDemoSession(PROPERTY, loadConfig(), "t", {
      realNow: () => at(7).getTime(),
      kind: "messaging",
      transport: new DemoMessagingAdapter(() => {}, "MESSAGING"),
    });
    session.smsConsentMode = "disabled";
    await handleVisitorText(session, PHONE, "Hi");
    await handleVisitorText(session, PHONE, "1");
    await handleVisitorText(session, PHONE, "1");
    expect(await session.stage()).toBe("choose-time");
    const reservationId = session.reservationId;
    await handleVisitorText(session, PHONE, "Tour");
    expect(await session.stage()).toBe("choose-date");
    expect(session.selectedDate).toBeUndefined();
    expect(session.offeredDates.map((day) => day.label)).toEqual([
      "Monday, Sep 28",
      "Tuesday, Sep 29",
      "Wednesday, Sep 30",
      "Thursday, Oct 1",
      "Friday, Oct 2",
    ]);
    expect(session.reservationId).toBe(reservationId);
    expect((await session.reservation())!.unitId).toBe("apt_101");
  });
});
