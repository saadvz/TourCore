import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safetyHash } from "../src/config/changeKinds";
import type { TourCoreConfig } from "../src/config/tourCoreConfig";
import { timeOnDay } from "../src/core/timezone";
import { tourListSummary } from "../src/operator/dayToDay";
import { persistSession } from "../src/operator/services";
import { setTourHours } from "../src/setup/setupActions";
import { configHash } from "../src/setup/workspace";
import { writeJsonAtomic } from "../src/storage/atomicWrite";
import { VisitorDemoSession } from "../src/visitor";
import { grokHarness, type GrokHarness } from "./grokHarness";
import { installHarness, SB_KEY, SB_SECRET, type InstallHarness } from "./installHarness";

/**
 * Landlord QA for the city dead end, next-step scope, and get_tours counts.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((run) => run()));

const TUNNEL = "https://brave-otter-lamp.trycloudflare.com";

function readyInstall(): InstallHarness {
  const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
  cleanups.push(h.cleanup);
  const now = new Date(h.now()).toISOString();
  h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
  h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
  h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at: now, message: "ok", url: TUNNEL });
  h.connectGrok();
  h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550109999" });
  h.inst.files.recordCheck("visitorMessaging", { ok: true, at: now, message: "ok", problems: [], publicBaseUrl: TUNNEL });
  h.inst.files.writeState({ ...h.inst.files.state(), storage: { mode: "LOCAL_DEMO", phase: "READY", chosenAt: now } });
  return h;
}

function use(h: GrokHarness): GrokHarness {
  cleanups.push(h.cleanup);
  return h;
}

/**
 * An older published property: no timezoneConfirmed flag. Rewrites the saved
 * file in place and keeps PUBLISHED_FOR_DEMO, so the lock has to come from
 * wasEverPublished rather than the flag.
 */
function asOlderPublished(h: GrokHarness, id: string, mutate: (property: TourCoreConfig["property"]) => void): void {
  const saved = h.workspace.load(id);
  const config = structuredClone(saved.config);
  delete config.property.timezoneConfirmed;
  mutate(config.property);
  delete config.property.timezoneConfirmed;
  const folder = join(h.root, "properties", id);
  writeJsonAtomic(join(folder, "tourcore.config.json"), config);
  const status = JSON.parse(readFileSync(join(folder, "status.json"), "utf8")) as { configHash: string; safetyHash?: string; status: string };
  status.configHash = configHash(config);
  status.safetyHash = safetyHash(config);
  writeJsonAtomic(join(folder, "status.json"), status);
  const loaded = h.workspace.load(id);
  if (loaded.state.status !== "PUBLISHED_FOR_DEMO") throw new Error(`expected the property to stay published, got ${loaded.state.status}`);
  if (loaded.config.property.timezoneConfirmed !== undefined) throw new Error("timezoneConfirmed should be absent");
}

async function browsing(h: GrokHarness, propertyId: string, name: string, phone: string) {
  const { config } = h.workspace.load(propertyId);
  const session = h.visitors.add(
    new VisitorDemoSession(propertyId, config, h.workspace.newVisitorTourId(propertyId, new Date(h.now())), { realNow: () => h.now() }),
  );
  await session.act("begin", { name, phone });
  await persistSession(h.services, session);
}

