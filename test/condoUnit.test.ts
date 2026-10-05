import { afterEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/tourCoreConfig";
import { SimulatedClock } from "../src/core/clock";
import { zonedTimeToUtc } from "../src/core/timezone";
import { createTourCore } from "../src/createTourCore";
import { MockDurinAccessAdapter } from "../src/durin/MockDurinAccessAdapter";
import { ConsoleMessenger, DemoMessagingAdapter } from "../src/messaging/Messenger";
import { unitNameOf } from "../src/operator/tours";
import { InMemoryStore } from "../src/storage/Store";
import {
  addDoor,
  addTourableSpace,
  BUILDING_ACCESS_QUESTION,
  CONDO_UNIT_QUESTION,
  createPropertySetup,
  ENTRY_INSTRUCTIONS_QUESTION,
  entryInstructionsFragment,
  runDryTour,
  setBuildingAccess,
  setEntryInstructions,
  setUnitProfile,
  SINGLE_FAMILY_SPACE_NAME,
} from "../src/setup";
import { handleVisitorText } from "../src/visitor/conversation";
import { entryReply } from "../src/visitor/entry";
import { streetAndUnit, unitLabel, visitorSubject } from "../src/visitor/identity";
import { VisitorDemoSession } from "../src/visitor/session";
import { at } from "./grokHarness";
import { basicForm, TOUR_DAY } from "./helpers";
import { installHarness, SB_KEY, SB_SECRET, type InstallHarness } from "./installHarness";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const TUNNEL = "https://brave-otter-lamp.trycloudflare.com";
function harness(): InstallHarness {
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

function condoDraft(access: "BUILDING_AND_UNIT" | "UNIT_ONLY", instructions?: string) {
  let draft = createPropertySetup({ address: "145 Main St, Hoboken, NJ 07030", propertyType: "APARTMENT_OR_CONDO" });
  draft = addTourableSpace(draft, { name: "4B" });
  draft = setBuildingAccess(draft, access);
  if (access === "BUILDING_AND_UNIT") draft = addDoor(draft, { name: "Lobby Entrance", kind: "ENTRANCE" }).draft;
  draft = setEntryInstructions(draft, instructions ? { instructions } : { skip: true });
  draft = setUnitProfile(draft, draft.units[0]!.id, { bedrooms: "2", bathrooms: "1", monthlyRent: "$2,400", availability: "now" });
  return draft;
}

async function welcomeOf(config: ReturnType<typeof condoDraft>) {
  const sent: string[] = [];
  const session = new VisitorDemoSession(config.property.id, config, "t", {
    realNow: () => at(7),
    kind: "messaging",
    transport: new DemoMessagingAdapter((line) => sent.push(line), "MESSAGING"),
  });
  await handleVisitorText(session, "+15550102000", "TOUR");
  await handleVisitorText(session, "+15550102000", "YES");
  return session.conversation.filter((item) => item.from === "tourcore").map((item) => item.text).join("\n");
}

async function bookCondo(config: ReturnType<typeof condoDraft>) {
  const clock = new SimulatedClock(zonedTimeToUtc({ ...TOUR_DAY, hour: 10, minute: 0 }, config.property.timezone));
  const durin = new MockDurinAccessAdapter({
    doorNames: Object.fromEntries(config.doors.map((d) => [d.id, d.name])),
    log: () => {},
    now: () => clock.now(),
  });
  const store = new InMemoryStore();
  const core = createTourCore(config, { clock, durin, messenger: new ConsoleMessenger(() => {}), store });
  const { prospect, reservation } = await core.startInquiry({ name: "Jane Smith", phone: "(555) 010-1234", unitId: config.units[0]!.id });
  const slot = (await core.availableSlots(TOUR_DAY))[0]!;
  await core.reserveSlot(reservation.id, slot.start.toISOString());
  await core.recordConsent(reservation.id, true);
  const ready = await core.submitVerification(reservation.id, basicForm());
  const texts = (await store.list("messages")).filter((m) => m.direction === "OUTBOUND" && m.audience === "PROSPECT").map((m) => m.body);
  return { core, prospect, ready, texts, store, clock };
}

describe("apartment or condo identity", () => {
  it("turns a unit number into street + unit, never Main Home", () => {
    expect(unitLabel("4B")).toBe("Unit 4B");
    expect(unitLabel("Unit 4B")).toBe("Unit 4B");
    expect(unitLabel("#4B")).toBe("Unit 4B");
    const property = { address: "145 Main St, Hoboken, NJ 07030", canonicalAddress: { street: "145 Main St" }, propertyType: "APARTMENT_OR_CONDO" as const };
    expect(streetAndUnit(property, "4B")).toBe("145 Main St, Unit 4B");
    expect(visitorSubject(property, "4B")).toBe("145 Main St, Unit 4B");
    expect(visitorSubject(property, "4B")).not.toContain(SINGLE_FAMILY_SPACE_NAME);
  });

  it("omits a blank entry-instructions fragment", () => {
    expect(entryInstructionsFragment(undefined)).toBeUndefined();
    expect(entryInstructionsFragment("")).toBeUndefined();
    expect(entryInstructionsFragment("   ")).toBeUndefined();
    expect(entryInstructionsFragment("Use the lobby code 1234")).toBe("Here's how to get in: Use the lobby code 1234");
  });
});

describe("apartment or condo setup", () => {
  it("offers the three setup types and then asks for the unit number", async () => {
    const h = harness();
    const created = await h.ok("create_property_setup", { address: "145 Main St, Hoboken, NJ" });
    await h.ok("update_property_details", { postalCode: "07030" });
    const confirmed = await h.ok("update_property_details", { confirmAddress: true });
    expect(confirmed.choices.map((c: { label: string }) => c.label)).toEqual([
      "Single-family home",
      "Multifamily (duplex / small building you own)",
      "Apartment or condo (one unit)",
    ]);
    const typed = await h.ok("update_property_details", { propertyType: "APARTMENT_OR_CONDO" });
    expect(typed.nextQuestion).toBe(CONDO_UNIT_QUESTION);
    expect(created.setup.propertyType).toBe("Not chosen yet");
  });

  it("builds a building-entrance + unit-door route and opens both on a practice tour", async () => {
    const draft = condoDraft("BUILDING_AND_UNIT", "Buzz 4B at the lobby desk");
    expect(validateConfig(draft)).toEqual([]);
    expect(draft.property.name).toBe("145 Main St, Unit 4B");
    expect(draft.units).toHaveLength(1);
    expect(draft.units[0]).toMatchObject({ name: "Unit 4B", entryInstructions: "Buzz 4B at the lobby desk" });
    expect(draft.routes[0]!.stops.map((s) => draft.doors.find((d) => d.id === s.doorId)?.name)).toEqual(["Lobby Entrance", "Unit 4B Door"]);
    expect(() => addTourableSpace(draft, { name: "5C" })).toThrow(/one unit/);

    const result = await runDryTour(draft, { now: zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 7, minute: 0 }, draft.property.timezone) });
    expect(result.passed).toBe(true);
    const opened = result.bundle!.accessGrants.map((g) => g.doorId);
    expect(opened).toEqual(expect.arrayContaining(draft.routes[0]!.stops.map((s) => s.doorId)));
    expect(opened).toHaveLength(2);
  });

  it("keeps a unit-door-only route when they do not control the building entrance", async () => {
    const draft = condoDraft("UNIT_ONLY");
    expect(validateConfig(draft)).toEqual([]);
    expect(draft.property.buildingAccess).toBe("UNIT_ONLY");
    expect(draft.doors.some((d) => d.kind === "ENTRANCE")).toBe(false);
    expect(draft.routes[0]!.stops.map((s) => s.doorId)).toEqual([draft.units[0]!.doorId]);
    expect(draft.units[0]!.entryInstructions).toBeUndefined();
    expect(draft.property.entryInstructionsDecided).toBe(true);

    const result = await runDryTour(draft, { now: zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 7, minute: 0 }, draft.property.timezone) });
    expect(result.passed).toBe(true);
    expect(result.bundle!.accessGrants.map((g) => g.doorId)).toEqual([draft.units[0]!.doorId]);
  });

  it("asks building-door control, then the building entrance, then optional entry instructions", async () => {
    const h = harness();
    await h.ok("create_property_setup", { address: "145 Main St, Hoboken, NJ 07030" });
    await h.ok("update_property_details", { confirmAddress: true, propertyType: "APARTMENT_OR_CONDO" });
    const added = await h.ok("add_unit", { name: "4B" });
    expect(added.unit).toMatchObject({ name: "Unit 4B", door: "Unit 4B Door" });
    expect(added.nextQuestion).toBe(BUILDING_ACCESS_QUESTION);
    const id = h.workspace.propertyIds()[0]!;
    expect(h.workspace.openDraft(id).draft.property.name).toBe("145 Main St, Unit 4B");

    const access = await h.ok("update_property_details", { buildingAccess: "BUILDING_AND_UNIT" });
    expect(access.nextQuestion).toBe("What's the building entrance called?");
    const door = await h.ok("add_door", { name: "Lobby Entrance", kind: "entrance" });
    expect(door.nextQuestion).toBe(ENTRY_INSTRUCTIONS_QUESTION);
    const afterDoor = await h.ok("get_property_setup");
    expect(afterDoor.setup.units[0].route).toBe("Lobby Entrance → Unit 4B Door");

    const skipped = await h.ok("update_property_details", { skipEntryInstructions: true });
    expect(skipped.setup.units[0].entryInstructions).toBeUndefined();
    expect(h.workspace.openDraft(skipped.setup.propertyId).draft.units[0]!.entryInstructions).toBeUndefined();

    const review = await h.ok("review_property_setup");
    expect(review.lines).toEqual(expect.arrayContaining(["Apartment or condo (one unit)", "Building entrance: you control it", "  Route: Lobby Entrance → Unit 4B Door"]));
    expect(review.lines.join("\n")).not.toMatch(/Main Home/);
    expect(review.lines.join("\n")).not.toMatch(/Entry instructions:/);
  });

  it("unit-only setup never puts a building door on the route", async () => {
    const h = harness();
    await h.ok("create_property_setup", { address: "145 Main St, Hoboken, NJ 07030", propertyType: "APARTMENT_OR_CONDO" });
    await h.ok("update_property_details", { confirmAddress: true });
    await h.ok("add_unit", { name: "4B" });
    const access = await h.ok("update_property_details", { buildingAccess: "UNIT_ONLY" });
    expect(access.nextQuestion).toBe(ENTRY_INSTRUCTIONS_QUESTION);
    await h.ok("update_property_details", { entryInstructions: "Tell the front desk you are touring 4B." });
    const { setup } = await h.ok("get_property_setup");
    expect(setup.buildingAccess).toBe("Unit door only");
    expect(setup.units[0]).toMatchObject({ route: "Unit 4B Door", entryInstructions: "Tell the front desk you are touring 4B." });
    expect(setup.doors.some((d: { kind: string }) => d.kind === "Entrance")).toBe(false);
    const review = await h.ok("review_property_setup");
    expect(review.lines).toEqual(expect.arrayContaining(["Building entrance: visitors get in on their own", "Entry instructions: Tell the front desk you are touring 4B."]));
  });
});

