import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPortableBackup, buildPortableBackup } from "../src/backup/portable";
import { safetyHash } from "../src/config/changeKinds";
import { loadConfig, TourCoreConfigShape, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { zonedTimeToUtc } from "../src/core/timezone";
import { setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { isCurrent, PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { configHash } from "../src/setup/workspace";
import { createSetupServer } from "../src/web/server";
import { handleApi } from "../src/web/api";
import { fakeSendblue, inbound, SECRET, sendblueEnv } from "./fakeSendblue";
import { grokHarness, type GrokHarness } from "./grokHarness";

/**
 * Proof that the only writable verification choices are basic-form and none.
 * These assertions fail on 631995cb (practice and the full ID check were still writable).
 */

const NO_FORM_QUESTION =
  "Without a form, anyone who texts can book a tour and get in without telling you who they are. Want to go ahead with no form?";
const NO_FORM_SAVED_LIVE = "Visitors won't fill out an identity form, and tour updates stay as they are.";
const FORM_SENTENCE = "please fill out this short form with your legal name, email and phone";
const IDENTITY_WORDING = /identity form|ID check|ID step|identity check|fill out this short form/i;
const WRITABLE = ["basic-form", "none"];

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((run) => run()));

function harness(): GrokHarness {
  const h = grokHarness();
  cleanups.push(h.cleanup);
  return h;
}

function storedMode(root: string, id: string): string {
  const raw = JSON.parse(readFileSync(join(root, "properties", id, "tourcore.config.json"), "utf8")) as { verificationMode?: string };
  return raw.verificationMode ?? "";
}

function restamp(h: GrokHarness, id: string, mode: string): void {
  const configPath = join(h.root, "properties", id, "tourcore.config.json");
  const statePath = join(h.root, "properties", id, "status.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.verificationMode = mode;
  writeConfig(configPath, config);
  const { configHash, safetyHash } = hashPair(h, id);
  const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
  const stamp = { passed: true, configHash, safetyHash };
  writeConfig(statePath, {
    ...state,
    status: "PUBLISHED_FOR_DEMO",
    configHash,
    safetyHash,
    publishedAt: state.publishedAt ?? new Date().toISOString(),
    readiness: { problems: [], checkedAt: new Date().toISOString(), ...stamp },
    dryTour: { ranAt: new Date().toISOString(), ...stamp },
  });
}

function writeConfig(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

function hashPair(h: GrokHarness, id: string): { configHash: string; safetyHash: string } {
  const loaded = JSON.parse(readFileSync(join(h.root, "properties", id, "tourcore.config.json"), "utf8"));
  const parsed = TourCoreConfigShape.parse(loaded);
  return { configHash: configHash(parsed), safetyHash: safetyHash(parsed) };
}

function enumValues(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.enum) && record.enum.every((item) => typeof item === "string")) return [...record.enum];
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (!Array.isArray(record[key])) continue;
    const values = (record[key] as unknown[]).flatMap(enumValues);
    if (values.length) return values;
  }
  return [];
}

function fieldEnum(schema: unknown, field: string): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (properties && typeof properties === "object" && field in (properties as Record<string, unknown>)) {
      found.push(...enumValues((properties as Record<string, unknown>)[field]));
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") walk(value);
    }
  };
  walk(schema);
  return [...new Set(found)];
}

