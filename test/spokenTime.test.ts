import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { parseFlexibleTime } from "../src/core/customSlot";
import { dayReference, spokenTimes } from "../src/core/spokenTime";
import { normalize } from "../src/intent/normalize";
import { localDateOf, zonedTimeToUtc, type LocalDate } from "../src/core/timezone";

const oct4: LocalDate = { year: 2026, month: 10, day: 4 };
const dec15: LocalDate = { year: 2026, month: 12, day: 15 };

const asked = (text: string, today: LocalDate = oct4) => dayReference(normalize(text), today);

describe("calendar dates in visitor text", () => {
  it("reads month name plus day", () => {
    expect(asked("Dec 1")).toEqual({ date: { year: 2026, month: 12, day: 1 } });
    expect(asked("Can I come December 1st?")).toEqual({ date: { year: 2026, month: 12, day: 1 } });
    expect(asked("1 Dec")).toEqual({ date: { year: 2026, month: 12, day: 1 } });
  });

  it("reads numeric US M/D and M/D/YY(YY)", () => {
    expect(asked("12/1")).toEqual({ date: { year: 2026, month: 12, day: 1 } });
    expect(asked("Can I come 12/1?")).toEqual({ date: { year: 2026, month: 12, day: 1 } });
    expect(asked("12/1/26")).toEqual({ date: { year: 2026, month: 12, day: 1 } });
    expect(asked("12/1/2026")).toEqual({ date: { year: 2026, month: 12, day: 1 } });
  });

  it("reads weekday plus date", () => {
    expect(asked("Tuesday Oct 6")).toEqual({ date: { year: 2026, month: 10, day: 6 }, weekday: "TUE" });
  });

  it("without a year, picks the next occurrence on or after today", () => {
    expect(asked("Jan 3", dec15)).toEqual({ date: { year: 2027, month: 1, day: 3 } });
    expect(asked("Oct 4")).toEqual({ date: { year: 2026, month: 10, day: 4 } });
  });

  it("keeps a just-passed this-year date as past when next year is beyond the horizon", () => {
    const oct5: LocalDate = { year: 2026, month: 10, day: 5 };
    expect(asked("October 1", oct5)).toEqual({ date: { year: 2026, month: 10, day: 1 } });
    expect(asked("Can I come October 1", oct5)).toEqual({ date: { year: 2026, month: 10, day: 1 } });
    expect(asked("Oct 1", oct5)).toEqual({ date: { year: 2026, month: 10, day: 1 } });
    expect(asked("Jan 3", dec15)).toEqual({ date: { year: 2027, month: 1, day: 3 } });
  });

  it("keeps today, tomorrow, and weekdays as they were", () => {
    expect(asked("Can I come today?")).toEqual({ relative: "today" });
    expect(asked("tomorrow")).toEqual({ relative: "tomorrow" });
    expect(asked("Saturday")).toEqual({ weekday: "SAT" });
  });

  it("does not treat a lone pair of numbers in a property question as a date", () => {
    expect(asked("unit 12 1 bedroom")).toBeUndefined();
  });

  it("marks an unparseable date ask as unclear instead of dropping it", () => {
    expect(asked("can I come the 45th")).toEqual({ unclear: true });
    expect(asked("sometime next month")).toEqual({ unclear: true });
    expect(asked("Can I come Feb 31?")).toEqual({ unclear: true });
  });
});

describe("a named weekday is that day, not today, unless today is that day and the time is still ahead", () => {
  const config = loadConfig();
  const mondayAfternoon = new Date(zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 15, minute: 0 }, "America/New_York"));
  const saturdayMorning = new Date(zonedTimeToUtc({ year: 2026, month: 10, day: 3, hour: 10, minute: 0 }, "America/New_York"));
  const saturdayAfternoon = new Date(zonedTimeToUtc({ year: 2026, month: 10, day: 3, hour: 16, minute: 0 }, "America/New_York"));
  const saturday = (day: number) => zonedTimeToUtc({ year: 2026, month: 10, day, hour: 14, minute: 45 }, "America/New_York");

  it("reads Is Saturday at 2:45 PM possible? as the coming Saturday", () => {
    const phrase = "Is Saturday at 2:45 PM possible?";
    const spoken = spokenTimes(normalize(phrase), { year: 2026, month: 9, day: 28 });
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({ hour: 2, minute: 45, meridiem: "PM", weekday: "SAT" });
    const resolved = parseFlexibleTime(phrase, config, mondayAfternoon);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.start.toISOString()).toBe(saturday(3).toISOString());
    expect(JSON.stringify(resolved)).not.toContain("already passed");
  });

  it("keeps Saturday when today is Saturday and 2:45 PM is still ahead", () => {
    const resolved = parseFlexibleTime("Is Saturday at 2:45 PM possible?", config, saturdayMorning);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.start.toISOString()).toBe(saturday(3).toISOString());
  });

  it("rolls to next Saturday when today is Saturday and 2:45 PM has passed", () => {
    const resolved = parseFlexibleTime("Saturday at 2:45 PM", config, saturdayAfternoon);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.start.toISOString()).toBe(saturday(10).toISOString());
    expect(JSON.stringify(resolved)).not.toContain("already passed");
  });
});

describe("named days stay on could/would/can I do custom times", () => {
  const monday = new Date(zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 10, minute: 0 }, "America/New_York"));
  const config = loadConfig();

  it.each([
    ["Could I do Thursday at 2:45?", { weekday: "THU" as const, hour: 2, minute: 45 }],
    ["Could I do Wednesday at 3:15?", { weekday: "WED" as const, hour: 3, minute: 15 }],
    ["Can I come Thursday at 2:45?", { weekday: "THU" as const, hour: 2, minute: 45 }],
    ["can we do Thursday at 2:45", { weekday: "THU" as const, hour: 2, minute: 45 }],
    ["how about Thursday at 2:45", { weekday: "THU" as const, hour: 2, minute: 45 }],
    ["would Thursday at 2:45 work", { weekday: "THU" as const, hour: 2, minute: 45 }],
    ["could I make Thursday at 2:45", { weekday: "THU" as const, hour: 2, minute: 45 }],
  ])("%s keeps the named day", (phrase, expected) => {
    const spoken = spokenTimes(normalize(phrase), { year: 2026, month: 9, day: 28 });
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({ hour: expected.hour, minute: expected.minute, weekday: expected.weekday });
    const resolved = parseFlexibleTime(phrase, config, monday);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      const day = resolved.start.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });
      expect(day.startsWith(expected.weekday === "THU" ? "Thursday" : "Wednesday")).toBe(true);
    }
  });
});

describe("a future YYYY-MM-DD instant stays on that date", () => {
  it("reads 2027-03-15T19:00:00.000Z as March 15, 2027 when today is Sep 28, 2026", () => {
    const config = loadConfig();
    const now = zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 7, minute: 0 }, "America/New_York");
    const resolved = parseFlexibleTime("2027-03-15T19:00:00.000Z", config, now);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.start.toISOString()).toBe("2027-03-15T19:00:00.000Z");
    expect(localDateOf(resolved.start, "America/New_York")).toEqual({ year: 2027, month: 3, day: 15 });
  });
});
