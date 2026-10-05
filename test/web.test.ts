import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PropertyWorkspace } from "../src/setup";
import { createSetupServer } from "../src/web/server";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

async function startApp(dev = false) {
  const root = mkdtempSync(join(tmpdir(), "tourcore-web-"));
  const server: Server = createSetupServer({ workspace: new PropertyWorkspace(root), dev });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  cleanup.push(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : undefined };
  };
  const cmd = (id: string, name: string, input: unknown) => call("POST", `/api/properties/${id}/commands/${name}`, { input });
  return { call, cmd, root, port };
}

/** What an operator does in the browser, as the API calls the page makes. */
async function setUpAlfredWay(app: Awaited<ReturnType<typeof startApp>>) {
  const created = await app.call("POST", "/api/properties", { address: "100 Alfred Way, Brooklyn, NY", name: "100 Alfred Way", propertyType: "APARTMENT_BUILDING" });
  const id = created.body.summary.id as string;
  await app.cmd(id, "addDoor", { name: "Lobby Entrance", kind: "ENTRANCE" });
  await app.cmd(id, "addUnit", { name: "Unit 101", summary: "One-bedroom apartment" });
  const last = await app.cmd(id, "addUnit", { name: "Unit 102", summary: "Two-bedroom apartment" });
  for (const unit of last.body.view.units) {
    await app.cmd(id, "setUnitProfile", { unitId: unit.id, values: { bedrooms: unit.name === "Unit 101" ? "1" : "2", bathrooms: "1", monthlyRent: "$2,000", availability: "now" } });
    await app.cmd(id, "setRoute", { unitId: unit.id, doorIds: unit.suggestedRoute });
  }
  return { id, created };
}

