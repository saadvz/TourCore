import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOSTED_ADMIN_TOOLS } from "../src/install/hostedAdminTools";
import { ANNOTATION_DECISIONS_FOR_SAAD, annotationsFor } from "../src/mcp/annotations";
import { handleMcpMessage, mcpToolList } from "../src/mcp/mcpBridge";
import { MCP_INSTRUCTIONS } from "../src/playbooks/instructions";
import { renderPlaybook } from "../src/playbooks/compose";
import { selectPlaybook } from "../src/playbooks/select";
import { OPERATOR_TOOLS } from "../src/operator/tools";
import { installHarness } from "./installHarness";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const DESTRUCTIVE = new Set(["revoke_tour_access", "remove_property", "import_portable_backup"]);
const SIDE_EFFECT_READS = new Set(["get_next_installation_step", "get_installation_status", "get_installation_component", "check_runtime_health", "verify_storage_migration"]);
const KEPT = new Set(["reset_hosted_demo", "disconnect_google_drive_storage", "takeover_storage_writer", "migrate_storage_to_google_drive"]);

function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[path.slice(dir.length)] = readFileSync(path).toString("base64");
    }
  };
  walk(dir);
  return out;
}

describe("get_state does not write", () => {
  it("leaves stored files byte-identical, including when a texting login would otherwise be saved", async () => {
    const h = installHarness({
      env: {
        SENDBLUE_API_API_KEY: "sb-key-phase1",
        SENDBLUE_API_API_SECRET: "sb-secret-phase1",
        SENDBLUE_FROM_NUMBER: "+15550109999",
      },
    });
    cleanups.push(h.cleanup);
    expect(h.inst.files.state().messagingProviderChoice).toBeUndefined();
    const before = snapshotTree(h.root);
    const state = await h.ok("get_state");
    expect(state.scope).toBe("install");
    expect(snapshotTree(h.root)).toEqual(before);
    expect(h.inst.files.state().messagingProviderChoice).toBeUndefined();
    await h.setUpAlfredWay();
    const afterSetup = snapshotTree(h.root);
    await h.ok("get_state");
    expect(snapshotTree(h.root)).toEqual(afterSetup);
    await h.ok("get_installation_status");
    expect(h.inst.files.state().messagingProviderChoice).toBe("sendblue");
  });
});

describe("playbook selection", () => {
  it("picks a playbook from the client name and capabilities, and never a gate", () => {
    expect(selectPlaybook({ name: "Grok", capabilities: { prompts: {}, resources: {} } })).toEqual({ id: "grok", mode: "full", version: "grok@2026-10-07" });
    expect(selectPlaybook({ name: "grok-bot", capabilities: { prompts: {} } })).toMatchObject({ id: "grok", mode: "tools", version: "grok@2026-10-07.tools" });
    expect(selectPlaybook({ name: "ChatGPT", capabilities: { prompts: {}, resources: {} } })).toMatchObject({ id: "chatgpt", mode: "tools", version: "chatgpt@2026-10-07.tools" });
    expect(selectPlaybook({ name: "OpenAI", capabilities: { prompts: {}, resources: {} } })).toMatchObject({ id: "chatgpt", mode: "tools" });
    expect(selectPlaybook({ name: "Claude", capabilities: { prompts: {}, resources: {} } })).toMatchObject({ id: "claude", mode: "full", version: "claude@2026-10-07" });
    expect(selectPlaybook({ name: "Anthropic", capabilities: { resources: {} } })).toMatchObject({ id: "claude", mode: "tools", version: "claude@2026-10-07.tools" });
    expect(selectPlaybook({ name: "mystery-client", capabilities: { prompts: {}, resources: {} } })).toMatchObject({ id: "baseline", mode: "tools", version: "baseline@2026-10-07.tools" });
    expect(selectPlaybook(undefined)).toMatchObject({ id: "baseline", mode: "tools" });
    expect(selectPlaybook({})).toMatchObject({ id: "baseline", mode: "tools" });
  });

  it("same install, different clients: identical milestones and gates, different playbook text", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    h.ctx.client = { name: "grok", capabilities: { prompts: {}, resources: {} } };
    const grok = await h.ok("get_state");
    h.ctx.client = { name: "someone-else" };
    const baseline = await h.ok("get_state");
    expect(grok.milestones).toEqual(baseline.milestones);
    expect(grok.nextStep.action).toBe(baseline.nextStep.action);
    expect(grok.nextStep.component).toBe(baseline.nextStep.component);
    expect(grok.health).toEqual(baseline.health);
    expect(grok.storage).toEqual(baseline.storage);
    expect(grok.currentMilestone).toBe(baseline.currentMilestone);
    expect(grok.playbook).toMatchObject({ id: "grok", version: "grok@2026-10-07", mode: "full" });
    expect(baseline.playbook).toMatchObject({ id: "baseline", version: "baseline@2026-10-07.tools", mode: "tools" });
    expect(grok.playbook.text).not.toBe(baseline.playbook.text);
    expect(JSON.stringify({ setup: grok.setup, units: grok.units, properties: grok.properties })).not.toMatch(/Main Home/);
  });
});

