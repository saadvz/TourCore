import { request } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPortableBackup, buildPortableBackup } from "../src/backup/portable";
import { safetyHash } from "../src/config/changeKinds";
import { touringHoursLabel } from "../src/core/customSlot";
import { spokenTimeZone } from "../src/core/timezone";
import { interpretByRules } from "../src/intent/ruleBased";
import { hoursStepSay } from "../src/operator/milestones";
import { parseUsAddress } from "../src/setup/address";
import { configHash } from "../src/setup/workspace";
import { writeJsonAtomic } from "../src/storage/atomicWrite";
import { PropertyWorkspace } from "../src/setup";
import { createSetupServer } from "../src/web/server";
import { grokHarness, type GrokHarness } from "./grokHarness";
import { installHarness } from "./installHarness";

/**
 * Phase 5a gate cases. Each case fails on master 8a36c2b and passes here.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((run) => run()));

function use(h: GrokHarness = grokHarness()): GrokHarness {
  cleanups.push(h.cleanup);
  return h;
}

const TIMED_OUT = "That upload timed out. Send me the backup file again and I'll check it.";
const UPLOAD_FIRST = "Upload the backup file first, then I can show you what's in it.";
const ZIP_CA = "That ZIP doesn't look like it's in California. Which one should I fix, the ZIP or the state?";
const ZONE_STATEMENT = "I'm using Eastern time for tours. You can change that anytime.";
const SWITCH_PACIFIC = "Tours still run on Eastern time. Should I switch to Pacific time?";
const HOLD_PACIFIC = `Before I save that, one thing. ${SWITCH_PACIFIC}`;
const MAPLE_CA_CONFIRM = "Did I get that right: 18 Maple Street, Teaneck, CA 94105?";
const TYPE_QUESTION = "Is this a single-family home, a multifamily home, or one apartment or condo?";
const ZIP_QUESTION = "What ZIP code should I use?";
const MAPLE = "18 Maple Street, Teaneck, NJ 07666";
const MAPLE_CONFIRM = `Did I get that right: ${MAPLE}?`;

function questions(text: string): number {
  return text.match(/\?/g)?.length ?? 0;
}

function oneQuestion(text: string): void {
  expect(questions(text)).toBeLessThanOrEqual(1);
}

const DAY_MENU = {
  message: "",
  step: "choose-date" as const,
  units: [{ name: "Unit 1A" }],
  timeChoices: ["Monday, Sep 28", "Tuesday, Sep 29", "Wednesday, Sep 30", "Thursday, Oct 1", "Friday, Oct 2"],
  remainingStops: [],
  doors: [],
  today: { year: 2026, month: 9, day: 28 },
  timezone: "America/New_York",
};

function dayIntent(message: string) {
  return interpretByRules({ ...DAY_MENU, message }).intent;
}

describe("two-word cities", () => {
  it("keeps Fort Lee and New York on one line, and Avenue when the city arrives later", async () => {
    expect(parseUsAddress("12 Main Street Fort Lee NJ")?.address).toMatchObject({
      street: "12 Main Street",
      city: "Fort Lee",
      state: "NJ",
    });
    expect(parseUsAddress("500 Broadway New York NY")?.address).toMatchObject({
      street: "500 Broadway",
      city: "New York",
      state: "NY",
    });
    expect(parseUsAddress("Saddle River NJ")?.address.city).toBe("Saddle River");
    expect(parseUsAddress("Little Ferry NJ")?.address.city).toBe("Little Ferry");
    expect(parseUsAddress("St. Louis MO")?.address).toMatchObject({ city: "St. Louis", state: "MO" });
    expect(parseUsAddress("Salt Lake City UT 84101")?.address).toMatchObject({ city: "Salt Lake City", state: "UT", postalCode: "84101" });
    expect(parseUsAddress("NJ")?.address.state).toBe("NJ");
    expect(parseUsAddress("07670")?.address).toMatchObject({ street: "", city: "", state: "", postalCode: "07670" });
    expect(parseUsAddress("Avenue")?.address.city ?? "").toBe("");

    const h = use();
    const created = await h.ok("create_property_setup", { address: "144 Hillside Avenue" });
    const id = created.setup.propertyId as string;
    expect(created.summary).not.toMatch(/GMT|UTC|time zone|I'm using/);
    await h.ok("update_property_details", { property: id, city: "Fort Lee" });
    await h.ok("update_property_details", { property: id, state: "NJ" });
    const zip = await h.ok("update_property_details", { property: id, postalCode: "07024" });
    expect(zip.nextQuestion).toBe("Did I get that right: 144 Hillside Avenue, Fort Lee, NJ 07024?");
    expect(String(zip.nextQuestion)).toContain("Avenue");
  });
});

describe("state and ZIP", () => {
  it("asks and saves nothing for an NJ ZIP with California, and accepts a matching pair", async () => {
    const h = use();
    expect(await h.fails("create_property_setup", { address: "Tenafly, CA 07670" })).toBe(ZIP_CA);
    expect(h.workspace.propertyIds()).toEqual([]);

    const created = await h.ok("create_property_setup", { address: "10 Oak Street" });
    const id = created.setup.propertyId as string;
    await h.ok("update_property_details", { property: id, city: "Tenafly", state: "CA" });
    expect(await h.fails("update_property_details", { property: id, postalCode: "07670" })).toBe(ZIP_CA);
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress?.postalCode).toBeUndefined();

    await h.ok("update_property_details", { property: id, state: "NJ" });
    const fixed = await h.ok("update_property_details", { property: id, postalCode: "07670" });
    expect(fixed.nextQuestion).toBe("Did I get that right: 10 Oak Street, Tenafly, NJ 07670?");
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress).toMatchObject({ state: "NJ", postalCode: "07670" });

    const other = await h.ok("create_property_setup", { address: "11 Oak Street, Tenafly, CA" });
    const otherId = other.setup.propertyId as string;
    expect(await h.fails("update_property_details", { property: otherId, state: "CA", postalCode: "07670" })).toBe(ZIP_CA);
    await h.ok("update_property_details", { property: otherId, postalCode: "90210" });
    expect(h.workspace.openDraft(otherId).draft.property.canonicalAddress).toMatchObject({ state: "CA", postalCode: "90210" });
  });

  it("loads, publishes and texts an older property whose ZIP and state already disagree", async () => {
    const h = use();
    expect(await h.fails("create_property_setup", { address: "9 Side Street, Tenafly, CA 07670" })).toBe(ZIP_CA);
    const id = await h.publish();
    const saved = h.workspace.load(id);
    const config = structuredClone(saved.config);
    config.property.address = "100 Alfred Way, Tenafly, CA 07670";
    config.property.canonicalAddress = {
      street: "100 Alfred Way",
      city: "Tenafly",
      state: "CA",
      postalCode: "07670",
      formatted: "100 Alfred Way, Tenafly, CA 07670",
    };
    const folder = join(h.root, "properties", id);
    writeJsonAtomic(join(folder, "tourcore.config.json"), config);
    const status = JSON.parse(readFileSync(join(folder, "status.json"), "utf8")) as { configHash: string; safetyHash?: string; status: string };
    status.configHash = configHash(config);
    status.safetyHash = safetyHash(config);
    writeJsonAtomic(join(folder, "status.json"), status);

    const loaded = h.workspace.load(id);
    expect(loaded.state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(loaded.config.property.canonicalAddress).toMatchObject({ state: "CA", postalCode: "07670" });
    const listed = await h.ok("get_property_setup", { property: id });
    expect(listed.summary).not.toContain("Which one should I fix");
    const visitor = await h.visitor(id);
    expect(visitor.session.offeredSlots.length).toBeGreaterThan(0);
    const texts = (await visitor.session.store.list("messages")).map((message) => message.body).join("\n");
    expect(texts).not.toContain("Which one should I fix");
    expect(texts.length).toBeGreaterThan(0);
  });
});

describe("zone copy", () => {
  it("leaves the zone out until a state is known, then says which time it is using", async () => {
    const h = use();
    const street = await h.ok("create_property_setup", { address: "12 Main Street" });
    expect(street.summary).toBe("Started 12 Main Street.");
    expect(JSON.stringify(street.summary)).not.toMatch(/GMT|UTC|I'm using|time zone/);
    expect(street.timezoneGuess).toBeUndefined();

    const eastern = await h.ok("create_property_setup", { address: "18 Maple Street, Teaneck, NJ 07666" });
    expect(eastern.summary).toBe(`Started ${MAPLE}. ${ZONE_STATEMENT} ${MAPLE_CONFIRM}`);
    expect(eastern.nextQuestion).toBeUndefined();
    oneQuestion(eastern.summary);

    const phoenix = await h.ok("create_property_setup", { address: "1 Central Avenue, Phoenix, AZ 85004" });
    expect(phoenix.summary).toBe("Started 1 Central Avenue, Phoenix, AZ 85004. I'm using Mountain time for tours. You can change that anytime. Did I get that right: 1 Central Avenue, Phoenix, AZ 85004?");
    expect(phoenix.nextQuestion).toBeUndefined();
    oneQuestion(phoenix.summary);
    expect(phoenix.summary).not.toMatch(/Standard|GMT|UTC/);
    expect(spokenTimeZone("America/Phoenix")).toBe("Mountain");
    expect(spokenTimeZone("Pacific/Honolulu")).toBe("Hawaii");
    expect(spokenTimeZone("America/Anchorage")).toBe("Alaska");
  });

  it("asks about a locked zone only when save_property actually changes the state", async () => {
    const h = use();
    const id = await h.publish();
    const same = await h.ok("save_property", { property: id, state: "NY" });
    expect(JSON.stringify(same)).not.toContain("Should I switch");
    expect(JSON.stringify(same)).not.toContain("I'm using");

    const changed = await h.ok("save_property", { property: id, state: "CA" });
    expect(changed.message).toBe(SWITCH_PACIFIC);
    oneQuestion(changed.message);
    expect(changed.message).not.toContain("Did I get that right");
    expect(h.workspace.load(id).config.property.timezone).toBe("America/New_York");

    const switched = await h.ok("update_property_details", { property: id, timezone: "Pacific" });
    expect(h.workspace.load(id).config.property.timezone).toBe("America/Los_Angeles");
    expect(h.workspace.load(id).config.property.timezoneConfirmed).toBe(true);
    expect(switched.summary).not.toContain("Should I switch");

    await h.ok("set_tour_hours", { property: id, days: "weekdays", start: "10am", end: "4pm" });
    expect(h.workspace.load(id).state.status).toBe("DRAFT");
    expect(h.workspace.load(id).state.publishedAt).toBeTruthy();
    const again = await h.ok("save_property", { property: id, state: "NY" });
    expect(again.message).toBe("Tours still run on Pacific time. Should I switch to Eastern time?");
    oneQuestion(again.message);
  });
});

describe("one question in a zone reply", () => {
  it("states a guessed zone, then the one next address, confirm, or type question", async () => {
    const zip = await use().ok("save_property", { address: "12 Main Street, Teaneck, NJ" });
    expect(zip.message).toBe(`${ZONE_STATEMENT} ${ZIP_QUESTION}`);
    oneQuestion(zip.message);

    const confirm = await use().ok("save_property", { address: MAPLE });
    expect(confirm.message).toBe(`${ZONE_STATEMENT} ${MAPLE_CONFIRM}`);
    oneQuestion(confirm.message);

    const type = await use().ok("save_property", { address: MAPLE, confirmAddress: true });
    expect(type.message).toBe(`${ZONE_STATEMENT} ${TYPE_QUESTION}`);
    oneQuestion(type.message);

    const alone = await use().ok("save_property", { address: MAPLE, confirmAddress: true, propertyType: "MULTIFAMILY_HOME" });
    expect(alone.message).toBe(`Saved ${MAPLE}. I'm using Eastern time for tours. Want a different one?`);
    oneQuestion(alone.message);

    const started = await use().ok("create_property_setup", { address: "12 Main Street, Teaneck, NJ" });
    expect(started.summary).toBe(`Started 12 Main Street, Teaneck, NJ. ${ZONE_STATEMENT} ${ZIP_QUESTION}`);
    expect(started.nextQuestion).toBeUndefined();
    oneQuestion(started.summary);

    const detailsHarness = use();
    const street = await detailsHarness.ok("save_property", { address: "14 Main Street" });
    const details = await detailsHarness.ok("update_property_details", {
      property: street.propertyId,
      city: "Teaneck",
      state: "NJ",
      postalCode: "07666",
      confirmAddress: true,
    });
    expect(details.summary).toBe(`Updated 14 Main Street. ${ZONE_STATEMENT} What type of property is this?`);
    expect(details.nextQuestion).toBeUndefined();
    expect(details.choices).toEqual(expect.any(Array));
    oneQuestion(details.summary);
    expect(details.summary).not.toContain("Want a different one?");

    const readbackHarness = use();
    const bare = await readbackHarness.ok("save_property", { address: "16 Main Street, Teaneck" });
    const readback = await readbackHarness.ok("update_property_details", { property: bare.propertyId, state: "NJ", postalCode: "07666" });
    expect(readback.summary).toBe(`Updated 16 Main Street. ${ZONE_STATEMENT} Did I get that right: 16 Main Street, Teaneck, NJ 07666?`);
    expect(readback.nextQuestion).toBeUndefined();
    expect(readback.confirmAddress).toBe(true);
    oneQuestion(readback.summary);
  });

  it("asks the switch question alone, then the next setup question only after yes, and a ZIP is not yes", async () => {
    const h = use();
    const opened = await h.ok("save_property", { address: MAPLE, confirmAddress: true });
    const id = opened.propertyId as string;
    expect(h.workspace.openDraft(id).draft.property.timezoneConfirmed).toBe(true);

    const asked = await h.ok("save_property", { property: id, state: "CA", postalCode: "90210", confirmAddress: true });
    expect(asked.message).toBe(SWITCH_PACIFIC);
    oneQuestion(asked.message);
    expect(asked.message).not.toContain(TYPE_QUESTION);
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/New_York");
    expect(h.workspace.openDraft(id).draft.property.zoneSwitchOffer).toBe("America/Los_Angeles");
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress?.postalCode).toBe("90210");

    const asTimezone = await h.ok("save_property", { property: id, timezone: "90210" });
    expect(asTimezone.message).toBe(SWITCH_PACIFIC);
    oneQuestion(asTimezone.message);
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/New_York");
    expect(h.workspace.openDraft(id).draft.property.zoneSwitchOffer).toBe("America/Los_Angeles");

    const asZip = await h.ok("save_property", { property: id, postalCode: "94105" });
    expect(asZip.message).toBe(HOLD_PACIFIC);
    oneQuestion(asZip.message);
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress?.postalCode).toBe("90210");
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/New_York");
    expect(h.workspace.openDraft(id).draft.property.zoneSwitchOffer).toEqual({ zone: "America/Los_Angeles", held: { postalCode: "94105" } });

    const yes = await h.ok("save_property", { property: id, timezone: "yes" });
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/Los_Angeles");
    expect(h.workspace.openDraft(id).draft.property.zoneSwitchOffer).toBeUndefined();
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress?.postalCode).toBe("94105");
    expect(yes.message).toBe(MAPLE_CA_CONFIRM);
    oneQuestion(yes.message);

    const other = await h.ok("create_property_setup", { address: "20 Oak Street, Teaneck, NJ 07666" });
    const otherId = other.setup.propertyId as string;
    await h.ok("update_property_details", { property: otherId, confirmAddress: true });
    const moved = await h.ok("update_property_details", { property: otherId, state: "CA", postalCode: "90210", confirmAddress: true });
    expect(moved.summary).toBe(`Updated 20 Oak Street. ${SWITCH_PACIFIC}`);
    oneQuestion(moved.summary);
    expect(moved.summary).not.toContain(TYPE_QUESTION);
    expect(moved.nextQuestion).toBeUndefined();
    expect(h.workspace.openDraft(otherId).draft.property.timezone).toBe("America/New_York");

    const zipAgain = await h.ok("update_property_details", { property: otherId, postalCode: "94105" });
    expect(zipAgain.summary).toBe(HOLD_PACIFIC);
    oneQuestion(zipAgain.summary);
    expect(zipAgain.nextQuestion).toBeUndefined();
    expect(h.workspace.openDraft(otherId).draft.property.timezone).toBe("America/New_York");
    expect(h.workspace.openDraft(otherId).draft.property.canonicalAddress?.postalCode).toBe("90210");
    expect(h.workspace.openDraft(otherId).draft.property.zoneSwitchOffer).toEqual({ zone: "America/Los_Angeles", held: { postalCode: "94105" } });

    const accepted = await h.ok("update_property_details", { property: otherId, timezone: "yes" });
    expect(h.workspace.openDraft(otherId).draft.property.timezone).toBe("America/Los_Angeles");
    expect(h.workspace.openDraft(otherId).draft.property.canonicalAddress?.postalCode).toBe("94105");
    expect(accepted.nextQuestion).toBe("Did I get that right: 20 Oak Street, Teaneck, CA 94105?");
    oneQuestion(accepted.summary);
    expect(accepted.summary).not.toContain("Should I switch");
    expect(accepted.summary).not.toContain("Did I get that right");
  });

  it("keeps the zone and saves the held ZIP when the answer is no", async () => {
    const h = use();
    const opened = await h.ok("save_property", { address: MAPLE, confirmAddress: true });
    const id = opened.propertyId as string;
    await h.ok("save_property", { property: id, state: "CA", postalCode: "90210", confirmAddress: true });
    const held = await h.ok("save_property", { property: id, postalCode: "94105" });
    expect(held.message).toBe(HOLD_PACIFIC);
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress?.postalCode).toBe("90210");

    const no = await h.ok("save_property", { property: id, timezone: "no" });
    const property = h.workspace.openDraft(id).draft.property;
    expect(property.timezone).toBe("America/New_York");
    expect(property.timezoneConfirmed).toBe(true);
    expect(property.zoneSwitchOffer).toBeUndefined();
    expect(property.canonicalAddress?.postalCode).toBe("94105");
    expect(no.message).toBe(MAPLE_CA_CONFIRM);
    oneQuestion(no.message);
  });

  it("checks a held ZIP against the state after yes, and does not save a mismatch", async () => {
    const h = use();
    const opened = await h.ok("save_property", { address: MAPLE, confirmAddress: true });
    const id = opened.propertyId as string;
    await h.ok("update_property_details", { property: id, state: "CA" });
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress?.postalCode).toBe("07666");
    const held = await h.ok("update_property_details", { property: id, postalCode: "07670" });
    expect(held.summary).toBe(HOLD_PACIFIC);
    expect((held.summary.match(/\?/g) ?? []).length).toBe(1);
    expect(held.nextQuestion).toBeUndefined();
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress?.postalCode).toBe("07666");

    const error = await h.fails("update_property_details", { property: id, timezone: "yes" });
    expect(error).toBe(ZIP_CA);
    expect((error.match(/\?/g) ?? []).length).toBe(1);
    const property = h.workspace.openDraft(id).draft.property;
    expect(property.timezone).toBe("America/Los_Angeles");
    expect(property.canonicalAddress?.postalCode).toBe("07666");
    expect(property.zoneSwitchOffer).toBeUndefined();
  });

  it("saves a held ZIP when the answer names the zone", async () => {
    const pacific = use();
    const pacificOpened = await pacific.ok("save_property", { address: MAPLE, confirmAddress: true });
    const pacificId = pacificOpened.propertyId as string;
    await pacific.ok("update_property_details", { property: pacificId, state: "CA" });
    await pacific.ok("update_property_details", { property: pacificId, postalCode: "94105" });
    const named = await pacific.ok("update_property_details", { property: pacificId, timezone: "Pacific" });
    expect(pacific.workspace.openDraft(pacificId).draft.property.timezone).toBe("America/Los_Angeles");
    expect(pacific.workspace.openDraft(pacificId).draft.property.canonicalAddress?.postalCode).toBe("94105");
    expect(named.nextQuestion).toBe(MAPLE_CA_CONFIRM);
    expect(named.summary).not.toContain("Did I get that right");
    expect((`${named.summary} ${named.nextQuestion}`.match(/\?/g) ?? []).length).toBe(1);

    const eastern = use();
    const easternOpened = await eastern.ok("save_property", { address: MAPLE, confirmAddress: true });
    const easternId = easternOpened.propertyId as string;
    await eastern.ok("save_property", { property: easternId, state: "CA" });
    await eastern.ok("save_property", { property: easternId, postalCode: "94105" });
    const kept = await eastern.ok("save_property", { property: easternId, timezone: "keep Eastern" });
    const property = eastern.workspace.openDraft(easternId).draft.property;
    expect(property.timezone).toBe("America/New_York");
    expect(property.timezoneConfirmed).toBe(true);
    expect(property.canonicalAddress?.postalCode).toBe("94105");
    expect(kept.message).toBe(MAPLE_CA_CONFIRM);
    oneQuestion(kept.message);
  });

  it("replaces a held ZIP with the latest one and keeps the other held fields", async () => {
    const h = use();
    const opened = await h.ok("save_property", { address: MAPLE, confirmAddress: true });
    const id = opened.propertyId as string;
    await h.ok("update_property_details", { property: id, state: "CA" });
    await h.ok("update_property_details", { property: id, city: "Beverly Hills", postalCode: "90210" });
    const latest = await h.ok("update_property_details", { property: id, postalCode: "94105" });
    expect(latest.summary).toBe(HOLD_PACIFIC);
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress).toMatchObject({ city: "Teaneck", postalCode: "07666" });
    expect(h.workspace.openDraft(id).draft.property.zoneSwitchOffer).toEqual({
      zone: "America/Los_Angeles",
      held: { city: "Beverly Hills", postalCode: "94105" },
    });

    await h.ok("update_property_details", { property: id, timezone: "yes" });
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress).toMatchObject({ city: "Beverly Hills", state: "CA", postalCode: "94105" });
    expect(JSON.stringify(h.workspace.openDraft(id).draft.property)).not.toContain("90210");
  });

  it("keeps a held ZIP on its own property when another property is started or updated", async () => {
    const h = use();
    const opened = await h.ok("save_property", { address: MAPLE, confirmAddress: true });
    const id = opened.propertyId as string;
    await h.ok("update_property_details", { property: id, state: "CA" });
    await h.ok("update_property_details", { property: id, postalCode: "94105" });
    expect(h.workspace.openDraft(id).draft.property.zoneSwitchOffer).toEqual({ zone: "America/Los_Angeles", held: { postalCode: "94105" } });

    const other = await h.ok("create_property_setup", { address: "20 Oak Street, Teaneck, NJ 07666" });
    const otherId = other.setup.propertyId as string;
    expect(h.workspace.openDraft(otherId).draft.property.canonicalAddress?.postalCode).toBe("07666");
    expect(h.workspace.openDraft(otherId).draft.property.zoneSwitchOffer).toBeUndefined();
    expect(JSON.stringify(h.workspace.openDraft(otherId).draft.property)).not.toContain("94105");

    await h.ok("update_property_details", { property: otherId, confirmAddress: true, name: "Oak House" });
    expect(h.workspace.openDraft(otherId).draft.property.canonicalAddress?.postalCode).toBe("07666");
    expect(h.workspace.openDraft(otherId).draft.property.timezone).toBe("America/New_York");
    expect(h.workspace.openDraft(id).draft.property.zoneSwitchOffer).toEqual({ zone: "America/Los_Angeles", held: { postalCode: "94105" } });
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress?.postalCode).toBe("07666");
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/New_York");

    await h.ok("update_property_details", { property: id, timezone: "yes" });
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress?.postalCode).toBe("94105");
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/Los_Angeles");
    expect(h.workspace.openDraft(otherId).draft.property.canonicalAddress?.postalCode).toBe("07666");
    expect(h.workspace.openDraft(otherId).draft.property.displayName).toBe("Oak House");
    expect(h.workspace.openDraft(otherId).draft.property.timezone).toBe("America/New_York");
  });

  it("still answers an older switch offer that has no held fields", async () => {
    const h = use();
    const id = await h.publish();
    await h.ok("save_property", { property: id, state: "CA" });
    expect(h.workspace.load(id).config.property.zoneSwitchOffer).toBe("America/Los_Angeles");
    const configPath = join(h.root, "properties", id, "tourcore.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { property: { zoneSwitchOffer?: unknown } };
    config.property.zoneSwitchOffer = { zone: "America/Los_Angeles" };
    writeFileSync(configPath, JSON.stringify(config));

    const yes = await h.ok("update_property_details", { property: id, timezone: "yes" });
    const property = h.workspace.load(id).config.property;
    expect(property.timezone).toBe("America/Los_Angeles");
    expect(property.timezoneConfirmed).toBe(true);
    expect(property.zoneSwitchOffer).toBeUndefined();
    expect(yes.summary).not.toContain("Should I switch");
  });

  it("names each property whose older ID check became the basic form", async () => {
    const source = use();
    const id = await source.publish();
    const configPath = join(source.root, "properties", id, "tourcore.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { verificationMode?: string; property: { id: string; name: string; displayName?: string } };
    config.verificationMode = "mock";
    writeFileSync(configPath, JSON.stringify(config));
    const backup = buildPortableBackup({
      root: source.root,
      installationId: "inst_phase5a",
      createdAt: "2026-10-08T12:00:00.000Z",
      tourCoreVersion: "test",
      secretValues: [],
    });
    const packed = backup.contents.files.find((file) => file.path.endsWith("/tourcore.config.json"));
    const second = structuredClone(packed!);
    const body = second.body as { verificationMode?: string; property: { id: string; name: string; displayName?: string } };
    body.property.id = "prop_oak_house";
    body.property.displayName = "Oak House";
    body.property.name = "Oak House";
    body.verificationMode = "mock";
    second.path = "properties/prop_oak_house/tourcore.config.json";
    backup.contents.files.push(second);
    const restored = use();
    const applied = applyPortableBackup(restored.root, backup, false);
    const alfred = "100 Alfred Way had an older ID check setting, so it now uses the basic identity form. Tell me if you'd rather have no form.";
    const oak = "Oak House had an older ID check setting, so it now uses the basic identity form. Tell me if you'd rather have no form.";
    expect(applied.notes).toEqual([alfred, oak]);

    const document = use();
    const documentId = await document.publish();
    const documentPath = join(document.root, "properties", documentId, "tourcore.config.json");
    const documentConfig = JSON.parse(readFileSync(documentPath, "utf8")) as { verificationMode?: string };
    documentConfig.verificationMode = "document-check";
    writeFileSync(documentPath, JSON.stringify(documentConfig));
    const documentBackup = buildPortableBackup({
      root: document.root,
      installationId: "inst_phase5a_document",
      createdAt: "2026-10-08T12:00:00.000Z",
      tourCoreVersion: "test",
      secretValues: [],
    });
    const quiet = applyPortableBackup(use().root, documentBackup, false);
    expect(quiet.notes).toEqual([]);
  });

  it("says that line in the import summary", async () => {
    const origin = installHarness();
    cleanups.push(origin.cleanup);
    const id = await origin.publish();
    const configPath = join(origin.root, "properties", id, "tourcore.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { verificationMode?: string };
    config.verificationMode = "mock";
    writeFileSync(configPath, JSON.stringify(config));
    const created = await origin.ok("create_portable_backup");
    const artifactId = String(created.handoff.path).split("/").pop()!;
    const downloaded = origin.inst.backups.handoff.takeDownload(artifactId, created.handoff.capability).body;
    const clean = installHarness();
    cleanups.push(clean.cleanup);
    const upload = await clean.ok("begin_restore_upload");
    const uploadId = String(upload.handoff.path).split("/").pop()!;
    clean.inst.backups.receive(uploadId, upload.handoff.capability, downloaded);
    const asked = await clean.ok("import_portable_backup", { uploadId });
    const restored = await clean.ok("import_portable_backup", { uploadId, confirmationCode: asked.confirmationCode });
    const line = "100 Alfred Way had an older ID check setting, so it now uses the basic identity form. Tell me if you'd rather have no form.";
    expect(restored.lines).toContain(line);
    expect(restored.summary).toContain(line);
    expect(restored.lines.filter((item: string) => item === line)).toHaveLength(1);
  });
});

describe("midnight hours", () => {
  it("says midnight while the stored end stays 23:59, and the visitor line matches", async () => {
    const h = use();
    const id = await h.publish();
    const saved = await h.ok("save_hours", { property: id, days: "every day", start: "8am", end: "11:59pm" });
    expect(saved.message).toBe("Tours run every day, 8 AM to midnight.");
    expect(saved.message).not.toContain("11:59");
    const hours = h.workspace.load(id).config.tourHours;
    expect(hours.end).toBe("23:59");
    expect(hours.start).toBe("08:00");
    const operator = hoursStepSay(hours);
    const visitor = touringHoursLabel(h.workspace.load(id).config);
    expect(operator).toBe("Tours run every day, 8 AM to midnight. Want to change that?");
    expect(visitor).toBe("8 AM to midnight");
    expect(operator).toContain(visitor);
    expect(visitor).not.toContain("11:59");
  });
});

describe("day menu", () => {
  it("keeps the master day picks and opens availability asks the old list missed", () => {
    expect(dayIntent("tmrw")).toEqual({ type: "SELECT_DATE", relative: "tomorrow" });
    expect(dayIntent("Fri")).toEqual({ type: "SELECT_DATE", weekday: "FRI" });
    expect(dayIntent("next Tuesday")).toEqual({ type: "SELECT_DATE", weekday: "TUE", nextWeek: true });
    expect(dayIntent("the 14th")).toEqual({ type: "UNKNOWN" });
    expect(dayIntent("Oct 1")).toEqual({ type: "SELECT_DATE", date: { year: 2026, month: 10, day: 1 } });

    const missed = [
      "can I come by Friday?",
      "is Friday a possibility?",
      "any chance Friday is open?",
      "could I swing by Friday?",
      "is Friday doable?",
      "would Friday work out?",
      "can I get in Friday?",
      "is Friday an option?",
      "Friday possible?",
      "mind if I come Friday?",
      "hoping Friday works?",
      "trying to come Friday?",
      "can Friday fit me in?",
      "is Friday still a go?",
      "Friday looking good?",
    ];
    for (const phrase of missed) {
      expect(dayIntent(phrase), phrase).toEqual({ type: "SELECT_DATE", weekday: "FRI" });
    }
    expect(dayIntent("is Friday parking free?")).toEqual({ type: "ASK_PROPERTY_QUESTION", question: "is Friday parking free?" });
    expect(dayIntent("Black Friday sale nearby?")).toEqual({ type: "ASK_PROPERTY_QUESTION", question: "Black Friday sale nearby?" });
    expect(dayIntent("is Friday busy?")).toEqual({ type: "ASK_PROPERTY_QUESTION", question: "is Friday busy?" });
  });
});

describe("day export grants", () => {
  it("keeps a cross-midnight grant on the day it was issued, not the next day", async () => {
    const h = use();
    const id = await h.publish();
    const visitor = await h.touringVisitor(id);
    const tourId = visitor.session.tourId;
    (h.visitors as unknown as { sessions: Map<string, unknown> }).sessions.clear();
    const loaded = h.workspace.loadTour(id, tourId)!;
    const issued = "2026-09-28T03:50:00.000Z";
    const usedNextDay = "2026-09-28T04:10:00.000Z";
    const openUntil = "2026-09-28T04:40:00.000Z";
    for (const grant of loaded.bundle.accessGrants) {
      grant.createdAt = issued;
      grant.validFrom = issued;
      grant.validUntil = openUntil;
    }
    for (const event of loaded.bundle.auditEvents) {
      if (event.type === "ACCESS_ALLOWED" || event.type === "ACCESS_DENIED") event.at = issued;
    }
    writeFileSync(join(loaded.folder, "tour-export.json"), JSON.stringify(loaded.bundle, null, 2) + "\n");
    const recordPath = join(loaded.folder, "record.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { ranAt: string; updatedAt: string };
    record.ranAt = issued;
    record.updatedAt = usedNextDay;
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");

    const issueDay = await h.ok("export_audit", { property: id, day: "2026-09-27" });
    const nextDay = await h.ok("export_audit", { property: id, day: "2026-09-28" });
    const onIssueDay = (issueDay.accessGrants as Array<{ tourRef: string; doorName: string }>).filter((grant) => grant.tourRef.endsWith(tourId));
    const onNextDay = (nextDay.accessGrants as Array<{ tourRef: string }>).filter((grant) => grant.tourRef.endsWith(tourId));
    const denialsNext = (nextDay.denials as Array<{ tourRef?: string }>).filter((denial) => denial.tourRef?.endsWith(tourId));
    expect(onIssueDay.length).toBeGreaterThan(0);
    expect(onNextDay).toEqual([]);
    expect(denialsNext).toEqual([]);

    const again = h.workspace.loadTour(id, tourId)!;
    const door = again.bundle.accessGrants[0]?.doorId;
    const allowed = again.bundle.auditEvents.filter((event) => event.type === "ACCESS_ALLOWED" && event.doorId === door && !event.detail.startsWith("duplicate"));
    expect(allowed.length).toBeGreaterThan(0);
    for (const event of allowed) event.at = usedNextDay;
    writeFileSync(join(again.folder, "tour-export.json"), JSON.stringify(again.bundle, null, 2) + "\n");
    const used = await h.ok("export_audit", { property: id, day: "2026-09-28" });
    const usedHere = (used.accessGrants as Array<{ tourRef: string; doorName: string }>).filter((grant) => grant.tourRef.endsWith(tourId));
    expect(usedHere).toHaveLength(1);
    expect(onIssueDay.map((grant) => grant.doorName)).toContain(usedHere[0]!.doorName);
    const issueAgain = await h.ok("export_audit", { property: id, day: "2026-09-27" });
    const stillIssued = (issueAgain.accessGrants as Array<{ tourRef: string; doorName: string }>).filter((grant) => grant.tourRef.endsWith(tourId));
    expect(stillIssued.map((grant) => grant.doorName).sort()).toEqual(onIssueDay.map((grant) => grant.doorName).sort());
  });
});

describe("restore hardening", () => {
  it("reads a rejected body only up to a limit, then cuts the connection", async () => {
    const h = installHarness({
      env: { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app", PORT: "8080" },
    });
    cleanups.push(h.cleanup);
    h.inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    h.inst.files.setPublicBaseUrl("https://demo.up.railway.app", "RAILWAY");
    const server = createSetupServer({ workspace: new PropertyWorkspace(h.root), installation: h.inst, log: () => {} });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const upload = await h.ok("begin_restore_upload");
    const total = 100 * 1024 * 1024;
    const sent = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: String(upload.handoff.path),
          method: "POST",
          headers: { "content-type": "application/json", "x-tourcore-capability": "wrong-capability" },
        },
        () => resolve(total),
      );
      req.on("error", () => resolve(written));
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let written = 0;
      const write = () => {
        while (written < total) {
          const n = Math.min(chunk.length, total - written);
          written += n;
          if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
            req.once("drain", write);
            return;
          }
        }
        req.end();
      };
      write();
      setTimeout(() => reject(new Error("rejected upload did not stop")), 20_000);
    });
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(4 * 1024 * 1024);
  }, 30_000);

  it("says the upload timed out on a second preview and when the link expires after the file arrives", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    const upload = await h.ok("begin_restore_upload");
    const uploadId = String(upload.handoff.path).split("/").pop()!;
    const path = join(h.root, "portable-handoff", `${uploadId}.json`);
    const opened = JSON.parse(readFileSync(path, "utf8")) as { expiresAt: number };
    writeFileSync(join(h.root, "portable-handoff", `${uploadId}.body`), '{"format":"tourcore-portable-backup"}\n');
    writeFileSync(path, JSON.stringify({ ...opened, bodyFile: true, bytes: 32, expiresAt: h.now() - 1 }, null, 2) + "\n");
    expect(await h.fails("preview_portable_restore", { uploadId })).toBe(TIMED_OUT);
    expect(await h.fails("preview_portable_restore", { uploadId })).toBe(TIMED_OUT);
    expect(await h.fails("import_portable_backup", { uploadId })).toBe(TIMED_OUT);

    const live = await h.ok("begin_restore_upload");
    const liveId = String(live.handoff.path).split("/").pop()!;
    expect(await h.fails("preview_portable_restore", { uploadId: liveId })).toBe(UPLOAD_FIRST);

    const older = await h.ok("begin_restore_upload");
    const olderId = String(older.handoff.path).split("/").pop()!;
    const olderPath = join(h.root, "portable-handoff", `${olderId}.json`);
    const olderRecord = JSON.parse(readFileSync(olderPath, "utf8")) as Record<string, unknown>;
    writeFileSync(olderPath, JSON.stringify({ ...olderRecord, body: '{"format":"old"}', expiresAt: h.now() - 1 }, null, 2) + "\n");
    expect(await h.fails("preview_portable_restore", { uploadId: olderId })).toBe(TIMED_OUT);
    expect(existsSync(olderPath)).toBe(true);
  });
});
