import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPortableBackup, checksumOf, PORTABLE_FORMAT, PORTABLE_SCHEMA_VERSION, type PortableBackup } from "../src/backup/portable";
import { safetyHash } from "../src/config/changeKinds";
import { TourCoreConfigShape } from "../src/config/tourCoreConfig";
import { interpretByRules, type InterpretContext } from "../src/intent";
import { sha256Json } from "../src/storage/documentStore";
import { handleApi } from "../src/web/api";
import {
  DOCUMENT_CHECK_UNAVAILABLE,
  LIVE_TEXTING_IDENTITY,
  PRACTICE_ON_LIVE,
  PRACTICE_REFUSED,
  VERIFICATION_BELOW_FLOOR,
} from "../src/setup/verificationFloor";
import { SAME_DAY_HOURS } from "../src/setup/parse";
import { configHash, isCurrent, type PropertyWorkspace } from "../src/setup/workspace";
import { grokHarness, type GrokHarness } from "./grokHarness";
import { installHarness } from "./installHarness";

const CLIENTS = ["grok", "chatgpt", "claude", "mystery-client"] as const;
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

  it("raises practice verification when texting goes live, for every client", async () => {
    const h = harness();
    h.services.installedMessaging = () => ({ mode: "live", provider: "sendblue", ready: true, requiredForPublish: false });
    for (const [index, name] of CLIENTS.entries()) {
      h.ctx.client = { name };
      const created = await h.ok("create_property_setup", {
        address: `${10 + index} Maple Street, Teaneck, NJ 07666`,
        propertyType: "MULTIFAMILY_HOME",
      });
      const propertyId = created.setup.propertyId as string;
      await h.ok("set_services", { property: propertyId, messaging: "demo" });
      await h.ok("save_settings", { property: propertyId, verification: "practice" });
      expect(h.workspace.openDraft(propertyId).draft.verificationMode, name).toBe("mock");
      const switched = await h.ok("set_services", { property: propertyId, messaging: "live" });
      expect(switched.summary, name).toBe(LIVE_TEXTING_IDENTITY);
      expect(h.workspace.openDraft(propertyId).draft.verificationMode, name).toBe("basic-form");
    }
  });

  it("says the same sentence when set_up_texting turns practice verification into live texting", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    h.inst.files.writeState({ ...h.inst.files.state(), messagingProviderChoice: "sendblue" });
    h.inst.files.update({ messagingProvider: "SENDBLUE" });
    for (const [index, name] of CLIENTS.entries()) {
      h.ctx.client = { name };
      const created = await h.ok("create_property_setup", {
        address: `${20 + index} Maple Street, Teaneck, NJ 07666`,
        propertyType: "MULTIFAMILY_HOME",
      });
      const propertyId = created.setup.propertyId as string;
      await h.ok("save_settings", { property: propertyId, verification: "practice" });
      const switched = await h.ok("set_up_texting", { property: propertyId, provider: "sendblue" });
      expect(switched.message, name).toBe(LIVE_TEXTING_IDENTITY);
      expect(h.workspace.openDraft(propertyId).draft.verificationMode, name).toBe("basic-form");
    }
  });

  it("refuses practice verification from the setup API and does not change the saved check", async () => {
    const h = harness();
    h.services.installedMessaging = () => ({ mode: "live", provider: "sendblue", ready: true, requiredForPublish: false });
    const created = await h.ok("create_property_setup", { address: "30 Maple Street, Teaneck, NJ 07666", propertyType: "MULTIFAMILY_HOME" });
    const propertyId = created.setup.propertyId as string;
    await h.ok("set_services", { property: propertyId, messaging: "live" });
    const refused = await handleApi(
      { ...h.services, workspace: h.workspace, dev: true, now: () => new Date(h.now()) },
      "POST",
      `/api/properties/${propertyId}/commands/setVerificationPolicy`,
      { input: { mode: "mock" } },
    );
    expect(refused.status).toBe(400);
    expect("json" in refused ? refused.json : {}).toMatchObject({ error: { message: PRACTICE_REFUSED, dev: { code: VERIFICATION_BELOW_FLOOR } } });
    expect(h.workspace.openDraft(propertyId).draft.verificationMode).toBe("basic-form");

    const held = await handleApi(
      { ...h.services, workspace: h.workspace, dev: true, now: () => new Date(h.now()) },
      "POST",
      `/api/properties/${propertyId}/commands/setVerificationPolicy`,
      { input: { mode: "document-check" } },
    );
    expect(held.status).toBe(200);
    expect(h.workspace.openDraft(propertyId).draft.verificationMode).toBe("basic-form");
  });

  it("stores the basic identity form when a restored backup would be live texting plus practice", () => {
    const root = harness().root;
    const live = { property: { id: "prop_qa" }, messagingMode: "live", verificationMode: "mock", doors: [], routes: [], units: [] };
    const file = {
      path: "properties/prop_qa/tourcore.config.json",
      kind: "property",
      body: live,
      sha256: sha256Json(live),
    };
    const contents = { files: [file] };
    const backup: PortableBackup = {
      format: PORTABLE_FORMAT,
      schemaVersion: PORTABLE_SCHEMA_VERSION,
      installationId: "inst_qa_round",
      createdAt: "2026-10-08T12:00:00.000Z",
      tourCoreVersion: "test",
      contents,
      checksum: checksumOf(contents),
    };
    const applied = applyPortableBackup(root, backup, false);
    expect(applied.notes).toEqual([LIVE_TEXTING_IDENTITY]);
    const stored = JSON.parse(readFileSync(join(root, "properties/prop_qa/tourcore.config.json"), "utf8")) as { verificationMode: string };
    expect(stored.verificationMode).toBe("basic-form");
  });

  it("fails readiness and publish while a live property is still on the practice check, and does not rewrite it", async () => {
    const h = harness();
    const id = await h.publish();
    h.services.installedMessaging = () => ({ mode: "live", provider: "sendblue", ready: false, requiredForPublish: true });
    restamp(h.workspace, id, (config) => {
      config.messagingMode = "live";
      delete config.messagingProvider;
      config.verificationMode = "mock";
    });
    const checked = await h.ok("run_checks", { property: id });
    expect(checked.status).toBe("blocked");
    expect(checked.code).toBe(VERIFICATION_BELOW_FLOOR);
    expect(checked.message).toBe(PRACTICE_ON_LIVE);
    const published = await h.ok("publish", { property: id });
    expect(published.code).toBe(VERIFICATION_BELOW_FLOOR);
    expect(published.message).toBe(PRACTICE_ON_LIVE);
    const saved = h.workspace.load(id);
    expect(saved.config.verificationMode).toBe("mock");
    expect(saved.state.status).toBe("PUBLISHED_FOR_DEMO");
  });

  it("does not rewrite a stored live practice check on read or on a content edit", async () => {
    const h = harness();
    const id = await h.publish();
    restamp(h.workspace, id, (config) => {
      config.messagingMode = "live";
      delete config.messagingProvider;
      config.verificationMode = "mock";
    });
    expect(h.workspace.load(id).config.verificationMode).toBe("mock");
    expect(h.workspace.load(id).config.verificationMode).toBe("mock");
    await h.ok("update_property_details", { property: id, facts: ["Street parking only."] });
    const saved = h.workspace.load(id);
    expect(saved.config.verificationMode).toBe("mock");
    expect(saved.state.status).toBe("PUBLISHED_FOR_DEMO");
  });

  it("keeps a published live property on the basic form when a full ID check is requested", async () => {
    const h = harness();
    const id = await h.publish();
    h.services.installedMessaging = () => ({ mode: "live", provider: "sendblue", ready: true, requiredForPublish: false });
    restamp(h.workspace, id, (config) => {
      config.messagingMode = "live";
      delete config.messagingProvider;
      config.verificationMode = "basic-form";
    });
    const saved = await h.ok("save_settings", { property: id, verification: "document-check" });
    expect(saved.status).toBe("done");
    expect(saved.message).toBe(DOCUMENT_CHECK_UNAVAILABLE);
    const after = h.workspace.load(id);
    expect(after.config.verificationMode).toBe("basic-form");
    expect(after.state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(isCurrent(after.state.readiness, after.state)).toBe(true);
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
