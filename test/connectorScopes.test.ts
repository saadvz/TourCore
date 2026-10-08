import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Installation } from "../src/install/installation";
import { resetLocalSmsOutbox } from "../src/messaging/local/outbox";
import { LANDLORD_CORE_TOOLS, OPS_TOOL_NAMES, QA_TOOL_NAMES } from "../src/mcp/scopes";
import { OPERATOR_SCOPE } from "../src/mcp/oauth/provider";
import { hashSecret, OAuthGrantStore } from "../src/mcp/oauth/store";
import { PropertyWorkspace } from "../src/setup";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { createSetupServer } from "../src/web/server";
import { grokHarness, type GrokHarness } from "./grokHarness";

const LANDLORD = "landlord-token-pre-split-123456";
const OPS = "ops-token-secret-value-123456";
const QA = "qa-token-secret-value-123456";
const HOST = "https://demo.up.railway.app";
const OWNER = "grok-owner-client";
const PRE_SPLIT = "tca_pre_split_access_token_landlord_ok";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  resetLocalSmsOutbox();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

async function post(port: number, path: string, body: unknown, token?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, text };
}

const listRpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const callRpc = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });

function namesFrom(json: unknown): string[] {
  return toolsFrom(json).map((tool) => tool.name);
}

function toolsFrom(json: unknown): Array<{ name: string; description?: string }> {
  return (json as { result: { tools: Array<{ name: string; description?: string }> } }).result.tools;
}

