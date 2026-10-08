import { request } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safetyHash } from "../src/config/changeKinds";
import { TourCoreConfigShape } from "../src/config/tourCoreConfig";
import { isBareTodayOrTonight, isGeneralTourHoursQuestion } from "../src/intent/tourHoursAsk";
import { Installation } from "../src/install/installation";
import { LANDLORD_CORE_TOOLS, OPS_TOOL_NAMES, QA_TOOL_NAMES } from "../src/mcp/scopes";
import { UNSET_ZONE_LINE } from "../src/setup/storedTimeZone";
import { configHash, PropertyWorkspace } from "../src/setup/workspace";
import { toursUnavailableText } from "../src/sms/templates";
import { tourHoursVisitorReply } from "../src/visitor/tourHoursQuestion";
import { VisitorDemoSession } from "../src/visitor";
import { writeJsonAtomic } from "../src/storage/atomicWrite";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { createSetupServer } from "../src/web/server";
import { installHarness } from "./installHarness";
import { at, hillsideConfig, liveApp } from "./liveApp";

/**
 * Phase 6a gate cases. Each behavior case fails on master 430bd96.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((run) => run()));

const HOURS_REPLY = "Tours run every day, 8 AM to midnight. Which day works for you? Just reply with a day, like today, tomorrow, or Saturday.";
const WEEKDAY_REPLY = "Tours run Monday to Friday, 9 AM to 5 PM. Which day works for you? Just reply with a day, like today, tomorrow, or Monday.";
const LANDLORD_REFUSAL = "That's no longer something I can do from this chat. Disconnect and reconnect Tour Core so I'm working from the current list, then ask me again.";
const TODAY_TIMES = "I have these times available Monday, Sep 28:\nReply 1 for 2:00 PM or 2 for 3:30 PM.";
const NO_MORE_TODAY = "There are no more tours today. The next one is Tuesday, Sep 29 at 2:00 PM. Reply yes to take it, or pick a day:";

function everyDayHours() {
  const config = hillsideConfig();
  config.tourHours = { ...config.tourHours, days: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"], start: "08:00", end: "23:59" };
  return config;
}

async function openDayMenu(a: Awaited<ReturnType<typeof liveApp>>, phone: string): Promise<void> {
  await a.textFrom(phone, "TOUR");
  await a.textFrom(phone, "YES");
  await a.textFrom(phone, "1");
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

async function post(port: number, path: string, body: unknown, token: string, session?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = (text ? JSON.parse(text) : {}) as { result?: { capabilities?: { tools?: { listChanged?: boolean } }; tools?: Array<{ name: string }>; structuredContent?: Record<string, unknown> }; error?: { message?: string } };
  return { status: res.status, json, session: res.headers.get("mcp-session-id") ?? undefined };
}

function readSse(port: number, path: string, token: string, session: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { Accept: "text/event-stream", Authorization: `Bearer ${token}`, "Mcp-Session-Id": session },
      },
      (res) => {
        let buf = "";
        const finish = () => {
          res.destroy();
          resolve(buf);
        };
        res.on("data", (chunk) => {
          buf += chunk.toString();
          if (buf.includes("notifications/tools/list_changed")) finish();
        });
        res.on("end", finish);
        res.on("error", finish);
      },
    );
    req.on("error", reject);
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error("timed out waiting for tools/list_changed"));
    });
    req.end();
  });
}

describe("hours reply names a day the visitor can say", () => {
  it("uses Saturday when Saturday is open, and the next reply opens that day", async () => {
    const a = await liveApp({ cleanups, config: everyDayHours() });
    const phone = "+15550106001";
    await openDayMenu(a, phone);
    expect(await a.textFrom(phone, "what are your hours")).toEqual([HOURS_REPLY]);
    const saturday = await a.textFrom(phone, "Saturday");
    expect(saturday.join("\n")).toContain("I have these times available Saturday, Oct 3:");
    expect(saturday.join("\n")).toContain("8:00 AM");
    expect((await a.grok("list_exceptions")).exceptions).toEqual([]);
  });

  it("names Monday when the saved days are weekdays", () => {
    expect(tourHoursVisitorReply({ days: ["MON", "TUE", "WED", "THU", "FRI"], start: "09:00", end: "17:00" }).body).toBe(WEEKDAY_REPLY);
    expect(isGeneralTourHoursQuestion("what are your hours tonight")).toBe(false);
  });
});

describe("bare today and tonight", () => {
  it("opens today's remaining times for tonight? and tonight, and does not tell the team", async () => {
    const a = await liveApp({ cleanups });
    const phone = "+15550106002";
    await openDayMenu(a, phone);
    expect(isBareTodayOrTonight("tonight?")).toBe(true);
    expect(isBareTodayOrTonight("tonight")).toBe(true);
    expect(await a.textFrom(phone, "tonight?")).toEqual([TODAY_TIMES]);
    expect((await a.grok("list_exceptions")).exceptions).toEqual([]);
    expect(await a.textFrom(phone, "tonight")).toEqual([TODAY_TIMES]);
    expect((await a.grok("list_exceptions")).exceptions).toEqual([]);

    const bare = await liveApp({ cleanups });
    const unanswered = "+15550106004";
    await openDayMenu(bare, unanswered);
    const id = readdirSync(join(bare.root, "properties")).find((name) => existsSync(join(bare.root, "properties", name, "tourcore.config.json")));
    if (!id) throw new Error("property missing");
    const path = join(bare.root, "properties", id, "tourcore.config.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as { tourHours: { days: string[] } };
    raw.tourHours.days = [];
    writeJsonAtomic(path, raw);
    const statusPath = join(bare.root, "properties", id, "status.json");
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as { configHash: string };
    status.configHash = configHash(TourCoreConfigShape.parse(raw));
    writeJsonAtomic(statusPath, status);
    expect(await bare.textFrom(unanswered, "tonight?")).toEqual(["I'll pass your question to the property team, and they'll reply here as soon as they can."]);
    const issues = (await bare.grok("list_exceptions")).exceptions as Array<{ summary: string }>;
    expect(issues.map((issue) => issue.summary)).toContain('Asked "tonight?". There\'s no approved answer yet.');
  });

  it("says there are no more tours today when the last start has passed", async () => {
    const clock = { t: at(16) };
    const a = await liveApp({ cleanups, clock });
    const phone = "+15550106003";
    await openDayMenu(a, phone);
    const replies = await a.textFrom(phone, "tonight?");
    expect(replies.join("\n")).toContain(NO_MORE_TODAY);
    expect((await a.grok("list_exceptions")).exceptions).toEqual([]);
  });
});

describe("missing time zone field", () => {
  it("reads a published file with no timezone field as unset and does not write the field back", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const path = join(h.root, "properties", id, "tourcore.config.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as { property: { timezone?: string } };
    delete raw.property.timezone;
    writeJsonAtomic(path, raw);
    const parsed = TourCoreConfigShape.parse(JSON.parse(readFileSync(path, "utf8")));
    const statusPath = join(h.root, "properties", id, "status.json");
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as { configHash: string; status: string };
    status.status = "PUBLISHED_FOR_DEMO";
    status.configHash = configHash(parsed);
    writeJsonAtomic(statusPath, status);

    const loaded = h.workspace.load(id);
    expect(loaded.config.property.timezone).toBe("");
    expect(loaded.state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(JSON.parse(readFileSync(path, "utf8")).property.timezone).toBeUndefined();
    const picture = await h.ok("get_state", { propertyId: id });
    expect(picture.summary).toBe(UNSET_ZONE_LINE);
    expect(picture.nextStep.say).toBe(UNSET_ZONE_LINE);
  });
});

describe("published zone cleared during a tour", () => {
  it("keeps the open grant, blocks the next door and a new tour, and flags the inbox until a zone is set", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.visitor(id);
    const [first, last] = "Pat Smith".split(" ");
    await v.act("chooseTime", { slotStart: v.slot().toISOString() });
    await v.act("consent", { agree: true });
    await v.act("submitIdentity", { firstName: first, lastName: last, email: "pat@example.com", phone: "555-010-2000" });
    h.setClock(v.slot().getTime());
    await v.act("arrive");
    const before = (await v.session.store.list("accessGrants")).filter((grant) => grant.status === "ACTIVE");
    expect(before).toHaveLength(1);

    const path = join(h.root, "properties", id, "tourcore.config.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as { property: { timezone: string } };
    raw.property.timezone = "";
    writeJsonAtomic(path, raw);
    const parsed = TourCoreConfigShape.parse(raw);
    const presentedSafety = safetyHash(parsed);
    const statusPath = join(h.root, "properties", id, "status.json");
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as {
      configHash: string;
      status: string;
      readiness?: { safetyHash?: string };
      dryTour?: { safetyHash?: string };
    };
    status.status = "PUBLISHED_FOR_DEMO";
    status.configHash = configHash(parsed);
    if (status.readiness) status.readiness.safetyHash = presentedSafety;
    if (status.dryTour) status.dryTour.safetyHash = presentedSafety;
    writeJsonAtomic(statusPath, status);
    const loaded = h.workspace.load(id);
    expect(loaded.state.status).toBe("PUBLISHED_FOR_DEMO");
    v.session.applyPublishedConfig(loaded.config);

    await v.act("atStop", { doorId: "unit_101_door" });
    const after = (await v.session.store.list("accessGrants")).filter((grant) => grant.status === "ACTIVE");
    expect(after).toHaveLength(1);
    expect(after[0]!.doorId).toBe(before[0]!.doorId);
    expect(v.session.conversation.map((item) => item.text).join("\n")).toContain(toursUnavailableText(loaded.config.property.name, loaded.config.operator.name));

    const fresh = h.visitors.add(
      new VisitorDemoSession(id, h.workspace.load(id).config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }),
    );
    await fresh.act("begin", { name: "Sam Lee", phone: "(555) 010-2099" });
    expect(await fresh.reservation()).toBeUndefined();
    expect(fresh.conversation.map((item) => item.text).join("\n")).toContain("aren't available right now");

    const picture = await h.ok("get_state", { propertyId: id });
    expect(picture.summary).toBe(UNSET_ZONE_LINE);
    expect(picture.nextStep.say).toBe(UNSET_ZONE_LINE);
    const inbox = await h.ok("get_inbox", { property: id });
    expect(JSON.stringify(inbox)).toContain(UNSET_ZONE_LINE);
    const zone = (inbox.items as Array<{ what?: string; exceptionId?: string; tourRef?: string; kind?: string; status?: string }>).find((item) => item.what === "Time zone needed");
    expect(zone).toMatchObject({ kind: "issue", status: "open", summary: UNSET_ZONE_LINE });
    expect(zone?.exceptionId).toBeUndefined();
    expect(zone?.tourRef).toBeUndefined();
    expect(inbox.summary).toBe("1 thing needs you.");
    const exceptions = await h.ok("list_exceptions", { property: id });
    expect(JSON.stringify(exceptions)).not.toContain(UNSET_ZONE_LINE);

    await h.ok("save_property", { property: id, timezone: "Eastern" });
    const cleared = await h.ok("get_state", { propertyId: id });
    expect(cleared.summary).not.toBe(UNSET_ZONE_LINE);
    expect(cleared.nextStep.say).not.toBe(UNSET_ZONE_LINE);
    const inboxAfter = await h.ok("get_inbox", { property: id });
    expect(JSON.stringify(inboxAfter)).not.toContain(UNSET_ZONE_LINE);
    expect(inboxAfter.summary).toBe("Nothing needs you right now.");
  });
});

describe("connector list refresh and the deployed commit", () => {
  const LANDLORD = "landlord-token-phase6a-123456";
  const OPS = "ops-token-phase6a-123456";
  const QA = "qa-token-phase6a-123456";
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  function serverFor(env: NodeJS.ProcessEnv) {
    const root = mkdtempSync(join(tmpdir(), "tourcore-phase6a-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
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
    return server;
  }

  it("advertises listChanged on every connector and sends tools/list_changed after initialized", async () => {
    const server = serverFor({});
    const port = await listen(server);
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grok", version: "1" } } };
    for (const [path, token, count] of [
      ["/mcp", LANDLORD, LANDLORD_CORE_TOOLS.length],
      ["/mcp/ops", OPS, OPS_TOOL_NAMES.length],
      ["/mcp/qa", QA, QA_TOOL_NAMES.length],
    ] as const) {
      const started = await post(port, path, init, token);
      expect(started.json.result?.capabilities?.tools?.listChanged, path).toBe(true);
      const session = started.session;
      expect(session, path).toBeTruthy();
      const accepted = await post(port, path, { jsonrpc: "2.0", method: "notifications/initialized" }, token, session);
      expect(accepted.status).toBe(202);
      const sse = await readSse(port, path, token, session!);
      expect(sse).toContain('"method":"notifications/tools/list_changed"');
      const listed = await post(port, path, { jsonrpc: "2.0", id: 2, method: "tools/list" }, token, session);
      expect(listed.json.result?.tools).toHaveLength(count);
    }
    const refused = await post(port, "/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "inject_local_sms", arguments: { from: "+15555550100", text: "Hi" } } }, LANDLORD);
    expect(refused.json.error?.message).toBe(LANDLORD_REFUSAL);
  });

  it("puts the full deploy SHA on /mcp/qa get_installation_status and leaves it off the landlord connector", async () => {
    const env: NodeJS.ProcessEnv = { RAILWAY_GIT_COMMIT_SHA: SHA, GITHUB_SHA: "should-not-win", TOURCORE_LEGACY_TOOLS: "1" };
    const server = serverFor(env);
    const port = await listen(server);
    const call = (path: string, token: string, name: string) =>
      post(port, path, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name, arguments: {} } }, token);

    const qa = await call("/mcp/qa", QA, "get_installation_status");
    const technical = (qa.json.result?.structuredContent?.technical ?? {}) as { commit?: string };
    expect(technical.commit).toBe(SHA);

    const landlord = await call("/mcp", LANDLORD, "get_state");
    expect(JSON.stringify(landlord.json)).not.toContain(SHA);
    expect(JSON.stringify(landlord.json)).not.toContain('"commit"');

    const legacy = await call("/mcp", LANDLORD, "get_installation_status");
    expect(JSON.stringify(legacy.json)).not.toContain(SHA);
    expect((legacy.json.result?.structuredContent?.technical as { commit?: string } | undefined)?.commit).toBeUndefined();

    delete env.RAILWAY_GIT_COMMIT_SHA;
    env.GITHUB_SHA = "githubsha0123456789abcdef0123456789abcd";
    const fromGithub = await call("/mcp/qa", QA, "get_installation_status");
    expect((fromGithub.json.result?.structuredContent?.technical as { commit?: string }).commit).toBe("githubsha0123456789abcdef0123456789abcd");
    delete env.GITHUB_SHA;
    env.VERCEL_GIT_COMMIT_SHA = "vercelsha0123456789abcdef0123456789abcd";
    const other = await call("/mcp/qa", QA, "get_installation_status");
    expect((other.json.result?.structuredContent?.technical as { commit?: string }).commit).toBe("vercelsha0123456789abcdef0123456789abcd");

    delete env.VERCEL_GIT_COMMIT_SHA;
    const missing = await call("/mcp/qa", QA, "get_installation_status");
    expect((missing.json.result?.structuredContent?.technical as { commit?: string }).commit).toBe("unknown");
  });
});