describe("apartment or condo visitor and landlord copy", () => {
  it("welcome uses street + unit and never sends entry instructions", async () => {
    const draft = condoDraft("UNIT_ONLY", "Code 4455 then elevator to 4");
    const welcome = await welcomeOf(draft);
    expect(welcome).toContain("Hi! Welcome to the self-guided tour for 145 Main St, Unit 4B.");
    expect(welcome).toContain("questions about the unit");
    expect(welcome).toContain("Which day works for you?");
    expect(welcome).not.toContain("Which unit");
    expect(welcome).not.toContain("Main Home");
    expect(welcome).not.toContain("Here's how to get in");
    expect(welcome).not.toContain("Code 4455");
    const menu = entryReply(draft, [{ label: "Monday" }]);
    expect(menu.body).not.toContain("Here's how to get in");
  });

  it("sends entry instructions once on the all-set text after verify, and not when skipped", async () => {
    const withCopy = condoDraft("BUILDING_AND_UNIT", "Use the lobby code 1234, then take the elevator to 4.");
    const { texts, ready } = await bookCondo(withCopy);
    expect(ready.status).toBe("READY");
    const allSet = texts.find((t) => t.startsWith("You're all set for your tour"))!;
    expect(allSet).toContain("Here's how to get in: Use the lobby code 1234, then take the elevator to 4.");
    expect(allSet).toContain("I'll open the entrance");
    expect(texts.filter((t) => t.includes("Here's how to get in"))).toHaveLength(1);
    expect(texts.find((t) => t.includes("Happy to set up"))).not.toContain("Here's how to get in");

    const skipped = condoDraft("UNIT_ONLY");
    const none = await bookCondo(skipped);
    const skippedAllSet = none.texts.find((t) => t.startsWith("You're all set for your tour"))!;
    expect(skippedAllSet).not.toContain("Here's how to get in");
    expect(skippedAllSet).toContain("I'll open the unit door");
    expect(none.texts.join("\n")).not.toContain("Here's how to get in");
  });

  it("landlord alerts name the street and unit, never Main Home", () => {
    const draft = condoDraft("UNIT_ONLY");
    const tour = { config: draft, bundle: { reservations: [{ unitId: draft.units[0]!.id }] } };
    expect(unitNameOf(tour as never)).toBe("145 Main St, Unit 4B");
    expect(unitNameOf(tour as never)).not.toContain("Main Home");
  });
});
