import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { zonedTimeToUtc } from "../src/core/timezone";
import { FALLBACK, liveApp } from "./liveApp";

/**
 * Visitors pick a day, then a time. A day question during booking is
 * availability, not a missing property fact. The chosen day stays put
 * through a question. A single-family home is named by its address.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function home(): TourCoreConfig {
  const config = loadConfig();
  const entrance = { ...config.doors[0]!, name: "Front Door" };
  const unit = { ...config.units[0]!, name: "Main Home", doorId: entrance.id };
  return {
    ...config,
    messagingMode: "live",
    property: {
      ...config.property,
      propertyType: "SINGLE_FAMILY",
      name: "144 Hillside Avenue, Teaneck, NJ 07666",
      address: "144 Hillside Avenue, Teaneck, NJ 07666",
      canonicalAddress: {
        street: "144 Hillside Avenue",
        city: "Teaneck",
        state: "NJ",
        postalCode: "07666",
        formatted: "144 Hillside Avenue, Teaneck, NJ 07666",
      },
      addressConfirmed: true,
      facts: [],
    },
    doors: [entrance],
    units: [unit],
    routes: [
      {
        id: "route_home",
        unitId: unit.id,
        stops: [{ doorId: entrance.id, guidance: "Welcome to 144 Hillside Avenue! Take your time, and text me any questions." }],
      },
    ],
  };
}

describe("date-first availability", () => {
  it("offers upcoming days, then that day's times, and a day question is not a property exception", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    const opened = (await a.text("1")).join("\n");
    expect(opened).toContain("Unit 1A at 100 Alfred Way");
    expect(opened).toContain("Which day works for you?");
    expect(opened).toContain("Monday, Sep 28");
    expect(opened).toContain("Friday, Oct 2");
    expect(opened).not.toContain("2:00 PM");

    const menu = (await a.text("What availability do you have?")).join("\n");
    expect(menu).toContain("Which day works for you?");
    expect(menu).toContain("Thursday, Oct 1");
    expect(menu).not.toContain("2:00 PM");

    const thursday = (await a.text("What about Thursday?")).join("\n");
    expect(thursday).toContain("I have these times available Thursday, Oct 1:");
    expect(thursday).toContain("2:00 PM");
    expect(thursday).toContain("3:30 PM");
    expect(thursday).not.toContain(FALLBACK);

    const friday = (await a.text("Any availability Friday?")).join("\n");
    expect(friday).toContain("Friday, Oct 2");
    expect(friday).toContain("2:00 PM");
    expect(friday).not.toContain(FALLBACK);

    const weekend = (await a.text("Any availability this weekend?")).join("\n");
    expect(weekend).toContain("I don't have weekend tours");
    expect(weekend).not.toContain(FALLBACK);

    const queue = await a.grok("list_exceptions");
    expect(queue.exceptions).toEqual([]);
  });

  it("keeps Thursday's times after a rent question", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    await a.text("Thursday");
    const rent = (await a.text("How much is rent?")).join("\n");
    expect(rent).toContain("Unit 1A rents for $2,300 a month.");
    expect(rent).not.toContain("I have these times available Thursday, Oct 1:");
    expect(rent).not.toContain("Monday, Sep 28");
    expect((await a.grok("list_exceptions")).exceptions).toEqual([]);
    const pick = (await a.text("1")).join("\n");
    expect(pick).toMatch(/2:00 PM|booked/);
  });

  it("files a custom time on the selected day, and on a different day when one is named", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    await a.text("Thursday");
    const sameDay = (await a.text("Can I come at 3:20?")).join("\n");
    expect(sameDay).toContain("3:20 PM isn't one of the regular tour times");
    const tour = a.ws.listTours("prop_100_alfred_way").find((item) => item.kind === "messaging")!;
    const bundle = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    const thursdayAt = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 15, minute: 20 }, "America/New_York").toISOString();
    expect(bundle.tourTimeRequests?.[0]?.requestedStartsAt).toBe(thursdayAt);

    const other = (await a.text("Monday at 3:20")).join("\n");
    expect(other).toContain("3:20 PM isn't one of the regular tour times");
    const again = a.ws.loadTour("prop_100_alfred_way", tour.tourId)!.bundle;
    const mondayAt = zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 15, minute: 20 }, "America/New_York").toISOString();
    expect(again.tourTimeRequests?.map((request) => request.requestedStartsAt)).toContain(mondayAt);
  });
});

describe("single-family visitor language", () => {
  it("names the home by its address, not the internal space label", async () => {
    const a = await liveApp({ cleanups, config: home() });
    const hi = (await a.optInSms()).join("\n");
    expect(hi).toContain("Hi! Welcome to the self-guided tour for 144 Hillside Avenue, Teaneck, NJ 07666.");
    expect(hi).toContain("questions about the home");
    expect(hi).toContain("Which day works for you?");
    expect(hi).not.toContain("Main Home");
    expect(hi).not.toContain("Which unit");

    await a.text("Thursday");
    const rent = (await a.text("How much is the rent for this home?")).join("\n");
    expect(rent).toContain("144 Hillside Avenue rents for $2,300 a month.");
    expect(rent).not.toContain("Main Home");
    expect(rent).not.toMatch(/\bunit\b/i);
    expect(rent).not.toContain("I have these times available");
    const pick = (await a.text("1")).join("\n");
    expect(pick).toMatch(/2:00 PM|Thursday, Oct 1|booked/);
  });

  it("keeps an explicit public name, still with the address", async () => {
    const config = home();
    config.property.displayName = "Teaneck Home";
    config.property.name = "Teaneck Home";
    const a = await liveApp({ cleanups, config });
    const hi = (await a.optInSms()).join("\n");
    expect(hi).toContain("Teaneck Home at 144 Hillside Avenue, Teaneck, NJ 07666");
    expect(hi).not.toContain("Main Home");
    const rent = (await a.text("How much is rent?")).join("\n");
    expect(rent).toContain("Teaneck Home at 144 Hillside Avenue, Teaneck, NJ 07666 rents for $2,300 a month.");
    expect(rent).not.toContain("Main Home");
  });
});
