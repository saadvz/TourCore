import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { describeTourDays } from "../src/operator/milestones";
import { canonicalAddressKey, canonicalizeStreet } from "../src/setup/address";
import { parseDays } from "../src/setup/parse";
import { handleApi } from "../src/web/api";
import { grokHarness, type GrokHarness } from "./grokHarness";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((run) => run()));

function harness(): GrokHarness {
  const h = grokHarness();
  cleanups.push(h.cleanup);
  return h;
}

describe("QA round 2", () => {
  it("treats St. Marks with and without the period as the same place and keeps the typed display", async () => {
    expect(canonicalAddressKey("12 St. Marks Place, Brooklyn, NY 11217")).toBe(canonicalAddressKey("12 St Marks Place, Brooklyn, NY 11217"));
    expect(canonicalizeStreet("12 St. Marks Place")).toBe("12 St. Marks Place");
    expect(canonicalizeStreet("12 St Marks Place")).toBe("12 St Marks Place");

    const h = harness();
    const created = await h.ok("create_property_setup", { address: "12 St. Marks Place, Brooklyn, NY 11217", propertyType: "SINGLE_FAMILY" });
    const id = created.setup.propertyId as string;
    expect(h.workspace.openDraft(id).draft.property.address).toContain("12 St. Marks Place");
    const again = await h.ok("create_property_setup", { address: "12 St Marks Place, Brooklyn, NY 11217", propertyType: "SINGLE_FAMILY" });
    expect(again.status).toBe("already-exists");
    expect(h.workspace.propertyIds()).toEqual([id]);
    expect(h.workspace.openDraft(id).draft.property.address).toContain("12 St. Marks Place");
  });

  it("expands the street type before a #2 unit clause and before Ave. S.", () => {
    expect(canonicalizeStreet("12 Oak Ave #2")).toBe("12 Oak Avenue #2");
    expect(canonicalizeStreet("Ave. S.")).toBe("Avenue S");
    expect(canonicalizeStreet("12 Ave. S.")).toBe("12 Avenue S");
  });

  it("speaks wrapped tour days the way Critiquito specified", () => {
    expect(describeTourDays(parseDays("Tue, Wed, Fri, Sat")!)).toBe("Tuesday, Wednesday, Friday and Saturday");
    expect(describeTourDays(parseDays("Mon-Wed plus Fri, Sat")!)).toBe("Monday to Wednesday, Friday and Saturday");
    expect(describeTourDays(parseDays("Sat, Sun")!)).toBe("Saturday and Sunday");
    expect(describeTourDays(parseDays("Sun, Mon")!)).toBe("Sunday and Monday");
    expect(describeTourDays(parseDays("Sat Sun Mon")!)).toBe("Saturday to Monday");
    expect(describeTourDays(parseDays("Fri-Mon")!)).toBe("Friday to Monday");
    expect(describeTourDays(parseDays("Fri-Mon plus Wed")!)).toBe("Friday to Monday and Wednesday");
    expect(describeTourDays(parseDays("Mon-Fri")!)).toBe("Monday to Friday");
    expect(describeTourDays(parseDays("Mon-Fri plus Sun")!)).toBe("Sunday to Friday");
    expect(describeTourDays(parseDays("Mon, Wed, Fri")!)).toBe("Monday, Wednesday and Friday");
    expect(`Tours run ${describeTourDays(parseDays("every day")!)}, 9 AM to 5 PM.`).toBe("Tours run every day, 9 AM to 5 PM.");
  });

  it("drops the home label from a single-family walking route and leaves a multi-unit route labeled", async () => {
    const h = harness();
    const home = await h.ok("create_property_setup", { address: "8 Birch Lane, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const homeId = home.setup.propertyId as string;
    await h.ok("save_units", { property: homeId, units: [{ description: "The whole house." }] });
    const preview = await h.ok("save_doors_and_routes", {
      property: homeId,
      preview: true,
      routes: [{ unit: "Main Home", doors: ["Front Door"] }],
    });
    expect(preview.message).toBe("The walking route is Front Door. Nothing was saved yet.");
    const saved = await h.ok("save_doors_and_routes", {
      property: homeId,
      routes: [{ unit: "Main Home", doors: ["Front Door"] }],
    });
    expect(saved.message).toBe("Saved the walking route: Front Door.");
    const kitchen = await h.ok("create_property_setup", { address: "9 Birch Lane, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const kitchenId = kitchen.setup.propertyId as string;
    await h.ok("save_units", { property: kitchenId, units: [{ description: "The whole house.", doorName: "Kitchen Door" }] });
    const several = await h.ok("save_doors_and_routes", {
      property: kitchenId,
      doors: [{ name: "Front Door", kind: "entrance" }],
      routes: [{ unit: "Main Home", doors: ["Front Door", "Kitchen Door"] }],
    });
    expect(several.message).toBe("Saved the walking route: Front Door, then Kitchen Door.");
    expect(several.message).not.toContain("the home");

    const building = await h.ok("create_property_setup", { address: "14 Oak Avenue, Teaneck, NJ 07666", propertyType: "MULTIFAMILY_HOME" });
    const buildingId = building.setup.propertyId as string;
    await h.ok("save_units", { property: buildingId, units: [{ name: "Unit A" }, { name: "Unit B" }] });
    const units = await h.ok("save_doors_and_routes", {
      property: buildingId,
      preview: true,
      doors: [{ name: "Front Door", kind: "entrance" }],
      routes: [
        { unit: "Unit A", doors: ["Front Door", "Unit A Door"] },
        { unit: "Unit B", doors: ["Front Door", "Unit B Door"] },
      ],
    });
    expect(units.message).toBe("I have: Unit A: Front Door, then Unit A Door. Unit B: Front Door, then Unit B Door. Nothing was saved.");
  });

  it("refuses overnight hours from the setup API and does not write them", async () => {
    const h = harness();
    const created = await h.ok("create_property_setup", { address: "16 Oak Avenue, Teaneck, NJ 07666", propertyType: "MULTIFAMILY_HOME" });
    const id = created.setup.propertyId as string;
    const before = h.workspace.openDraft(id).draft.tourHours;
    const refused = await handleApi(
      { ...h.services, workspace: h.workspace, dev: true, now: () => new Date(h.now()) },
      "POST",
      `/api/properties/${id}/commands/setTourHours`,
      { input: { start: "22:00", end: "02:00" } },
    );
    expect(refused.status).toBe(400);
    expect("json" in refused ? refused.json : {}).toMatchObject({
      error: { message: "Tour hours have to end later the same day. What time should tours end?" },
    });
    expect(h.workspace.openDraft(id).draft.tourHours).toMatchObject({ start: before.start, end: before.end });
  });

  it("documents the identity choices, same-day tour hours, and consequential publish", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const skill = readFileSync(join(root, ".grok/skills/setup-property/SKILL.md"), "utf8").replace(/\s+/g, " ");
    expect(skill).toContain("Should visitors fill out a short identity form before their tour? I recommend it, so you know who's coming in.");
    expect(skill).toContain("Without a form, anyone who texts can book a tour and get in without telling you who they are. Want to go ahead with no form?");
    const catalog = readFileSync(join(root, "grok-template/integrations/tour-core-tools.md"), "utf8");
    expect(catalog).toMatch(/\| `publish` \| consequential \|/);
    expect(catalog).toMatch(/\| `save_hours` \| change \|[^\n]*Tours have to end later the same day/);
  });
});