function toolSchema(body: unknown, name: string): { description: string; inputSchema: unknown } {
  const tools = (body as { result?: { tools?: Array<{ name: string; description: string; inputSchema: unknown }> } }).result?.tools ?? [];
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

async function publishedLegacy(mode: "mock" | "document-check") {
  const h = harness();
  const id = await h.publish();
  restamp(h, id, mode);
  return { h, id };
}

async function expectLegacyReadsAsBasicForm(h: GrokHarness, id: string, stored: string): Promise<void> {
  expect(storedMode(h.root, id)).toBe(stored);
  const saved = h.workspace.load(id);
  expect(saved.config.verificationMode).toBe("basic-form");
  expect(saved.state.status).toBe("PUBLISHED_FOR_DEMO");
  expect(isCurrent(saved.state.readiness, saved.state)).toBe(true);
  expect(isCurrent(saved.state.dryTour, saved.state)).toBe(true);
  const checks = await h.ok("run_checks", { property: id });
  expect(checks.status).toBe("done");
  const after = h.workspace.load(id);
  expect(after.config.verificationMode).toBe("basic-form");
  expect(after.state.status).toBe("PUBLISHED_FOR_DEMO");
  expect(isCurrent(after.state.readiness, after.state)).toBe(true);
  expect(isCurrent(after.state.dryTour, after.state)).toBe(true);
  expect(storedMode(h.root, id)).toBe(stored);
}

describe("verification choices", () => {
  it("offers and accepts only the basic identity form and no form, and refuses older values", async () => {
    const h = harness();
    const id = await h.setUpAlfredWay();
    const list = await h.mcp("tools/list");
    const saveSettings = toolSchema(list.body, "save_settings");
    const setPolicy = toolSchema(list.body, "set_verification_policy");
    expect(fieldEnum(saveSettings.inputSchema, "verification")).toEqual(WRITABLE);
    expect(fieldEnum(setPolicy.inputSchema, "level")).toEqual(WRITABLE);
    expect(saveSettings.description).toContain("basic identity form (recommended)");
    expect(saveSettings.description).toContain("no form");
    expect(setPolicy.description).toContain("basic identity form (recommended)");
    expect(setPolicy.description).toContain("anyone who texts could book and get in without saying who they are");
    expect(`${saveSettings.description} ${setPolicy.description}`).not.toMatch(/practice|full ID check|document-check/i);

    const policy = await h.ok("get_verification_policy", { property: id });
    expect(policy.current).toBe("basic-form");
    expect(policy.choices.map((choice: { choice: string }) => choice.choice)).toEqual(WRITABLE);
    expect(policy.choices.map((choice: { label: string }) => choice.label)).toEqual(["Basic identity form (recommended)", "No form"]);

    for (const verification of ["practice", "mock", "document-check"]) {
      const refused = await h.call("save_settings", { property: id, verification });
      expect(refused.ok).toBe(false);
      expect(storedMode(h.root, id)).toBe("basic-form");
    }
    for (const level of ["practice", "mock", "document-check"]) {
      const refused = await h.call("set_verification_policy", { property: id, level });
      expect(refused.ok).toBe(false);
      expect(storedMode(h.root, id)).toBe("basic-form");
    }

    for (const mode of ["mock", "document-check", "practice"]) {
      const refused = await handleApi(
        { workspace: h.workspace, dev: false },
        "POST",
        `/api/properties/${id}/commands/setVerificationPolicy`,
        { input: { mode } },
      );
      expect(refused.status).toBe(400);
      expect(storedMode(h.root, id)).toBe("basic-form");
      expect(h.workspace.load(id).config.verificationMode).toBe("basic-form");
    }

    const accepted = await handleApi(
      { workspace: h.workspace, dev: false },
      "POST",
      `/api/properties/${id}/commands/setVerificationPolicy`,
      { input: { mode: "none" } },
    );
    expect(accepted.status).toBe(200);
    expect(storedMode(h.root, id)).toBe("none");
    const back = await handleApi(
      { workspace: h.workspace, dev: false },
      "POST",
      `/api/properties/${id}/commands/setVerificationPolicy`,
      { input: { mode: "basic-form" } },
    );
    expect(back.status).toBe(200);
    expect(storedMode(h.root, id)).toBe("basic-form");
  });

  it("reads a stored practice check as the basic identity form, stays published, and still passes the checks", async () => {
    const { h, id } = await publishedLegacy("mock");
    await expectLegacyReadsAsBasicForm(h, id, "mock");
  });

  it("reads a stored full ID check as the basic identity form, stays published, and still passes the checks", async () => {
    const { h, id } = await publishedLegacy("document-check");
    await expectLegacyReadsAsBasicForm(h, id, "document-check");
  });

  it("restores a backup that still says practice or full ID check as the basic identity form and keeps it published", async () => {
    for (const mode of ["mock", "document-check"] as const) {
      const source = harness();
      const id = await source.publish();
      restamp(source, id, mode);
      const backup = buildPortableBackup({
        root: source.root,
        installationId: "inst_verification_choices",
        createdAt: "2026-10-08T12:00:00.000Z",
        tourCoreVersion: "test",
        secretValues: [],
      });
      const packed = backup.contents.files.find((file) => file.path.endsWith(`/${id}/tourcore.config.json`));
      expect((packed?.body as { verificationMode?: string } | undefined)?.verificationMode).toBe(mode);

      const restored = harness();
      const result = applyPortableBackup(restored.root, backup, false);
      expect(result.notes.join("\n")).not.toMatch(/practice|full ID check|identity check/i);
      expect(storedMode(restored.root, id)).toBe("basic-form");
      const saved = restored.workspace.load(id);
      expect(saved.config.verificationMode).toBe("basic-form");
      expect(saved.state.status).toBe("PUBLISHED_FOR_DEMO");
      expect(isCurrent(saved.state.readiness, saved.state)).toBe(true);
      expect(isCurrent(saved.state.dryTour, saved.state)).toBe(true);
      const checks = await restored.ok("run_checks", { property: id });
      expect(checks.status).toBe("done");
      const after = restored.workspace.load(id);
      expect(after.state.status).toBe("PUBLISHED_FOR_DEMO");
      expect(isCurrent(after.state.readiness, after.state)).toBe(true);
      expect(storedMode(restored.root, id)).toBe("basic-form");
    }
  });

  it("saves no form on live texting only after the landlord says yes", async () => {
    const h = harness();
    const id = await h.setUpAlfredWay();
    await h.ok("set_services", { property: id, messaging: "live" });
    expect(h.workspace.load(id).config.messagingMode).toBe("live");
    expect(h.workspace.load(id).config.verificationMode).toBe("basic-form");

    const asked = await h.ok("save_settings", { property: id, verification: "none" });
    expect(asked.status).toBe("next");
    expect(asked.message).toBe(NO_FORM_QUESTION);
    expect(asked.confirmation.question).toBe(NO_FORM_QUESTION);
    expect(storedMode(h.root, id)).toBe("basic-form");

    const saved = await h.ok("save_settings", { property: id, verification: "none", confirmationCode: asked.confirmation.code });
    expect(saved.status).toBe("done");
    expect(saved.message).toBe(NO_FORM_SAVED_LIVE);
    expect(storedMode(h.root, id)).toBe("none");
    expect(h.workspace.load(id).config.messagingMode).toBe("live");

    const other = harness();
    const otherId = await other.setUpAlfredWay();
    await other.ok("set_services", { property: otherId, messaging: "live" });
    const policy = await other.ok("set_verification_policy", { property: otherId, level: "none" });
    expect(policy.status).toBe("needs-confirmation");
    expect(policy.summary).toBe(NO_FORM_QUESTION);
    expect(storedMode(other.root, otherId)).toBe("basic-form");
    await other.ok("set_verification_policy", { property: otherId, level: "none", confirmationCode: policy.confirmation.code });
    expect(storedMode(other.root, otherId)).toBe("none");
    expect(other.workspace.load(otherId).config.messagingMode).toBe("live");
  });

  it("sends no identity-form wording when there is no form, and keeps the basic-form transcript", async () => {
    const basic = await startPhoneApp("basic-form");
    await basic.text("TOUR");
    await basic.text("YES");
    await basic.text("1");
    await basic.text("1");
    const booked = await basic.text("1");
    const booking = booked.replies.join("\n");
    expect(booking).toContain("Great, you're booked for 2:00 PM on Monday, Sep 28.");
    expect(booking).toContain(FORM_SENTENCE);
    expect(booking).not.toContain("You're all set");
    const waiting = await basic.text("ok");
    expect(waiting.replies.join("\n")).toContain("Here's your identity form link again");

    const none = await startPhoneApp("none");
    const replies: string[] = [];
    const say = async (content: string) => {
      const sent = await none.text(content);
      replies.push(...sent.replies);
      return sent;
    };
    await say("TOUR");
    await say("YES");
    await say("1");
    await say("1");
    const noneBooked = await say("1");
    expect(noneBooked.replies.join("\n")).toContain("Great, you're booked for 2:00 PM on Monday, Sep 28.");
    expect(noneBooked.replies.join("\n")).toContain("You're all set for your tour");
    await say("HELP");
    await say("where's the form");
    await say("Actually cancel that");
    const kept = await say("NO");
    expect(kept.replies.join("\n")).toContain("Okay, your tour stays on Monday, Sep 28 at 2:00 PM.");
    const early = await say("I'm here");
    expect(early.replies.join("\n")).toContain("You're a little early");
    none.setClock(at(13, 50));
    const arrived = await say("I'm here");
    expect(arrived.replies[0]).toContain("open for you now");
    const transcript = replies.join("\n");
    expect(transcript).not.toMatch(IDENTITY_WORDING);
    expect(transcript).toContain("You're all set for your tour");
    expect(transcript).toContain("Great, you're booked");
    expect(transcript).toContain("Okay, your tour stays on Monday, Sep 28 at 2:00 PM.");
  });
});

/** Monday 28 Sep 2026 at the property; tours at 2:00 PM, doors from 1:50 PM. */
const at = (hour: number, minute = 0) => zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour, minute }, "America/New_York").getTime();
const PHONE = "+15550102000";

function phoneProperty(mode: "basic-form" | "none"): TourCoreConfig {
  const config = loadConfig();
  return {
    ...config,
    messagingMode: "live",
    verificationMode: mode,
    property: { ...config.property, facts: ["Street parking only."] },
  };
}

async function startPhoneApp(mode: "basic-form" | "none") {
  const root = mkdtempSync(join(tmpdir(), "tourcore-verify-"));
  const fake = fakeSendblue();
  cleanups.push(setSendblueRuntime({ env: () => sendblueEnv(), client: () => fake.client }));
  let clock = at(7);
  const ws = new PropertyWorkspace(root);
  const { config } = ws.save(phoneProperty(mode));
  ws.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(clock) }));
  const server: Server = createSetupServer({ workspace: ws, now: () => new Date(clock), realNow: () => clock, log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  cleanups.push(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  let n = 0;
  const text = async (content: string) => {
    const before = fake.sent.length;
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/sendblue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "sb-signing-secret": SECRET },
      body: JSON.stringify(inbound(PHONE, content, `verify_${mode}_${++n}`)),
    });
    return { status: res.status, replies: fake.sent.slice(before).map((sent) => sent.content) };
  };
  return { text, setClock: (t: number) => (clock = t) };
}
