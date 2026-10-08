import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approvedFacts } from "../src/core/facts";
import { SimulatedClock } from "../src/core/clock";
import { zonedTimeToUtc } from "../src/core/timezone";
import { createTourCore } from "../src/createTourCore";
import { ConsoleMessenger } from "../src/messaging/Messenger";
import {
  applySetupCommand,
  createPropertySetup,
  describeHistory,
  draftView,
  dryTourView,
  PropertyWorkspace,
  readinessView,
  runDryTour,
  runReadinessCheck,
  SetupInputError,
  type SetupDraft,
} from "../src/setup";

const MONDAY_MORNING = zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 7, minute: 0 }, "America/New_York");

/** Builds a property only through the named commands the browser uses. */
function viaCommands(): SetupDraft {
  let d = createPropertySetup({ address: "100 Alfred Way, Brooklyn, NY", name: "100 Alfred Way", propertyType: "APARTMENT_BUILDING" });
  const run = (name: string, input: unknown) => (d = applySetupCommand(d, name, input));
  run("addDoor", { name: "Lobby Entrance", kind: "ENTRANCE" });
  run("addUnit", { name: "Unit 101", summary: "One-bedroom apartment on the first floor.", facts: ["South-facing windows."] });
  run("addUnit", { name: "Unit 102", summary: "Two-bedroom apartment." });
  for (const unit of draftView(d).units) run("setRoute", { unitId: unit.id, doorIds: unit.suggestedRoute });
  return d;
}

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "tourcore-edit-"));
  roots.push(root);
  return new PropertyWorkspace(root);
}

describe("setup commands", () => {
  it("build a valid property from the same actions every surface uses", () => {
    const view = draftView(viaCommands());
    expect(view.canSave).toBe(true);
    expect(view.units.map((u) => u.route?.doorNames)).toEqual([
      ["Lobby Entrance", "Unit 101 Door"],
      ["Lobby Entrance", "Unit 102 Door"],
    ]);
  });

  it("reject bad input and unknown actions in plain language", () => {
    const d = viaCommands();
    expect(() => applySetupCommand(d, "addUnit", { summary: "no name" })).toThrow(SetupInputError);
    expect(() => applySetupCommand(d, "teleport", {})).toThrow("That action isn't available.");
    const unitDoor = d.units[0]!.doorId;
    expect(() => applySetupCommand(d, "removeDoor", { doorId: unitDoor })).toThrow(/Remove the unit instead/);
  });
});

describe("targeted editing", () => {
  it("renames one unit and, only when asked, its matching door", () => {
    const d = viaCommands();
    const u102 = d.units[1]!;
    const kept = applySetupCommand(d, "renameUnit", { unitId: u102.id, name: "Unit 202" });
    expect(kept.doors.find((x) => x.id === u102.doorId)?.name).toBe("Unit 102 Door");

    const both = applySetupCommand(d, "renameUnit", { unitId: u102.id, name: "Unit 202", alsoRenameDoor: true });
    expect(both.units[1]!.name).toBe("Unit 202");
    expect(both.doors.find((x) => x.id === u102.doorId)?.name).toBe("Unit 202 Door");
    expect(both.units[1]!.id).toBe(u102.id);
    expect(both.units[0]).toEqual(d.units[0]);
    expect(both.tourHours).toEqual(d.tourHours);
  });

  it("never renames a door the operator named themselves", () => {
    let d = viaCommands();
    const u102 = d.units[1]!;
    d = applySetupCommand(d, "renameDoor", { doorId: u102.doorId, name: "Blue Door" });
    expect(draftView(d).units[1]!.doorFollowsName).toBe(false);
    d = applySetupCommand(d, "renameUnit", { unitId: u102.id, name: "Unit 202", alsoRenameDoor: true });
    expect(d.doors.find((x) => x.id === u102.doorId)?.name).toBe("Blue Door");
  });

  it("edits one unit's description without touching anything else", () => {
    const d = viaCommands();
    const next = applySetupCommand(d, "setUnitDetails", { unitId: d.units[1]!.id, summary: "Two-bedroom with a balcony." });
    expect(next.units[1]!.summary).toBe("Two-bedroom with a balcony.");
    expect({ ...next, units: [] }).toEqual({ ...d, units: [] });
    expect(next.units[0]).toEqual(d.units[0]);
  });

  it("keeps unfinished drafts apart from the saved setup", () => {
    const ws = workspace();
    const d = viaCommands();
    ws.save(d);
    const broken = { ...d, routes: [] };
    ws.saveDraft(broken);
    expect(ws.openDraft(d.property.id)).toMatchObject({ unsavedChanges: true });
    expect(ws.load(d.property.id).config.routes).toHaveLength(2);
    ws.discardDraft(d.property.id);
    expect(ws.openDraft(d.property.id).unsavedChanges).toBe(false);
  });
});

