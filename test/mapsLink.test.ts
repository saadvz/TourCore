import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { SimulatedClock } from "../src/core/clock";
import { directionsUrl, propertyDirectionsUrl, tourDirectionsText } from "../src/core/mapsLink";
import { zonedTimeToUtc } from "../src/core/timezone";
import { createTourCore } from "../src/createTourCore";
import { MockDurinAccessAdapter } from "../src/durin/MockDurinAccessAdapter";
import { ConsoleMessenger } from "../src/messaging/Messenger";
import { InMemoryStore } from "../src/storage/Store";
import { basicForm, TOUR_DAY } from "./helpers";
import { hillsideConfig, liveApp, PHONE } from "./liveApp";

/**
 * Once a visitor's tour is all set, a second text links to directions to the
 * property. Both lines are Critiquito-locked and checked word for word.
 * No complete saved address, no link.
 */

const ALL_SET = "You're all set for your tour on Monday, Sep 28 at 2:00 PM!\nDoors will work for you from 1:50 PM to 2:45 PM.\nText \"I'm here\" when you arrive and I'll open the entrance.";

const DIRECTIONS = "https://www.google.com/maps/dir/?api=1&destination=";
const HILLSIDE = { street: "144 Hillside Ave", city: "Teaneck", state: "NJ", postalCode: "07666", formatted: "144 Hillside Ave, Teaneck, NJ 07666" };
const HILLSIDE_URL = `${DIRECTIONS}144%20Hillside%20Ave%2C%20Teaneck%2C%20NJ%2007666`;
const HILLSIDE_TEXT = `Here's how to get there: ${HILLSIDE_URL}`;

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

describe("directions URL from the property address", () => {
  it("is a Google Maps dir link with the URL-encoded full address as the destination", () => {
    expect(directionsUrl(HILLSIDE)).toBe(HILLSIDE_URL);
    const url = new URL(HILLSIDE_URL);
    expect(`${url.origin}${url.pathname}`).toBe("https://www.google.com/maps/dir/");
    expect(url.searchParams.get("api")).toBe("1");
    expect(url.searchParams.get("destination")).toBe("144 Hillside Ave, Teaneck, NJ 07666");
    expect([...url.searchParams.keys()]).toEqual(["api", "destination"]);
  });

  it("escapes characters that would otherwise break the link", () => {
    const url = directionsUrl({ street: "12 Main St #3 & Rear", city: "St. Paul", state: "MN", postalCode: "55102" });
    expect(url).toBe(`${DIRECTIONS}12%20Main%20St%20%233%20%26%20Rear%2C%20St.%20Paul%2C%20MN%2055102`);
    expect(new URL(url).searchParams.get("destination")).toBe("12 Main St #3 & Rear, St. Paul, MN 55102");
  });

  it("uses whatever address is saved on the property, not a fixed one", () => {
    expect(propertyDirectionsUrl({ canonicalAddress: HILLSIDE, addressConfirmed: true })).toBe(HILLSIDE_URL);
    expect(propertyDirectionsUrl({ canonicalAddress: { street: "9 Elm Ct", city: "Austin", state: "TX", postalCode: "78701" } })).toBe(
      `${DIRECTIONS}9%20Elm%20Ct%2C%20Austin%2C%20TX%2078701`,
    );
  });

  it("gives no link when the address is missing, incomplete or not yet confirmed", () => {
    expect(propertyDirectionsUrl({})).toBeUndefined();
    expect(propertyDirectionsUrl({ canonicalAddress: { ...HILLSIDE, postalCode: undefined } })).toBeUndefined();
    expect(propertyDirectionsUrl({ canonicalAddress: { ...HILLSIDE, postalCode: "  " } })).toBeUndefined();
    expect(propertyDirectionsUrl({ canonicalAddress: { ...HILLSIDE, street: "" } })).toBeUndefined();
    expect(propertyDirectionsUrl({ canonicalAddress: { ...HILLSIDE, city: " " } })).toBeUndefined();
    expect(propertyDirectionsUrl({ canonicalAddress: { ...HILLSIDE, state: "" } })).toBeUndefined();
    expect(propertyDirectionsUrl({ canonicalAddress: HILLSIDE, addressConfirmed: false })).toBeUndefined();
  });

  it("visitor line is exactly 'Here's how to get there: {url}', with no brand names", () => {
    const text = tourDirectionsText(HILLSIDE_URL);
    expect(text).toBe(HILLSIDE_TEXT);
    expect(text.slice(0, text.indexOf("https://"))).not.toMatch(/google|apple/i);
  });
});

describe("all-set text with directions", () => {
  it("sends the approved all-set text unchanged, then directions as its own text", async () => {
    const { ready, texts } = await bookAndCollect(withAddress(loadConfig(), HILLSIDE));
    expect(ready.status).toBe("READY");
    expect(texts.slice(-2)).toEqual([ALL_SET, HILLSIDE_TEXT]);
  });

  it("an older setup with a full address but no confirmation flag still gets directions", async () => {
    const { texts } = await bookAndCollect(withAddress(loadConfig(), HILLSIDE, undefined));
    expect(texts.at(-1)).toBe(HILLSIDE_TEXT);
  });

  it("skips directions when the operator hasn't confirmed the address", async () => {
    const { ready, texts } = await bookAndCollect(withAddress(loadConfig(), HILLSIDE, false));
    expect(ready.status).toBe("READY");
    expect(texts.at(-1)).toBe(ALL_SET);
    expect(texts.join("\n")).not.toContain("google.com/maps");
  });

  it("skips directions, and leaves the all-set text last, when the address has no ZIP", async () => {
    const { ready, texts } = await bookAndCollect(withAddress(loadConfig(), { ...HILLSIDE, postalCode: undefined, formatted: "144 Hillside Ave, Teaneck, NJ" }));
    expect(ready.status).toBe("READY");
    expect(texts.at(-1)).toBe(ALL_SET);
    expect(texts.join("\n")).not.toContain("google.com/maps");
  });

  it("skips directions when the property has no saved street, city, state and ZIP", async () => {
    const config = loadConfig();
    expect(config.property.canonicalAddress).toBeUndefined();
    const { texts } = await bookAndCollect(config);
    expect(texts.at(-1)).toBe(ALL_SET);
    expect(texts.join("\n")).not.toContain("google.com/maps");
  });
});

describe("all-set directions over Sendblue", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  it("texts the visitor's phone the all-set line, then the directions link", async () => {
    const a = await liveApp({ cleanups, config: withAddress(hillsideConfig(), HILLSIDE) });
    await a.book();
    const sent = a.fake.sent.filter((s) => s.number === PHONE).map((s) => s.content);
    const allSet = sent.findIndex((t) => t.startsWith("You're all set for your tour"));
    expect(sent[allSet]).toBe(ALL_SET);
    expect(sent[allSet + 1]).toBe(HILLSIDE_TEXT.replaceAll("Ave", "Avenue"));
    expect(sent).toHaveLength(allSet + 2);
  });
});
