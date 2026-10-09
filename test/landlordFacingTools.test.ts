import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { publicHealth } from "../src/install/checks";
import { HOSTED_ADMIN_TOOLS } from "../src/install/hostedAdminTools";
import { Installation } from "../src/install/installation";
import { HOSTED_OWNER_TOOL, LANDLORD_CORE_TOOLS } from "../src/mcp/scopes";
import { OPERATOR_TOOLS, OPERATOR_TOOL_NAMES } from "../src/operator/tools";
import { renderPlaybook } from "../src/playbooks/compose";
import { MCP_INSTRUCTIONS } from "../src/playbooks/instructions";
import { milestoneToolFor } from "../src/playbooks/milestoneTool";
import { SHARED_STEPS, type StepId } from "../src/playbooks/shared";
import { PropertyWorkspace } from "../src/setup";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { createSetupServer } from "../src/web/server";

/**
 * Landlord-facing instructions may name only the 21 landlord tools, plus
 * reset_hosted_demo. A whole file marked qa-skill, a <!-- connector: qa -->
 * or <!-- connector: ops --> region, an ## QA connector or ## Ops connector
 * section, or a line that says "QA connector" or "ops connector" may name
 * the other connectors' tools.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LANDLORD = new Set<string>([...LANDLORD_CORE_TOOLS, HOSTED_OWNER_TOOL]);
const FOREIGN = [...new Set(OPERATOR_TOOL_NAMES)].filter((name) => !LANDLORD.has(name)).sort((a, b) => b.length - a.length);
const FOREIGN_RE = new RegExp(`\\b(${FOREIGN.join("|")})\\b`, "g");

const DOC_ROOTS = [".grok/skills", "grok-template", "GROK_BOOTSTRAP.md", "README.md"];

function filesUnder(rel: string): string[] {
  const abs = join(ROOT, rel);
  if (!statSync(abs).isDirectory()) return rel.endsWith("SETUP_PROMPT.md") ? [] : [rel];
  return readdirSync(abs).flatMap((name) => {
    if (name === "SETUP_PROMPT.md") return [];
    const child = join(rel, name);
    return statSync(join(ROOT, child)).isDirectory() ? filesUnder(child) : [child];
  });
}

/** Landlord-facing prose. QA and ops sections are removed before the scan. */
export function landlordFacingText(text: string): string {
  if (text.includes("<!-- connector: qa-skill -->")) return "";
  const stripped = text.replace(/<!-- connector: (?:qa|ops) -->[\s\S]*?<!-- \/connector -->/g, "");
  const kept: string[] = [];
  let skipSection = false;
  for (const line of stripped.split("\n")) {
    const heading = /^(#{1,6}) /.exec(line);
    if (heading && heading[1]!.length <= 2 && skipSection) skipSection = false;
    if (heading && heading[1]!.length === 2 && /^## (?:QA|Ops) connector\b/.test(line)) {
      skipSection = true;
      continue;
    }
    if (skipSection) continue;
    if (/QA connector|ops connector/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

function foreignTools(text: string): string[] {
  return [...new Set([...text.matchAll(FOREIGN_RE)].map((match) => match[1]!))];
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("landlord-facing tool names", () => {
  it("names a foreign tool in an unmarked paragraph", () => {
    expect(foreignTools("Call list_properties, then create_property_setup.")).toEqual(["list_properties", "create_property_setup"]);
    expect(foreignTools(landlordFacingText("<!-- connector: qa -->\nCall list_properties.\n<!-- /connector -->\nCall get_state."))).toEqual([]);
    expect(foreignTools(landlordFacingText("On the QA connector, call inject_local_sms."))).toEqual([]);
  });

  it("keeps skills, the template, the bootstrap, and the README on landlord tools outside QA and ops sections", () => {
    const hits: string[] = [];
    for (const rel of DOC_ROOTS.flatMap(filesUnder)) {
      const found = foreignTools(landlordFacingText(read(rel)));
      for (const name of found) hits.push(`${rel}: ${name}`);
    }
    expect(hits).toEqual([]);
  });

  it("keeps landlord tool descriptions and next-step copy on landlord tools", () => {
    const hits: string[] = [];
    for (const tool of [...OPERATOR_TOOLS, ...HOSTED_ADMIN_TOOLS]) {
      if (!LANDLORD.has(tool.name)) continue;
      for (const name of foreignTools(tool.description)) hits.push(`${tool.name} description: ${name}`);
    }
    for (const step of Object.keys(SHARED_STEPS) as StepId[]) {
      const tool = milestoneToolFor(step);
      if (!LANDLORD.has(tool)) hits.push(`milestone ${step}: ${tool}`);
    }
    const spoken = Object.values(SHARED_STEPS).flatMap((step) => [step.ask, step.done, step.ifItFails]).join("\n");
    for (const name of foreignTools(spoken)) hits.push(`shared step: ${name}`);
    for (const name of foreignTools(read("src/operator/milestones.ts"))) hits.push(`milestones: ${name}`);
    for (const name of foreignTools(MCP_INSTRUCTIONS)) hits.push(`MCP_INSTRUCTIONS: ${name}`);
    const clients = [undefined, { name: "Grok" }, { name: "Claude" }, { name: "ChatGPT" }];
    for (const client of clients) {
      for (const step of Object.keys(SHARED_STEPS) as StepId[]) {
        for (const name of foreignTools(renderPlaybook(client, step).text)) hits.push(`playbook ${client?.name ?? "baseline"} ${step}: ${name}`);
      }
    }
    const note = /const RESTORE_NOTE = "([^"]+)"/.exec(read("src/backup/service.ts"))?.[1] ?? "";
    for (const name of foreignTools(note)) hits.push(`RESTORE_NOTE: ${name}`);
    expect(hits).toEqual([]);
  });
});

const TOKEN = "landlord-token-facing-1234567890";
const HOST = "https://demo.up.railway.app";
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

async function post(port: number, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    error?: { message: string };
    result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ text: string }> };
  };
  if (json.error) throw new Error(json.error.message);
  if (json.result?.isError) throw new Error(json.result.content?.[0]?.text ?? "tool error");
  return json.result?.structuredContent ?? {};
}