describe("MCP instructions", () => {
  it("stays under 2048 bytes, and the first 512 bytes end on a sentence", async () => {
    const bytes = Buffer.from(MCP_INSTRUCTIONS, "utf8");
    expect(bytes.length).toBeLessThan(2048);
    const head = bytes.subarray(0, 512).toString("utf8");
    expect(head.trimEnd().endsWith(".")).toBe(true);
    expect(head.startsWith("Call get_state first and follow its next step.")).toBe(true);
    const h = installHarness();
    cleanups.push(h.cleanup);
    const init = await handleMcpMessage(h.ctx, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grok", version: "1" } } });
    expect(init.body).toMatchObject({ result: { instructions: MCP_INSTRUCTIONS } });
  });
});

describe("MCP annotations", () => {
  it("marks reads, the three destructive tools, and explicit non-destructive writes", () => {
    expect(OPERATOR_TOOLS).toHaveLength(84);
    expect(OPERATOR_TOOLS.some((tool) => tool.name === "get_state")).toBe(true);
    const listed = mcpToolList();
    expect(listed).toHaveLength(84);
    for (const tool of [...OPERATOR_TOOLS, ...HOSTED_ADMIN_TOOLS]) {
      const hints = annotationsFor(tool);
      expect(hints.openWorldHint).toBe(false);
      expect(hints.idempotentHint).toBe(hints.readOnlyHint);
      const shown = listed.find((item) => item.name === tool.name);
      if (shown) expect(shown.annotations).toMatchObject(hints);
      if (KEPT.has(tool.name)) {
        expect(hints.readOnlyHint).toBe(false);
        expect(hints.destructiveHint).toBe(tool.kind === "consequential");
      } else if (DESTRUCTIVE.has(tool.name)) {
        expect(hints).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      } else if (tool.kind === "read" && !SIDE_EFFECT_READS.has(tool.name)) {
        expect(hints).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      } else {
        expect(hints).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      }
    }
    for (const name of ["schedule_one_off_tour", "reschedule_tour", "approve_tour_time_request", "activate_google_drive_storage"]) {
      expect(annotationsFor({ name, kind: "consequential" }).destructiveHint).toBe(false);
    }
    expect(annotationsFor({ name: "get_next_installation_step", kind: "read" }).readOnlyHint).toBe(false);
    expect(annotationsFor({ name: "get_state", kind: "read" }).readOnlyHint).toBe(true);
    expect(ANNOTATION_DECISIONS_FOR_SAAD.map((item) => item.name)).toEqual([
      "reset_hosted_demo",
      "disconnect_google_drive_storage",
      "takeover_storage_writer",
      "migrate_storage_to_google_drive",
      "activate_google_drive_storage",
    ]);
  });
});

describe("decision 11 wake copy", () => {
  it("is in the Grok playbook only, with one spoken offer and a yes before any action", () => {
    const full = renderPlaybook({ name: "grok", capabilities: { prompts: {}, resources: {} } }, "alerts");
    const tools = renderPlaybook({ name: "grok" }, "alerts");
    const offer = "Want me to ping you the moment something needs you?";
    const question = "{name} asked for {time} on {day}. I can approve that time, offer another time, or decline it. Nothing goes to the visitor until you pick.";
    for (const text of [full.text, tools.text]) {
      expect(text).toContain(`Ask only this: ${offer}`);
      expect(text).toContain(question);
      expect(text).toContain("Only after a clear yes");
      expect(text).toContain("You never text a visitor.");
    }
    const spoken = full.text.split("For you, not out loud:")[0] ?? "";
    expect(spoken).not.toMatch(/webhook|routine|event id|secure link/i);
    for (const client of [{ name: "claude", capabilities: { prompts: {}, resources: {} } }, { name: "chatgpt", capabilities: { prompts: {}, resources: {} } }, { name: "unknown" }, undefined]) {
      const other = renderPlaybook(client, "alerts").text;
      expect(other).not.toContain(offer);
      expect(other).not.toContain("approve_tour_time_request");
      expect(other).toContain("Want me to tell you when someone books, starts, or finishes a tour");
    }
  });
});
