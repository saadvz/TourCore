import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { zonedTimeToUtc } from "../src/core/timezone";
import { MessagingEndpoints } from "../src/messaging/endpoints";
import { setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { PropertyWorkspace, readinessView, runReadinessCheck } from "../src/setup";
import { FileRuntimeStore, MemoryRuntimeStore, type RuntimeStore } from "../src/storage/runtimeStore";
import { VisitorDemoRegistry } from "../src/visitor";
import { SessionPersistence } from "../src/visitor/durableSession";
import { RESTORE_TROUBLE } from "../src/visitor/messagingRouter";
import { createSetupServer } from "../src/web/server";
import { fakeSendblue, inbound, LINE, SECRET, sendblueEnv } from "./fakeSendblue";

/** Monday 28 Sep 2026 at the property; tours at 2:00 PM and 3:30 PM, doors 1:50 PM to 2:45 PM for the first. */
const at = (hour: number, minute = 0) => zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour, minute }, "America/New_York").getTime();
const PHONE = "+15550102000";
const PROPERTY = "prop_100_alfred_way";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function sendblueProperty(overrides: Partial<TourCoreConfig["property"]> = {}): TourCoreConfig {
  const config = loadConfig();
  return {
    ...config,
    messagingMode: "sendblue",
    property: { ...config.property, facts: ["Shared laundry room in the basement.", "Street parking only."], ...overrides },
  };
}

/**
 * A Tour Core install on disk that can be stopped and started again. Each
 * start is a brand-new server process as far as Tour Core can tell: new
 * registry, links, ledger, interpreter; only the folder is shared.
 */
async function durableApp(options: { line?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tourcore-restart-"));
  const fake = fakeSendblue();
  cleanups.push(setSendblueRuntime({ env: () => sendblueEnv(options.line ? { fromNumber: options.line, fromNumberRaw: options.line } : {}), client: () => fake.client }));
  let clock = at(7);
  const setup = new PropertyWorkspace(root);
  const { config } = setup.save(sendblueProperty());
  setup.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(clock) }));

  let server: Server | undefined;
  let port = 0;
  let visitors = new VisitorDemoRegistry();
  const logs: string[] = [];
  const start = async () => {
    visitors = new VisitorDemoRegistry();
    server = createSetupServer({ workspace: new PropertyWorkspace(root), now: () => new Date(clock), realNow: () => clock, dev: true, visitors, log: (l) => logs.push(l) });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  };
  const stop = () => new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  cleanups.push(() => {
    server?.close();
    rmSync(root, { recursive: true, force: true });
  });
  await start();

  let n = 0;
  const text = async (content: string, handle = `in_${++n}`, to = LINE) => {
    const before = fake.sent.length;
    const payload = { ...inbound(PHONE, content, handle), to_number: to, sendblue_number: to };
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/sendblue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "sb-signing-secret": SECRET },
      body: JSON.stringify(payload),
    });
    const replies = fake.sent.slice(before).filter((s) => s.number === PHONE).map((s) => s.content);
    const toTeam = fake.sent.slice(before).filter((s) => s.number !== PHONE).map((s) => s.content);
    return { status: res.status, body: await res.json(), replies, reply: replies.join("\n"), toTeam };
  };
  const local = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json()) as any };
  };
  const ws = () => new PropertyWorkspace(root);
  const tours = () => ws().listTours(PROPERTY).filter((t) => t.kind === "messaging");
  const bundle = (tourId = tours()[0]!.tourId) => ws().loadTour(PROPERTY, tourId)!.bundle;
  const runtime = () => new FileRuntimeStore(join(root, "runtime"));
  return {
    root,
    fake,
    logs,
    text,
    local,
    ws,
    tours,
    bundle,
    runtime,
    visitors: () => visitors,
    setClock: (t: number) => (clock = t),
    restart: async () => {
      await stop();
      await start();
    },
  };
}
type App = Awaited<ReturnType<typeof durableApp>>;

