import { request, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccessWindows } from "../src/operator/accessWindows";
import { formatAuditDaySummary } from "../src/operator/auditExport";
import { safetyHash } from "../src/config/changeKinds";
import { TourCoreConfigShape, validateConfig } from "../src/config/tourCoreConfig";
import { isGeneralTourHoursQuestion } from "../src/intent/tourHoursAsk";
import { MessagingEndpoints } from "../src/messaging/endpoints";
import { presentStoredTimeZone, UNSET_ZONE_LINE } from "../src/setup/storedTimeZone";
import { UNKNOWN_ANSWER } from "../src/core/TourCore";
import { toursUnavailableText } from "../src/sms/templates";
import { configHash, PropertyWorkspace, statusLabel } from "../src/setup/workspace";
import { MessagingConversations } from "../src/visitor/messagingRouter";
import { VerificationLinks } from "../src/visitor/verificationLinks";
import { writeJsonAtomic } from "../src/storage/atomicWrite";
import { handlePortableRequest } from "../src/backup/http";
import { createSetupServer } from "../src/web/server";
import { grokHarness, type GrokHarness } from "./grokHarness";
import { installHarness } from "./installHarness";
import { hillsideConfig, liveApp, type LiveApp } from "./liveApp";

/**
 * Phase 5c gate cases. Each case fails on master 8a69f5d and passes here.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((run) => run()));

function use(h: GrokHarness = grokHarness()): GrokHarness {
  cleanups.push(h.cleanup);
  return h;
}

const ZIP_CA = "That ZIP doesn't look like it's in California. Which one should I fix, the ZIP or the state?";
const HOURS_REPLY = "Tours run every day, 8 AM to midnight. Which day works for you? Just reply with a day, like today, tomorrow, or Saturday.";
const FRIDAY_TIMES = "I have these times available Friday, Oct 2:\nReply 1 for 2:00 PM or 2 for 3:30 PM.";
const PRACTICE_SIX = "No visitors were turned away. 6 practice-tour denials.";
const PRACTICE_ONE = "No visitors were turned away. 1 practice-tour denial.";

async function openDayMenu(a: LiveApp, phone: string): Promise<void> {
  await a.textFrom(phone, "TOUR");
  await a.textFrom(phone, "YES");
  await a.textFrom(phone, "1");
}

function everyDayHours() {
  const config = hillsideConfig();
  config.tourHours = { ...config.tourHours, days: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"], start: "08:00", end: "23:59" };
  return config;
}

describe("day export JSON", () => {
  it("trims a two-day tour to that day's grants and events", async () => {
    const h = use();
    const id = await h.publish();
    const visitor = await h.touringVisitor(id);
    const tourId = visitor.session.tourId;
    (h.visitors as unknown as { sessions: Map<string, unknown> }).sessions.clear();
    const loaded = h.workspace.loadTour(id, tourId)!;
    const issued = "2026-09-28T03:50:00.000Z";
    const usedNextDay = "2026-09-28T04:10:00.000Z";
    const openUntil = "2026-09-28T04:40:00.000Z";
    const grants = loaded.bundle.accessGrants;
    expect(grants.length).toBeGreaterThan(1);
    const issuedOnly = grants[0]!;
    const usedLater = grants[1]!;
    for (const grant of grants) {
      grant.createdAt = issued;
      grant.validFrom = issued;
      grant.validUntil = openUntil;
    }
    for (const event of loaded.bundle.auditEvents) {
      if (event.type === "ACCESS_ALLOWED" && event.doorId === usedLater.doorId && !event.detail.startsWith("duplicate")) event.at = usedNextDay;
      else if (event.type === "ACCESS_ALLOWED" || event.type === "ACCESS_DENIED") event.at = issued;
    }
    writeFileSync(join(loaded.folder, "tour-export.json"), JSON.stringify(loaded.bundle, null, 2) + "\n");
    const recordPath = join(loaded.folder, "record.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { ranAt: string; updatedAt: string };
    record.ranAt = issued;
    record.updatedAt = usedNextDay;
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");

    const issueDay = await h.ok("export_audit", { property: id, day: "2026-09-27" });
    const nextDay = await h.ok("export_audit", { property: id, day: "2026-09-28" });
    const issueDoc = readExport(h.root, id, String(issueDay.reference));
    const nextDoc = readExport(h.root, id, String(nextDay.reference));
    const issueTour = issueDoc.tours.find((tour) => tour.tourId === tourId)!;
    const nextTour = nextDoc.tours.find((tour) => tour.tourId === tourId)!;
    const issueGrantDoors = issueTour.bundle.accessGrants.map((grant) => grant.doorId).sort();
    const nextGrantDoors = nextTour.bundle.accessGrants.map((grant) => grant.doorId);
    expect(issueGrantDoors).toEqual(grants.map((grant) => grant.doorId).sort());
    expect(nextGrantDoors).toEqual([usedLater.doorId]);
    expect(nextGrantDoors).not.toContain(issuedOnly.doorId);
    expect(issueTour.bundle.auditEvents.every((event) => event.at < "2026-09-28T04:00:00.000Z")).toBe(true);
    expect(issueTour.bundle.auditEvents.some((event) => event.at === issued)).toBe(true);
    expect(nextTour.bundle.auditEvents.every((event) => event.at >= "2026-09-28T04:00:00.000Z")).toBe(true);
    expect(nextTour.bundle.auditEvents.some((event) => event.at === usedNextDay)).toBe(true);
    expect(nextTour.bundle.auditEvents.some((event) => event.at === issued)).toBe(false);
  });

  it("keeps a grant that has no createdAt on the validFrom day, and on the next day only if a door was used", () => {
    const issued = "2026-09-28T03:50:00.000Z";
    const usedNextDay = "2026-09-28T04:10:00.000Z";
    const day1 = { from: "2026-09-27T04:00:00.000Z", to: "2026-09-28T04:00:00.000Z" };
    const day2 = { from: "2026-09-28T04:00:00.000Z", to: "2026-09-29T04:00:00.000Z" };
    const bundle = {
      accessGrants: [{ doorId: "lobby", reservationId: "res", validFrom: issued, validUntil: "2026-09-28T04:40:00.000Z" }],
      auditEvents: [
        { type: "ACCESS_ALLOWED", at: usedNextDay, doorId: "lobby", reservationId: "res", detail: "opened" },
        { type: "ACCESS_DENIED", at: issued, doorId: "other", reservationId: "res", detail: "early" },
      ],
    };
    const onIssue = AccessWindows.trimToDay(bundle, day1);
    const onNext = AccessWindows.trimToDay(bundle, day2);
    expect(onIssue.accessGrants).toHaveLength(1);
    expect(onIssue.auditEvents.map((event) => event.at)).toEqual([issued]);
    expect(onNext.accessGrants).toHaveLength(1);
    expect(onNext.auditEvents.map((event) => event.at)).toEqual([usedNextDay]);
  });
});

function readExport(root: string, propertyId: string, reference: string): {
  tours: Array<{ tourId: string; bundle: { accessGrants: Array<{ doorId: string }>; auditEvents: Array<{ at: string }> } }>;
} {
  const exportId = /^Audit export ([^,]+),/.exec(reference)![1]!;
  return JSON.parse(readFileSync(join(root, "properties", propertyId, "audit-exports", exportId, "audit-export.json"), "utf8"));
}

describe("daily summary denials", () => {
  it("says no visitors were turned away when the denials are all from practice tours", async () => {
    const h = use();
    const id = await h.publish();
    setPracticeDenials(h, id, 6);
    const out = await h.ok("export_audit", { property: id, day: "2026-09-28" });
    expect(out.denials).toHaveLength(6);
    expect(out.totals.accessDenials).toBe(0);
    expect(out.totals.practiceAccessDenials).toBe(6);
    expect(out.summary).toBe(
      "Monday, Sep 28: 0 visitor tours (0 completed, 0 active, 0 stopped), 0 questions needing attention, plus 1 practice tour. " + PRACTICE_SIX,
    );
    expect(out.summary).toContain(PRACTICE_SIX);
  });

  it("uses the singular practice line for one practice denial", async () => {
    const h = use();
    const id = await h.publish();
    setPracticeDenials(h, id, 1);
    const out = await h.ok("export_audit", { property: id, day: "2026-09-28" });
    expect(out.denials).toHaveLength(1);
    expect(out.summary).toContain(PRACTICE_ONE);
    expect(out.summary).not.toContain("practice-tour denials");
  });

  it("keeps the real denial count and adds a practice line only when practice denials exist", () => {
    const base = {
      day: "Monday, Sep 28",
      tours: 1,
      completed: 1,
      active: 0,
      stopped: 0,
      accessDenials: 1,
      questionsNeedingAttention: 1,
      practiceTours: 1,
    };
    expect(formatAuditDaySummary(base)).toBe(
      "Monday, Sep 28: 1 visitor tour (1 completed, 0 active, 0 stopped), 1 access denial, 1 question needing attention, plus 1 practice tour.",
    );
    expect(formatAuditDaySummary({ ...base, practiceAccessDenials: 2 })).toBe(
      "Monday, Sep 28: 1 visitor tour (1 completed, 0 active, 0 stopped), 1 access denial, 1 question needing attention, plus 1 practice tour. 2 practice-tour denials.",
    );
    expect(formatAuditDaySummary({ ...base, accessDenials: 0, practiceAccessDenials: 0 })).toContain("0 access denials");
  });
});

function setPracticeDenials(h: GrokHarness, propertyId: string, count: number): void {
  const tourId = h.workspace.load(propertyId).state.dryTour?.tourId;
  if (!tourId) throw new Error("practice tour missing");
  const loaded = h.workspace.loadTour(propertyId, tourId)!;
  const sample = loaded.bundle.auditEvents.find((event) => event.type === "ACCESS_DENIED") ?? loaded.bundle.auditEvents[0];
  if (!sample) throw new Error("practice tour has no events");
  const reservationId = loaded.bundle.reservations[0]?.id ?? sample.reservationId;
  const kept = loaded.bundle.auditEvents.filter((event) => event.type !== "ACCESS_DENIED");
  const at = "2026-09-28T14:00:00.000Z";
  const denials = Array.from({ length: count }, (_, index) => ({
    ...sample,
    id: `deny_${index}`,
    seq: 800 + index,
    at,
    type: "ACCESS_DENIED" as const,
    reservationId,
    code: "DENY_WRONG_ROUTE",
    detail: "practice denial",
  }));
  loaded.bundle.auditEvents = [...kept, ...denials];
  writeFileSync(join(loaded.folder, "tour-export.json"), JSON.stringify(loaded.bundle, null, 2) + "\n");
}

describe("tour time questions", () => {
  it("answers a general tour-times question from the saved hours", async () => {
    const a = await liveApp({ cleanups, config: everyDayHours() });
    const phone = "+15550104001";
    await openDayMenu(a, phone);
    for (const phrase of ["what are your tour times?", "when can I tour?", "what hours do you do tours", "tour hours?", "what are your hours"]) {
      const replies = await a.textFrom(phone, phrase);
      expect(replies, phrase).toEqual([HOURS_REPLY]);
    }
    expect((await a.grok("list_exceptions")).exceptions).toEqual([]);
  });

  it("keeps a weekday or today, tomorrow, and tonight off the saved-hours reply", () => {
    expect(isGeneralTourHoursQuestion("tour hours?")).toBe(true);
    expect(isGeneralTourHoursQuestion("what are your hours")).toBe(true);
    expect(isGeneralTourHoursQuestion("tour hours on Friday")).toBe(false);
    expect(isGeneralTourHoursQuestion("what are your hours today")).toBe(false);
    expect(isGeneralTourHoursQuestion("what are your hours tomorrow")).toBe(false);
    expect(isGeneralTourHoursQuestion("what are your hours tonight")).toBe(false);
  });

  it("still opens Friday from is Friday open?", async () => {
    const a = await liveApp({ cleanups });
    const phone = "+15550104002";
    await openDayMenu(a, phone);
    const replies = await a.textFrom(phone, "is Friday open?");
    expect(replies.join("\n")).toBe(FRIDAY_TIMES);
    expect((await a.grok("list_exceptions")).exceptions).toEqual([]);
  });

  it("passes the question to the team when no hours are saved", async () => {
    const a = await liveApp({ cleanups });
    const phone = "+15550104003";
    await openDayMenu(a, phone);
    const id = readdirSync(join(a.root, "properties")).find((name) => existsSync(join(a.root, "properties", name, "tourcore.config.json")));
    if (!id) throw new Error("property missing");
    const path = join(a.root, "properties", id, "tourcore.config.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as { tourHours: { days: string[] } };
    raw.tourHours.days = [];
    writeJsonAtomic(path, raw);
    const statusPath = join(a.root, "properties", id, "status.json");
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as { configHash: string };
    status.configHash = configHash(TourCoreConfigShape.parse(raw));
    writeJsonAtomic(statusPath, status);
    const replies = await a.textFrom(phone, "what are your tour times?");
    expect(replies).toEqual([UNKNOWN_ANSWER]);
    const issues = (await a.grok("list_exceptions")).exceptions as Array<{ summary: string }>;
    expect(issues.map((issue) => issue.summary)).toContain('Asked "what are your tour times?". There\'s no approved answer yet.');
  });
});

describe("unset time zone", () => {
  it("does not store a computer offset for a street with no state", async () => {
    const h = use();
    const street = await h.ok("create_property_setup", { address: "12 Main Street" });
    const id = street.setup.propertyId as string;
    const file = JSON.parse(readFileSync(join(h.root, "properties", id, "draft.json"), "utf8")) as { property: { timezone: string } };
    expect(file.property.timezone).toBe("");
    expect(file.property.timezone).not.toBe("GMT+00:00");
    expect(h.workspace.openDraft(id).draft.property.timezone).toBe("");
    expect(JSON.stringify(street.setup)).not.toMatch(/GMT\+00:00|UTC/);
  });

  it("reads an older GMT+00:00 record with no state as unset and does not rewrite it", async () => {
    const h = use();
    const id = await h.publish();
    const path = join(h.root, "properties", id, "tourcore.config.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      property: { timezone: string; timezoneConfirmed?: boolean; canonicalAddress?: { state?: string } };
    };
    raw.property.timezone = "GMT+00:00";
    raw.property.canonicalAddress = { ...raw.property.canonicalAddress, state: "" };
    delete raw.property.timezoneConfirmed;
    writeJsonAtomic(path, raw);
    const parsed = TourCoreConfigShape.parse(raw);
    const statusPath = join(h.root, "properties", id, "status.json");
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as { configHash: string; status: string };
    status.configHash = configHash(parsed);
    writeJsonAtomic(statusPath, status);

    const loaded = h.workspace.load(id);
    expect(loaded.config.property.timezone).toBe("");
    expect(loaded.state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(JSON.parse(readFileSync(path, "utf8")).property.timezone).toBe("GMT+00:00");
  });

  it("asks for a time zone when none is saved, and names a saved zone it does not recognize", async () => {
    const h = use();
    const id = await h.publish();
    const saved = structuredClone(h.workspace.load(id).config);

    const empty = structuredClone(saved);
    empty.property.timezone = "";
    const emptyIssue = validateConfig(empty).find((issue) => issue.code === "TIMEZONE_INVALID");
    expect(emptyIssue?.message).toBe(EMPTY_ZONE);
    expect(emptyIssue?.message).not.toContain("America/New_York");

    const older = structuredClone(saved);
    older.property.timezone = "GMT+00:00";
    older.property.canonicalAddress = {
      street: older.property.canonicalAddress?.street ?? "100 Alfred Way",
      city: older.property.canonicalAddress?.city ?? "Brooklyn",
      state: "",
      formatted: older.property.canonicalAddress?.formatted ?? "100 Alfred Way, Brooklyn",
    };
    delete older.property.timezoneConfirmed;
    const presented = presentStoredTimeZone(older);
    expect(presented.property.timezone).toBe("");
    const unsetIssue = validateConfig(presented).find((issue) => issue.code === "TIMEZONE_INVALID");
    expect(unsetIssue?.message).toBe(EMPTY_ZONE);
    expect(unsetIssue?.message).not.toContain("America/New_York");

    const invalid = structuredClone(saved);
    invalid.property.timezone = "Mars/Olympus";
    const invalidIssue = validateConfig(invalid).find((issue) => issue.code === "TIMEZONE_INVALID");
    expect(invalidIssue?.message).toBe(`I don't recognize the time zone "Mars/Olympus". Try something like Eastern or Pacific.`);
    expect(invalidIssue?.message).not.toContain("America/New_York");
  });

  it("blocks a published GMT+00:00 property with no state, then runs tours after Eastern is set", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const path = join(h.root, "properties", id, "tourcore.config.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      property: { name: string; timezone: string; timezoneConfirmed?: boolean; canonicalAddress?: { state?: string } };
    };
    raw.property.timezone = "GMT+00:00";
    raw.property.canonicalAddress = { ...raw.property.canonicalAddress, state: "" };
    delete raw.property.timezoneConfirmed;
    writeJsonAtomic(path, raw);
    const parsed = TourCoreConfigShape.parse(raw);
    const presented = presentStoredTimeZone(parsed);
    const viewedSafety = safetyHash(presented);
    const statusPath = join(h.root, "properties", id, "status.json");
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as {
      configHash: string;
      status: string;
      readiness?: { safetyHash?: string };
      dryTour?: { safetyHash?: string };
    };
    status.status = "PUBLISHED_FOR_DEMO";
    status.configHash = configHash(parsed);
    if (status.readiness) status.readiness.safetyHash = viewedSafety;
    if (status.dryTour) status.dryTour.safetyHash = viewedSafety;
    writeJsonAtomic(statusPath, status);

    const loaded = h.workspace.load(id);
    expect(loaded.config.property.timezone).toBe("");
    expect(loaded.state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(statusLabel(loaded)).toBe("Published for demo · needs attention");
    expect(JSON.parse(readFileSync(path, "utf8")).property.timezone).toBe("GMT+00:00");
    const human = toursUnavailableText(loaded.config.property.name, loaded.config.operator.name, loaded.config.operator.visitorContact);

    const line = "+15550001111";
    const endpoints = new MessagingEndpoints(h.runtime);
    endpoints.attach({ address: line, provider: "demo", propertyId: id });
    const sent: string[] = [];
    const router = new MessagingConversations({
      workspace: h.workspace,
      registry: h.visitors,
      runtime: h.runtime,
      endpoints,
      transport: () => ({
        provider: "demo",
        presentation: "MESSAGING",
        send: async (message) => {
          sent.push(message.body);
          return { provider: "demo", channel: "DEMO", status: "SENT", sentAt: new Date(h.now()).toISOString() };
        },
      }),
      links: new VerificationLinks({ baseUrl: () => undefined }),
      realNow: () => h.now(),
      now: () => new Date(h.now()),
      defaultLine: () => line,
      consentMode: () => "disabled",
    });
    const text = async (phone: string, body: string) => {
      sent.length = 0;
      await router.receive({
        provider: "test",
        providerMessageId: `m_${phone}_${sent.length}_${body.length}`,
        from: phone,
        to: line,
        text: body,
        channel: "SMS",
        receivedAt: new Date(h.now()).toISOString(),
      });
      return [...sent];
    };

    const firstPhone = "+15550104111";
    await expect(text(firstPhone, "Hi")).resolves.toEqual([human]);
    expect(h.visitors.latestForPhone(id, firstPhone, "messaging")).toBeUndefined();
    const browser = await h.visitor(id, { phone: "5550104112" });
    expect(browser.session.conversation.filter((item) => item.from === "tourcore").map((item) => item.text).join("\n")).toContain(human);
    expect(await browser.session.reservation()).toBeUndefined();

    const picture = await h.ok("get_state", { propertyId: id });
    expect(picture.summary).toBe(UNSET_ZONE_LINE);
    expect(picture.nextStep.say).toBe(UNSET_ZONE_LINE);
    expect(picture.playbook.text).toContain(UNSET_ZONE_LINE);
    expect(picture.setup.status).toBe("Published for demo · needs attention");

    await h.ok("save_property", { property: id, timezone: "Eastern" });
    const restored = h.workspace.load(id);
    expect(restored.config.property.timezone).toBe("America/New_York");
    expect(restored.state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(statusLabel(restored)).toBe("Published for demo");
    const after = await h.ok("get_state", { propertyId: id });
    expect(after.summary).not.toBe(UNSET_ZONE_LINE);
    expect(after.nextStep.say).not.toBe(UNSET_ZONE_LINE);

    const second = await text("+15550104113", "Hi");
    expect(second.join("\n")).toContain("Which unit would you like to see?");
    expect(second.join("\n")).not.toContain("aren't available right now");
    const touring = await h.visitor(id, { phone: "5550104114" });
    expect(touring.session.offeredDates.length).toBeGreaterThan(0);
    expect(touring.slot()).toBeInstanceOf(Date);
    expect(touring.session.conversation.map((item) => item.text).join("\n")).not.toContain("aren't available right now");
  });
});

describe("restore upload drain", () => {
  it("stops reading a declared over-cap body at 1 MB and still answers 413 for a short body", async () => {
    const h = installHarness({
      env: { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app", PORT: "8080" },
    });
    cleanups.push(h.cleanup);
    h.inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    h.inst.files.setPublicBaseUrl("https://demo.up.railway.app", "RAILWAY");
    const upload = await h.ok("begin_restore_upload");
    const total = 8 * 1024 * 1024;
    let pushed = 0;
    const req = new Readable({
      read() {
        if (pushed >= total) {
          this.push(null);
          return;
        }
        const n = Math.min(64 * 1024, total - pushed);
        pushed += n;
        this.push(Buffer.alloc(n, 0x61));
      },
    }) as IncomingMessage;
    req.headers = {
      "content-type": "application/json",
      "content-length": String(60_000_000),
      "x-tourcore-capability": String(upload.handoff.capability),
    };
    req.socket = { destroy: () => req.destroy() } as unknown as IncomingMessage["socket"];
    const result = await handlePortableRequest(h.inst.backups, "POST", String(upload.handoff.path), req);
    expect(result?.status).toBe(413);
    expect(result?.body).toContain("50 MB");
    await new Promise<void>((resolve) => {
      if (req.destroyed || req.readableEnded) return resolve();
      req.on("close", () => resolve());
      req.on("end", () => resolve());
    });
    expect(pushed).toBeGreaterThan(0);
    expect(pushed).toBeLessThan(4 * 1024 * 1024);

    const server = createSetupServer({ workspace: new PropertyWorkspace(h.root), installation: h.inst, log: () => {} });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const declared = await h.ok("begin_restore_upload");
    const empty = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: String(declared.handoff.path),
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(60_000_000),
            "x-tourcore-capability": String(declared.handoff.capability),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(empty.status).toBe(413);
    expect(empty.body).toContain("50 MB");
  }, 30_000);
});

const EMPTY_ZONE = "What time zone should tours use, like Eastern or Pacific?";
const HOSTED_DECLINE = "Operational records stay with hosted Tour Core. Portable backups are off until you connect Google Drive.";
const SELF_HOST_DECLINE = "Your records stay on this computer. Portable backups stay off until Google Drive is connected.";

describe("portable backup decline copy", () => {
  it("keeps the hosted line on a hosted install", async () => {
    const h = installHarness({
      env: { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app", PORT: "8080" },
    });
    cleanups.push(h.cleanup);
    h.inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    expect((await h.ok("decline_portable_backup")).summary).toBe(HOSTED_DECLINE);
    expect((await h.ok("backup_records", { action: "decline" })).message).toBe(HOSTED_DECLINE);
    expect(h.inst.records.provider()).toBe("HOSTED_VOLUME");
  });

  it("moves a self-hosted install with Google set up but not connected onto this computer, then says so", async () => {
    const local = installHarness({
      env: {
        TOURCORE_DEPLOYMENT_MODE: "SELF_HOSTED",
        TOURCORE_GOOGLE_OAUTH_CLIENT_ID: "tourcore-google-client.apps.googleusercontent.com",
        TOURCORE_GOOGLE_OAUTH_CLIENT_SECRET: "tourcore-google-secret",
      },
    });
    cleanups.push(local.cleanup);
    local.inst.files.ensure({ deploymentMode: "SELF_HOSTED" });
    expect(local.inst.records.provider()).toBe("NOT_CONFIGURED");
    const declined = await local.ok("backup_records", { action: "decline" });
    expect(declined.message).toBe(SELF_HOST_DECLINE);
    expect(local.inst.records.provider()).toBe("LOCAL_DEMO");
    expect(local.inst.files.state().storage?.mode).toBe("LOCAL_DEMO");
  });

  it("uses the computer line when records are already local or Drive is still waiting", async () => {
    const local = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "SELF_HOSTED" } });
    cleanups.push(local.cleanup);
    local.inst.files.ensure({ deploymentMode: "SELF_HOSTED" });
    const localState = local.inst.files.state();
    local.inst.files.writeState({ ...localState, storage: { ...localState.storage, mode: "LOCAL_DEMO", phase: "READY" } });
    expect(local.inst.records.provider()).toBe("LOCAL_DEMO");
    expect((await local.ok("decline_portable_backup")).summary).toBe(SELF_HOST_DECLINE);

    const waiting = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "SELF_HOSTED" } });
    cleanups.push(waiting.cleanup);
    waiting.inst.files.ensure({ deploymentMode: "SELF_HOSTED" });
    const waitingState = waiting.inst.files.state();
    waiting.inst.files.writeState({ ...waitingState, storage: { ...waitingState.storage, phase: "CONNECTING" } });
    expect(waiting.inst.records.provider()).toBe("GOOGLE_DRIVE_CONNECTING");
    expect((await waiting.ok("decline_portable_backup")).summary).toBe(SELF_HOST_DECLINE);
  });
});

describe("state-only ZIP check", () => {
  it("asks and saves nothing when only the state changes to a ZIP mismatch", async () => {
    const h = use();
    const created = await h.ok("create_property_setup", { address: "400 Rock Road, Glen Rock, NJ 07452" });
    const id = created.setup.propertyId as string;
    expect(await h.fails("update_property_details", { property: id, state: "CA" })).toBe(ZIP_CA);
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress).toMatchObject({ state: "NJ", postalCode: "07452" });
    expect(h.workspace.openDraft(id).draft.property.address).not.toContain("CA 07452");
    expect(await h.fails("save_property", { property: id, state: "CA" })).toBe(ZIP_CA);
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress).toMatchObject({ state: "NJ", postalCode: "07452" });
  });

  it("still loads and publishes an older saved mismatch, and a fact edit does not recheck it", async () => {
    const h = use();
    const id = await h.publish();
    const saved = h.workspace.load(id);
    const config = structuredClone(saved.config);
    config.property.address = "400 Rock Road, Glen Rock, CA 07452";
    config.property.canonicalAddress = {
      street: "400 Rock Road",
      city: "Glen Rock",
      state: "CA",
      postalCode: "07452",
      formatted: "400 Rock Road, Glen Rock, CA 07452",
    };
    writeJsonAtomic(join(h.root, "properties", id, "tourcore.config.json"), config);
    const status = JSON.parse(readFileSync(join(h.root, "properties", id, "status.json"), "utf8")) as { configHash: string; safetyHash?: string };
    status.configHash = configHash(config);
    writeJsonAtomic(join(h.root, "properties", id, "status.json"), status);

    const loaded = h.workspace.load(id);
    expect(loaded.state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(loaded.config.property.canonicalAddress).toMatchObject({ state: "CA", postalCode: "07452" });
    const facts = await h.ok("update_property_details", { property: id, facts: ["Street parking only."] });
    expect(JSON.stringify(facts)).not.toContain("Which one should I fix");
    expect(h.workspace.load(id).config.property.canonicalAddress).toMatchObject({ state: "CA", postalCode: "07452" });
    expect(h.workspace.load(id).state.status).toBe("PUBLISHED_FOR_DEMO");
  });
});