describe("connector scopes", () => {
  it("lists 21 landlord tools on a self-host static token, and refuses QA and ops tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-scope-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const server = createSetupServer({
      workspace: new PropertyWorkspace(root),
      mcpAuth: "static",
      operatorToken: () => LANDLORD,
      opsToken: () => OPS,
      qaToken: () => QA,
      log: () => {},
    });
    cleanups.push(() => server.close());
    const port = await listen(server);

    const listed = await post(port, "/mcp", listRpc, LANDLORD);
    expect(listed.status).toBe(200);
    expect(namesFrom(listed.json)).toEqual([...LANDLORD_CORE_TOOLS]);

    const qaCall = await post(port, "/mcp", callRpc("inject_local_sms", { from: "+15555550100", text: "Hi" }), LANDLORD);
    const opsCall = await post(port, "/mcp", callRpc("discover_storage"), LANDLORD);
    expect(qaCall.json).toMatchObject({ error: { code: -32602, message: "I can't do that from this chat." } });
    expect(opsCall.json).toMatchObject({ error: { code: -32602, message: "I can't do that from this chat." } });
    expect(namesFrom(listed.json)).not.toContain("inject_local_sms");
    expect(namesFrom(listed.json)).not.toContain("discover_storage");

    expect((await post(port, "/mcp/qa", listRpc, LANDLORD)).status).toBe(401);
    expect((await post(port, "/mcp/ops", listRpc, LANDLORD)).status).toBe(401);
    expect((await post(port, "/mcp/qa", callRpc("inject_local_sms", { from: "+15555550100", text: "Hi" }), LANDLORD)).status).toBe(401);
    expect((await post(port, "/mcp/ops", callRpc("discover_storage"), LANDLORD)).status).toBe(401);

    const qa = await post(port, "/mcp/qa", listRpc, QA);
    const ops = await post(port, "/mcp/ops", listRpc, OPS);
    expect(namesFrom(qa.json)).toEqual([...QA_TOOL_NAMES]);
    expect(namesFrom(ops.json)).toEqual([...OPS_TOOL_NAMES]);
  });

  it("fails closed when the ops or QA secret is missing, and the landlord connector still answers", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-scope-off-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const server = createSetupServer({
      workspace: new PropertyWorkspace(root),
      mcpAuth: "static",
      operatorToken: () => LANDLORD,
      opsToken: () => undefined,
      qaToken: () => undefined,
      log: () => {},
    });
    cleanups.push(() => server.close());
    const port = await listen(server);
    expect((await post(port, "/mcp/ops", listRpc, OPS)).json).toMatchObject({ error: { message: "The Tour Core ops connector is off." } });
    expect((await post(port, "/mcp/qa", listRpc, QA)).json).toMatchObject({ error: { message: "The Tour Core QA connector is off." } });
    expect((await post(port, "/mcp/ops", listRpc, OPS)).status).toBe(503);
    expect((await post(port, "/mcp/qa", listRpc, QA)).status).toBe(503);
    expect((await post(port, "/mcp", listRpc, LANDLORD)).status).toBe(200);
    expect(namesFrom((await post(port, "/mcp", listRpc, LANDLORD)).json)).toEqual([...LANDLORD_CORE_TOOLS]);
  });

  it("shows reset_hosted_demo only to the hosted owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-scope-owner-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const env: NodeJS.ProcessEnv = { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app" };
    const runtime = new FileRuntimeStore(join(root, "runtime"));
    const inst = new Installation({ root, runtime, env: () => env });
    inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    inst.files.setPublicBaseUrl(HOST, "RAILWAY");
    inst.files.writeState({ ...inst.files.state(), hostedTenant: { clientId: OWNER, boundAt: "2026-09-01T00:00:00.000Z" } });
    const now = Date.now();
    new OAuthGrantStore(runtime).addGrant({
      clientId: OWNER,
      clientName: "Grok",
      issuer: HOST,
      resource: `${HOST}/mcp`,
      scopes: [OPERATOR_SCOPE],
      createdAt: now,
      expiresAt: now + 86_400_000,
      accessHash: hashSecret(PRE_SPLIT),
      accessExpiresAt: now + 3_600_000,
    });
    const server = createSetupServer({ workspace: new PropertyWorkspace(root), installation: inst, mcpAuth: "oauth", log: () => {} });
    cleanups.push(() => server.close());
    const port = await listen(server);
    const listed = await post(port, "/mcp", listRpc, PRE_SPLIT);
    expect(listed.status).toBe(200);
    expect(namesFrom(listed.json)).toEqual([...LANDLORD_CORE_TOOLS, "reset_hosted_demo"]);
  });

  it("keeps a pre-split static token on the landlord connector", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-scope-static-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const server = createSetupServer({
      workspace: new PropertyWorkspace(root),
      mcpAuth: "static",
      operatorToken: () => LANDLORD,
      log: () => {},
    });
    cleanups.push(() => server.close());
    const port = await listen(server);
    expect(namesFrom((await post(port, "/mcp", listRpc, LANDLORD)).json)).toEqual([...LANDLORD_CORE_TOOLS]);
    const state = await post(port, "/mcp", callRpc("get_state"), LANDLORD);
    expect(state.status).toBe(200);
    expect(JSON.stringify(state.json)).not.toMatch(/can't run that tool/);
  });

  it("with TOURCORE_LEGACY_TOOLS=1, /mcp lists and calls inject_local_sms; with the flag off, that call is refused", async () => {
    const off = await legacySession(undefined);
    expect(off.names).toEqual([...LANDLORD_CORE_TOOLS]);
    const refused = await post(off.port, "/mcp", callRpc("inject_local_sms", { from: "+15555550100", text: "Hi" }), LANDLORD);
    expect(refused.json).toMatchObject({ error: { code: -32602, message: "I can't do that from this chat." } });

    const on = await legacySession("1");
    expect(on.names[0]).toBe("list_properties");
    expect(on.names).toContain("get_state");
    expect(on.names).toContain("list_properties");
    expect(on.names).toContain("get_installation_status");
    for (const name of QA_TOOL_NAMES) expect(on.names).toContain(name);
    for (const name of OPS_TOOL_NAMES) expect(on.names).toContain(name);
    const inject = on.tools.find((tool) => tool.name === "inject_local_sms");
    expect(inject?.description).toContain("Leave property out");
    const called = await post(on.port, "/mcp", callRpc("inject_local_sms", { from: "+15555550100", text: "Hi" }), LANDLORD);
    expect(called.status).toBe(200);
    const body = called.json as { error?: { message: string }; result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toBe("There aren't any properties set up yet.");

    expect(namesFrom((await post(on.port, "/mcp/qa", listRpc, QA)).json)).toEqual([...QA_TOOL_NAMES]);
    expect(namesFrom((await post(on.port, "/mcp/ops", listRpc, OPS)).json)).toEqual([...OPS_TOOL_NAMES]);
    expect(namesFrom((await post(off.port, "/mcp/qa", listRpc, QA)).json)).toEqual([...QA_TOOL_NAMES]);
    expect(namesFrom((await post(off.port, "/mcp/ops", listRpc, OPS)).json)).toEqual([...OPS_TOOL_NAMES]);
  });

  it("shared-line inject omits the property: a picker for two places, and a skip for one", async () => {
    const many = await sharedInject(["12 Scratch Lane, Teaneck, NJ 07666", "88 Pine St, Teaneck, NJ 07666"], { nameFirst: "Scratch House" });
    expect(many.result.sharedLine).toBe(true);
    expect(many.result.summary).toBe("Delivered the visitor text on the shared line.");
    const asked = (many.result.bubbles as Array<{ body: string }>).map((b) => b.body).join("\n");
    expect(asked).toContain("Which place are you touring?");
    expect(asked).toContain("Reply 1 or 2.");
    expect(asked).toContain("Scratch House");
    expect(asked).toContain("88 Pine St");

    resetLocalSmsOutbox();
    const one = await sharedInject(["12 Scratch Lane, Teaneck, NJ 07666"], { nameFirst: "Scratch House" });
    expect(one.result.sharedLine).toBe(true);
    const skipped = (one.result.bubbles as Array<{ body: string }>).map((b) => b.body).join("\n");
    expect(skipped).not.toContain("Which place are you touring?");
    expect(skipped.length).toBeGreaterThan(0);
  }, 120_000);
});