const tokenIn = (reply: string) => reply.match(/\/verify\/([A-Za-z0-9_-]+)/)![1]!;

async function bookToConsent(app: App) {
  await app.text("Hi");
  await app.text("1");
  await app.text("1");
}

async function bookAndVerify(app: App) {
  await bookToConsent(app);
  const consent = await app.text("YES");
  const token = tokenIn(consent.reply);
  await app.local("POST", `/api/verify/${token}`, { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: PHONE });
  return token;
}

async function liveView(app: App) {
  const { properties } = (await app.local("GET", "/api/properties")).body;
  const id = properties.find((p: { id: string }) => p.id === PROPERTY).activeVisitorDemo;
  return id ? (await app.local("GET", `/api/visitor-demos/${id}/live`)).body.live : undefined;
}

describe("a text-message tour picks up where it left off after a restart", () => {
  it("booking: a unit chosen before the restart, the time chosen after, one conversation", async () => {
    const app = await durableApp();
    await app.text("Hi");
    const unit = await app.text("1");
    expect(unit.reply).toContain("Reply 1 for 2:00 PM or 2 for 3:30 PM.");

    await app.restart();
    const time = await app.text("1");
    expect(time.reply).toContain("you're booked for 2:00 PM");
    expect(time.reply).toContain("Is it OK if I text you about this tour");

    expect(app.tours()).toHaveLength(1);
    const b = app.bundle();
    expect(b.reservations).toHaveLength(1);
    expect(b.auditEvents.filter((e) => e.type === "RESERVATION_CREATED")).toHaveLength(1);
    expect(new Set(b.messages.map((m) => m.correlationId))).toEqual(new Set([b.messages[0]!.correlationId]));
  });

  it("consent: a natural yes after the restart answers the consent question", async () => {
    const app = await durableApp();
    await bookToConsent(app);
    await app.restart();
    const consent = await app.text("yeah that's fine");
    expect(consent.reply).toContain("please fill out this short form");
    expect(app.bundle().consents).toHaveLength(1);
  });

  it("clarification: 'yes' after the restart still answers 'Are you at the property now?'", async () => {
    const app = await durableApp();
    await bookAndVerify(app);
    app.setClock(at(13, 58));
    expect((await app.text("I'm around back")).reply).toBe("Are you at the property now?\nReply YES or NO.");

    await app.restart();
    const yes = await app.text("yes");
    expect(yes.reply).toContain("Entrance is open for you now.");
    const b = app.bundle();
    expect(b.accessGrants.map((g) => g.doorId)).toEqual(["entrance"]);
    expect(b.consents).toHaveLength(1);
    expect(b.auditEvents.filter((e) => e.type === "FOLLOW_UP_RESPONSE")).toHaveLength(0);
  });

  it("verification link: issued before the restart, still works after", async () => {
    const app = await durableApp();
    await bookToConsent(app);
    const token = tokenIn((await app.text("YES")).reply);
    await app.restart();
    expect((await app.local("GET", `/api/verify/${token}`)).body).toMatchObject({ ok: true, property: "100 Alfred Way" });
    const done = await app.local("POST", `/api/verify/${token}`, { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: PHONE });
    expect(done.body).toMatchObject({ ok: true });
    expect(app.bundle().verifications).toHaveLength(1);
    expect(app.bundle().reservations[0]!.status).toBe("READY");
  });

  it("used link: stays used after the restart; no second verification", async () => {
    const app = await durableApp();
    const token = await bookAndVerify(app);
    await app.restart();
    expect((await app.local("GET", `/api/verify/${token}`)).status).toBe(410);
    const again = await app.local("POST", `/api/verify/${token}`, { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: PHONE });
    expect(again).toMatchObject({ status: 410, body: { message: "This form has already been completed. Check your messages for your tour details." } });
    expect(app.bundle().verifications).toHaveLength(1);
  });

  it("replaced link: the old one stays retired and the new one works after the restart; tokens aren't stored", async () => {
    const app = await durableApp();
    await bookToConsent(app);
    const a = tokenIn((await app.text("YES")).reply);
    const b = tokenIn((await app.text("where's the form?")).reply);
    expect(a).not.toBe(b);
    await app.restart();
    expect((await app.local("GET", `/api/verify/${a}`)).status).toBe(410);
    expect((await app.local("GET", `/api/verify/${b}`)).body).toMatchObject({ ok: true });

    const saved = readdirSync(join(app.root, "runtime", "verification")).map((f) => readFileSync(join(app.root, "runtime", "verification", f), "utf8")).join("\n");
    expect(saved).not.toContain(a);
    expect(saved).not.toContain(b);
    expect((await app.local("POST", `/api/verify/${b}`, { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "555-999-0000" })).body.message).toBe(
      "That phone number doesn't match the one you're texting from. Please use the same number.",
    );
  });

  it("active tour: inside Unit 101 before the restart, questions and finishing work after", async () => {
    const app = await durableApp();
    await bookAndVerify(app);
    app.setClock(at(13, 58));
    await app.text("I'm here");
    expect((await app.text("at unit 101")).reply).toContain("Unit 101 Door is open for you now.");

    await app.restart();
    expect((await app.text("does this place have laundry?")).reply).toBe("Here's what the property team shared: Shared laundry room in the basement.");
    expect((await app.text("I'm done")).reply).toContain("Would you like someone from the property team to follow up?");

    await app.restart();
    expect((await app.text("yeah have someone reach out")).reply).toContain("will be in touch soon");
    const b = app.bundle();
    expect(b.accessGrants.map((g) => [g.doorId, g.status])).toEqual([
      ["entrance", "REVOKED"],
      ["unit_101", "REVOKED"],
    ]);
    expect(b.auditEvents.filter((e) => e.type === "FOLLOW_UP_RESPONSE").map((e) => e.detail)).toEqual(["yes"]);
    expect(app.tours()).toHaveLength(1);
  });
});