describe("address parts, one at a time", () => {
  it("walks 302 Main Street, Unit 4B through city, state, and ZIP to the read-back", async () => {
    const h = use(grokHarness());
    const created = await h.ok("create_property_setup", { address: "302 Main Street, Unit 4B" });
    expect(created.nextQuestion).toBe("What state is it in?");
    expect(JSON.stringify(created)).not.toContain("What city should I use?");
    expect(JSON.stringify(created)).not.toContain("Did I get that right");

    const city = await h.ok("update_property_details", { city: "Hackensack" });
    expect(city.nextQuestion).toBe("Got it. What state is that in?");
    expect(h.workspace.openDraft(created.setup.propertyId).draft.property.canonicalAddress).toMatchObject({
      street: "302 Main Street",
      unit: "Unit 4B",
      city: "Hackensack",
      state: "",
    });

    const state = await h.ok("update_property_details", { state: "NJ" });
    expect(state.nextQuestion).toBe("What ZIP code should I use?");
    const zip = await h.ok("update_property_details", { postalCode: "07601" });
    expect(zip.nextQuestion).toBe("Did I get that right: 302 Main Street, Unit 4B, Hackensack, NJ 07601?");
    expect(zip.nextQuestion).not.toContain("\n");
  });

  it("asks for the street when that is the missing part and keeps the state and ZIP", async () => {
    const h = use(grokHarness());
    const created = await h.ok("create_property_setup", { address: "NJ 07601" });
    expect(created.nextQuestion).toBe("What's the street address?");
    const id = created.setup.propertyId as string;
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress).toMatchObject({ state: "NJ", postalCode: "07601" });
    const street = await h.ok("update_property_details", { street: "302 Main Street" });
    expect(street.nextQuestion).toBe("What city should I use?");
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress).toMatchObject({
      street: "302 Main Street",
      state: "NJ",
      postalCode: "07601",
      city: "",
    });
  });

  it("says it did not catch a state it cannot read, and keeps the street and city", async () => {
    const h = use(grokHarness());
    const created = await h.ok("create_property_setup", { address: "302 Main Street, Hackensack" });
    const id = created.setup.propertyId as string;
    expect(await h.fails("update_property_details", { state: "Jersey" })).toBe("I didn't catch that state. Which state is it, like NJ or New Jersey?");
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress).toMatchObject({
      street: "302 Main Street",
      city: "Hackensack",
      state: "",
    });
  });

  it("still asks for the state when it is simply missing", async () => {
    const h = use(grokHarness());
    const created = await h.ok("create_property_setup", { address: "302 Main Street, Unit 4B" });
    expect(created.nextQuestion).toBe("What state is it in?");
  });

  it("asks for the city when the state is already saved", async () => {
    const h = use(grokHarness());
    const created = await h.ok("create_property_setup", { address: "302 Main Street, NJ" });
    expect(created.nextQuestion).toBe("What city should I use?");
    expect(JSON.stringify(created)).not.toContain("Did I get that right");
    expect(h.workspace.openDraft(created.setup.propertyId).draft.property.canonicalAddress).toMatchObject({
      street: "302 Main Street",
      city: "",
      state: "NJ",
    });
  });

  it("keeps a city given first and asks for the state", async () => {
    const h = use(grokHarness());
    const created = await h.ok("create_property_setup", { address: "302 Main Street, Hackensack" });
    expect(created.nextQuestion).toBe("What state is it in?");
    expect(JSON.stringify(created)).not.toContain("What city should I use?");
    expect(h.workspace.openDraft(created.setup.propertyId).draft.property.canonicalAddress).toMatchObject({
      street: "302 Main Street",
      city: "Hackensack",
      state: "",
    });
    const saved = await h.ok("save_property", { property: created.setup.propertyId, city: "Hackensack" });
    expect(saved.message).toBe("Got it. What state is that in?");
    expect(h.workspace.openDraft(created.setup.propertyId).draft.property.canonicalAddress?.city).toBe("Hackensack");
  });
});

