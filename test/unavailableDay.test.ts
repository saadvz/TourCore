import { describe, expect, it } from "vitest";
import { loadConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { BOOKING_HORIZON_DAYS, isBeyondBookingHorizon } from "../src/core/schedule";
import { zonedTimeToUtc, type LocalDate } from "../src/core/timezone";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import { handleVisitorText } from "../src/visitor/conversation";
import { VisitorDemoSession, visitorView } from "../src/visitor";
import { acceptsOfferedOpening, unavailableDayReply } from "../src/visitor/unavailableDay";

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

  it("today is open but no slots remain", () => {
    expect(replyFor(at(2026, 10, 4, 22, 49), date(2026, 10, 4), at(2026, 10, 5, 8, 15), openEveryDay)).toBe(
      "There are no more tours today. The next one is Monday, Oct 5 at 8:15 AM. Want that, or another day?",
    );
  });

  it("a later open day is fully booked", () => {
    expect(replyFor(at(2026, 10, 5, 9), date(2026, 10, 7), at(2026, 10, 8, 9), weekdays)).toBe(
      "Wednesday, Oct 7 is fully booked. The next opening is Thursday, Oct 8 at 9:00 AM. Want that, or another day?",
    );
  });

  it("the requested weekday is not a tour day", () => {
    expect(replyFor(at(2026, 10, 4, 22, 49), date(2026, 10, 3), at(2026, 10, 5, 8, 15), weekdays)).toBe(
      "Tours don't run on Saturdays. The next opening is Monday, Oct 5 at 8:15 AM. Want that, or another day?",
    );
  });

  it("the requested day is beyond the booking horizon", () => {
    expect(isBeyondBookingHorizon(date(2026, 9, 28), date(2026, 11, 16))).toBe(true);
    expect(replyFor(at(2026, 9, 28, 7), date(2026, 11, 16), at(2026, 10, 5, 8, 15), weekdays)).toBe(
      "I can't book that far ahead yet. The next opening is Monday, Oct 5 at 8:15 AM. Want that, or another day?",
    );
  });

  it("omits the next-opening ask when nothing is open", () => {
    expect(replyFor(at(2026, 10, 4, 22, 49), date(2026, 10, 4), undefined, openEveryDay)).toBe("There are no more tours today.");
  });

  it("does not use the old closed-day sentence or 'I have tours available'", () => {
    const text = replyFor(at(2026, 10, 4, 22, 49), date(2026, 10, 4), at(2026, 10, 5, 8, 15), openEveryDay);
    expect(text).not.toContain("I don't have tours on Sunday, Oct 4");
    expect(text).not.toContain("I have tours available");
    expect(text).not.toContain("Which day works for you?");
  });

  it("treats today + horizon days as too far, and today + horizon - 1 as in range", () => {
    expect(BOOKING_HORIZON_DAYS).toBe(21);
    expect(isBeyondBookingHorizon(date(2026, 9, 28), date(2026, 10, 18))).toBe(false);
    expect(isBeyondBookingHorizon(date(2026, 9, 28), date(2026, 10, 19))).toBe(true);
  });

  it("reads 'that' and 'yes' as accepting the next opening", () => {
    expect(acceptsOfferedOpening("that")).toBe(true);
    expect(acceptsOfferedOpening("That one!")).toBe(true);
    expect(acceptsOfferedOpening("yes")).toBe(true);
    expect(acceptsOfferedOpening("another day")).toBe(false);
    expect(acceptsOfferedOpening("Monday")).toBe(false);
  });
});

