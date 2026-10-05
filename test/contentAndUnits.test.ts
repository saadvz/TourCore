import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findApprovedAnswer, approvedFacts } from "../src/core/facts";
import { classifyChange } from "../src/config/changeKinds";
import { TourCoreConfigShape } from "../src/config/tourCoreConfig";
import { missingProfileFields, nextProfileQuestion, parseBulkUnitDetails, parseProfileValue, profileFacts, type UnitProfile } from "../src/config/unitProfile";
import { Installation } from "../src/install/installation";
import { publicHealth } from "../src/install/checks";
import { INSTALLATION_COMPONENTS } from "../src/install/status";
import { OAuthGrantStore } from "../src/mcp/oauth/store";
import { setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { isCurrent } from "../src/setup/workspace";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { createSetupServer } from "../src/web/server";
import { fakeSendblue, LINE } from "./fakeSendblue";
import { at, grokHarness, type GrokHarness } from "./grokHarness";
import { fakeNetwork, SB_KEY, SB_SECRET } from "./installHarness";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function harness(): GrokHarness {
  const h = grokHarness();
  cleanups.push(h.cleanup);
  return h;
}

// ------------------------------------------------------------------------
// 1. The real fresh-install sequence, end to end over HTTP
// ------------------------------------------------------------------------

describe("real fresh-install sequence (HTTP, MCP, secure setup page)", () => {
  it("texting → first property → alerts offered → declined → readiness; alerts are never offered before the property", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-fresh-"));
    let clock = at(7);
    const TUNNEL = "https://brave-otter-lamp.trycloudflare.com";
    const TOKEN = "fresh-install-test-token";
    const net = fakeNetwork();
    const hooks: Array<{ url: string; secret?: string }> = [];
    const fake = fakeSendblue({ hooks, lines: [{ sendblue_number: LINE, status: "ONLINE" }] });
    const create = fake.client.webhooks.create.bind(fake.client.webhooks);
    fake.client.webhooks.create = async (body) => (hooks.push(...(body.webhooks as typeof hooks)), create(body));
    cleanups.push(setSendblueRuntime({ client: () => fake.client }));
    const runtime = new FileRuntimeStore(join(root, "runtime"));
    const installation = new Installation({ root, runtime, now: () => clock, fetch: net.fetch as never });
    net.state.health = () => publicHealth(installation);
    // What npm run bootstrap:grok leaves behind: a Grok-managed installation with a checked public address.
    installation.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    installation.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
    const server = createSetupServer({ workspace: new PropertyWorkspace(root), installation, now: () => new Date(clock), realNow: () => clock, operatorToken: () => TOKEN, log: () => {} });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    cleanups.push(() => {
      server.close();
      rmSync(root, { recursive: true, force: true });
    });
    let rpc = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const grok = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
      });
      const body = (await res.json()) as { result: { isError: boolean; structuredContent: unknown; content: Array<{ text: string }> } };
      if (body.result.isError) throw new Error(body.result.content[0]!.text);
      return body.result.structuredContent;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = (method: string, path: string, session: string, body?: unknown) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = httpRequest(
          { host: "127.0.0.1", port, path: `/api/install/${path}`, method, headers: { Host: `localhost:${port}`, "X-TourCore-Setup-Session": session, ...(data ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)) } : {}) } },
          (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
          },
        );
        req.on("error", reject);
        req.end(data);
      });

    const sequence: string[] = [];
    const nextStep = async () => {
      const s = await grok("get_next_installation_step");
      sequence.push(s.action);
      return s;
    };
    expect((await nextStep()).action).toBe("CHECK_PUBLIC_ENDPOINT");
    await grok("check_public_endpoint");
    expect((await nextStep()).action).toBe("CONNECT_GROK");
    // The operator approves the connection.
    new OAuthGrantStore(runtime, () => clock).addGrant({ clientId: "grok", clientName: "Grok", issuer: TUNNEL, resource: `${TUNNEL}/mcp`, scopes: ["tourcore.operator"], createdAt: clock, expiresAt: clock + 86_400_000, accessHash: "x", accessExpiresAt: clock + 3_600_000 });

    const texting = await nextStep();
    expect(texting).toMatchObject({ action: "CHOOSE_MESSAGING_PROVIDER" });
    await grok("choose_messaging_provider", { provider: "sendblue" });
    const connect = await nextStep();
    expect(connect).toMatchObject({ action: "CONNECT_VISITOR_MESSAGING", secureSetupStep: "visitor-messaging" });
    const link = await grok("get_secure_setup_url", { step: connect.secureSetupStep });
    const session = /#s=([^&]+)/.exec(link.url)![1]!;
    // Before any property, the secure setup page doesn't show alerts at all.
    expect((await page("GET", "status", session)).body.sections).toEqual({ visitorMessaging: true, operatorAlerts: false });
    expect((await page("POST", "visitor-messaging", session, { apiKey: SB_KEY, apiSecret: SB_SECRET, fromNumber: LINE })).body.ok).toBe(true);

    const drive = await nextStep();
    expect(drive.action).toBe("CONNECT_GOOGLE_DRIVE");
    await grok("use_local_demo_storage");
    // Sendblue READY, records kept locally, and no property: the ONLY next step is the first property. Alerts aren't offered.
    const property = await nextStep();
    expect(property).toMatchObject({ component: "PROPERTY", action: "SET_UP_PROPERTY", operatorMessage: "Everything needed to start is connected and tested. Would you like to add your first property?" });
    const status = await grok("get_installation_status");
    const alerts = status.components.find((c: { component: string }) => c.component === "OPERATOR_ALERTS");
    expect(alerts).toMatchObject({ state: "NOT_CONFIGURED", requirement: "RECOMMENDED" });
    expect(alerts.next).toBeUndefined();
    expect(JSON.stringify(status.nextStep)).not.toMatch(/alert/i);
    expect((await page("GET", "status", session)).body.sections.operatorAlerts).toBe(false);

    // The operator sets up the property (Setup Property skill), including unit details.
    await grok("create_property_setup", { address: "12 Elm St, Brooklyn, NY", name: "12 Elm St", propertyType: "APARTMENT_BUILDING" });
    await grok("add_unit", { name: "Unit 1A" });
    await grok("add_unit", { name: "Unit 1B" });
    const partial = await grok("set_unit_details", { details: "1A is 2 bed 1 bath for $2,300 and 1B is 1 bed 1 bath for $1,950" });
    expect(partial.nextQuestion).toBe("When are these units available?");
    // Unit details still missing: the property isn't "set up", so alerts still wait.
    expect((await nextStep()).action).toBe("FINISH_PROPERTY_SETUP");
    await grok("set_unit_details", { details: "1A is available now and 1B is available October 15" });
    await grok("add_door", { name: "Front Door", kind: "entrance" });
    for (const unit of ["1A", "1B"]) await grok("set_route", { unit, doors: ["Front Door", `Unit ${unit} Door`] });
    await grok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
    await grok("set_verification_policy", { level: "basic-form" });
    const help = await nextStep();
    expect(help).toMatchObject({
      action: "FINISH_PROPERTY_SETUP",
      operatorMessage:
        "What number can stuck visitors call? Pick one someone answers during tour hours. What email should visitors see when they text HELP?",
    });
    await grok("update_property_details", { skipVisitorHelp: true });

    // Only now: alerts are offered, and the page shows them.
    const offer = await nextStep();
    expect(offer).toMatchObject({
      component: "OPERATOR_ALERTS",
      action: "OFFER_OPERATOR_ALERTS",
      optional: true,
      operatorMessage: "Your property is configured. Would you like me to keep you updated when someone books, starts or finishes a tour, and alert you if something needs your input?",
    });
    // Texting was connected before the property, so the property uses it without being asked.
    expect((await grok("get_property_setup")).setup.visitorTexting).toBe("Connected");
    expect((await page("GET", "status", session)).body.sections.operatorAlerts).toBe(true);
    // "No thanks."
    await grok("skip_optional_setup", { component: "OPERATOR_ALERTS" });
    expect((await nextStep()).action).toBe("RUN_READINESS");

    expect(sequence).toEqual(["CHECK_PUBLIC_ENDPOINT", "CONNECT_GROK", "CHOOSE_MESSAGING_PROVIDER", "CONNECT_VISITOR_MESSAGING", "CONNECT_GOOGLE_DRIVE", "SET_UP_PROPERTY", "FINISH_PROPERTY_SETUP", "FINISH_PROPERTY_SETUP", "OFFER_OPERATOR_ALERTS", "RUN_READINESS"]);
  }, 20_000);

  it("the installation context file lists components in Tour Core's actual order and never calls alerts required", () => {
    const doc = readFileSync(new URL("../grok-template/context/installation.md", import.meta.url), "utf8");
    const rows = [...doc.matchAll(/^\| ([A-Z_]+)(?:, [A-Z_]+)* \|/gm)].map((m) => m[0].slice(2, -2).split(", ")).flat();
    const order = INSTALLATION_COMPONENTS.filter((c) => rows.includes(c));
    expect(rows.filter((r) => (INSTALLATION_COMPONENTS as readonly string[]).includes(r))).toEqual(order);
    expect(rows.indexOf("OPERATOR_ALERTS")).toBeGreaterThan(rows.indexOf("PROPERTY"));
    expect(doc).toMatch(/Alerts are never required and never come before the first property/);
  });
});