describe("street suffix stays on the street", () => {
  it("reads 144 Hillside Avenue back in full after the city, state, and ZIP", async () => {
    const h = use(grokHarness());
    const created = await h.ok("create_property_setup", { address: "144 Hillside Avenue" });
    const id = created.setup.propertyId as string;
    expect(created.setup.name).toBe("144 Hillside Avenue");
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress).toMatchObject({
      street: "144 Hillside Avenue",
      city: "",
      state: "",
    });

    const city = await h.ok("update_property_details", { city: "Tenafly" });
    expect(city.nextQuestion).toBe("Got it. What state is that in?");
    const state = await h.ok("update_property_details", { state: "NJ" });
    expect(state.nextQuestion).toBe("What ZIP code should I use?");
    const zip = await h.ok("update_property_details", { postalCode: "07670" });
    expect(zip.nextQuestion).toBe("Did I get that right: 144 Hillside Avenue, Tenafly, NJ 07670?");
    expect(zip.setup.name).toBe("144 Hillside Avenue");
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress).toMatchObject({
      street: "144 Hillside Avenue",
      city: "Tenafly",
      state: "NJ",
      postalCode: "07670",
    });
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/New_York");
    expect(JSON.stringify(zip)).not.toMatch(/UTC|GMT\+00/);
  });

  it("reads a one-line address with no commas back with the street and the city apart", async () => {
    const h = use(grokHarness());
    const created = await h.ok("create_property_setup", { address: "144 Hillside Avenue Tenafly NJ 07670" });
    expect(created.nextQuestion).toBe("Did I get that right: 144 Hillside Avenue, Tenafly, NJ 07670?");
    expect(created.setup.name).toBe("144 Hillside Avenue");
    expect(h.workspace.openDraft(created.setup.propertyId).draft.property.canonicalAddress).toMatchObject({
      street: "144 Hillside Avenue",
      city: "Tenafly",
      state: "NJ",
      postalCode: "07670",
    });
  });

  it("keeps comma addresses and a comma-less city", async () => {
    const h = use(grokHarness());
    const comma = await h.ok("create_property_setup", { address: "146 Hillside Avenue, Tenafly, NJ 07670" });
    expect(comma.nextQuestion).toBe("Did I get that right: 146 Hillside Avenue, Tenafly, NJ 07670?");
    const main = await h.ok("create_property_setup", { address: "302 Main Street, Hackensack, NJ 07601" });
    expect(main.nextQuestion).toBe("Did I get that right: 302 Main Street, Hackensack, NJ 07601?");
    const oneLine = await h.ok("create_property_setup", { address: "Main St Hackensack NJ 07601" });
    expect(oneLine.nextQuestion).toBe("Did I get that right: Main Street, Hackensack, NJ 07601?");
    expect(oneLine.setup.name).toBe("Main Street");
  });
});

describe("guessed time zone follows the state", () => {
  it("replaces a computer guess when the state is saved later", async () => {
    const h = use(grokHarness());
    const created = await h.ok("create_property_setup", { address: "144 Hillside Avenue" });
    const id = created.setup.propertyId as string;
    await h.ok("update_property_details", { state: "NJ" });
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/New_York");
    expect(h.workspace.openDraft(id).draft.property.timezoneConfirmed).toBeUndefined();
    const zip = await h.ok("update_property_details", { city: "Tenafly", postalCode: "07670" });
    expect(zip.nextQuestion).toBe("Did I get that right: 144 Hillside Avenue, Tenafly, NJ 07670?");
    expect(JSON.stringify(zip)).not.toMatch(/UTC|GMT\+00/);
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/New_York");
  });

  it("re-guesses when the state changes", async () => {
    const h = use(grokHarness());
    const created = await h.ok("create_property_setup", { address: "144 Hillside Avenue, Tenafly, NJ 07670" });
    const id = created.setup.propertyId as string;
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/New_York");
    await h.ok("update_property_details", { state: "CA" });
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/Los_Angeles");
  });

  it("does not replace a time zone the operator set", async () => {
    const h = use(grokHarness());
    const created = await h.ok("create_property_setup", { address: "144 Hillside Avenue", timezone: "America/Chicago" });
    const id = created.setup.propertyId as string;
    expect(h.workspace.openDraft(id).draft.property.timezoneConfirmed).toBe(true);
    await h.ok("update_property_details", { city: "Tenafly" });
    await h.ok("update_property_details", { state: "NJ" });
    const zip = await h.ok("update_property_details", { postalCode: "07670" });
    expect(zip.nextQuestion).toBe("Did I get that right: 144 Hillside Avenue, Tenafly, NJ 07670?");
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/Chicago");
    await h.ok("update_property_details", { state: "CA", timezone: "America/Denver" });
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/Denver");
  });
});

