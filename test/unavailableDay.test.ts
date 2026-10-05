import { describe, expect, it } from "vitest";
import { loadConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { BOOKING_HORIZON_DAYS, isBeyondBookingHorizon } from "../src/core/schedule";
import { zonedTimeToUtc, type LocalDate } from "../src/core/timezone";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import { handleVisitorText } from "../src/visitor/conversation";
import { VisitorDemoSession, visitorView } from "../src/visitor";
import { unavailableDayReply } from "../src/visitor/unavailableDay";

const TZ = "America/New_York";
const PHONE = "+15550102000";

const at = (year: number, month: number, day: number, hour: number, minute = 0) =>
  zonedTimeToUtc({ year, month, day, hour, minute }, TZ);

const date = (year: number, month: number, day: number): LocalDate => ({ year, month, day });

function everydayHours(base = loadConfig()): TourCoreConfig {
  return {
    ...base,
    tourHours: {
      days: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
      start: "08:15",
      end: "23:59",
      slotEveryMinutes: 60,
      tourLengthMinutes: 45,
      earlyArrivalMinutes: base.tourHours.earlyArrivalMinutes,
    },
  };
}

function oneSundaySlot(base = loadConfig()): TourCoreConfig {
  return {
    ...everydayHours(base),
    tourHours: {
      ...everydayHours(base).tourHours,
      days: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
      start: "08:15",
      end: "09:15",
    },
  };
}

function replyFor(now: Date, requested: LocalDate, next: Date | undefined, config: TourCoreConfig) {
  return unavailableDayReply({ config, now, requested, ...(next ? { nextOpening: next } : {}) });
}

function textVisitor(options: { config?: TourCoreConfig; now: number }) {
  const transport = new DemoMessagingAdapter(() => {}, "MESSAGING");
  const session = new VisitorDemoSession("prop_100_alfred_way", options.config ?? loadConfig(), "t", {
    realNow: () => options.now,
    transport,
    kind: "messaging",
  });
  let n = 0;
  const say = (text: string) => handleVisitorText(session, PHONE, text, { provider: "test", providerMessageId: `m_${++n}` });
  const lastReply = () => [...session.conversation].reverse().find((m) => m.from === "tourcore")!.text;
  return { session, say, lastReply };
}

async function toChooseDate(p: ReturnType<typeof textVisitor>) {
  await p.say("TOUR");
  await p.say("YES");
  await p.say("1");
}

function webVisitor(options: { config?: TourCoreConfig; now: number }) {
  return new VisitorDemoSession("prop_100_alfred_way", options.config ?? loadConfig(), "t", { realNow: () => options.now });
}

async function toWebChooseDate(session: VisitorDemoSession) {
  await session.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
  await session.act("chooseUnit", { unitId: "apt_101" });
}

async function bookAllSlots(session: VisitorDemoSession, day: LocalDate) {
  const slots = await session.core.availableSlots(day);
  let n = 0;
  for (const slot of slots) {
    n += 1;
    const { reservation } = await session.core.startInquiry({ name: `Other ${n}`, phone: `(555) 010-${3100 + n}`, unitId: "apt_101" }, { announce: false });
    await session.core.reserveSlot(reservation.id, slot.start.toISOString());
  }
}

const lastFromTourCore = (s: VisitorDemoSession) => [...s.conversation].reverse().find((m) => m.from === "tourcore")!.text;

describe("unavailableDayReply", () => {
  const openEveryDay = everydayHours();
  const weekdays = loadConfig();

  it("today is open but no slots remain: says no more today and the next opening", () => {
    const now = at(2026, 10, 4, 22, 49);
    const next = at(2026, 10, 5, 8, 15);
    expect(replyFor(now, date(2026, 10, 4), next, openEveryDay)).toBe(
      "There are no more tours today. The next opening is tomorrow at 8:15 AM. Which day works for you?",
    );
  });

  it("a later open day is fully booked", () => {
    const now = at(2026, 9, 28, 7);
    const next = at(2026, 9, 28, 14);
    expect(replyFor(now, date(2026, 9, 29), next, weekdays)).toBe(
      "Tuesday, Sep 29 is fully booked. The next opening is today at 2:00 PM. Which day works for you?",
    );
  });

  it("the requested weekday is not a tour day", () => {
    const now = at(2026, 9, 28, 7);
    const next = at(2026, 9, 28, 14);
    expect(replyFor(now, date(2026, 10, 4), next, weekdays)).toBe(
      "I don't have tours on Sundays. The next opening is today at 2:00 PM. Which day works for you?",
    );
  });

  it("the requested day is beyond the booking horizon", () => {
    const now = at(2026, 9, 28, 7);
    const next = at(2026, 9, 28, 14);
    expect(isBeyondBookingHorizon(date(2026, 9, 28), date(2026, 11, 16))).toBe(true);
    expect(replyFor(now, date(2026, 11, 16), next, weekdays)).toBe(
      "That's too far out to book. The next opening is today at 2:00 PM. Which day works for you?",
    );
  });

  it("uses on {weekday, date} when the next opening is not today or tomorrow", () => {
    const now = at(2026, 10, 2, 16);
    const next = at(2026, 10, 5, 14);
    expect(replyFor(now, date(2026, 10, 2), next, weekdays)).toBe(
      "There are no more tours today. The next opening is on Monday, Oct 5 at 2:00 PM. Which day works for you?",
    );
  });

  it("omits the next-opening clause when nothing is open", () => {
    const now = at(2026, 10, 4, 22, 49);
    expect(replyFor(now, date(2026, 10, 4), undefined, openEveryDay)).toBe("There are no more tours today. Which day works for you?");
  });

  it("does not use the old closed-day sentence or 'I have tours available'", () => {
    const now = at(2026, 10, 4, 22, 49);
    const text = replyFor(now, date(2026, 10, 4), at(2026, 10, 5, 8, 15), openEveryDay);
    expect(text).not.toContain("I don't have tours on Sunday, Oct 4");
    expect(text).not.toContain("I have tours available");
  });

  it("treats today + horizon days as too far, and today + horizon - 1 as in range", () => {
    expect(BOOKING_HORIZON_DAYS).toBe(21);
    expect(isBeyondBookingHorizon(date(2026, 9, 28), date(2026, 10, 18))).toBe(false);
    expect(isBeyondBookingHorizon(date(2026, 9, 28), date(2026, 10, 19))).toBe(true);
  });
});

describe("typed day questions use the shared copy", () => {
  it("Sunday 10:49 PM, last slot gone: no more tours today, next is tomorrow 8:15 AM", async () => {
    const p = textVisitor({ config: everydayHours(), now: at(2026, 10, 4, 22, 49).getTime() });
    await toChooseDate(p);
    await p.say("Is there a tour for today?");
    expect(p.lastReply()).toContain("There are no more tours today. The next opening is tomorrow at 8:15 AM. Which day works for you?");
    expect(p.lastReply()).toContain("1) Monday, Oct 5");
    expect(p.lastReply()).not.toContain("I don't have tours on Sunday");
    expect(p.lastReply()).not.toContain("I have tours available");
  });

  it("today is open but every remaining start is booked", async () => {
    const p = textVisitor({ config: oneSundaySlot(), now: at(2026, 10, 4, 8).getTime() });
    await toChooseDate(p);
    await bookAllSlots(p.session, date(2026, 10, 4));
    await p.say("today");
    expect(p.lastReply()).toContain("There are no more tours today. The next opening is tomorrow at 8:15 AM. Which day works for you?");
    expect(p.lastReply()).not.toContain("is fully booked");
    expect(p.lastReply()).not.toContain("I have tours available");
  });

  it("Sunday is not a tour day on the weekday schedule", async () => {
    const p = textVisitor({ now: at(2026, 9, 28, 7).getTime() });
    await toChooseDate(p);
    await p.say("Sunday");
    expect(p.lastReply()).toContain("I don't have tours on Sundays. The next opening is today at 2:00 PM. Which day works for you?");
    expect(p.lastReply()).toContain("1) Monday, Sep 28");
    expect(p.lastReply()).not.toContain("I have tours available");
  });
});

describe("chooseDate buttons use the same helper", () => {
  it("a future open day with no remaining starts is fully booked", async () => {
    const session = webVisitor({ now: at(2026, 9, 28, 7).getTime() });
    await toWebChooseDate(session);
    await bookAllSlots(session, date(2026, 9, 29));
    await session.act("chooseDate", { date: "2026-09-29" });
    expect(lastFromTourCore(session)).toContain("Tuesday, Sep 29 is fully booked. The next opening is today at 2:00 PM. Which day works for you?");
    expect(lastFromTourCore(session)).toContain("Pick a day below.");
    expect(lastFromTourCore(session)).not.toContain("I have tours available");
    expect(await session.stage()).toBe("choose-date");
    expect((await visitorView(session)).choices.map((c) => c.label).slice(0, 2)).toEqual(["Monday, Sep 28", "Tuesday, Sep 29"]);
  });

  it("a day past the booking horizon is too far out", async () => {
    const session = webVisitor({ now: at(2026, 9, 28, 7).getTime() });
    await toWebChooseDate(session);
    await session.act("chooseDate", { date: "2026-11-16" });
    expect(lastFromTourCore(session)).toContain("That's too far out to book. The next opening is today at 2:00 PM. Which day works for you?");
    expect(lastFromTourCore(session)).toContain("Pick a day below.");
    expect(lastFromTourCore(session)).not.toContain("I have tours available");
    expect(lastFromTourCore(session)).not.toContain("I have these times available");
    expect(await session.stage()).toBe("choose-date");
  });

  it("still offers times when the requested day is open", async () => {
    const session = webVisitor({ now: at(2026, 9, 28, 7).getTime() });
    await toWebChooseDate(session);
    await session.act("chooseDate", { date: "2026-09-28" });
    expect(lastFromTourCore(session)).toContain("I have these times available Monday, Sep 28:");
    expect(await session.stage()).toBe("choose-time");
  });
});
