import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { SimulatedClock } from "../src/core/clock";
import { mapsUrl, propertyMapsUrl, tourMapText } from "../src/core/mapsLink";
import { zonedTimeToUtc } from "../src/core/timezone";
import { createTourCore } from "../src/createTourCore";
import { MockDurinAccessAdapter } from "../src/durin/MockDurinAccessAdapter";
import { ConsoleMessenger } from "../src/messaging/Messenger";
import { InMemoryStore } from "../src/storage/Store";
import { basicForm, TOUR_DAY } from "./helpers";
import { hillsideConfig, liveApp, PHONE } from "./liveApp";

/**
 * Once a visitor's tour is all set, a second text links to the property on a
 * map. The all-set line itself is Critiquito-approved and stays word for word;
 * the map line is a draft. No complete saved address, no link.
 */

const ALL_SET = "You're all set for your tour on Monday, Sep 28 at 2:00 PM!\nDoors will work for you from 1:50 PM to 2:45 PM.\nText \"I'm here\" when you arrive and I'll open the entrance.";

const HILLSIDE = { street: "144 Hillside Ave", city: "Teaneck", state: "NJ", postalCode: "07666", formatted: "144 Hillside Ave, Teaneck, NJ 07666" };
const HILLSIDE_URL = "https://maps.google.com/?q=144%20Hillside%20Ave%2C%20Teaneck%2C%20NJ%2007666";

function withAddress(config: TourCoreConfig, canonicalAddress: TourCoreConfig["property"]["canonicalAddress"], addressConfirmed: boolean | undefined = true): TourCoreConfig {
  const property = { ...config.property, address: canonicalAddress?.formatted ?? config.property.address, canonicalAddress };
  if (addressConfirmed === undefined) delete property.addressConfirmed;
  else property.addressConfirmed = addressConfirmed;
  return { ...config, property };
}

/** Books Jane into the 2:00 PM Unit 101 tour and returns every text she was sent, in order. */
async function bookAndCollect(config: TourCoreConfig) {
  const clock = new SimulatedClock(zonedTimeToUtc({ ...TOUR_DAY, hour: 10, minute: 0 }, config.property.timezone));
  const durin = new MockDurinAccessAdapter({ doorNames: Object.fromEntries(config.doors.map((d) => [d.id, d.name])), log: () => {}, now: () => clock.now() });
  const store = new InMemoryStore();
  const core = createTourCore(config, { clock, durin, messenger: new ConsoleMessenger(() => {}), store });
  const { reservation } = await core.startInquiry({ name: "Jane Smith", phone: "(555) 010-1234", unitId: "apt_101" });
  const slot = (await core.availableSlots(TOUR_DAY))[0]!;
  await core.reserveSlot(reservation.id, slot.start.toISOString());
  await core.recordConsent(reservation.id, true);
  const ready = await core.submitVerification(reservation.id, basicForm());
  const texts = (await store.list("messages")).filter((m) => m.direction === "OUTBOUND" && m.audience === "PROSPECT").map((m) => m.body);
  return { ready, texts };
}