describe("a published property keeps its time zone", () => {
  async function published(mutate: (property: TourCoreConfig["property"]) => void) {
    const h = use(grokHarness());
    const id = await h.publish();
    asOlderPublished(h, id, mutate);
    expect(h.workspace.wasEverPublished(id)).toBe(true);
    return { h, id };
  }

  it("keeps Chicago when a state is saved onto a property that had none", async () => {
    const { h, id } = await published((property) => {
      property.timezone = "America/Chicago";
      property.address = "100 Alfred Way, Brooklyn";
      property.addressConfirmed = false;
      property.canonicalAddress = { ...property.canonicalAddress!, state: "", formatted: "100 Alfred Way, Brooklyn" };
    });
    await h.ok("update_property_details", { property: id, state: "NY" });
    const saved = h.workspace.openDraft(id).draft.property;
    expect(saved.timezone).toBe("America/Chicago");
    expect(saved.timezoneConfirmed).toBeUndefined();
  });

  it("keeps Chicago when the address is re-entered with a state", async () => {
    const { h, id } = await published((property) => {
      property.timezone = "America/Chicago";
      property.address = "100 Alfred Way, Brooklyn";
      property.addressConfirmed = false;
      property.canonicalAddress = { ...property.canonicalAddress!, state: "", formatted: "100 Alfred Way, Brooklyn" };
    });
    await h.ok("update_property_details", { property: id, address: "100 Alfred Way, Brooklyn, NY" });
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/Chicago");
  });

  it("keeps Chicago when a ZIP is saved and the property has no canonical address", async () => {
    const { h, id } = await published((property) => {
      property.timezone = "America/Chicago";
      property.address = "100 Alfred Way, Brooklyn, NY";
      property.addressConfirmed = false;
      delete property.canonicalAddress;
    });
    await h.ok("update_property_details", { property: id, postalCode: "11201" });
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/Chicago");
  });

  it("keeps Chicago when the state changes from NJ to CA", async () => {
    const { h, id } = await published((property) => {
      property.timezone = "America/Chicago";
      property.address = "100 Alfred Way, Brooklyn, NJ";
      property.addressConfirmed = false;
      property.canonicalAddress = { ...property.canonicalAddress!, state: "NJ", formatted: "100 Alfred Way, Brooklyn, NJ" };
    });
    await h.ok("update_property_details", { property: id, state: "CA" });
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/Chicago");
  });
});

describe("time zone lock and the switch question", () => {
  it("keeps re-guessing on a never-published setup until the address is confirmed", async () => {
    const h = use(grokHarness());
    const created = await h.ok("create_property_setup", { address: "144 Hillside Avenue, Tenafly, NJ 07670" });
    const id = created.setup.propertyId as string;
    const moved = await h.ok("update_property_details", { state: "CA" });
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/Los_Angeles");
    expect(moved.summary).not.toContain("Tours still run");
    expect(moved.summary).not.toContain("Should I switch");

    const again = await h.ok("create_property_setup", { address: "146 Hillside Avenue, Tenafly, NJ 07670" });
    const confirmedId = again.setup.propertyId as string;
    await h.ok("update_property_details", { property: confirmedId, confirmAddress: true });
    expect(h.workspace.openDraft(confirmedId).draft.property.timezoneConfirmed).toBe(true);
    const after = await h.ok("update_property_details", { property: confirmedId, state: "CA" });
    expect(h.workspace.openDraft(confirmedId).draft.property.timezone).toBe("America/New_York");
    expect(after.summary).toContain("Tours still run on Eastern time. Should I switch to Pacific time?");
  });

  it("asks before switching a published Eastern property from NJ to CA", async () => {
    const h = use(grokHarness());
    const id = await h.publish();
    asOlderPublished(h, id, (property) => {
      property.timezone = "America/New_York";
      property.address = "100 Alfred Way, Brooklyn, NJ";
      property.addressConfirmed = false;
      property.canonicalAddress = { ...property.canonicalAddress!, state: "NJ", formatted: "100 Alfred Way, Brooklyn, NJ" };
    });
    const changed = await h.ok("update_property_details", { property: id, state: "CA" });
    expect(changed.summary).toBe("Updated 100 Alfred Way. All changes saved. Tours still run on Eastern time. Should I switch to Pacific time?");
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/New_York");
    expect(JSON.stringify(changed)).not.toContain("America/Los_Angeles");
  });

  it("adds no line when a published Eastern property changes from NJ to NY", async () => {
    const h = use(grokHarness());
    const id = await h.publish();
    asOlderPublished(h, id, (property) => {
      property.timezone = "America/New_York";
      property.address = "100 Alfred Way, Brooklyn, NJ";
      property.addressConfirmed = false;
      property.canonicalAddress = { ...property.canonicalAddress!, state: "NJ", formatted: "100 Alfred Way, Brooklyn, NJ" };
    });
    const changed = await h.ok("update_property_details", { property: id, state: "NY" });
    expect(changed.summary).toBe("Updated 100 Alfred Way. All changes saved.");
    expect(changed.summary).not.toContain("Tours still run");
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("America/New_York");
  });
});

