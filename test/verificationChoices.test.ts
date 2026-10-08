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
import { applySetupCommand, createPropertySetup, isCurrent, PropertyWorkspace, reviewSetup, runReadinessCheck, setVerificationPolicy } from "../src/setup";
import { draftView } from "../src/setup/presenters";
import { REUSE_FIELD_HELP, REUSE_FIELD_LABEL, verificationReuseSentence, WEB_VERIFICATION_HEADING, WEB_VERIFICATION_LEAD } from "../src/setup/verification";
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
const NOT_READY = "We're not quite ready to open doors yet. Finish the steps I sent earlier and you'll be all set.";
const ID_EXPIRED = "Your ID check has expired, so I need a quick re-check before I can open doors.";
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

    const unconfirmed = await handleApi(
      { workspace: h.workspace, dev: false },
      "POST",
      `/api/properties/${id}/commands/setVerificationPolicy`,
      { input: { mode: "none" } },
    );
    expect(unconfirmed.status).toBe(400);
    expect("json" in unconfirmed ? unconfirmed.json : {}).toMatchObject({ error: { message: NO_FORM_QUESTION } });
    expect(storedMode(h.root, id)).toBe("basic-form");
    expect(h.workspace.load(id).config.verificationMode).toBe("basic-form");

    const accepted = await handleApi(
      { workspace: h.workspace, dev: false },
      "POST",
      `/api/properties/${id}/commands/setVerificationPolicy`,
      { input: { mode: "none", confirm: true } },
    );
    expect(accepted.status).toBe(200);
    expect(storedMode(h.root, id)).toBe("none");
    const nonePolicy = await h.ok("get_verification_policy", { property: id });
    expect(nonePolicy.summary).toBe("No identity form.");
    expect(nonePolicy.summary).not.toMatch(/reuse|days/i);
    expect(nonePolicy.reuseForDays).toBeUndefined();
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

  it("reads the form reuse sentence, and no form as one line with no reuse wording", () => {
    const draft = setVerificationPolicy(createPropertySetup({ address: "18 Maple St, Teaneck, NJ 07666" }), { reuseForDays: 30 });
    const formRows = ["Basic identity form (recommended)", verificationReuseSentence(30)];
    expect(reviewSetup(draft).sections.find((section) => section.title === "VERIFICATION")?.lines).toEqual(formRows);
    expect(draftView(draft).reviewCards.find((card) => card.step === "verification")?.rows.join(". ")).toBe(
      "Basic identity form (recommended). Visitors who filled it out won't be asked again for 30 days.",
    );
    const none = setVerificationPolicy(draft, { mode: "none" });
    expect(reviewSetup(none).sections.find((section) => section.title === "VERIFICATION")?.lines).toEqual(["No identity form."]);
    expect(draftView(none).reviewCards.find((card) => card.step === "verification")?.rows).toEqual(["No identity form."]);
    expect(() => applySetupCommand(draft, "setVerificationPolicy", { mode: "none" })).toThrow(NO_FORM_QUESTION);
    expect(draft.verificationMode).toBe("basic-form");
    const saved = applySetupCommand(draft, "setVerificationPolicy", { mode: "none", confirm: true });
    expect(saved.verificationMode).toBe("none");
  });

  it("asks the setup page to confirm no form, and hides reuse days until the form stays", () => {
    const web = readFileSync(new URL("../src/web/public/app.js", import.meta.url), "utf8");
    const step = web.slice(web.indexOf("function verificationStep"), web.indexOf("// Records and messages"));
    expect(step).toContain(`el("h1", {}, ${JSON.stringify(WEB_VERIFICATION_HEADING)})`);
    expect(step).toContain(`el("p", { class: "lead" }, ${JSON.stringify(WEB_VERIFICATION_LEAD)})`);
    expect(step).not.toContain("I recommend it, so you know who's coming in.");
    expect(step).not.toContain("How many days can a check be reused?");
    expect(step).toContain(REUSE_FIELD_LABEL);
    expect(step).toContain(REUSE_FIELD_HELP);
    expect(step).toContain("hidden: mode === \"none\"");
    expect(step).toContain(NO_FORM_QUESTION);
    expect(step).toContain('btn("Yes, no form"');
    expect(step).toContain('btn("Keep the form"');
    expect(step).toContain('{ mode: "none", confirm: true }');
    expect(step).toContain("if (mode === \"none\")");
    expect(step).toContain("confirmCard.hidden = false");
    expect(step).not.toContain("confirm: true, reuseForDays");
    expect(step).not.toContain("reuseForDays: Number(days.value), confirm");

    const cli = readFileSync(new URL("../src/cli/setup.ts", import.meta.url), "utf8");
    const edit = cli.slice(cli.indexOf("async function editVerification"), cli.indexOf("async function editServices"));
    expect(REUSE_FIELD_LABEL).toBe("How many days before a visitor fills out the form again?");
    expect(REUSE_FIELD_HELP).toBe("A visitor who already filled out the form can book another tour within this many days without filling it out again.");
    expect(edit).toContain("Anyone who texts can book a tour and get in without telling you who they are.");
    expect(edit).toContain("if (mode === \"none\") return next;");
    expect(edit).toContain("REUSE_FIELD_LABEL");
    expect(edit).toContain("REUSE_FIELD_HELP");
    expect(edit).not.toMatch(/Once someone has been checked|How many days should a check stay good/);
  });

  it("opens the door on Wednesday for a no-form tour booked Monday with a 1-day window", async () => {
    const none = await startPhoneApp("none", 1);
    const replies: string[] = [];
    const say = async (content: string) => {
      const sent = await none.text(content);
      replies.push(...sent.replies);
      return sent;
    };
    await say("TOUR");
    await say("YES");
    await say("1");
    const days = await say("3");
    expect(days.replies.join("\n")).toContain("Wednesday, Sep 30");
    const booked = await say("1");
    expect(booked.replies.join("\n")).toContain("You're all set");
    expect(booked.replies.join("\n")).toContain("Wednesday, Sep 30");
    none.setClock(at(13, 50, 30));
    const arrived = await say("I'm here");
    const again = await say("I'm here");
    const arrival = [arrived.replies.join("\n"), again.replies.join("\n")].join("\n");
    expect(arrived.replies.join("\n")).toContain("is open for you now");
    expect(arrival).not.toContain(NOT_READY);
    expect(arrival).not.toContain(ID_EXPIRED);
    expect(replies.join("\n")).not.toMatch(IDENTITY_WORDING);
  });

  it("opens the door on a rebook after the reuse window, with no identity text", async () => {
    const none = await startPhoneApp("none", 1);
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
    const first = await say("1");
    expect(first.replies.join("\n")).toContain("You're all set");
    await say("Actually cancel that");
    await say("YES");
    none.setClock(at(7, 0, 30));
    await say("TOUR");
    await say("YES");
    await say("1");
    const days = await say("3");
    expect(days.replies.join("\n")).toContain("Friday, Oct 2");
    const rebooked = await say("1");
    expect(rebooked.replies.join("\n")).toContain("You're all set");
    expect(rebooked.replies.join("\n")).toContain("Friday, Oct 2");
    none.setClock(at(13, 50, 2, 10));
    const arrived = await say("I'm here");
    expect(arrived.replies.join("\n")).toContain("is open for you now");
    expect(replies.join("\n")).not.toContain(NOT_READY);
    expect(replies.join("\n")).not.toContain(ID_EXPIRED);
    expect(replies.join("\n")).not.toMatch(IDENTITY_WORDING);
  });
});

/** Monday 28 Sep 2026 at the property unless a later day is given. Tours at 2:00 PM, doors from 1:50 PM. */
const at = (hour: number, minute = 0, day = 28, month = 9) => zonedTimeToUtc({ year: 2026, month, day, hour, minute }, "America/New_York").getTime();
const PHONE = "+15550102000";

function phoneProperty(mode: "basic-form" | "none", verificationValidForDays = 30): TourCoreConfig {
  const config = loadConfig();
  return {
    ...config,
    messagingMode: "live",
    verificationMode: mode,
    verificationValidForDays,
    property: { ...config.property, facts: ["Street parking only."] },
  };
}

async function startPhoneApp(mode: "basic-form" | "none", verificationValidForDays = 30) {
  const root = mkdtempSync(join(tmpdir(), "tourcore-verify-"));
  const fake = fakeSendblue();
  cleanups.push(setSendblueRuntime({ env: () => sendblueEnv(), client: () => fake.client }));
  let clock = at(7);
  const ws = new PropertyWorkspace(root);
  const { config } = ws.save(phoneProperty(mode, verificationValidForDays));
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