describe("hosted setup-property dry walk", () => {
  it("follows get_state through publish using only landlord tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-landlord-walk-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const env: NodeJS.ProcessEnv = {
      TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0",
      RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app",
      TOURCORE_MCP_AUTH_MODE: "static",
      TOURCORE_OPERATOR_TOKEN: TOKEN,
      PUBLIC_BASE_URL: HOST,
    };
    const runtime = new FileRuntimeStore(join(root, "runtime"));
    let inst!: Installation;
    const fetchImpl = async (url: string) => {
      if (url.includes("/healthz")) return { status: 200, json: async () => publicHealth(inst) };
      return { status: 200, json: async () => ({}) };
    };
    inst = new Installation({ root, runtime, env: () => env, fetch: fetchImpl as never, now: () => Date.parse("2026-10-09T15:00:00.000Z") });
    inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    inst.files.setPublicBaseUrl(HOST, "RAILWAY");
    inst.files.recordCheck("publicEndpointCheck", { ok: true, at: "2026-10-09T15:00:00.000Z", message: "Tour Core is reachable at its public address.", url: HOST });

    const server = createSetupServer({
      workspace: new PropertyWorkspace(root),
      installation: inst,
      mcpAuth: "static",
      operatorToken: () => TOKEN,
      log: () => {},
    });
    cleanups.push(() => server.close());
    const port = await listen(server);
    const used: string[] = [];
    const log: string[] = [];
    let propertyId: string | undefined;
    let publishCode: string | undefined;
    let sawProfileOnSaveUnits = false;
    let published = false;

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      expect(LANDLORD_CORE_TOOLS, name).toContain(name);
      used.push(name);
      const result = await post(port, { jsonrpc: "2.0", id: used.length, method: "tools/call", params: { name, arguments: args } });
      for (const nameHit of foreignTools(JSON.stringify(result))) log.push(`returned ${nameHit} from ${name}`);
      if (typeof result.propertyId === "string") propertyId = result.propertyId;
      const confirmation = result.confirmation as { code?: string } | undefined;
      if (name === "publish" && confirmation?.code) publishCode = confirmation.code;
      if (result.published === true) published = true;
      if (result.status === "blocked") throw new Error(`${name} blocked: ${String(result.message ?? result.reason)}\n${log.join("\n")}`);
      return result;
    };

    const answer = (tool: string, say: string): { name: string; args: Record<string, unknown> } => {
      const property = propertyId ? { property: propertyId } : {};
      if (tool === "set_up_texting") return { name: tool, args: { provider: "local" } };
      if (tool === "backup_records") return { name: tool, args: { action: "decline" } };
      if (tool === "save_hours") return { name: tool, args: { ...property, days: "weekdays", start: "9am", end: "5pm" } };
      if (tool === "save_settings") return { name: tool, args: { ...property, verification: "basic-form", skipAlerts: true } };
      if (tool === "run_checks") return { name: tool, args: property };
      if (tool === "publish") return { name: tool, args: { ...property, ...(publishCode ? { confirmationCode: publishCode } : {}) } };
      if (tool === "save_doors_and_routes") {
        return {
          name: tool,
          args: {
            ...property,
            doors: [{ name: "Front Door", kind: "entrance" }],
            routes: [
              { unit: "Unit A", doors: ["Front Door", "Unit A Door"] },
              { unit: "Unit B", doors: ["Front Door", "Unit B Door"] },
            ],
          },
        };
      }
      if (tool === "save_units") {
        if (/bedroom|bathroom|rent|available/i.test(say)) {
          sawProfileOnSaveUnits = true;
          return {
            name: tool,
            args: {
              ...property,
              details: "Unit A is 2 bed 1 bath for $2,200, available now. Unit B is 1 bed 1 bath for $1,950, available October 15.",
            },
          };
        }
        return { name: tool, args: { ...property, units: [{ name: "Unit A" }, { name: "Unit B" }] } };
      }
      if (tool === "save_property") {
        if (/street address|property address/i.test(say)) {
          return propertyId
            ? { name: tool, args: { ...property, street: "18 Maple Street" } }
            : { name: tool, args: { address: "18 Maple Street" } };
        }
        if (/what state/i.test(say)) return { name: tool, args: { ...property, state: "NJ" } };
        if (/what city/i.test(say)) return { name: tool, args: { ...property, city: "Teaneck" } };
        if (/zip/i.test(say)) return { name: tool, args: { ...property, postalCode: "07666" } };
        if (/did i get that right/i.test(say)) return { name: tool, args: { ...property, confirmAddress: true } };
        if (/single-family|apartment or condo/i.test(say)) return { name: tool, args: { ...property, propertyType: "MULTIFAMILY_HOME" } };
        if (/stuck visitors|touring hours/i.test(say)) return { name: tool, args: { ...property, skipVisitorHelp: true } };
        if (/time zone|switch to/i.test(say)) return { name: tool, args: { ...property, timezone: "no" } };
      }
      throw new Error(`No landlord answer for ${tool}: ${say}`);
    };

    for (let step = 0; step < 40 && !published; step++) {
      const state = await call("get_state");
      const next = state.nextStep as { tool?: string; say?: string };
      const tool = String(next.tool ?? "");
      const say = String(next.say ?? "");
      log.push(`${tool}: ${say}`);
      expect(LANDLORD.has(tool), `${tool} from get_state`).toBe(true);
      if (tool === "get_inbox" || tool === "get_state") break;
      const turn = answer(tool, say);
      log.push(`call ${turn.name} ${JSON.stringify(turn.args)}`);
      const result = await call(turn.name, turn.args);
      log.push(`-> ${String(result.status ?? "")} ${String(result.message ?? "")}`);
      const repeated = log.filter((line) => line.startsWith(`${tool}: ${say}`)).length;
      if (repeated > 2) throw new Error(`Stuck on ${tool}: ${say}\n${log.join("\n")}`);
    }

    expect(published, log.join("\n")).toBe(true);
    expect(sawProfileOnSaveUnits, log.join("\n")).toBe(true);
    expect(log.some((line) => line.startsWith("returned ")), log.join("\n")).toBe(false);
    expect(used.every((name) => (LANDLORD_CORE_TOOLS as readonly string[]).includes(name))).toBe(true);
  }, 120_000);
});
