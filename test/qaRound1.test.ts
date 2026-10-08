import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safetyHash } from "../src/config/changeKinds";
import { TourCoreConfigShape } from "../src/config/tourCoreConfig";
import { interpretByRules, type InterpretContext } from "../src/intent";
import { SAME_DAY_HOURS } from "../src/setup/parse";
import { configHash, isCurrent, type PropertyWorkspace } from "../src/setup/workspace";
import { grokHarness, type GrokHarness } from "./grokHarness";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((run) => run()));

function harness(): GrokHarness {
  const h = grokHarness();
  cleanups.push(h.cleanup);
  return h;
}

/** A property published before this change: non-canonical names, with status hashes aimed at that file. */
function restamp(workspace: PropertyWorkspace, id: string, mutate: (config: Record<string, any>) => void): void {
  const configPath = join(workspace.root, "properties", id, "tourcore.config.json");
  const statePath = join(workspace.root, "properties", id, "status.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
  mutate(config);
  writeFileSync(configPath, JSON.stringify(config));
  const parsed = TourCoreConfigShape.parse(JSON.parse(readFileSync(configPath, "utf8")));
  const full = configHash(parsed);
  const safety = safetyHash(parsed);
  const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, any>;
  const stamp = { passed: true, configHash: full, safetyHash: safety };
  writeFileSync(
    statePath,
    JSON.stringify({
      ...state,
      status: "PUBLISHED_FOR_DEMO",
      configHash: full,
      safetyHash: safety,
      publishedAt: state.publishedAt ?? new Date().toISOString(),
      readiness: { problems: [], checkedAt: state.readiness?.checkedAt ?? new Date().toISOString(), ...stamp },
      dryTour: { ranAt: state.dryTour?.ranAt ?? new Date().toISOString(), ...stamp },
    }),
  );
}

function chooseUnit(message: string, units: { name: string }[]) {
  const ctx: InterpretContext = {
    message,
    step: "choose-unit",
    units,
    timeChoices: [],
    remainingStops: [],
    doors: [],
    today: { year: 2026, month: 10, day: 8 },
  };
  return interpretByRules(ctx);
}

describe("QA round 1", () => {
  it("keeps a pre-normalization published property published through content edits, and drafts a real structural change", async () => {
    const h = harness();
    const id = await h.publish();
    restamp(h.workspace, id, (config) => {
      const ave = String(config.property.address).replace("Way", "Ave");
      config.property.address = ave;
      if (config.property.canonicalAddress) {
        config.property.canonicalAddress.street = String(config.property.canonicalAddress.street).replace("Way", "Ave");
        config.property.canonicalAddress.formatted = ave;
      }
      const unit = config.units[0];
      unit.name = "1A";
      const door = config.doors.find((item: { id: string }) => item.id === unit.doorId);
      if (door) door.name = "1A Door";
    });
    expect(h.workspace.load(id).state.status).toBe("PUBLISHED_FOR_DEMO");

    await h.ok("update_property_details", { property: id, facts: ["Cats are welcome."] });
    await h.ok("set_unit_details", { property: id, units: [{ unit: "Unit 1A", monthlyRent: "2000" }] });
    await h.ok("save_property", { property: id, facts: ["Cats are welcome.", "Street parking."] });
    await h.ok("save_units", { property: id, units: [{ name: "Unit 1A", description: "Sunny one-bedroom." }] });

    const kept = h.workspace.load(id);
    expect(kept.state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(kept.config.property.address).toContain("Avenue");
    expect(kept.config.units.some((unit) => unit.name === "Unit 1A")).toBe(true);
    expect(isCurrent(kept.state.readiness, kept.state)).toBe(true);
    expect(isCurrent(kept.state.dryTour, kept.state)).toBe(true);

    await h.ok("set_tour_hours", { property: id, start: "10am", end: "4pm" });
    expect(h.workspace.load(id).state.status).toBe("DRAFT");
  });

  it("lets a visitor pick a unit by its short code, with or without the Unit prefix", () => {
    const stored = [
      { name: "Unit 1A" },
      { name: "Unit 2B" },
    ];
    for (const phrase of ["1A", "I'd like to see 1A", "unit 1a"]) {
      expect(chooseUnit(phrase, stored).intent, phrase).toMatchObject({ type: "SELECT_UNIT", unitName: "Unit 1A" });
    }
    expect(chooseUnit("2B please", stored).intent).toMatchObject({ type: "SELECT_UNIT", unitName: "Unit 2B" });
    const legacy = [{ name: "1A" }, { name: "2B" }];
    expect(chooseUnit("1A", legacy).intent).toMatchObject({ type: "SELECT_UNIT", unitName: "1A" });
    expect(chooseUnit("I'd like to see 1A", legacy).intent).toMatchObject({ type: "SELECT_UNIT", unitName: "1A" });
    expect(chooseUnit("2B please", legacy).intent).toMatchObject({ type: "SELECT_UNIT", unitName: "2B" });
    expect(chooseUnit("unit 1a", legacy).intent).toMatchObject({ type: "SELECT_UNIT", unitName: "1A" });
  });


  it("treats a pre-normalization address as the same property for both create and save", async () => {
    const h = harness();
    const created = await h.ok("create_property_setup", { address: "27 Oak Avenue, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const id = created.setup.propertyId as string;
    const renamed = `${id}_legacy`;
    renameSync(join(h.root, "properties", id), join(h.root, "properties", renamed));
    const draftPath = join(h.root, "properties", renamed, "draft.json");
    const draft = JSON.parse(readFileSync(draftPath, "utf8")) as { property: { address: string; canonicalAddress?: { street: string; formatted: string } } };
    draft.property.address = "27 Oak Ave, Teaneck, NJ 07666";
    if (draft.property.canonicalAddress) {
      draft.property.canonicalAddress.street = "27 Oak Ave";
      draft.property.canonicalAddress.formatted = "27 Oak Ave, Teaneck, NJ 07666";
    }
    writeFileSync(draftPath, JSON.stringify(draft));

    const again = await h.ok("create_property_setup", { address: "27 Oak Avenue, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    expect(again.status).toBe("already-exists");
    expect(again.summary).toBe("27 Oak Avenue, Teaneck, NJ 07666 is already set up. I'll keep working on that one.");
    expect(h.workspace.propertyIds()).toEqual([renamed]);

    await h.ok("create_property_setup", { address: "9 Pine Road, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const saved = await h.ok("save_property", { address: "27 Oak Avenue, Teaneck, NJ 07666" });
    expect(saved.status).toBe("already-exists");
    expect(saved.message).toBe("27 Oak Avenue, Teaneck, NJ 07666 is already set up. I'll keep working on that one.");
    expect(h.workspace.propertyIds()).toHaveLength(2);
    expect(h.workspace.propertyIds()).toContain(renamed);
  });

  it("says the home instead of Main Home, and refuses overnight hours", async () => {
    const h = harness();
    const created = await h.ok("create_property_setup", { address: "4 Birch Lane, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const propertyId = created.setup.propertyId as string;
    const saved = await h.ok("save_units", { property: propertyId, units: [{ description: "The whole house." }] });
    expect(saved.message).toBe("Saved the home.");
    expect(h.workspace.openDraft(propertyId).draft.units[0]?.name).toBe("Main Home");
    const custom = await h.ok("create_property_setup", { address: "6 Birch Lane, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const named = await h.ok("save_units", { property: custom.setup.propertyId, units: [{ name: "Garden House", description: "The whole house." }] });
    expect(named.message).toBe("Saved Garden House.");

    const hours = h.workspace.openDraft(propertyId).draft.tourHours;
    const blocked = await h.ok("save_hours", { property: propertyId, start: "10 PM", end: "2 AM" });
    expect(blocked.status).toBe("blocked");
    expect(blocked.message).toBe(SAME_DAY_HOURS);
    const old = await h.ok("set_tour_hours", { property: propertyId, start: "10pm", end: "2am" });
    expect(old.status).toBe("blocked");
    expect(old.summary).toBe(SAME_DAY_HOURS);
    expect(h.workspace.openDraft(propertyId).draft.tourHours).toMatchObject({ start: hours.start, end: hours.end });
  });
});
