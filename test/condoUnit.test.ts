import { afterEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/tourCoreConfig";
import { SimulatedClock } from "../src/core/clock";
import { zonedTimeToUtc } from "../src/core/timezone";
import { createTourCore } from "../src/createTourCore";
import { MockDurinAccessAdapter } from "../src/durin/MockDurinAccessAdapter";
import { ConsoleMessenger, DemoMessagingAdapter } from "../src/messaging/Messenger";
import { formatPhone } from "../src/core/phone";
import { who } from "../src/operator/tourTimes";
import { midSentence, unitNameOf } from "../src/operator/tours";
import { InMemoryStore } from "../src/storage/Store";
import {
  addDoor,
  addTourableSpace,
  BUILDING_ACCESS_QUESTION,
  CONDO_UNIT_QUESTION,
  createPropertySetup,
  ENTRY_INSTRUCTIONS_QUESTION,
  entryInstructionsFragment,
  renameUnit,
  runDryTour,
  setBuildingAccess,
  setEntryInstructions,
  setUnitProfile,
  SINGLE_FAMILY_SPACE_NAME,
} from "../src/setup";
import { handleVisitorText } from "../src/visitor/conversation";
import { entryReply } from "../src/visitor/entry";
import { UNNAMED_VISITOR } from "../src/domain/model";
import { streetAndUnit, unitLabel, visitorPlace, visitorSubject, visitorTourOf } from "../src/visitor/identity";
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

async function bookCondo(config: ReturnType<typeof condoDraft>, visitor = { name: "Jane Smith", phone: "(555) 010-1234" }) {
  const clock = new SimulatedClock(zonedTimeToUtc({ ...TOUR_DAY, hour: 10, minute: 0 }, config.property.timezone));
  const durin = new MockDurinAccessAdapter({
    doorNames: Object.fromEntries(config.doors.map((d) => [d.id, d.name])),
    log: () => {},
    now: () => clock.now(),
  });
  const store = new InMemoryStore();
  const core = createTourCore(config, { clock, durin, messenger: new ConsoleMessenger(() => {}), store });
  const { prospect, reservation } = await core.startInquiry({ ...visitor, unitId: config.units[0]!.id });
  const slot = (await core.availableSlots(TOUR_DAY))[0]!;
  await core.reserveSlot(reservation.id, slot.start.toISOString());
  const consented = await core.recordConsent(reservation.id, true);
  const ready = consented.status === "READY" ? consented : await core.submitVerification(consented.id, basicForm(visitor.phone));
  const texts = (await store.list("messages")).filter((m) => m.direction === "OUTBOUND" && m.audience === "PROSPECT").map((m) => m.body);
  const outbound = async () =>
    (await store.list("messages")).filter((m) => m.direction === "OUTBOUND" && m.audience === "PROSPECT").map((m) => m.body);
  const request = (doorId: string) => core.requestAccess({ reservationId: ready.id, prospectId: prospect.id, doorId });
  return { core, prospect, ready, texts, store, clock, request, outbound };
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

  it("uppercases short unit codes and title-cases spelled names", () => {
    expect(unitLabel("4b")).toBe("Unit 4B");
    expect(unitLabel("unit 4b")).toBe("Unit 4B");
    expect(unitLabel("12c")).toBe("Unit 12C");
    expect(unitLabel("ph")).toBe("Unit PH");
    expect(unitLabel("PH")).toBe("Unit PH");
    expect(unitLabel("apt 12c")).toBe("Unit 12C");
    expect(unitLabel("Garden")).toBe("Unit Garden");
    expect(unitLabel("garden")).toBe("Unit Garden");
    expect(unitLabel("unit garden")).toBe("Unit Garden");
    expect(unitLabel("GARDEN")).toBe("Unit Garden");
    expect(unitLabel("Garden")).not.toBe("Unit GARDEN");
    expect(unitLabel("Loft")).toBe("Unit Loft");
    expect(unitLabel("loft")).toBe("Unit Loft");
    expect(unitLabel("LOFT")).toBe("Unit Loft");
    expect(unitLabel("Rear")).toBe("Unit Rear");
    expect(unitLabel("rear")).toBe("Unit Rear");
    expect(unitLabel("Top")).toBe("Unit Top");
    expect(unitLabel("top")).toBe("Unit Top");
    expect(unitLabel("Loft")).not.toBe("Unit LOFT");
    expect(unitLabel("PH")).toBe("Unit PH");
    const property = { address: "145 Main St, Hoboken, NJ 07030", canonicalAddress: { street: "145 Main St" }, propertyType: "APARTMENT_OR_CONDO" as const };
    expect(streetAndUnit(property, "4b")).toBe("145 Main St, Unit 4B");
    expect(streetAndUnit(property, "garden")).toBe("145 Main St, Unit Garden");
    expect(visitorSubject({ ...property, propertyType: "SINGLE_FAMILY" }, "Main Home")).not.toMatch(/Unit /);
    const coded = addTourableSpace(createPropertySetup({ address: "145 Main St, Hoboken, NJ 07030", propertyType: "APARTMENT_OR_CONDO" }), { name: "4b" });
    expect(coded.units[0]!.name).toBe("Unit 4B");
    expect(coded.property.name).toBe("145 Main Street, Unit 4B");
    const named = addTourableSpace(createPropertySetup({ address: "145 Main St, Hoboken, NJ 07030", propertyType: "APARTMENT_OR_CONDO" }), { name: "garden" });
    expect(named.units[0]!.name).toBe("Unit Garden");
    expect(named.property.name).toBe("145 Main Street, Unit Garden");
  });

  it("applies the same casing when renaming a unit and refreshes the door and nickname", () => {
    let draft = addTourableSpace(createPropertySetup({ address: "145 Main St, Hoboken, NJ 07030", propertyType: "APARTMENT_OR_CONDO" }), { name: "Garden" });
    expect(draft.units[0]!.name).toBe("Unit Garden");
    expect(draft.doors.find((d) => d.id === draft.units[0]!.doorId)?.name).toBe("Unit Garden Door");
    expect(draft.property.name).toBe("145 Main Street, Unit Garden");

    draft = renameUnit(draft, draft.units[0]!.id, "loft");
    expect(draft.units[0]!.name).toBe("Unit Loft");
    expect(draft.doors.find((d) => d.id === draft.units[0]!.doorId)?.name).toBe("Unit Loft Door");
    expect(draft.property.name).toBe("145 Main Street, Unit Loft");
    expect(draft.units[0]!.name).not.toBe("loft");
    expect(draft.doors.some((d) => d.name === "loft Door")).toBe(false);

    draft = renameUnit(draft, draft.units[0]!.id, "4b");
    expect(draft.units[0]!.name).toBe("Unit 4B");
    expect(draft.doors.find((d) => d.id === draft.units[0]!.doorId)?.name).toBe("Unit 4B Door");
    expect(draft.property.name).toBe("145 Main Street, Unit 4B");
  });

  it("does not treat a street line stored as the name as a public building name", () => {
    const scratch = {
      address: "1 QA Scratch Lane, Tenafly, NJ 07670",
      displayName: "1 QA Scratch Lane",
      name: "1 QA Scratch Lane",
      propertyType: "SINGLE_FAMILY" as const,
      canonicalAddress: { street: "1 QA Scratch Lane" },
    };
    expect(visitorPlace(scratch).publicName).toBeUndefined();
    expect(visitorTourOf(scratch)).toBe("1 QA Scratch Lane");
    expect(visitorTourOf(scratch)).not.toMatch(/ at /);
    expect(visitorSubject(scratch, "Main Home")).toBe("1 QA Scratch Lane");
    const home = {
      address: "144 Hillside Ave, Teaneck, NJ 07666",
      displayName: "Teaneck Home",
      propertyType: "SINGLE_FAMILY" as const,
      canonicalAddress: { street: "144 Hillside Ave" },
    };
    expect(visitorTourOf(home)).toBe("Teaneck Home at 144 Hillside Ave, Teaneck, NJ 07666");
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
    expect(draft.property.name).toBe("145 Main Street, Unit 4B");
    expect(draft.units).toHaveLength(1);
    expect(draft.units[0]).toMatchObject({ name: "Unit 4B", entryInstructions: "Buzz 4B at the lobby desk" });
    expect(draft.routes[0]!.stops.map((s) => draft.doors.find((d) => d.id === s.doorId)?.name)).toEqual(["Lobby Entrance", "Unit 4B Door"]);
    expect(() => addTourableSpace(draft, { name: "5C" })).toThrow(/one unit/);

    const result = await runDryTour(draft, { now: zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 7, minute: 0 }, draft.property.timezone) });
    expect(result.passed).toBe(true);
    expect(result.checks.find((c) => c.id === "entrance")).toMatchObject({ ok: true, label: "Visitor arrives on time", outcome: "Entrance access approved" });
    expect(result.checks.map((c) => c.id)).toContain("unit_door");
    const opened = [...new Set(result.bundle!.accessGrants.map((g) => g.doorId))];
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
    expect([...new Set(result.bundle!.accessGrants.map((g) => g.doorId))]).toEqual([draft.units[0]!.doorId]);
    expect(result.checks.map((c) => c.id)).not.toContain("entrance");
    expect(result.checks.find((c) => c.id === "unit_door")).toMatchObject({ ok: true, label: "Visitor enters Unit 4B" });
  });

  it("keeps the entrance proof on a single-family home whose unit door is the front entrance", async () => {
    let draft = createPropertySetup({ address: "1 QA Scratch Lane, Tenafly, NJ 07670", propertyType: "SINGLE_FAMILY" });
    draft = addTourableSpace(draft, { name: "QA Scratch Home" });
    draft = setUnitProfile(draft, draft.units[0]!.id, { bedrooms: "3", bathrooms: "2", monthlyRent: "$4,200", availability: "now" });
    expect(validateConfig(draft)).toEqual([]);
    expect(draft.units[0]).toMatchObject({ name: "QA Scratch Home", doorId: draft.doors.find((d) => d.kind === "ENTRANCE")!.id });
    expect(draft.routes[0]!.stops.map((s) => s.doorId)).toEqual([draft.units[0]!.doorId]);

    const result = await runDryTour(draft, { now: zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 7, minute: 0 }, draft.property.timezone) });
    expect(result.passed).toBe(true);
    expect(result.checks.find((c) => c.id === "entrance")).toMatchObject({ ok: true, label: "Visitor arrives on time", outcome: "Entrance access approved" });
    expect(result.checks.map((c) => c.id)).not.toContain("unit_door");
    expect(result.checks.some((c) => c.label.includes("QA Scratch Home"))).toBe(false);
  });

  it("asks building-door control, then the building entrance, then optional entry instructions", async () => {
    const h = harness();
    await h.ok("create_property_setup", { address: "145 Main St, Hoboken, NJ 07030" });
    await h.ok("update_property_details", { confirmAddress: true, propertyType: "APARTMENT_OR_CONDO" });
    const added = await h.ok("add_unit", { name: "4B" });
    expect(added.unit).toMatchObject({ name: "Unit 4B", door: "Unit 4B Door" });
    expect(added.nextQuestion).toBe(BUILDING_ACCESS_QUESTION);
    const id = h.workspace.propertyIds()[0]!;
    expect(h.workspace.openDraft(id).draft.property.name).toBe("145 Main Street, Unit 4B");

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
    expect(review.lines).toEqual(expect.arrayContaining(["Apartment or condo (one unit)", "Unit 4B", "Building entrance: you control it", "  Route: Lobby Entrance → Unit 4B Door"]));
    expect(review.lines.join("\n")).not.toMatch(/Main Home/);
    expect(review.lines.join("\n")).not.toMatch(/Entry instructions:/);
  });

  it("update_unit cases a condo rename and refreshes the door and nickname", async () => {
    const h = harness();
    await h.ok("create_property_setup", { address: "145 Main St, Hoboken, NJ 07030", propertyType: "APARTMENT_OR_CONDO" });
    await h.ok("update_property_details", { confirmAddress: true });
    await h.ok("add_unit", { name: "Garden" });
    const renamed = await h.ok("update_unit", { unit: "Unit Garden", newName: "loft", alsoRenameDoor: true });
    expect(renamed.summary).toBe("Updated Unit Loft.");
    expect(renamed.summary).not.toMatch(/Updated loft\./i);
    expect(renamed.unit).toMatchObject({ name: "Unit Loft", door: "Unit Loft Door" });
    const id = h.workspace.propertyIds()[0]!;
    expect(h.workspace.openDraft(id).draft.property.name).toBe("145 Main Street, Unit Loft");
    expect(h.workspace.openDraft(id).draft.units[0]!.name).toBe("Unit Loft");

    const recased = await h.ok("update_unit", { unit: "Unit Loft", newName: "4b" });
    expect(recased.summary).toBe("Updated Unit 4B.");
    expect(recased.summary).not.toMatch(/Updated 4b\./i);
    expect(recased.unit).toMatchObject({ name: "Unit 4B" });
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

    await h.ok("set_unit_details", { details: "4B is 2 bed 1 bath for $2,400, available now." });
    await h.ok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
    const practice = await h.ok("run_dry_tour");
    expect(practice.passed).toBe(true);
    expect(practice.proofPoints.join("\n")).toContain("Unit 4B access was allowed");
    expect(practice.proofPoints.join("\n")).not.toContain("Entrance access was allowed");
  });

  it("single-family practice tour keeps the entrance proof line, not the unit-door wording", async () => {
    const h = harness();
    await h.ok("create_property_setup", { address: "1 QA Scratch Lane, Tenafly, NJ 07670", propertyType: "SINGLE_FAMILY" });
    await h.ok("update_property_details", { confirmAddress: true });
    await h.ok("add_unit", { name: "QA Scratch Home" });
    await h.ok("set_unit_details", { units: [{ unit: "QA Scratch Home", bedrooms: "3", bathrooms: "2", monthlyRent: "$4,200", availability: "now" }] });
    await h.ok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
    const practice = await h.ok("run_dry_tour");
    expect(practice.passed).toBe(true);
    expect(practice.proofPoints).toContain("\u2713 Entrance access was allowed at the right time");
    expect(practice.proofPoints.join("\n")).not.toContain("QA Scratch Home access was allowed");
  });
});