describe("access after a restart is never looser", () => {
  it("wrong door is still denied without contacting Durin; repeating an opened door reuses its grant", async () => {
    const app = await durableApp();
    await bookAndVerify(app);
    app.setClock(at(13, 58));
    await app.text("I'm here");

    await app.restart();
    expect((await app.text("at unit 102")).reply).toContain("That door isn't part of your tour");
    await app.text("at the entrance");
    const live = await liveView(app);
    expect(live.dev.durinRequests).toBe(0);
    const b = app.bundle();
    expect(b.accessGrants.map((g) => g.doorId)).toEqual(["entrance"]);
    expect(b.auditEvents.find((e) => e.type === "ACCESS_DENIED" && e.doorId === "unit_102")?.code).toBe("DENY_WRONG_ROUTE");
    expect(b.auditEvents.some((e) => e.type === "ACCESS_ALLOWED" && e.detail.includes("reused grant"))).toBe(true);
  });

  it("a tour window that closed while Tour Core was off stays closed", async () => {
    const app = await durableApp();
    await bookAndVerify(app);
    await app.restart();
    app.setClock(at(16, 0));
    const late = await app.text("I'm here");
    expect(late.reply).toBe("Your tour time has ended, so I can't open doors anymore. Want me to find you another time?");
    expect(app.bundle().accessGrants).toHaveLength(0);
  });

  it("a revoked tour stays revoked and an operator hold stays in place", async () => {
    for (const change of ["revoke", "hold"] as const) {
      const app = await durableApp();
      await bookAndVerify(app);
      const session = app.visitors().latestForPhone(PROPERTY, PHONE, "messaging")!;
      if (change === "revoke") await session.core.revokeReservation(session.reservationId!, "operator called it off");
      else await session.core.placeOperatorHold(session.reservationId!, "checking something");
      await new SessionPersistence(app.ws(), app.runtime()).save(session);

      await app.restart();
      app.setClock(at(13, 58));
      await app.text("I'm here");
      const b = app.bundle();
      expect(b.reservations[0]!.status).toBe(change === "revoke" ? "REVOKED" : "OPERATOR_HOLD");
      expect(b.accessGrants).toHaveLength(0);
      expect(b.auditEvents.some((e) => e.type === "ACCESS_ALLOWED")).toBe(false);
    }
  });

  it("a finished tour is not reopened; texting HI starts a new one", async () => {
    const app = await durableApp();
    await bookAndVerify(app);
    app.setClock(at(13, 58));
    await app.text("I'm here");
    await app.text("done");
    await app.text("no");

    await app.restart();
    expect(await app.visitors().activeFor(PROPERTY)).toBeUndefined();
    expect((await app.local("GET", "/api/properties")).body.properties[0].activeVisitorDemo).toBeUndefined();
    expect((await app.text("thanks!")).reply).toBe("This tour has ended. Text HI any time to start a new one.");
    expect((await app.text("Hi")).reply).toContain("Which unit would you like to see?");
    expect(app.tours()).toHaveLength(2);
    const old = app.tours().find((t) => t.outcome === "finished")!;
    expect(app.bundle(old.tourId).reservations[0]!.status).toBe("COMPLETED");
  });
});

