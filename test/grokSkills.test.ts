import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/tourCoreConfig";
import { publicHealth } from "../src/install/checks";
import { handleSecureSetupApi } from "../src/install/secureSetup";
import { setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { fakeSendblue } from "./fakeSendblue";
import { at, grokHarness, type GrokHarness } from "./grokHarness";
import { installHarness, ROUTINE_KEY, ROUTINE_URL, SB_KEY, SB_SECRET } from "./installHarness";

/**
 * One deterministic scenario per Grok operator skill. Each follows the
 * skill's own sequence: the operator's words (comments), the tool calls the
 * skill prescribes (through the MCP bridge, as Grok Bot makes them), and what
 * Tour Core returns for Grok to say. Every tool used must be in the skill's
 * allowed-tools. No Grok account, network or model involved.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function allowedTools(skill: string): Set<string> {
  const text = readFileSync(new URL(`../.grok/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
  return new Set(/^allowed-tools:\s*(.+)$/m.exec(text)![1]!.split(/[\s,]+/).filter(Boolean));
}

/** A Grok Bot session running one skill: every call goes through MCP tools/call and must be allowed by the skill. */
function skillSession(skill: string, h: GrokHarness = grokHarness()) {
  cleanups.push(h.cleanup);
  const allowed = allowedTools(skill);
  const used: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    expect(allowed, `${skill} doesn't allow ${name}`).toContain(name);
    used.push(name);
    const reply = (await h.mcp("tools/call", { name, arguments: args })).body as { result: { isError: boolean; structuredContent?: unknown; content: Array<{ text: string }> } };
    return reply.result.isError ? { error: reply.result.content[0]!.text } : reply.result.structuredContent;
  };
  const yes = async (name: string, args: Record<string, unknown>) => {
    const asked = await tool(name, args);
    expect(asked.status).toBe("needs-confirmation");
    return { asked, done: await tool(name, { ...args, confirmationCode: asked.confirmation.code }) };
  };
  return { h, tool, yes, used };
}