describe("typed day questions use the shared copy", () => {
  it("Sunday 10:49 PM, last slot gone: no more tours today, next is Monday 8:15 AM", async () => {
    const p = textVisitor({ config: everydayHours(), now: at(2026, 10, 4, 22, 49).getTime() });
    await toChooseDate(p);
    await p.say("Is there a tour for today?");
    expect(p.lastReply()).toContain("There are no more tours today. The next one is Monday, Oct 5 at 8:15 AM. Want that, or another day?");
    expect(p.lastReply()).toContain("1) Monday, Oct 5");
    expect(p.lastReply()).not.toContain("I don't have tours on Sunday");
    expect(p.lastReply()).not.toContain("I have tours available");
  });

  it("accepting 'that' books the exact next opening through the time-menu path", async () => {
    const p = textVisitor({ config: everydayHours(), now: at(2026, 10, 4, 22, 49).getTime() });
    await toChooseDate(p);
    await p.say("Is there a tour for today?");
    await p.say("that");
    expect(p.lastReply()).toContain("Great, you're booked for 8:15 AM on Monday, Oct 5.");
    expect(p.lastReply()).toContain("Is it OK if I text you about this tour");
    expect(p.lastReply()).not.toContain("I have these times available");
    expect(await p.session.stage()).toBe("consent");
    expect((await p.session.reservation())?.slotStart).toBe(at(2026, 10, 5, 8, 15).toISOString());
  });

  it("if that exact time was taken, offers the day's remaining times", async () => {
    const p = textVisitor({ config: everydayHours(), now: at(2026, 10, 4, 22, 49).getTime() });
    await toChooseDate(p);
    await p.say("Is there a tour for today?");
    const stolen = at(2026, 10, 5, 8, 15);
    const { reservation } = await p.session.core.startInquiry({ name: "Other", phone: "(555) 010-3199", unitId: "apt_101" }, { announce: false });
    await p.session.core.reserveSlot(reservation.id, stolen.toISOString());
    await p.say("that");
    expect(p.lastReply()).toContain("I have these times available Monday, Oct 5:");
    expect(p.lastReply()).toContain("9:15 AM");
    expect(p.lastReply()).not.toContain("8:15 AM");
    expect(await p.session.stage()).toBe("choose-time");
  });

  it("naming the next-opening day uses the existing day choice", async () => {
    const p = textVisitor({ config: everydayHours(), now: at(2026, 10, 4, 22, 49).getTime() });
    await toChooseDate(p);
    await p.say("Is there a tour for today?");
    await p.say("Monday");
    expect(p.lastReply()).toContain("I have these times available Monday, Oct 5:");
    expect(p.lastReply()).toContain("8:15 AM");
    expect(await p.session.stage()).toBe("choose-time");
  });

  it("today is open but every remaining start is booked", async () => {
    const p = textVisitor({ config: oneSundaySlot(), now: at(2026, 10, 4, 8).getTime() });
    await toChooseDate(p);
    await bookAllSlots(p.session, date(2026, 10, 4));
    await p.say("today");
    expect(p.lastReply()).toContain("There are no more tours today. The next one is Monday, Oct 5 at 8:15 AM. Want that, or another day?");
    expect(p.lastReply()).not.toContain("is fully booked");
    expect(p.lastReply()).not.toContain("I have tours available");
  });

  it("Saturday is not a tour day on the weekday schedule", async () => {
    const p = textVisitor({ now: at(2026, 9, 28, 7).getTime() });
    await toChooseDate(p);
    await p.say("Saturday");
    expect(p.lastReply()).toContain("Tours don't run on Saturdays. The next opening is Monday, Sep 28 at 2:00 PM. Want that, or another day?");
    expect(p.lastReply()).toContain("1) Monday, Sep 28");
    expect(p.lastReply()).not.toContain("I have tours available");
  });

  it("when nothing is open, uses the no-open-times line and no day menu", async () => {
    const config: TourCoreConfig = {
      ...loadConfig(),
      operator: { ...loadConfig().operator, name: "Maple Leasing team" },
      tourHours: {
        days: ["SUN"],
        start: "08:15",
        end: "09:15",
        slotEveryMinutes: 60,
        tourLengthMinutes: 45,
        earlyArrivalMinutes: 10,
      },
    };
    const p = textVisitor({ config, now: at(2026, 10, 4, 8).getTime() });
    await toChooseDate(p);
    await bookAllSlots(p.session, date(2026, 10, 4));
    await bookAllSlots(p.session, date(2026, 10, 11));
    await bookAllSlots(p.session, date(2026, 10, 18));
    await p.say("today");
    expect(p.lastReply()).toBe("There are no open tour times right now. The Maple Leasing team will reach out.");
    expect(p.lastReply()).not.toContain("Which day works for you?");
    expect(p.lastReply()).not.toMatch(/^\d\) /m);
    expect(await p.session.stage()).toBe("choose-date");
  });
});

describe("chooseDate buttons use the same helper", () => {
  it("a future open day with no remaining starts is fully booked", async () => {
    const session = webVisitor({ now: at(2026, 9, 28, 7).getTime() });
    await toWebChooseDate(session);
    await bookAllSlots(session, date(2026, 9, 29));
    await session.act("chooseDate", { date: "2026-09-29" });
    expect(lastFromTourCore(session)).toContain("Tuesday, Sep 29 is fully booked. The next opening is Monday, Sep 28 at 2:00 PM. Want that, or another day?");
    expect(lastFromTourCore(session)).toContain("Pick a day below.");
    expect(lastFromTourCore(session)).not.toContain("I have tours available");
    expect(await session.stage()).toBe("choose-date");
    expect((await visitorView(session)).choices.map((c) => c.label).slice(0, 2)).toEqual(["Monday, Sep 28", "Tuesday, Sep 29"]);
  });

  it("picking the next-opening day from the buttons offers that day's times", async () => {
    const session = webVisitor({ now: at(2026, 9, 28, 7).getTime() });
    await toWebChooseDate(session);
    await bookAllSlots(session, date(2026, 9, 29));
    await session.act("chooseDate", { date: "2026-09-29" });
    await session.act("chooseDate", { date: "2026-09-28" });
    expect(lastFromTourCore(session)).toContain("I have these times available Monday, Sep 28:");
    expect(await session.stage()).toBe("choose-time");
  });

  it("a day past the booking horizon is too far out", async () => {
    const session = webVisitor({ now: at(2026, 9, 28, 7).getTime() });
    await toWebChooseDate(session);
    await session.act("chooseDate", { date: "2026-11-16" });
    expect(lastFromTourCore(session)).toContain("I can't book that far ahead yet. The next opening is Monday, Sep 28 at 2:00 PM. Want that, or another day?");
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