async function legacySession(flag: string | undefined): Promise<{ port: number; names: string[]; tools: Array<{ name: string; description?: string }> }> {
  const root = mkdtempSync(join(tmpdir(), "tourcore-scope-legacy-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = flag ? { TOURCORE_LEGACY_TOOLS: flag } : {};
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  const installation = new Installation({ root, runtime, env: () => env });
  const server = createSetupServer({
    workspace: new PropertyWorkspace(root),
    installation,
    mcpAuth: "static",
    operatorToken: () => LANDLORD,
    opsToken: () => OPS,
    qaToken: () => QA,
    log: () => {},
  });
  cleanups.push(() => server.close());
  const port = await listen(server);
  const tools = toolsFrom((await post(port, "/mcp", listRpc, LANDLORD)).json);
  return { port, names: tools.map((tool) => tool.name), tools };
}

async function sharedInject(addresses: string[], options: { nameFirst?: string }) {
  const h = grokHarness();
  cleanups.push(h.cleanup);
  for (const [index, address] of addresses.entries()) {
    h.setClock(h.now() + 60_000);
    const created = await h.ok("create_property_setup", {
      address,
      ...(index === 0 && options.nameFirst ? { name: options.nameFirst } : {}),
      propertyType: "SINGLE_FAMILY",
    });
    const id = created.setup.propertyId as string;
    await h.ok("add_unit", { property: id });
    await h.ok("set_unit_details", { property: id, units: [{ unit: "Main Home", bedrooms: "3", bathrooms: "2", monthlyRent: "$3,400", availability: "now" }] });
    await h.ok("set_tour_hours", { property: id, days: "weekdays", start: "9am", end: "5pm" });
    await h.ok("set_verification_policy", { property: id, level: "basic-form" });
    await h.ok("update_property_details", { property: id, skipVisitorHelp: true });
    await h.ok("set_services", { property: id, messaging: "local" });
    await h.ok("run_readiness_check", { property: id });
    h.workspace.recordDryTour(id, { passed: true, ranAt: new Date(h.now()).toISOString(), checks: [], audit: [] });
    await h.approve("publish_demo_property", { property: id });
  }
  const server = createSetupServer({
    workspace: h.workspace,
    mcpAuth: "static",
    operatorToken: () => LANDLORD,
    qaToken: () => QA,
    log: () => {},
  });
  cleanups.push(() => server.close());
  const port = await listen(server);
  const sent = await post(port, "/mcp/qa", callRpc("inject_local_sms", { from: "+15555550111", text: "Tour" }), QA);
  expect(sent.status).toBe(200);
  const body = sent.json as { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ text: string }> }; error?: { message: string } };
  expect(body.error).toBeUndefined();
  expect(body.result?.isError).not.toBe(true);
  return { result: body.result!.structuredContent!, h: h as GrokHarness };
}