describe("next step stays on the property the call was about", () => {
  it("does not return another property's condo read-back", async () => {
    const h = readyInstall();
    const hillside = await h.publish();
    await h.touringVisitor(hillside, { name: "Pat Smith" });
    const listed = await h.ok("get_tours", { property: hillside });
    const tourRef = listed.active[0].tourRef as string;

    const condo = await h.ok("create_property_setup", { address: "300 Main Street, Unit 4B, Hackensack, NJ 07601" });
    const readBack = "Did I get that right: 300 Main Street, Unit 4B, Hackensack, NJ 07601?";
    expect(condo.nextQuestion).toBe(readBack);
    const install = await h.ok("get_state", {});
    expect(install.nextStep.say).toBe(readBack);

    const asked = await h.ok("cancel_tour", { tourRef, reason: "They asked to stop" });
    expect(JSON.stringify(asked)).not.toContain("300 Main Street");
    expect(JSON.stringify(asked)).not.toContain("Did I get that right");
    const aboutHillside = await h.ok("get_state", { propertyId: hillside });
    expect(JSON.stringify(aboutHillside)).not.toContain("300 Main Street");
  });

  it("does not return a draft property's hours step when a published tour is called off", async () => {
    const h = readyInstall();
    const published = await h.publish();
    await h.touringVisitor(published, { name: "Pat Smith" });
    const listed = await h.ok("get_tours", { property: published });
    const tourRef = listed.active[0].tourRef as string;

    const created = await h.ok("create_property_setup", {
      address: "16 Oak Avenue, Teaneck, NJ 07666",
      propertyType: "MULTIFAMILY_HOME",
    });
    const draftId = created.setup.propertyId as string;
    await h.ok("update_property_details", { property: draftId, confirmAddress: true, skipVisitorHelp: true });
    await h.ok("add_unit", { property: draftId, name: "Unit A" });
    await h.ok("add_unit", { property: draftId, name: "Unit B" });
    await h.ok("set_unit_details", {
      property: draftId,
      details: "Unit A is 2 bed 1 bath for $2,200, available now. Unit B is 1 bed 1 bath for $1,950, available now.",
    });
    await h.ok("add_door", { property: draftId, name: "Front Door", kind: "entrance" });
    await h.ok("set_route", { property: draftId, unit: "Unit A", doors: ["Front Door", "Unit A Door"] });
    await h.ok("set_route", { property: draftId, unit: "Unit B", doors: ["Front Door", "Unit B Door"] });
    h.workspace.saveDraft(
      setTourHours(h.workspace.openDraft(draftId).draft, {
        days: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
        start: "08:00",
        end: "23:59",
      }),
    );
    const draftState = await h.ok("get_state", { propertyId: draftId });
    const draftHours = "Tours run every day, 8 AM to 11:59 PM. Want to change that?";
    expect(draftState.nextStep).toMatchObject({ tool: "save_hours", say: draftHours });

    const asked = await h.ok("cancel_tour", { tourRef, reason: "They asked to stop" });
    const done = await h.ok("cancel_tour", { tourRef, reason: "They asked to stop", confirmationCode: asked.confirmation.code });
    for (const result of [asked, done]) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(draftHours);
      expect(text).not.toContain("11:59");
      expect(text).not.toContain("16 Oak Avenue");
      expect(result.nextStep?.tool).not.toBe("save_hours");
    }
  });
});