describe("browser setup", () => {
  it("serves the page", async () => {
    const app = await startApp();
    const page = await app.call("GET", "/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Tour Core");
    const appJs = await app.call("GET", "/app.js");
    expect(appJs.status).toBe(200);
    expect(appJs.text).toContain("Use a team name that reads naturally after");
    expect(appJs.text).toContain("Maple Leasing team");
    expect(appJs.text).not.toContain("your own name");
    expect(appJs.text).toContain("What number can stuck visitors call? Pick one someone answers during tour hours.");
    expect(appJs.text).not.toContain("What email should visitors see when they text HELP?");
  });

  it("goes from a new property to published for demo through the real setup actions", async () => {
    const app = await startApp();
    const { id, created } = await setUpAlfredWay(app);
    expect(created.body.summary).toMatchObject({ status: "IN_PROGRESS", saved: false });
    expect(created.body.view.property).toMatchObject({ timezone: "America/New_York", timezoneLabel: "Eastern Time" });

    const property = await app.call("GET", `/api/properties/${id}`);
    expect(property.body.view.canSave).toBe(true);
    expect(property.body.view.reviewCards.find((c: { title: string }) => c.title === "Unit 101").route.text).toBe("Lobby Entrance \u2192 Unit 101 Door");

    const readiness = await app.call("POST", `/api/properties/${id}/readiness`, {});
    expect(readiness.body.readiness.passed).toBe(true);
    expect(readiness.body.readiness.checks.map((c: { label: string }) => c.label)).toEqual([
      "Property details", "Unit information", "Tour hours", "Unit routes", "Verification", "Messaging", "Records", "Durin access", "Audit/export",
    ]);
    expect(readiness.body.summary.saved).toBe(true);

    const practice = await app.call("POST", `/api/properties/${id}/practice`, {});
    expect(practice.body.practice.passed).toBe(true);
    const safety = practice.body.practice.groups.find((g: { id: string }) => g.id === "safety");
    expect(safety.items.at(-1)).toMatchObject({ label: "Visitor tries Unit 102 Door", outcome: "Access correctly denied before Durin was contacted", ok: true });

    const published = await app.call("POST", `/api/properties/${id}/publish`, {});
    expect(published.body).toMatchObject({ published: true, summary: { status: "PUBLISHED_FOR_DEMO", statusLabel: "Published for demo" } });

    const list = await app.call("GET", "/api/properties");
    expect(list.body.properties).toHaveLength(1);
    expect(list.body.properties[0]).toMatchObject({ name: "100 Alfred Way", published: true, hasHistory: true });

    const history = await app.call("GET", `/api/properties/${id}/history`);
    const sentences = history.body.entries.map((e: { text: string }) => e.text);
    expect(sentences).toContain("Access to Unit 102 Door was denied because it was not part of Pat's tour.");

    const download = await app.call("GET", `/api/properties/${id}/export/records.json`);
    expect(download.headers.get("content-disposition")).toContain("attachment");
  });

  it("saves the optional visitor help number from the services step", async () => {
    const app = await startApp();
    const { id } = await setUpAlfredWay(app);
    const saved = await app.cmd(id, "setAlertContact", { name: "Leasing team", visitorContact: "(555) 010-4444" });
    expect(saved.body.view.operator).toMatchObject({ visitorContact: "+15550104444" });
    expect(saved.body.view.operator.supportEmail).toBeUndefined();
    expect(saved.body.view.reviewCards.find((c: { title: string }) => c.title === "Records and messages").rows).toEqual(
      expect.arrayContaining(["Visitors can call: (555) 010-4444"]),
    );
    expect(saved.body.view.reviewCards.find((c: { title: string }) => c.title === "Records and messages").rows.join("\n")).not.toMatch(/Support email/);
    const skipped = await app.cmd(id, "setAlertContact", { name: "Leasing team", visitorContact: "" });
    expect(skipped.body.view.operator).toMatchObject({ visitorContact: "" });
    expect(skipped.body.view.reviewCards.find((c: { title: string }) => c.title === "Records and messages").rows).toEqual(
      expect.arrayContaining(["Visitors can call: not set"]),
    );
  });

  it("hides codes, adapter names and file paths from operators", async () => {
    const app = await startApp();
    const { id } = await setUpAlfredWay(app);
    await app.call("POST", `/api/properties/${id}/readiness`, {});
    const practice = await app.call("POST", `/api/properties/${id}/practice`, {});
    const history = await app.call("GET", `/api/properties/${id}/history`);
    const property = await app.call("GET", `/api/properties/${id}`);
    for (const res of [practice, history, property]) {
      expect(res.text).not.toMatch(/DENY_|ACCESS_DENIED|MockDurin|InMemoryStore|"dev"/);
      expect(res.text).not.toContain(app.root.replace(/\\/g, "\\\\"));
    }
  });

  it("shows technical details in developer mode", async () => {
    const app = await startApp(true);
    const { id } = await setUpAlfredWay(app);
    await app.call("POST", `/api/properties/${id}/readiness`, {});
    await app.call("POST", `/api/properties/${id}/practice`, {});
    const history = await app.call("GET", `/api/properties/${id}/history`);
    expect(history.text).toContain("DENY_WRONG_ROUTE");
    expect(history.body.dev.folder).toContain("practice-tours");
    expect((await app.call("GET", "/api/meta")).body.dev).toBe(true);
  });

  it("points readiness failures at the exact thing to fix", async () => {
    const app = await startApp();
    const created = await app.call("POST", "/api/properties", { address: "5 Elm St, Austin, TX", propertyType: "MULTIFAMILY_HOME" });
    const id = created.body.summary.id;
    await app.cmd(id, "addDoor", { name: "Front Door", kind: "ENTRANCE" });
    await app.cmd(id, "addUnit", { name: "Loft" });
    const readiness = await app.call("POST", `/api/properties/${id}/readiness`, {});
    expect(readiness.body.readiness.passed).toBe(false);
    expect(readiness.body.savedChanges).toBe(false);
    const routes = readiness.body.readiness.checks.find((c: { id: string }) => c.id === "routes");
    expect(routes.problems[0]).toEqual({ message: "Loft does not have a complete route.", fix: { step: "routes", label: "Fix route", unitId: "loft" } });
  });

  it("edits one unit of a published property without silently republishing", async () => {
    const app = await startApp();
    const { id } = await setUpAlfredWay(app);
    await app.call("POST", `/api/properties/${id}/readiness`, {});
    await app.call("POST", `/api/properties/${id}/practice`, {});
    await app.call("POST", `/api/properties/${id}/publish`, {});

    // A valid edit is saved immediately, which takes the property back to draft until it's checked again.
    const edited = await app.cmd(id, "renameUnit", { unitId: "unit_102", name: "Unit 202", alsoRenameDoor: true });
    expect(edited.body.summary).toMatchObject({ unsavedChanges: false, published: false, status: "DRAFT", save: { state: "saved", label: "All changes saved" } });
    expect(edited.body.view.units[1]).toMatchObject({ name: "Unit 202", door: { name: "Unit 202 Door" } });

    await app.call("POST", `/api/properties/${id}/readiness`, {});
    const publish = await app.call("POST", `/api/properties/${id}/publish`, {});
    expect(publish.body.published).toBe(false);
    expect(publish.body.blockers).toEqual([{ message: "The setup changed after the last practice tour. Please run it again.", next: { action: "practice", label: "Run a practice tour" } }]);

    // An edit with problems is kept as a draft; the saved setup is untouched and practice waits for a fix.
    const broken = await app.cmd(id, "setRoute", { unitId: "unit_101", doorIds: ["unit_101_door"] });
    expect(broken.body.summary.save).toEqual({ state: "draft", label: "Changes kept as a draft until 1 problem is fixed" });
    expect((await app.call("POST", `/api/properties/${id}/practice`, {})).status).toBe(409);
  });

  it("runs a visitor demo from the phone while the operator watches, then keeps it in history", async () => {
    const app = await startApp();
    const { id } = await setUpAlfredWay(app);
    await app.call("POST", `/api/properties/${id}/readiness`, {});
    const started = await app.call("POST", `/api/properties/${id}/visitor-demos`, {});
    expect(started.body.visitorUrl).toBe(`/visitor?s=${started.body.sessionId}`);
    expect((await app.call("GET", started.body.visitorUrl)).text).toContain("Visitor demo");

    const sid = started.body.sessionId as string;
    const tap = async (action: string, input: unknown = {}) => (await app.call("POST", `/api/visitor-demos/${sid}/actions/${action}`, { input })).body.visitor;
    await tap("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    let phone = await tap("chooseUnit", { unitId: "unit_101" });
    phone = await tap("chooseDate", phone.choices[0].input);
    phone = await tap("chooseTime", phone.choices[0].input);
    await tap("consent", { agree: true });
    phone = await tap("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "555-010-2000" });
    if (phone.demoControls.some((c: { action: string }) => c.action === "demoSkipAhead")) await tap("demoSkipAhead");
    phone = await tap("arrive");
    phone = await tap("demoWrongDoor");
    expect(phone.thread.at(-1).text).toBe("Demo safety check: Tour Core refused this door and never contacted Durin.");
    expect(phone.dev).toBeUndefined();

    const live = await app.call("GET", `/api/visitor-demos/${sid}/live`);
    expect(live.body.live).toMatchObject({ visitorName: "Pat Smith", unitName: "Unit 101", status: "Touring" });
    expect(live.text).not.toMatch(/DENY_|MockDurin|"dev"/);
    expect(live.body.live.recent.map((e: { text: string }) => e.text)).toContain("Access to Unit 102 Door was denied because it was not part of Pat's tour.");

    const list = (await app.call("GET", "/api/properties")).body.properties[0];
    expect(list).toMatchObject({ activeVisitorDemo: sid, hasHistory: true });
    const tours = (await app.call("GET", `/api/properties/${id}/tours`)).body.tours;
    expect(tours[0]).toMatchObject({ kindLabel: "Visitor demo", outcomeLabel: "In progress", visitorName: "Pat Smith" });
    const detail = (await app.call("GET", `/api/properties/${id}/tours/${tours[0].id}`)).body.tour;
    expect(detail.conversation.some((m: { from: string; text: string }) => m.from === "visitor" && m.text === "I'm here.")).toBe(true);
  });

  it("lets the operator change a booked visitor's tour time; 'move to now' exists only in developer mode", async () => {
    for (const dev of [false, true]) {
      const app = await startApp(dev);
      const { id } = await setUpAlfredWay(app);
      await app.call("POST", `/api/properties/${id}/readiness`, {});
      const sid = (await app.call("POST", `/api/properties/${id}/visitor-demos`, {})).body.sessionId as string;
      const tap = async (action: string, input: unknown = {}) => (await app.call("POST", `/api/visitor-demos/${sid}/actions/${action}`, { input })).body.visitor;
      await tap("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
      let phone = await tap("chooseUnit", { unitId: "unit_101" });
      phone = await tap("chooseDate", phone.choices[0].input);
      await tap("chooseTime", phone.choices[0].input);
      await tap("consent", { agree: true });
      await tap("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "555-010-2000" });

      const { times, anyTime } = (await app.call("GET", `/api/visitor-demos/${sid}/times`)).body;
      expect(times.length).toBeGreaterThan(0);
      expect(Boolean(anyTime)).toBe(dev);
      const moved = await app.call("POST", `/api/visitor-demos/${sid}/reschedule`, { startsAt: times[0].startsAt });
      expect(moved.body.live).toMatchObject({ status: "Ready, waiting for arrival", canReschedule: true });
      expect(moved.body.live.recentMessages.at(-1).text).toContain("Your tour has moved to");
      const bad = await app.call("POST", `/api/visitor-demos/${sid}/reschedule`, { startsAt: "2026-01-01T03:00:00.000Z" });
      expect(bad.status).toBe(400);

      const now = await app.call("POST", `/api/visitor-demos/${sid}/move-to-now`, {});
      expect(now.status).toBe(dev ? 200 : 404);
      const sundayNight = await app.call("POST", `/api/visitor-demos/${sid}/reschedule`, { localTime: "2099-09-27T19:45" });
      expect(sundayNight.status).toBe(dev ? 200 : 404);
      if (dev) expect(sundayNight.body.live.tourTime).toContain("7:45 PM");
    }
  });

  it("shows access codes and Durin call counts on the phone only in developer mode", async () => {
    const app = await startApp(true);
    const { id } = await setUpAlfredWay(app);
    await app.call("POST", `/api/properties/${id}/readiness`, {});
    const sid = (await app.call("POST", `/api/properties/${id}/visitor-demos`, {})).body.sessionId;
    const phone = (await app.call("GET", `/api/visitor-demos/${sid}`)).body.visitor;
    expect(phone.dev).toMatchObject({ durinRequests: 0 });
  });

  it("explains mistakes plainly and rejects requests from other sites", async () => {
    const app = await startApp();
    const { id } = await setUpAlfredWay(app);
    const dupe = await app.cmd(id, "addUnit", { name: "Unit 101" });
    expect(dupe.status).toBe(400);
    expect(dupe.body.error).toEqual({ message: 'There\'s already a unit called "Unit 101".' });

    const form = await fetch(`http://127.0.0.1:${app.port}/api/properties`, { method: "POST", body: "address=x", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(form.status).toBe(415);
  });
});