describe("retried webhooks after a restart", () => {
  it("an event processed before the restart is recognised afterwards and not run again", async () => {
    const app = await durableApp();
    await app.text("Hi", "evt-1");
    await app.text("1", "evt-2");
    const first = await app.text("1", "ABC");
    expect(first.replies).toHaveLength(1);

    await app.restart();
    const retry = await app.text("1", "ABC");
    expect(retry).toMatchObject({ status: 200, body: { duplicate: true }, replies: [] });
    const b = app.bundle();
    expect(b.reservations).toHaveLength(1);
    expect(b.auditEvents.filter((e) => e.type === "RESERVATION_CREATED")).toHaveLength(1);
    expect(b.messages.filter((m) => m.providerMessageId === "ABC")).toHaveLength(1);

    const ledger = JSON.parse(readFileSync(join(app.root, "runtime", "messaging-ledger", "ledger.json"), "utf8"));
    expect(ledger["sendblue:in:ABC"]).toMatchObject({ state: "done", provider: "sendblue", messageId: "ABC", duplicates: 1, correlationId: b.messages[0]!.correlationId });
    expect(ledger["sendblue:in:ABC"].processedAt).toBeTruthy();
  });

  it("carries over the ledger kept by older versions", async () => {
    const app = await durableApp();
    await app.text("Hi", "old-1");
    // Simulate an install from before the runtime folder: only the old ledger file exists.
    const current = readFileSync(join(app.root, "runtime", "messaging-ledger", "ledger.json"), "utf8");
    mkdirSync(join(app.root, "messaging"), { recursive: true });
    writeFileSync(join(app.root, "messaging", "ledger.json"), current);
    rmSync(join(app.root, "runtime", "messaging-ledger"), { recursive: true, force: true });

    await app.restart();
    expect((await app.text("Hi", "old-1")).body).toMatchObject({ duplicate: true });
    expect(existsSync(join(app.root, "runtime", "messaging-ledger", "ledger.json"))).toBe(true);
  });
});