describe("Grok skill scenarios", () => {
  it("Setup Property: a natural operator conversation creates a valid setup and ends published", async () => {
    const { h, tool, yes } = skillSession("setup-property");
    // "I want to set up my building."  Grok: "Sure. What's the address?"
    expect((await tool("list_properties")).properties).toEqual([]);
    // "100 Alfred Way, Brooklyn NY."
    const created = await tool("create_property_setup", { address: "100 Alfred Way, Brooklyn, NY", name: "100 Alfred Way" });
    expect(created.summary).toBe("Started 100 Alfred Way. I guessed Eastern Time for the time zone; please confirm.");
    // "Two units, 101 and 102." / "The lobby entrance." / "No hallway doors."
    await tool("add_unit", { name: "Unit 101", description: "One-bedroom" });
    await tool("add_unit", { name: "Unit 102", description: "Two-bedroom" });
    await tool("add_door", { name: "Lobby Entrance", kind: "entrance" });
    for (const unit of ["101", "102"]) {
      const preview = await tool("preview_route", { unit, doors: ["lobby entrance", "unit door"] });
      expect(preview.status).toBe("ok");
      // "Yep."
      await tool("set_route", { unit, doors: preview.route });
    }
    // "Weekdays, 9 to 5."
    expect((await tool("set_tour_hours", { days: "weekdays", start: "9", end: "5" })).summary).toBe("Monday-Friday, 9:00 AM-5:00 PM. That's up to 8 tours a day.");
    // "Basic form."  "Real texts."  (Sendblue isn't connected in this test, so stay on practice texts.)
    await tool("set_verification_policy", { level: "basic-form" });
    expect((await tool("get_services")).records.choices.map((c: { label: string }) => c.label)).toEqual(["On this computer", "A folder in your Google Drive"]);

    const review = await tool("review_property_setup");
    expect(review).toMatchObject({ canSave: true, problems: [], saved: "All changes saved" });
    expect(validateConfig(h.workspace.load("prop_100_alfred_way").config)).toEqual([]);
    // "Yes." Grok: "Great. I'll check the setup and run a practice tour before publishing."
    expect((await tool("run_readiness_check")).passed).toBe(true);
    expect((await tool("run_dry_tour")).passed).toBe(true);
    const { asked, done } = await yes("publish_demo_property", {});
    expect(asked.summary).toBe("Everything passed. Do you want me to publish 100 Alfred Way for demo?");
    expect(done.published).toBe(true);
  });

  it("Map Route: an ambiguous route gets a question back, and nothing is saved until it's clear", async () => {
    const h = grokHarness();
    const { tool } = skillSession("map-route", h);
    await h.ok("create_property_setup", { address: "100 Alfred Way, Brooklyn, NY", name: "100 Alfred Way" });
    await h.ok("add_door", { name: "Lobby Entrance", kind: "entrance" });
    await h.ok("add_door", { name: "Garden Entrance", kind: "entrance" });
    await h.ok("add_door", { name: "Second Floor Hallway", kind: "hallway" });
    await h.ok("add_unit", { name: "Unit 201" });

    // "Unit 201 uses the entrance, then the hallway, then the unit door."
    expect((await tool("list_doors")).doors.map((d: { name: string }) => d.name)).toEqual(["Lobby Entrance", "Garden Entrance", "Second Floor Hallway", "Unit 201 Door"]);
    const first = await tool("preview_route", { unit: "201", doors: ["the entrance", "hallway", "unit door"] });
    expect(first.status).toBe("needs-clarification");
    expect(first.summary).toBe('"the entrance" could be Lobby Entrance or Garden Entrance. Which one?');
    expect((await tool("get_route", { unit: "201" })).route).toBeUndefined();

    // "The garden one."
    const second = await tool("preview_route", { unit: "201", doors: ["garden entrance", "hallway", "unit door"] });
    expect(second.summary).toBe("I have: Garden Entrance \u2192 Second Floor Hallway \u2192 Unit 201 Door. Is that right?");
    // "Yes."
    await tool("set_route", { unit: "201", doors: second.route, directions: "Up the stairs on the left" });
    expect(await tool("get_route", { unit: "201" })).toMatchObject({ route: ["Garden Entrance", "Second Floor Hallway", "Unit 201 Door"], directions: "Up the stairs on the left" });
  });

  it("Run Readiness Check: a real failure is surfaced as-is, then passes once fixed", async () => {
    const h = grokHarness();
    const { tool } = skillSession("run-readiness-check", h);
    await h.setUpAlfredWay();
    // Real texts chosen, but this computer has no Sendblue set up: the real messaging check fails.
    await h.ok("set_services", { messaging: "sendblue" });
    const failing = await tool("run_readiness_check");
    expect(failing.passed).toBe(false);
    const messaging = failing.checks.find((c: { check: string }) => c.check === "Visitor messaging");
    expect(messaging.ok).toBe(false);
    expect(messaging.problems.length).toBeGreaterThan(0);
    expect(failing.lines.filter((l: string) => l.startsWith("\u2717"))).toHaveLength(1);
    expect(JSON.stringify(failing)).not.toMatch(/SENDBLUE_|_NOT_|CHECK_FAILED/);

    // Operator: "Use practice texts for now."
    await h.ok("set_services", { messaging: "demo" });
    expect((await tool("run_readiness_check")).passed).toBe(true);
  });

  it("Simulate Tour: a successful practice tour with its proof points, and nobody texted", async () => {
    const h = grokHarness();
    const { tool } = skillSession("simulate-tour", h);
    await h.setUpAlfredWay();
    const result = await tool("run_dry_tour", { unit: "Unit 102" });
    expect(result.passed).toBe(true);
    expect(result.proofPoints).toContain("\u2713 Unit 102 access was allowed");
    expect(result.proofPoints).toContain("\u2713 Unit 101 Door (not on the route) was denied before Durin was contacted");
    expect(result.proofPoints.every((p: string) => p.startsWith("\u2713"))).toBe(true);
    expect(h.visitors.all()).toHaveLength(0);
  });

  it("Work Exception: an unknown visitor question shows up in the queue and the operator resolves it", async () => {
    const h = grokHarness();
    const { tool, yes } = skillSession("work-exception", h);
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    await v.act("ask", { question: "Is parking included?" });

    // "Show active tours."
    const [tour] = (await tool("list_active_tours")).tours;
    expect(tour).toMatchObject({ visitorName: "Pat Smith", unitName: "Unit 101", status: "Touring" });
    // "What's happening with Pat's tour?"
    const inspected = await tool("inspect_tour", { tourRef: tour.tourRef });
    expect(inspected.needsAttention).toHaveLength(1);
    expect(inspected.tour.questions.at(-1)).toContain('Pat asked "Is parking included?"');

    // "Show me what needs attention."
    const queue = await tool("list_exceptions");
    expect(queue.exceptions.map((x: { visitorName: string; unitName: string; summary: string; tourStatus: string }) => [x.visitorName, x.unitName, x.summary, x.tourStatus])).toEqual([
      ["Pat Smith", "Unit 101", 'Asked "Is parking included?". There\'s no approved answer yet.', "Tour still active"],
    ]);
    // "Open Pat's issue."
    const opened = await tool("inspect_exception", { exceptionId: queue.exceptions[0].exceptionId });
    expect(opened.issue.recentMessages.at(-1).text).toContain("I've flagged it for the property team");
    // "Yes, parking is included."  Grok offers; "Yes."
    const { asked, done } = await yes("answer_flagged_question", { exceptionId: opened.issue.exceptionId, approvedFact: "Parking is included." });
    expect(asked.visitorWillReceive).toBe('About your question "Is parking included?": here\'s what the property team shared: Parking is included.');
    expect(done.visitorAnswered).toBe(true);
    expect((await tool("list_exceptions")).summary).toBe("Nothing needs attention right now.");
  });

  it("Work Exception: a door-system failure and a tour that couldn't be restored both reach the queue, and access stays blocked", async () => {
    const h = grokHarness();
    h.services.needsAttention = () => [{ visitorPhone: "+15550104444", problem: "The reservation doesn't belong to this visitor.", at: new Date(at(8)).toISOString() }];
    const { tool, yes } = skillSession("work-exception", h);
    const id = await h.publish();
    const v = await h.visitor(id);
    await v.act("chooseTime", { slotStart: v.slot().toISOString() });
    await v.act("consent", { agree: true });
    await v.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "555-010-2000" });
    h.setClock(v.slot().getTime());
    v.session.durin.requestAccess = async () => ({ ok: false, reason: "lock offline" });
    await v.act("arrive");

    const queue = await tool("list_exceptions");
    const byWhat = Object.fromEntries(queue.exceptions.map((x: { what: string }) => [x.what, x]));
    expect(byWhat["Door system problem"]).toMatchObject({ summary: "Durin couldn't open Lobby Entrance, so the tour was paused.", accessBlocked: true, tourStatus: "Door system problem. Access is blocked." });
    expect(byWhat["Tour couldn't be restored"]).toMatchObject({ visitorName: "A visitor texting from +15550104444", accessBlocked: true });

    // "The lock's back. Resume Pat's tour." "Yes."
    const [tour] = (await tool("list_active_tours")).tours;
    expect(tour.paused).toBe(true);
    await yes("clear_operator_hold", { tourRef: tour.tourRef });
    // "I called the restored-tour visitor." -> mark handled
    await tool("resolve_exception", { exceptionId: byWhat["Tour couldn't be restored"].exceptionId, resolutionNote: "Called them back." });
    // The door-system pause no longer applies once resumed; it stays in the history as cleared.
    expect((await tool("list_exceptions")).exceptions).toEqual([]);
    const history = (await tool("list_exceptions", { includeHandled: true })).exceptions.map((x: { what: string; status: string }) => [x.what, x.status]);
    expect(history).toEqual(expect.arrayContaining([["Door system problem", "cleared"], ["Tour couldn't be restored", "resolved"]]));
  });

  it("Export Audit: a validated audit export with a plain summary", async () => {
    const h = grokHarness();
    const { tool } = skillSession("export-audit", h);
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    await v.act("finish");
    // "Export today's audit."
    const out = await tool("export_audit", { day: "today" });
    expect(out.totals).toMatchObject({ tours: 1, completed: 1, practiceTours: 1, openIssues: 0 });
    expect(out.reference).toMatch(/^Audit export 2026-09-28_.+, saved with 100 Alfred Way's tour records on the Tour Core computer\.$/);
    expect(out.files.map((f: { file: string }) => f.file)).toEqual(["audit-export.json", "audit.csv"]);
    // The same export can be opened from the browser app's API on the Tour Core computer.
    const { handleApi } = await import("../src/web/api");
    const exportId = /^Audit export (\S+),/.exec(out.reference)![1]!;
    const file = await handleApi({ workspace: h.workspace, dev: false }, "GET", `/api/properties/${id}/audit-exports/${exportId}/audit-export.json`, undefined);
    expect("download" in file && JSON.parse(file.download.content).summary.tours).toBe(1);
  });
});