describe("get_tours counts bookings, not open texts", () => {
  it("counts one future booking and ignores four browsing conversations", async () => {
    const h = use(grokHarness());
    const propertyId = await h.publish();
    for (const [name, phone] of [
      ["Ada Fox", "5550102101"],
      ["Bea Fox", "5550102102"],
      ["Cam Fox", "5550102103"],
      ["Dee Fox", "5550102104"],
    ] as const) {
      await browsing(h, propertyId, name, phone);
    }
    const visitor = await h.visitor(propertyId, { name: "Pat Smith", phone: "5550102199" });
    const start = visitor.slot();
    await visitor.act("chooseTime", { slotStart: start.toISOString() });
    const listed = await h.ok("get_tours", { property: propertyId });
    expect(listed.summary).toBe(`1 tour coming up: Pat Smith at ${timeOnDay(start, "America/New_York")}.`);
    expect(listed.active).toEqual([]);
    expect(listed.upcoming).toHaveLength(1);
  });

  it("counts a tour in progress as happening now", async () => {
    const h = use(grokHarness());
    const propertyId = await h.publish();
    await h.touringVisitor(propertyId, { name: "Pat Smith" });
    const listed = await h.ok("get_tours", { property: propertyId });
    expect(listed.summary).toBe("1 tour happening now: Pat Smith.");
    expect(listed.active).toHaveLength(1);
    expect(listed.upcoming).toEqual([]);
  });

  it("lists two later bookings as coming up", async () => {
    const h = use(grokHarness());
    const propertyId = await h.publish();
    const first = await h.visitor(propertyId, { name: "Pat Smith", phone: "5550102201" });
    const firstStart = first.slot();
    await first.act("chooseTime", { slotStart: firstStart.toISOString() });
    const second = await h.visitor(propertyId, { name: "Sam Lee", phone: "5550102202" });
    const secondStart = second.session.offeredSlots.find((slot) => slot.start.getTime() !== firstStart.getTime())?.start;
    expect(secondStart).toBeTruthy();
    await second.act("chooseTime", { slotStart: secondStart!.toISOString() });
    const listed = await h.ok("get_tours", { property: propertyId });
    const lines = [firstStart, secondStart!].sort((a, b) => a.getTime() - b.getTime()).map((start) => {
      const name = start.getTime() === firstStart.getTime() ? "Pat Smith" : "Sam Lee";
      return `${name} at ${timeOnDay(start, "America/New_York")}`;
    });
    expect(listed.summary).toBe(`2 tours coming up: ${lines[0]} and ${lines[1]}.`);
    expect(listed.active).toEqual([]);
    expect(listed.upcoming).toHaveLength(2);
  });

  it("reads zero tours as none right now", async () => {
    const h = use(grokHarness());
    const propertyId = await h.publish();
    const listed = await h.ok("get_tours", { property: propertyId });
    expect(listed.summary).toBe("No tours right now.");
    expect(listed.active).toEqual([]);
    expect(listed.upcoming).toEqual([]);
  });

  it("joins more than one coming-up tour", () => {
    expect(tourListSummary([], ["Pat Smith at 9:00 AM on Monday, Sep 28", "Sam Lee at 10:00 AM on Monday, Sep 28"])).toBe(
      "2 tours coming up: Pat Smith at 9:00 AM on Monday, Sep 28 and Sam Lee at 10:00 AM on Monday, Sep 28.",
    );
    expect(tourListSummary(["Pat Smith", "Sam Lee"], [])).toBe("2 tours happening now: Pat Smith and Sam Lee.");
    expect(tourListSummary(["Pat Smith"], ["Sam Lee at 10:00 AM on Monday, Sep 28"])).toBe(
      "1 tour happening now: Pat Smith. 1 tour coming up: Sam Lee at 10:00 AM on Monday, Sep 28.",
    );
  });
});