describe("apartment or condo visitor and landlord copy", () => {
  it("welcome uses street + unit and never sends entry instructions", async () => {
    const draft = condoDraft("UNIT_ONLY", "Code 4455 then elevator to 4");
    const welcome = await welcomeOf(draft);
    expect(welcome).toContain("Hi! Welcome to the self-guided tour for 145 Main Street, Unit 4B.");
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
    const allSet = texts.find((t) => t.startsWith("You're all set for your"))!;
    expect(allSet).toContain("Here's how to get in: Use the lobby code 1234, then take the elevator to 4.");
    expect(allSet).toContain("I'll open the entrance");
    expect(texts.filter((t) => t.includes("Here's how to get in"))).toHaveLength(1);
    expect(texts.find((t) => t.includes("Happy to set up"))).not.toContain("Here's how to get in");

    const skipped = condoDraft("UNIT_ONLY");
    const none = await bookCondo(skipped);
    const skippedAllSet = none.texts.find((t) => t.startsWith("You're all set for your"))!;
    expect(skippedAllSet).not.toContain("Here's how to get in");
    expect(skippedAllSet).toContain("I'll open the unit door");
    expect(none.texts.join("\n")).not.toContain("Here's how to get in");
  });

  it("repeats entry instructions only when the building entrance opens, not on a unit-only first door", async () => {
    const both = condoDraft("BUILDING_AND_UNIT", "Use the lobby code 1234");
    const booked = await bookCondo(both);
    expect(booked.texts.find((t) => t.startsWith("You're all set"))).toContain("Here's how to get in: Use the lobby code 1234");
    booked.clock.set(new Date(booked.ready.slotStart!));
    await booked.request(both.routes[0]!.stops[0]!.doorId);
    const afterEntrance = await booked.outbound();
    const entranceOpen = afterEntrance.find((t) => t.includes("is open for you now"));
    expect(entranceOpen).toContain("Here's how to get in: Use the lobby code 1234");
    await booked.request(both.units[0]!.doorId);
    const afterUnit = await booked.outbound();
    const unitOpen = afterUnit.filter((t) => t.includes("is open for you now")).at(-1);
    expect(unitOpen).not.toContain("Here's how to get in");

    const only = condoDraft("UNIT_ONLY", "Tell the front desk you are touring 4B.");
    const unitOnly = await bookCondo(only);
    expect(unitOnly.texts.find((t) => t.startsWith("You're all set"))).toContain("Here's how to get in: Tell the front desk you are touring 4B.");
    unitOnly.clock.set(new Date(unitOnly.ready.slotStart!));
    await unitOnly.request(only.units[0]!.doorId);
    const opened = (await unitOnly.outbound()).find((t) => t.includes("is open for you now"));
    expect(opened).toBeDefined();
    expect(opened).not.toContain("Here's how to get in");
  });

  it("mid-tour copy says at Unit 4B, never the street-plus-unit nickname", async () => {
    const draft = condoDraft("BUILDING_AND_UNIT");
    const booked = await bookCondo(draft);
    expect(booked.core.stopName(draft.units[0]!.doorId)).toBe("Unit 4B");
    expect(booked.core.stopName(draft.units[0]!.doorId)).not.toContain("145 Main St");
    booked.clock.set(new Date(booked.ready.slotStart!));
    await booked.request(draft.routes[0]!.stops[0]!.doorId);
    const afterEntrance = (await booked.outbound()).join("\n");
    expect(afterEntrance).toContain('Text "at Unit 4B" when you get there.');
    expect(afterEntrance).not.toContain("at 145 Main St, Unit 4B");
    expect(afterEntrance).not.toContain("Main Home");
  });

  it("single-family mid-tour copy uses the door name, never Main Home", () => {
    let draft = createPropertySetup({ address: "12 Oak St, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    draft = addTourableSpace(draft, {});
    const clock = new SimulatedClock(zonedTimeToUtc({ ...TOUR_DAY, hour: 10, minute: 0 }, draft.property.timezone));
    const core = createTourCore(draft, {
      clock,
      durin: new MockDurinAccessAdapter({ doorNames: Object.fromEntries(draft.doors.map((d) => [d.id, d.name])), log: () => {}, now: () => clock.now() }),
      messenger: new ConsoleMessenger(() => {}),
      store: new InMemoryStore(),
    });
    const doorId = draft.units[0]!.doorId;
    expect(core.stopName(doorId)).toBe("the front door");
    expect(core.stopName(doorId)).not.toContain("Main Home");
    expect(core.stopName(doorId)).not.toBe("12 Oak St");
  });

  it("landlord alerts name the street and unit, never Main Home", () => {
    const draft = condoDraft("UNIT_ONLY");
    const tour = { config: draft, bundle: { reservations: [{ unitId: draft.units[0]!.id }] } };
    expect(unitNameOf(tour as never)).toBe("145 Main Street, Unit 4B");
    expect(unitNameOf(tour as never)).not.toContain("Main Home");
  });

  it("single-family alerts use the street via visitorSubject, never Main Home or a duplicated address", () => {
    const property = {
      address: "1 QA Scratch Lane, Tenafly, NJ 07670",
      displayName: "1 QA Scratch Lane",
      name: "1 QA Scratch Lane",
      propertyType: "SINGLE_FAMILY" as const,
      canonicalAddress: { street: "1 QA Scratch Lane" },
    };
    const tour = { config: { property, units: [{ id: "u", name: "Main Home" }] }, bundle: { reservations: [{ unitId: "u" }] } };
    expect(unitNameOf(tour as never)).toBe("1 QA Scratch Lane");
    expect(unitNameOf(tour as never)).not.toContain("Main Home");
    expect(unitNameOf(tour as never)).not.toMatch(/1 QA Scratch Lane at 1 QA Scratch Lane/);
    expect(unitNameOf(tour as never)).not.toMatch(/ at /);
  });

  it("goodbye uses the visitor's name, or omits the placeholder when they are unnamed", async () => {
    const janeDraft = condoDraft("UNIT_ONLY");
    const named = await bookCondo(janeDraft);
    named.clock.set(new Date(named.ready.slotStart!));
    await named.request(janeDraft.units[0]!.doorId);
    await named.core.completeTour(named.ready.id);
    const jane = (await named.outbound()).find((t) => t.startsWith("Thanks for touring"));
    expect(jane).toContain("Thanks for touring 145 Main Street, Unit 4B, Jane!");
    expect(jane).not.toContain(", Visitor");

    const draft = { ...condoDraft("UNIT_ONLY"), verificationMode: "none" as const };
    const unnamed = await bookCondo(draft, { name: UNNAMED_VISITOR, phone: "(555) 010-1234" });
    unnamed.clock.set(new Date(unnamed.ready.slotStart!));
    await unnamed.request(draft.units[0]!.doorId);
    await unnamed.core.completeTour(unnamed.ready.id);
    const thanks = (await unnamed.outbound()).find((t) => t.startsWith("Thanks for touring"));
    expect(thanks).toContain("Thanks for touring 145 Main Street, Unit 4B!");
    expect(thanks).not.toContain("Visitor");
  });

  it("who() uses the phone label when unnamed, never a mid-sentence The visitor", () => {
    const unnamed = { bundle: { reservations: [], prospects: [] }, visitorPhone: "+15550102000" };
    const label = formatPhone("+15550102000");
    expect(who(unnamed as never)).toBe(label);
    expect(midSentence(who(unnamed as never))).toBe(label);
    expect(`${who(unnamed as never)} doesn't have a tour time to move yet.`).toBe(`${label} doesn't have a tour time to move yet.`);
    expect(`Declined. ${who(unnamed as never)}'s 3:00 PM tour is still confirmed.`).toBe(
      `Declined. ${label}'s 3:00 PM tour is still confirmed.`,
    );
    expect(`Move ${midSentence(who(unnamed as never))}'s tour`).toBe(`Move ${label}'s tour`);
    expect(`I asked ${midSentence(who(unnamed as never))} about 3:30 PM.`).toBe(`I asked ${label} about 3:30 PM.`);
    expect(who({ bundle: { reservations: [], prospects: [] } } as never)).toBe("the visitor");
    expect(`I asked ${midSentence("the visitor")} about 3:30 PM.`).not.toMatch(/The visitor/);
    expect(midSentence("A visitor texting from +15550102000")).toBe("a visitor texting from +15550102000");
    expect(midSentence("Pat Smith")).toBe("Pat Smith");
    expect(`Call off ${midSentence("A visitor texting from +15550102000")}'s tour`).toBe(
      "Call off a visitor texting from +15550102000's tour",
    );
  });
});