// ------------------------------------------------------------------------
// 2-5. Approved content vs structural changes, live facts, one confirmation
// ------------------------------------------------------------------------

async function publishedWithUnknownBedrooms(h: GrokHarness) {
  const id = await h.setUpAlfredWay();
  await h.ok("set_unit_details", { units: [{ unit: "101", bedrooms: "not sure" }] });
  // No other approved wording about bedrooms, so the question can't be answered yet.
  await h.ok("update_unit", { unit: "Unit 101", description: "Ground-floor apartment" });
  await h.ok("run_readiness_check");
  await h.ok("run_dry_tour");
  await h.approve("publish_demo_property", {});
  return id;
}

describe("approved content changes keep the property published", () => {
  it("a flagged bedroom question: one confirmation, structured value saved, clean visitor answer, still published, no re-checks", async () => {
    const h = harness();
    const id = await publishedWithUnknownBedrooms(h);
    const before = h.workspace.load(id).state;
    const v = await h.touringVisitor(id, { name: "Testy McTest" });
    await v.act("ask", { question: "I have a question. How many bedrooms are in the unit?" });
    const [issue] = (await h.ok("list_exceptions")).exceptions;
    expect(issue.summary).toContain("How many bedrooms are in the unit?");

    // Operator: "2 bedrooms."  → Grok calls the tool once and asks its question once.
    const asked = await h.ok("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "2 bedrooms" });
    expect(asked).toMatchObject({ status: "needs-confirmation", summary: 'I\'ll save "Unit 101 has 2 bedrooms" as an approved fact and send that answer to Testy. Continue?', visitorWillReceive: "Unit 101 has 2 bedrooms. Let me know if you have any other questions." });
    // Operator: "Yes."  → done; no second application-level confirmation.
    const done = await h.ok("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "2 bedrooms", confirmationCode: asked.confirmation.code });
    expect(done.status).toBeUndefined();
    expect(done).toMatchObject({ approvedFact: "Unit 101 has 2 bedrooms.", visitorAnswered: true, stillPublished: true, needsRecheck: false, setupStatus: "Published for demo" });
    expect(v.session.conversation.at(-1)!.text).toBe("Unit 101 has 2 bedrooms. Let me know if you have any other questions.");
    expect(JSON.stringify(v.session.conversation.at(-1))).not.toMatch(/About your question|property team shared|approved fact/);

    const after = h.workspace.load(id);
    expect(after.config.units.find((u) => u.id === "unit_101")!.profile!.bedrooms).toMatchObject({ status: "PROVIDED", value: 2 });
    expect(after.state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(after.state.readiness).toEqual(before.readiness);
    expect(after.state.dryTour).toEqual(before.dryTour);
    expect(isCurrent(after.state.readiness, after.state) && isCurrent(after.state.dryTour, after.state)).toBe(true);
    expect(await h.workspace.publishBlockers(id, new Date(h.now()))).toEqual([]);
    expect((await h.ok("list_exceptions", { includeHandled: true })).exceptions[0]).toMatchObject({ status: "resolved" });
    expect(h.workspace.contentChanges(id).at(-1)!.changes).toEqual(["Unit 101: bedrooms"]);
    // The same active tour already uses the canonical value.
    await v.act("ask", { question: "Sorry, how many bedrooms again?" });
    expect(v.session.conversation.at(-1)!.text).toBe("Unit 101 has 2 bedrooms.");
  });

  it("an active tour sees an operator's new fact immediately: no new reservation, restart, republish or session", async () => {
    const h = harness();
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    await v.act("ask", { question: "Is there a dishwasher?" });
    expect(v.session.conversation.at(-1)!.text).toMatch(/^I don't have that information/);
    await h.ok("update_unit", { unit: "Unit 101", facts: ["The kitchen has a dishwasher."] });
    expect(h.workspace.load(id).state.status).toBe("PUBLISHED_FOR_DEMO");
    await v.act("ask", { question: "Is there a dishwasher?" });
    expect(v.session.conversation.at(-1)!.text).toBe("Here's what the property team shared: The kitchen has a dishwasher.");
  });

  it("unit detail edits (rent, availability, description, amenities) stay published with checks intact", async () => {
    const h = harness();
    const id = await h.publish();
    await h.ok("set_unit_details", { units: [{ unit: "101", monthlyRent: "$2,050", availability: "November 1", squareFeet: "700", laundry: "In-unit washer and dryer" }] });
    await h.ok("update_unit", { unit: "Unit 102", description: "Two-bedroom with a balcony" });
    await h.ok("update_property_details", { facts: ["Street parking only."] });
    const { state } = h.workspace.load(id);
    expect(state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(isCurrent(state.readiness, state) && isCurrent(state.dryTour, state)).toBe(true);
  });

  it("structural route edit DOES invalidate readiness and publication", async () => {
    const h = harness();
    const id = await h.publish();
    await h.ok("add_door", { name: "Hallway Door", kind: "hallway" });
    await h.ok("set_route", { unit: "Unit 101", doors: ["Lobby Entrance", "Hallway Door", "Unit 101 Door"] });
    const { state } = h.workspace.load(id);
    expect(state.status).toBe("DRAFT");
    expect(isCurrent(state.readiness, state)).toBe(false);
    expect((await h.workspace.publishBlockers(id)).map((b) => b.code)).toEqual(expect.arrayContaining(["READINESS_OUT_OF_DATE", "DRY_TOUR_OUT_OF_DATE"]));
  });

  it("structural tour-hours edit DOES invalidate readiness and publication", async () => {
    const h = harness();
    const id = await h.publish();
    await h.ok("set_tour_hours", { end: "6pm" });
    const { state } = h.workspace.load(id);
    expect(state.status).toBe("DRAFT");
    expect(isCurrent(state.dryTour, state)).toBe(false);
  });

  it("the change classifier is the one place deciding content vs structural", () => {
    const cfg = JSON.parse(readFileSync(new URL("../config/demo-property.json", import.meta.url), "utf8"));
    const clone = () => structuredClone(cfg);
    const facts = clone();
    facts.property.facts = ["Gym on the roof."];
    const rent = clone();
    rent.units[0].profile.monthlyRent.value.amount = 2400;
    const directions = clone();
    directions.routes[0].stops[0].guidance = "Come in and turn left.";
    const hours = clone();
    hours.tourHours.end = "18:00";
    const verification = clone();
    verification.verificationMode = "mock";
    const route = clone();
    route.routes[0].stops.reverse();
    expect(classifyChange(cfg, cfg)).toBe("none");
    for (const c of [facts, rent, directions]) expect(classifyChange(cfg, c)).toBe("content");
    for (const c of [hours, verification, route]) expect(classifyChange(cfg, c)).toBe("structural");
  });
});

// ------------------------------------------------------------------------
// Minimum unit information
// ------------------------------------------------------------------------

describe("minimum unit information", () => {
  it("resolves natural bulk details into structured values, and never invents what wasn't said", () => {
    const names = ["Unit 1A", "Unit 1B", "Unit 2A", "Unit 2B"];
    const bulk = parseBulkUnitDetails("1A and 1B are 2 bed 1 bath for $2,200. 2A is 3 bed 2 bath for $2,800 and 2B is 2 bed 2 bath for $2,500.", names);
    expect(bulk.units).toEqual([
      { unit: "Unit 1A", values: { bedrooms: "2", bathrooms: "1", monthlyRent: "$2,200" } },
      { unit: "Unit 1B", values: { bedrooms: "2", bathrooms: "1", monthlyRent: "$2,200" } },
      { unit: "Unit 2A", values: { bedrooms: "3", bathrooms: "2", monthlyRent: "$2,800" } },
      { unit: "Unit 2B", values: { bedrooms: "2", bathrooms: "2", monthlyRent: "$2,500" } },
    ]);
    // Availability wasn't mentioned, so it's absent: not guessed.
    for (const u of bulk.units) expect(u.values.availability).toBeUndefined();
  });

  it("setup asks only for what's still missing, and summarizes concisely", async () => {
    const h = harness();
    await h.ok("create_property_setup", { address: "12 Elm St, Brooklyn, NY", name: "12 Elm St", propertyType: "APARTMENT_BUILDING" });
    for (const n of ["1A", "1B", "2A", "2B"]) await h.ok("add_unit", { name: n });
    const out = await h.ok("set_unit_details", { details: "1A and 1B are 2 bed 1 bath for $2,200. 2A is 3 bed 2 bath for $2,800 and 2B is 2 bed 2 bath for $2,500." });
    expect(out.lines).toEqual([
      "1A — 2 bed · 1 bath · $2,200/month · availability not given yet",
      "1B — 2 bed · 1 bath · $2,200/month · availability not given yet",
      "2A — 3 bed · 2 bath · $2,800/month · availability not given yet",
      "2B — 2 bed · 2 bath · $2,500/month · availability not given yet",
    ]);
    expect(out.nextQuestion).toBe("When are these units available?");
    expect(out.missing).toEqual([
      { unit: "1A", missing: ["availability"] },
      { unit: "1B", missing: ["availability"] },
      { unit: "2A", missing: ["availability"] },
      { unit: "2B", missing: ["availability"] },
    ]);
    const partly = await h.ok("set_unit_details", { units: [{ unit: "1A", availability: "now" }, { unit: "1B", availability: "not available yet" }] });
    expect(partly.nextQuestion).toBe("When are 2A, 2B available?");
    const done = await h.ok("set_unit_details", { details: "2A is available October 15 and 2B is available now" });
    expect(done.complete).toBe(true);
    expect(done.summary).toMatch(/Does that look right\?$/);
    expect(done.lines[1]).toBe("1B — 2 bed · 1 bath · $2,200/month · availability not listed");
  });

  it("a unit can't silently skip its basic information: readiness names what's missing; NOT_PROVIDED counts as answered", async () => {
    const h = harness();
    await h.ok("create_property_setup", { address: "100 Alfred Way, Brooklyn, NY", name: "100 Alfred Way", propertyType: "APARTMENT_BUILDING" });
    await h.ok("add_door", { name: "Lobby Entrance", kind: "entrance" });
    await h.ok("add_unit", { name: "Unit 101" });
    await h.ok("set_route", { unit: "Unit 101", doors: ["Lobby Entrance", "Unit 101 Door"] });
    await h.ok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
    const failing = await h.ok("run_readiness_check");
    expect(failing.passed).toBe(false);
    expect(failing.lines).toContain("\u2717 Unit information: Unit 101 still needs bedrooms, bathrooms, rent and availability (or say which you don't want listed).");
    await h.ok("set_unit_details", { units: [{ unit: "101", bedrooms: "studio", bathrooms: "1", monthlyRent: "don't list the price", availability: "I don't know" }] });
    expect((await h.ok("run_readiness_check")).passed).toBe(true);
    const unit = h.workspace.load("prop_100_alfred_way").config.units[0]!;
    expect(unit.profile).toMatchObject({ bedrooms: { status: "PROVIDED", value: 0 }, monthlyRent: { status: "NOT_PROVIDED" }, availability: { status: "NOT_PROVIDED" } });
  });

  it("explicit NOT_PROVIDED, $0 and studio are three different things", () => {
    const now = new Date("2026-09-28T12:00:00Z");
    expect(parseProfileValue("monthlyRent", "$0", now)).toMatchObject({ status: "PROVIDED", value: { amount: 0 } });
    expect(parseProfileValue("monthlyRent", "not sure", now)).toMatchObject({ status: "NOT_PROVIDED" });
    expect(parseProfileValue("monthlyRent", "don't list the price", now)).toMatchObject({ status: "NOT_PROVIDED" });
    expect(parseProfileValue("bedrooms", "studio", now)).toMatchObject({ status: "PROVIDED", value: 0 });
    expect(parseProfileValue("bedrooms", "0", now)).toMatchObject({ status: "PROVIDED", value: 0 });
    expect(parseProfileValue("availability", "not available yet", now)).toMatchObject({ status: "NOT_PROVIDED" });
    expect(parseProfileValue("availability", "October 15", now)).toMatchObject({ status: "PROVIDED", value: { text: "October 15", date: "2026-10-15" } });
    expect(() => parseProfileValue("bedrooms", "lots", now)).toThrow(/didn't understand the bedrooms/);
    expect(parseProfileValue("monthlyRent", "$2,200", now).updatedAt).toBe(now.toISOString());

    const unitWith = (name: string, profile: Record<string, unknown>) => ({ name, profile: profile as UnitProfile });
    const free = unitWith("Unit 1", { monthlyRent: parseProfileValue("monthlyRent", "$0", now) });
    const unlisted = unitWith("Unit 2", { monthlyRent: parseProfileValue("monthlyRent", "not sure", now) });
    const studio = unitWith("Unit 3", { bedrooms: parseProfileValue("bedrooms", "studio", now) });
    expect(profileFacts(free).map((f) => f.text)).toEqual(["Unit 1 rents for $0 a month."]);
    expect(profileFacts(unlisted)).toEqual([]);
    expect(profileFacts(studio).map((f) => f.text)).toEqual(["Unit 3 is a studio (no separate bedroom)."]);
    expect(missingProfileFields(unlisted)).toEqual(["bedrooms", "bathrooms", "availability"]);
    expect(nextProfileQuestion([unlisted])?.question).toBe("How many bedrooms does Unit 2 have?");
  });

  it("structured facts answer visitor questions; a NOT_PROVIDED value falls through to the safe unknown flow", async () => {
    const cfg = TourCoreConfigShape.parse(JSON.parse(readFileSync(new URL("../config/demo-property.json", import.meta.url), "utf8")));
    cfg.units[1]!.profile!.monthlyRent = { status: "NOT_PROVIDED" };
    const ask = (unit: string, q: string) => findApprovedAnswer(approvedFacts(cfg, unit), q).map((f) => f.text);
    expect(ask("apt_101", "How many bedrooms?")).toEqual(["Unit 101 has 2 bedrooms."]);
    expect(ask("apt_101", "How much is this unit?")).toEqual(["Unit 101 rents for $2,300 a month."]);
    expect(ask("apt_101", "When is it available?")).toEqual(["Unit 101 is available now."]);
    expect(ask("apt_102", "When is it available?")).toEqual(["Unit 102 is available October 15."]);
    expect(ask("apt_102", "What's the rent?")).toEqual([]);

    const h = harness();
    const id = await h.setUpAlfredWay();
    await h.ok("set_unit_details", { units: [{ unit: "101", monthlyRent: "not sure" }] });
    await h.ok("run_readiness_check");
    await h.ok("run_dry_tour");
    await h.approve("publish_demo_property", {});
    const v = await h.touringVisitor(id);
    await v.act("ask", { question: "How much is the rent?" });
    expect(v.session.conversation.at(-1)!.text).toMatch(/^I don't have that information/);
    expect((await h.ok("list_exceptions")).exceptions[0].what).toBe("Question with no approved answer");
  });

  it("readiness checks run on the demo property include unit information", async () => {
    const cfg = JSON.parse(readFileSync(new URL("../config/demo-property.json", import.meta.url), "utf8"));
    const result = await runReadinessCheck(cfg, { now: new Date(at(7)) });
    expect(result.checks.find((c) => c.id === "units")).toMatchObject({ label: "Unit information", ok: true });
  });
});
