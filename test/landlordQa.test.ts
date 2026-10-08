import { afterEach, describe, expect, it } from "vitest";
import { timeOnDay } from "../src/core/timezone";
import { tourListSummary } from "../src/operator/dayToDay";
import { persistSession } from "../src/operator/services";
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
