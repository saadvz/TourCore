import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { legacySendblueFingerprints } from "../src/config/changeKinds";
import { loadConfig } from "../src/config/tourCoreConfig";
import { isCurrent, PropertyWorkspace } from "../src/setup/workspace";
import { writeJsonAtomic } from "../src/storage/atomicWrite";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

describe("live messaging mode", () => {
  it("rewrites an old sendblue property to live without dropping publication", () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-mode-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const ws = new PropertyWorkspace(root);
    const saved = ws.save({ ...loadConfig(), messagingMode: "live" });
    const id = saved.config.property.id;
    const file = join(root, "properties", id, "tourcore.config.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { messagingMode: string };
    raw.messagingMode = "sendblue";
    writeJsonAtomic(file, raw);
    const old = legacySendblueFingerprints(saved.config);
    const at = "2026-10-02T12:00:00.000Z";
    writeJsonAtomic(join(root, "properties", id, "status.json"), {
      propertyId: id,
      status: "PUBLISHED_FOR_DEMO",
      configHash: old.full,
      safetyHash: old.safety,
      savedAt: at,
      publishedAt: at,
      readiness: { passed: true, checkedAt: at, configHash: old.full, safetyHash: old.safety, problems: [] },
      dryTour: { passed: true, ranAt: at, configHash: old.full, safetyHash: old.safety },
    });

    const loaded = ws.load(id);
    expect(loaded.config.messagingMode).toBe("live");
    expect(JSON.parse(readFileSync(file, "utf8")).messagingMode).toBe("live");
    expect(loaded.state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(loaded.state.publishedAt).toBe(at);
    expect(loaded.state.readiness?.passed).toBe(true);
    expect(isCurrent(loaded.state.readiness, loaded.state)).toBe(true);
    expect(isCurrent(loaded.state.dryTour, loaded.state)).toBe(true);
    expect(ws.load(id).state.status).toBe("PUBLISHED_FOR_DEMO");
  });
});