describe("Install Tour Core skill", () => {
  const text = readFileSync(new URL("../.grok/skills/install-tour-core/SKILL.md", import.meta.url), "utf8");
  const sequence = text.slice(text.indexOf("## Sequence"), text.indexOf("## Validate"));

  it("checks status before acting, bootstraps only when the runtime is absent, and uses secure setup for credentials", () => {
    expect(sequence.indexOf("get_installation_status")).toBeGreaterThan(-1);
    expect(sequence.indexOf("get_installation_status")).toBeLessThan(sequence.indexOf("npm run bootstrap:grok"));
    expect(sequence).toContain("Don't reinstall something\nthat's running.".replace(/\n/g, text.includes("\r\n") ? "\r\n" : "\n"));
    expect(sequence).toMatch(/Install and start on your cloud computer \(only when Tour Core is absent or not answering\)/);
    expect(sequence).toContain("get_secure_setup_url");
    expect(sequence).toContain("OPERATOR_IN_SECURE_SETUP");
    expect(sequence).toContain("get_next_installation_step");
    // Property setup starts only once the infrastructure is ready.
    expect(sequence).toMatch(/Only once `infrastructureReady` is true and the next step is PROPERTY/);
  });

  it("never asks for a secret in chat and never names a private repository", () => {
    const requests = [
      /\b(paste|send|share|give|tell|type)\b[^.\n]{0,20}\b(me|us|here)\b[^.\n]{0,40}\b(key|secret|token|password|credential)s?\b/i,
      /\bwhat(?:'s| is) your\b[^.\n]{0,30}\b(key|secret|token|password)\b/i,
      /\b(key|secret|token|password)s?\b[^.\n]{0,30}\bin (the )?chat\b(?![^.\n]*\b(never|not|don't|without)\b)/i,
    ];
    for (const pattern of requests) expect(text).not.toMatch(pattern);
    expect(text).toMatch(/not in chat/);
    expect(text).not.toMatch(/github\.com\/[\w.-]+\/[\w.-]+/i);
    expect(text).toContain("TOURCORE_REPO_URL");
    // Outside its list of prohibitions, the skill never asks the operator to run anything.
    expect(text.slice(0, text.indexOf("## Never"))).not.toMatch(/(?<!never )ask (the operator|them) to run/i);
  });

  it("scenario: \"Set up Tour Core\" follows Tour Core's next steps with only the skill's tools, and reaches property setup once infrastructure is ready", async () => {
    const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
    const { tool, used } = skillSession("install-tour-core", h);
    const hooks: Array<{ url: string }> = [];
    const fake = fakeSendblue({ hooks, lines: [{ sendblue_number: "+15550109999", status: "ONLINE" }] });
    const create = fake.client.webhooks.create.bind(fake.client.webhooks);
    fake.client.webhooks.create = async (body) => (hooks.push(...(body.webhooks as Array<{ url: string }>)), create(body));
    cleanups.push(setSendblueRuntime({ client: () => fake.client }));
    h.net.state.health = () => publicHealth(h.inst);

    /** The operator typing into the secure setup page Grok opened (never through Grok). */
    const operatorFillsIn = async (url: string, body: Record<string, string>) => {
      const token = /#s=([^&]+)/.exec(url)![1]!;
      const route = url.includes("step=operator-alerts") ? "operator-alerts" : "visitor-messaging";
      const out = await handleSecureSetupApi({ installation: h.inst, services: h.services }, "POST", `/api/install/${route}`, { "x-tourcore-setup-session": token }, body);
      expect(out.status).toBe(200);
    };

    // "Set up Tour Core."
    const first = await tool("get_installation_status");
    expect(used[0]).toBe("get_installation_status");
    const performed: string[] = [];
    let step = first.nextStep;
    for (let i = 0; i < 12 && step.component !== "PROPERTY"; i++) {
      performed.push(`${step.action}:${step.performedBy}`);
      if (step.action === "ESTABLISH_PUBLIC_ENDPOINT") {
        // Grok runs `npm run bootstrap:grok` in its own terminal (covered in bootstrap.test.ts); here, its outcome.
        expect(step.command).toBe("npm run bootstrap:grok");
        h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
        h.inst.files.setPublicBaseUrl("https://brave-otter-lamp.trycloudflare.com", "CLOUDFLARE_QUICK_TUNNEL");
      } else if (step.action === "CONNECT_GROK") {
        h.connectGrok(); // the operator clicks Allow on Tour Core's connection page
      } else if (step.performedBy === "OPERATOR_IN_SECURE_SETUP") {
        const link = await tool("get_secure_setup_url", { step: step.secureSetupStep });
        expect(link.url).toContain(`step=${step.secureSetupStep}`);
        await operatorFillsIn(link.url, step.secureSetupStep === "operator-alerts" ? { webhookUrl: ROUTINE_URL, key: ROUTINE_KEY } : { apiKey: SB_KEY, apiSecret: SB_SECRET, fromNumber: "+15550109999" });
      } else if (step.performedBy === "GROK" && step.tool) {
        expect((await tool(step.tool)).ok).not.toBe(false);
      } else throw new Error(`Unexpected step ${step.action}`);
      step = (await tool("get_next_installation_step")) as typeof step;
    }
    expect(performed).toEqual([
      "ESTABLISH_PUBLIC_ENDPOINT:GROK",
      "CHECK_PUBLIC_ENDPOINT:GROK",
      "CONNECT_GROK:OPERATOR",
      "CONNECT_VISITOR_MESSAGING:OPERATOR_IN_SECURE_SETUP",
      "CONNECT_OPERATOR_ALERTS:OPERATOR_IN_SECURE_SETUP",
    ]);
    const status = await tool("get_installation_status");
    expect(status.infrastructureReady).toBe(true);
    expect(status.nextStep).toMatchObject({ component: "PROPERTY", action: "SET_UP_PROPERTY", skill: "setup-property", operatorMessage: "No property is configured yet. Want to set one up?" });
    expect(status.lines.slice(0, 7)).toEqual([
      "\u2713 Tour Core runtime: Tour Core is running.",
      "\u2713 Public address: Tour Core is reachable at its public address.",
      "\u2713 Grok connection: Grok is connected.",
      "\u2713 Visitor messaging: Visitors can text +15550109999.",
      "\u2713 Operator alerts: Tour Core can alert you when a visitor needs attention.",
      "\u2713 Tour records: Tour records are stored with this Tour Core installation.",
      "\u2713 Access system: Demo. No real doors open.",
    ]);
    // Nothing Grok saw carries a credential.
    const seen = JSON.stringify(await tool("get_installation_status")) + JSON.stringify(first);
    for (const secret of [SB_KEY, SB_SECRET, ROUTINE_URL, ROUTINE_KEY]) expect(seen).not.toContain(secret);
  });
});