describe("maps URL from the property address", () => {
  it("URL-encodes street, city, state and ZIP into one Google Maps query", () => {
    expect(mapsUrl(HILLSIDE)).toBe(HILLSIDE_URL);
    expect(decodeURIComponent(new URL(HILLSIDE_URL).searchParams.get("q")!)).toBe("144 Hillside Ave, Teaneck, NJ 07666");
  });

  it("escapes characters that would otherwise break the link", () => {
    const url = mapsUrl({ street: "12 Main St #3 & Rear", city: "St. Paul", state: "MN", postalCode: "55102" });
    expect(url).toBe("https://maps.google.com/?q=12%20Main%20St%20%233%20%26%20Rear%2C%20St.%20Paul%2C%20MN%2055102");
    expect(new URL(url).searchParams.get("q")).toBe("12 Main St #3 & Rear, St. Paul, MN 55102");
  });

  it("uses whatever address is saved on the property, not a fixed one", () => {
    expect(propertyMapsUrl({ canonicalAddress: HILLSIDE, addressConfirmed: true })).toBe(HILLSIDE_URL);
    expect(propertyMapsUrl({ canonicalAddress: { street: "9 Elm Ct", city: "Austin", state: "TX", postalCode: "78701" } })).toBe(
      "https://maps.google.com/?q=9%20Elm%20Ct%2C%20Austin%2C%20TX%2078701",
    );
  });

  it("gives no link when the address is missing, incomplete or not yet confirmed", () => {
    expect(propertyMapsUrl({})).toBeUndefined();
    expect(propertyMapsUrl({ canonicalAddress: { ...HILLSIDE, postalCode: undefined } })).toBeUndefined();
    expect(propertyMapsUrl({ canonicalAddress: { ...HILLSIDE, postalCode: "  " } })).toBeUndefined();
    expect(propertyMapsUrl({ canonicalAddress: { ...HILLSIDE, street: "" } })).toBeUndefined();
    expect(propertyMapsUrl({ canonicalAddress: { ...HILLSIDE, city: " " } })).toBeUndefined();
    expect(propertyMapsUrl({ canonicalAddress: { ...HILLSIDE, state: "" } })).toBeUndefined();
    expect(propertyMapsUrl({ canonicalAddress: HILLSIDE, addressConfirmed: false })).toBeUndefined();
  });

  it("draft map line (for Critiquito) is exactly 'Here's a map: {url}'", () => {
    expect(tourMapText(HILLSIDE_URL)).toBe(`Here's a map: ${HILLSIDE_URL}`);
  });
});

describe("all-set text with a map", () => {
  it("sends the approved all-set text unchanged, then the map as its own text", async () => {
    const { ready, texts } = await bookAndCollect(withAddress(loadConfig(), HILLSIDE));
    expect(ready.status).toBe("READY");
    expect(texts.slice(-2)).toEqual([ALL_SET, `Here's a map: ${HILLSIDE_URL}`]);
  });

  it("an older setup with a full address but no confirmation flag still gets the map", async () => {
    const { texts } = await bookAndCollect(withAddress(loadConfig(), HILLSIDE, undefined));
    expect(texts.at(-1)).toBe(`Here's a map: ${HILLSIDE_URL}`);
  });

  it("skips the map, and leaves the all-set text last, when the address has no ZIP", async () => {
    const { ready, texts } = await bookAndCollect(withAddress(loadConfig(), { ...HILLSIDE, postalCode: undefined, formatted: "144 Hillside Ave, Teaneck, NJ" }));
    expect(ready.status).toBe("READY");
    expect(texts.at(-1)).toBe(ALL_SET);
    expect(texts.join("\n")).not.toContain("maps.google.com");
  });

  it("skips the map when the property has no saved street, city, state and ZIP", async () => {
    const config = loadConfig();
    expect(config.property.canonicalAddress).toBeUndefined();
    const { texts } = await bookAndCollect(config);
    expect(texts.at(-1)).toBe(ALL_SET);
    expect(texts.join("\n")).not.toContain("maps.google.com");
  });
});

describe("all-set map over Sendblue", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  it("texts the visitor's phone the all-set line, then the map link", async () => {
    const a = await liveApp({ cleanups, config: withAddress(hillsideConfig(), HILLSIDE) });
    await a.book();
    const sent = a.fake.sent.filter((s) => s.number === PHONE).map((s) => s.content);
    const allSet = sent.findIndex((t) => t.startsWith("You're all set for your tour"));
    expect(sent[allSet]).toBe(ALL_SET);
    expect(sent[allSet + 1]).toBe(`Here's a map: ${HILLSIDE_URL}`);
    expect(sent).toHaveLength(allSet + 2);
  });
});
