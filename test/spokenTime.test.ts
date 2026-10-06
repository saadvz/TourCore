import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { parseFlexibleTime } from "../src/core/customSlot";
import { dayReference, spokenTimes } from "../src/core/spokenTime";
import { normalize } from "../src/intent/normalize";
import { zonedTimeToUtc, type LocalDate } from "../src/core/timezone";

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