describe("approved unit facts", () => {
  it("persist through save and reload exactly as written", () => {
    const ws = workspace();
    const d = viaCommands();
    ws.save(d);
    const reloaded = new PropertyWorkspace(ws.root).load(d.property.id).config;
    expect(reloaded.units[0]).toMatchObject({ summary: "One-bedroom apartment on the first floor.", facts: ["South-facing windows."] });
  });

  it("are the only facts available to a tour, scoped to the reserved unit", async () => {
    const config = applySetupCommand(viaCommands(), "setPropertyDetails", { facts: ["Street parking only."] });
    const unit102 = config.units[1]!.id;
    expect(approvedFacts(config, unit102).map((f) => f.text)).toEqual(["Street parking only.", "Two-bedroom apartment."]);
    expect(approvedFacts(config).every((f) => f.source === "operator")).toBe(true);

    const clock = new SimulatedClock(MONDAY_MORNING);
    const core = createTourCore(config, { clock, messenger: new ConsoleMessenger(() => {}) });
    const { reservation } = await core.startInquiry({ name: "Jane Smith", phone: "5550101234", unitId: config.units[0]!.id });
    const facts = await core.approvedFacts(reservation.id);
    expect(facts.map((f) => f.text)).toEqual(["Street parking only.", "One-bedroom apartment on the first floor.", "South-facing windows."]);
  });

  it("are never invented for a unit without any", () => {
    const d = applySetupCommand(viaCommands(), "setUnitDetails", { unitId: "unit_102", summary: "" });
    expect(approvedFacts(d, "unit_102")).toEqual([]);
  });
});

describe("operator-facing presenters", () => {
  it("turn a readiness failure into a fix the operator can click", async () => {
    const d = viaCommands();
    const view = readinessView(await runReadinessCheck({ ...d, routes: d.routes.slice(0, 1) }, { now: MONDAY_MORNING }));
    const routes = view.checks.find((c) => c.id === "routes")!;
    expect(routes.ok).toBe(false);
    expect(routes.problems[0]).toMatchObject({
      message: "Unit 102 does not have a complete route.",
      fix: { step: "routes", label: "Fix route", unitId: "unit_102" },
    });
  });

  it("render a practice tour as a timeline with an obvious safety test", async () => {
    const view = dryTourView(await runDryTour(viaCommands(), { now: MONDAY_MORNING }));
    expect(view.headline).toBe("Practice tour passed.");
    expect(view.groups.map((g) => g.title)).toEqual(["The visitor's journey", "Safety test", "Finishing up"]);
    expect(view.groups[0]!.items.map((i) => i.label)).toEqual(["Inquiry received", "Tour reserved", "Consent recorded", "Identity form completed", "Reservation ready"]);
    const safety = view.groups[1]!.items.map((i) => `${i.label}: ${i.outcome}`);
    expect(safety).toContain("Visitor arrives too early: Access correctly denied");
    expect(safety).toContain("Visitor arrives on time: Entrance access approved");
    expect(safety).toContain("Visitor enters Unit 101: Access approved");
    expect(safety).toContain("Visitor tries Unit 102 Door: turned away before any door was unlocked");
    expect(view.groups[2]!.items.map((i) => i.label)).toEqual([
      "T-15 any-questions text",
      "T-5 extra-time offer",
      "One-time extension",
      "Tour completed",
      "Access revoked",
      "Follow-up sent",
      "The tour-end text was sent (no extra time taken)",
      "T+5 leave check-in",
      "T+15 close",
      "Tour records saved",
    ]);
    expect(view.messages.length).toBeGreaterThan(0);
  });

  it("translate the audit trail into plain sentences with no raw codes", async () => {
    const result = await runDryTour(viaCommands(), { now: MONDAY_MORNING });
    const entries = describeHistory(result.audit, result.bundle!, "America/New_York");
    const text = entries.map((e) => e.text).join("\n");
    expect(text).toContain("Pat's tour was reserved for 9:00 AM.");
    expect(text).toContain("Pat arrived too early. Lobby Entrance stayed locked.");
    expect(text).toContain("Lobby Entrance access was approved for Pat.");
    expect(text).toContain("Access to Unit 102 Door was denied because it was not part of Pat's tour.");
    expect(text).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
    expect(entries.find((e) => e.text.includes("not part of"))).toMatchObject({ tone: "blocked", dev: { type: "ACCESS_DENIED", code: "DENY_WRONG_ROUTE" } });
    expect(entries.some((e) => e.dev.type === "ACCESS_REQUESTED")).toBe(false);
  });

  it("uses the property team in history when no team name is stored", () => {
    const event = { id: "e1", seq: 1, type: "OPERATOR_NOTIFIED" as const, at: "2026-09-28T14:00:00.000Z", detail: "Pat asked for help." };
    const blank = describeHistory([event], { doors: [], units: [], prospects: [], reservations: [] }, "America/New_York");
    expect(blank[0]!.text).toBe("The property team was alerted: Pat asked for help.");
    const named = describeHistory([event], { doors: [], units: [], prospects: [], reservations: [], operatorName: "leasing team" }, "America/New_York");
    expect(named[0]!.text).toBe("The property team was alerted: Pat asked for help.");
  });
});