describe("which property answers on which texting number", () => {
  it("resolves the property from the number texted; an unknown number gets no answer and creates nothing", async () => {
    const app = await durableApp();
    expect((await app.text("Hi")).reply).toContain("Welcome to the self-guided tour for 100 Alfred Way!");
    const stranger = await app.text("Hi", "x-1", "+15558887777");
    expect(stranger).toMatchObject({ status: 200, replies: [] });
    expect(app.tours()).toHaveLength(1);
    expect(app.logs.some((l) => l.includes("isn't connected to a property"))).toBe(true);
  });

  it("one number, one property: a second claim is refused, a move lets go of the old number", () => {
    const endpoints = new MessagingEndpoints(new MemoryRuntimeStore());
    expect(endpoints.attach({ address: "+15550009999", provider: "sendblue", propertyId: "prop_a" })).toEqual({ changed: true });
    expect(() => endpoints.attach({ address: "(555) 000-9999", provider: "sendblue", propertyId: "prop_b" })).toThrow(/already used for another property/);
    expect(endpoints.attach({ address: "+15550001111", provider: "sendblue", propertyId: "prop_a" })).toEqual({ changed: true, previous: "+15550009999" });
    expect(endpoints.resolve("+15550009999")).toBeUndefined();
    expect(endpoints.resolve("555-000-1111")?.propertyId).toBe("prop_a");
  });

  it("the readiness check shows the attached number and flags a number another property already uses", async () => {
    const app = await durableApp();
    const readiness = await app.local("POST", `/api/properties/${PROPERTY}/readiness`, {});
    expect(readiness.body.readiness.checks.map((c: { label: string }) => c.label)).toContain("Tour progress can be safely saved");
    expect((await app.local("GET", `/api/properties/${PROPERTY}/messaging`)).body.line).toBe(LINE);
    expect((await app.local("GET", "/api/properties")).body.properties[0].messagingLine).toBe(LINE);

    const other = sendblueProperty({ id: "prop_200_other_st", name: "200 Other St", address: "200 Other St" });
    app.ws().save({ ...other });
    const second = await app.local("POST", `/api/properties/prop_200_other_st/readiness`, {});
    const messaging = second.body.readiness.checks.find((c: { id: string }) => c.id === "messaging");
    expect(messaging.ok).toBe(false);
    expect(messaging.problems[0].message).toContain("already used for another property");
  });

  it("a changed texting number sends a published property back to draft until readiness passes again", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-line-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const ws = new PropertyWorkspace(root);
    const { config } = ws.save(sendblueProperty());
    ws.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(at(7)) }));
    const endpoints = new MessagingEndpoints(new FileRuntimeStore(join(root, "runtime")));
    endpoints.attach({ address: LINE, provider: "sendblue", propertyId: PROPERTY });
    const moved = endpoints.attach({ address: "+15550001111", provider: "sendblue", propertyId: PROPERTY });
    expect(moved.previous).toBe(LINE);
    const state = ws.invalidateReadiness(PROPERTY, "The texting number changed. Run the readiness check again.");
    expect(state).toMatchObject({ status: "DRAFT", readiness: { passed: false } });
    expect(ws.load(PROPERTY).state.publishedAt).toBeUndefined();
  });
});

describe("the operator's view after a restart", () => {
  it("reloading the browser shows the same live tour: visitor, unit, time, step, messages, questions, follow-up", async () => {
    const app = await durableApp();
    await bookAndVerify(app);
    app.setClock(at(13, 58));
    await app.text("I'm here");
    await app.text("at unit 101");
    await app.text("is there a gym?");

    await app.restart();
    const live = await liveView(app);
    expect(live).toMatchObject({
      active: true,
      source: "Real phone",
      visitorName: "Pat Smith",
      visitorPhone: PHONE,
      unitName: "Unit 101",
      status: "Touring",
      currentStep: "At Unit 101",
    });
    expect(live.tourTime).toContain("2:00 PM");
    expect(live.recentMessages.length).toBeGreaterThan(0);
    expect(live.questions.map((q: { text: string }) => q.text).join(" ")).toContain("gym");

    await app.text("done");
    await app.restart();
    expect((await liveView(app)).followUp).toBeUndefined();
    await app.text("yes");
    const tourId = app.tours()[0]!.tourId;
    const detail = (await app.local("GET", `/api/properties/${PROPERTY}/tours/${tourId}`)).body.tour;
    expect(detail.outcomeLabel).toBe("Finished");
  });
});

