import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { zonedTimeToUtc } from "../src/core/timezone";
import {
  applySetupCommand,
  createPropertySetup,
  draftView,
  PropertyWorkspace,
  runDryTour,
  saveStateView,
  SetupInputError,
  tourDetailView,
  tourListView,
  type SetupDraft,
} from "../src/setup";
import { writeFolderAtomic, writeJsonAtomic } from "../src/storage/atomicWrite";

const at = (day: number, hour: number, minute = 0) => zonedTimeToUtc({ year: 2026, month: 9, day, hour, minute }, "America/New_York");

function property(withRoutes = true): SetupDraft {
  let d = createPropertySetup({ address: "100 Alfred Way, Brooklyn, NY", name: "100 Alfred Way" });
  d = applySetupCommand(d, "addDoor", { name: "Lobby Entrance", kind: "ENTRANCE" });
  d = applySetupCommand(d, "addUnit", { name: "Unit 101", summary: "One-bedroom apartment." });
  d = applySetupCommand(d, "addUnit", { name: "Unit 102" });
  if (withRoutes) for (const u of draftView(d).units) d = applySetupCommand(d, "setRoute", { unitId: u.id, doorIds: u.suggestedRoute });
  return d;
}

const roots: string[] = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "tourcore-ux-"));
  roots.push(root);
  return new PropertyWorkspace(root);
}
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("route auto-save on Continue", () => {
  it("saves a valid suggested route", () => {
    const d = property(false);
    const unit = draftView(d).units[0]!;
    const next = applySetupCommand(d, "setRoute", { unitId: unit.id, doorIds: unit.suggestedRoute, onlyIfValid: true });
    expect(draftView(next).units[0]!.route?.doorNames).toEqual(["Lobby Entrance", "Unit 101 Door"]);
  });

  it("never saves an invalid route silently", () => {
    const d = property(false);
    const unit = draftView(d).units[0]!;
    expect(() => applySetupCommand(d, "setRoute", { unitId: unit.id, doorIds: [unit.door!.id], onlyIfValid: true })).toThrow(
      new SetupInputError("ROUTE_NOT_VALID", "Unit 101's route needs to start at an entrance."),
    );
    expect(d.routes).toHaveLength(0);
  });
});

describe("saved and unsaved state", () => {
  it("saves valid edits straight away and keeps invalid ones as a draft", () => {
    const ws = workspace();
    const d = property();
    expect(ws.persistEdit(d)).toBe("saved");
    expect(ws.openDraft(d.property.id)).toMatchObject({ unsavedChanges: false });
    expect(saveStateView(d, false)).toEqual({ state: "saved", label: "All changes saved" });

    const broken = applySetupCommand(d, "setTourHours", { slotEveryMinutes: 30 });
    expect(ws.persistEdit(broken)).toBe("draft");
    const opened = ws.openDraft(d.property.id);
    expect(opened.unsavedChanges).toBe(true);
    expect(saveStateView(opened.draft, true)).toEqual({ state: "draft", label: "Changes kept as a draft until 1 problem is fixed" });
    expect(ws.load(d.property.id).config.tourHours.slotEveryMinutes).toBe(60);
  });
});

describe("tour schedule display", () => {
  it("shows the number of tours only when the schedule is valid", () => {
    const ok = draftView(property()).tourHours;
    expect(ok).toMatchObject({ valid: true, toursPerDay: 8, summary: "Monday-Friday, 9:00 AM-5:00 PM. That's up to 8 tours a day." });

    const overlapping = draftView(applySetupCommand(property(), "setTourHours", { slotEveryMinutes: 30 }));
    expect(overlapping.tourHours).toMatchObject({ valid: false, toursPerDay: undefined, summary: undefined });
    expect(overlapping.issues.map((i) => i.message)).toContain(
      "Tours start every 30 minutes, but each visit (including 10 minutes early) takes 55 minutes, so visitors would overlap. Space tours at least 55 minutes apart.",
    );
  });
});

describe("previous practice tours", () => {
  it("lists every practice tour, newest first, and reopens any of them", async () => {
    const ws = workspace();
    const { config } = ws.save(property());
    const id = config.property.id;
    ws.recordDryTour(id, await runDryTour(config, { now: at(27, 13, 42) }));
    ws.recordDryTour(id, await runDryTour(config, { now: at(27, 14, 14) }));

    const list = tourListView(ws.listTours(id), config.property.timezone);
    expect(list.map((t) => `${t.label} \u2014 ${t.outcomeLabel}`)).toEqual(["Sep 27, 2:14 PM \u2014 Passed", "Sep 27, 1:42 PM \u2014 Passed"]);

    const older = ws.loadTour(id, list[1]!.id)!;
    const view = tourDetailView(older.record, older.bundle, config);
    expect(view).toMatchObject({ title: "Practice tour", ranAtLabel: "Sep 27, 1:42 PM", outcomeLabel: "Passed", visitorName: "Pat Practice", unitName: "Unit 101" });
    expect(view.safetyChecks?.find((g) => g.id === "safety")?.items.at(-1)?.outcome).toBe("Access correctly denied before Durin was contacted");
    expect(view.conversation.some((m) => m.from === "tourcore" && m.text.includes("Would you like someone from the property team to follow up?"))).toBe(true);
    expect(view.accessDecisions.map((e) => e.text)).toContain("Access to Unit 102 Door was denied because it was not part of Pat's tour.");
    expect(ws.exportTour(id, list[1]!.id)?.json).toContain('"schemaVersion": 1');
  });
});

describe("write safety", () => {
  it("writes whole files and folders without leaving temp files behind", () => {
    const ws = workspace();
    const file = join(ws.root, "state.json");
    writeJsonAtomic(file, { ok: 1 });
    writeJsonAtomic(file, { ok: 2 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ok: 2 });
    expect(readdirSync(ws.root)).toEqual(["state.json"]);

    const folder = join(ws.root, "tour");
    writeFolderAtomic(folder, { "a.json": "{}", "b.csv": "x\n" });
    expect(readdirSync(folder).sort()).toEqual(["a.json", "b.csv"]);
    expect(() => writeFolderAtomic(folder, { "a.json": "{}" })).toThrow(/already exists/);
    expect(readdirSync(ws.root).sort()).toEqual(["state.json", "tour"]);
  });

  it("fails closed if a save was interrupted between the setup and status files", async () => {
    const ws = workspace();
    const { config } = ws.save(property());
    const id = config.property.id;
    ws.recordReadiness(id, { passed: true, checkedAt: new Date().toISOString(), checks: [] });
    ws.recordDryTour(id, { passed: true, ranAt: new Date().toISOString(), checks: [], audit: [] });
    expect((await ws.publishDemoProperty(id)).published).toBe(true);

    // Simulate a crash after the new setup file was written but before its status file was.
    const path = join(ws.root, "properties", id, "tourcore.config.json");
    writeFileSync(path, JSON.stringify({ ...config, operator: { ...config.operator, name: "Night manager" } }));
    const reloaded = ws.load(id);
    expect(reloaded.state.status).toBe("DRAFT");
    expect((await ws.publishBlockers(id)).map((b) => b.code)).toEqual(["READINESS_OUT_OF_DATE", "DRY_TOUR_OUT_OF_DATE"]);
    expect(existsSync(join(ws.root, "properties", id, "status.json"))).toBe(true);
  });
});
