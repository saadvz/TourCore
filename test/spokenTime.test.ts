import { describe, expect, it } from "vitest";
import { dayReference } from "../src/core/spokenTime";
import { normalize } from "../src/intent/normalize";
import type { LocalDate } from "../src/core/timezone";

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