describe("restoring fails closed", () => {
  it("records that don't match are held for the team: the visitor is told, nothing opens, the server keeps running", async () => {
    const app = await durableApp();
    await bookAndVerify(app);
    // Tamper with the canonical records while Tour Core is off: the reservation now claims to be mid-tour with no matching identity check.
    const tour = app.tours()[0]!;
    const file = join(app.root, "properties", PROPERTY, "practice-tours", tour.tourId, "tour-export.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.verifications = [];
    saved.reservations[0].status = "TOURING";
    writeFileSync(file, JSON.stringify(saved));
    // And leave an unreadable snapshot beside it.
    writeFileSync(join(app.root, "runtime", "sessions", "vd_broken00000.json"), "{ not json");

    await app.restart();
    app.setClock(at(13, 58));
    const first = await app.text("I'm at unit 101");
    expect(first.replies).toEqual([RESTORE_TROUBLE]);
    // Team alerts appear in Tour Core's own views (they never go out over the visitor's line).
    expect(first.toTeam).toEqual([]);
    const summary = (await app.local("GET", "/api/properties")).body.properties[0];
    expect(summary.needsAttention).toHaveLength(1);
    expect(summary.needsAttention[0].message).toBe(`A text-message tour with ${PHONE} couldn't be picked up after a restart. Please reach out to them.`);
    expect(summary.needsAttention[0].dev.problem).toBe("The identity check on file doesn't match this tour's status.");
    expect(summary.activeVisitorDemo).toBeUndefined();
    expect(app.bundle(tour.tourId).accessGrants).toHaveLength(0);

    expect((await app.text("I'm here")).replies[0]).toContain("Text HI to start a new tour.");
    expect((await app.text("Hi")).reply).toContain("Which unit would you like to see?");
    expect(app.logs.some((l) => l.includes("couldn't be read"))).toBe(true);
  });

  it("canonical records win over a snapshot that fell behind", async () => {
    const app = await durableApp();
    await bookToConsent(app);
    // Snapshot written, then a later step only reached the canonical records (as if the process stopped in between).
    const sessionFile = readdirSync(join(app.root, "runtime", "sessions"))[0]!;
    const behind = readFileSync(join(app.root, "runtime", "sessions", sessionFile), "utf8");
    await app.text("yes");
    writeFileSync(join(app.root, "runtime", "sessions", sessionFile), behind);

    await app.restart();
    expect((await app.text("anything")).reply).toContain("Here's your identity form link again.");
    expect(app.logs.some((l) => l.includes("the tour records were used"))).toBe(true);
  });
});

describe("readiness: tour progress storage", () => {
  it("passes when active tours can be saved and read back", async () => {
    const result = await runReadinessCheck(sendblueProperty(), { now: new Date(at(7)), runtime: new MemoryRuntimeStore() });
    expect(result.checks.find((c) => c.id === "progress")).toMatchObject({ label: "Tour progress can be safely saved", ok: true });
  });

  it("fails in plain words when they can't, with the error kept for developers", async () => {
    const broken: RuntimeStore = {
      get: () => undefined,
      put: () => {
        throw new Error("EACCES: permission denied");
      },
      delete: () => {},
      list: () => ({ entries: [], damaged: [] }),
    };
    const result = await runReadinessCheck(sendblueProperty(), { now: new Date(at(7)), runtime: broken });
    const check = result.checks.find((c) => c.id === "progress")!;
    expect(check).toMatchObject({ label: "Saving tour progress", ok: false, problems: ["Tour Core can't safely save active tours right now."] });
    expect(result.passed).toBe(false);
    expect(readinessView(result).checks.find((c) => c.id === "progress")!.problems[0]!.dev).toMatchObject({ detail: "EACCES: permission denied" });
  });

  it("isn't part of the check for properties that don't use real phones", async () => {
    const result = await runReadinessCheck(loadConfig(), { now: new Date(at(7)), runtime: new MemoryRuntimeStore() });
    expect(result.checks.some((c) => c.id === "progress")).toBe(false);
  });
});
