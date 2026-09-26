import { describe, expect, it } from "vitest";
import { loadConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { SimulatedClock } from "../src/core/clock";
import { slotsOn } from "../src/core/schedule";
import { formatTime, zonedTimeToUtc } from "../src/core/timezone";
import { createTourCore } from "../src/createTourCore";
import { ConsoleMessenger } from "../src/messaging/Messenger";

const withZone = (timezone: string): TourCoreConfig => {
  const config = loadConfig();
  return { ...config, property: { ...config.property, timezone } };
};

describe("property timezone", () => {
  it("places tour times in the property's zone, not the host's", () => {
    const monday = { year: 2026, month: 9, day: 28 };
    expect(slotsOn(withZone("America/New_York"), monday)[0]!.start.toISOString()).toBe("2026-09-28T18:00:00.000Z");
    expect(slotsOn(withZone("Asia/Tokyo"), monday)[0]!.start.toISOString()).toBe("2026-09-28T05:00:00.000Z");
    expect(slotsOn(withZone("America/Los_Angeles"), monday)[0]!.label).toBe("2:00 PM");
  });

  it("follows daylight saving changes at the property", () => {
    const afterFallBack = { year: 2026, month: 11, day: 2 };
    expect(slotsOn(withZone("America/New_York"), afterFallBack)[0]!.start.toISOString()).toBe("2026-11-02T19:00:00.000Z");
  });

  it("uses the property's weekday even when UTC is already the next day", () => {
    const config = { ...withZone("America/Los_Angeles"), tourHours: { ...withZone("UTC").tourHours, start: "20:00", end: "22:00" } };
    // Friday 20:00 in Los Angeles is Saturday 03:00 UTC; Friday tours must still exist.
    expect(slotsOn(config, { year: 2026, month: 10, day: 2 })).toHaveLength(1);
    expect(slotsOn(config, { year: 2026, month: 10, day: 3 })).toHaveLength(0);
  });

  it("computes access windows and messages in property time", async () => {
    const config = withZone("Asia/Tokyo");
    const clock = new SimulatedClock(zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 10, minute: 0 }, "Asia/Tokyo"));
    const lines: string[] = [];
    const core = createTourCore(config, { clock, messenger: new ConsoleMessenger((l) => lines.push(l)) });
    const { reservation } = await core.startInquiry({ name: "Jane Smith", phone: "5550101234", unitId: "apt_101" });
    const slot = (await core.availableSlots())[0]!;
    const booked = await core.reserveSlot(reservation.id, slot.start.toISOString());
    expect(booked.windowStart).toBe("2026-09-28T04:50:00.000Z");
    expect(formatTime(new Date(booked.windowStart!), "Asia/Tokyo")).toBe("1:50 PM");
    expect(lines.join("\n")).toContain("booked for 2:00 PM");
  });
});
