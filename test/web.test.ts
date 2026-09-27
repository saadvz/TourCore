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
  const created = await app.call("POST", "/api/properties", { address: "100 Alfred Way, Brooklyn, NY", name: "100 Alfred Way" });
  const id = created.body.summary.id as string;
  await app.cmd(id, "addDoor", { name: "Lobby Entrance", kind: "ENTRANCE" });
  await app.cmd(id, "addUnit", { name: "Unit 101", summary: "One-bedroom apartment" });
  const last = await app.cmd(id, "addUnit", { name: "Unit 102", summary: "Two-bedroom apartment" });
  for (const unit of last.body.view.units) await app.cmd(id, "setRoute", { unitId: unit.id, doorIds: unit.suggestedRoute });
  return { id, created };
}

describe("browser setup", () => {
  it("serves the page", async () => {
    const app = await startApp();
    const page = await app.call("GET", "/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Tour Core");
    expect((await app.call("GET", "/app.js")).status).toBe(200);
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
      "Property details", "Tour hours", "Unit routes", "Verification", "Messaging", "Records", "Durin access", "Audit/export",
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
    const created = await app.call("POST", "/api/properties", { address: "5 Elm St, Austin, TX" });
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

    const edited = await app.cmd(id, "renameUnit", { unitId: "unit_102", name: "Unit 202", alsoRenameDoor: true });
    expect(edited.body.summary).toMatchObject({ unsavedChanges: true, published: true });
    expect(edited.body.view.units[1]).toMatchObject({ name: "Unit 202", door: { name: "Unit 202 Door" } });

    const blockedPractice = await app.call("POST", `/api/properties/${id}/practice`, {});
    expect(blockedPractice.status).toBe(409);

    await app.call("POST", `/api/properties/${id}/readiness`, {});
    const publish = await app.call("POST", `/api/properties/${id}/publish`, {});
    expect(publish.body.published).toBe(false);
    expect(publish.body.blockers).toEqual([{ message: "The setup changed after the last practice tour. Please run it again.", next: { action: "practice", label: "Run a practice tour" } }]);
    expect(publish.body.summary.status).toBe("DRAFT");
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
