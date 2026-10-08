import { request } from "node:http";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccessWindows } from "../src/operator/accessWindows";
import { formatAuditDaySummary } from "../src/operator/auditExport";
import { TourCoreConfigShape } from "../src/config/tourCoreConfig";
import { UNKNOWN_ANSWER } from "../src/core/TourCore";
import { configHash, PropertyWorkspace } from "../src/setup/workspace";
import { writeJsonAtomic } from "../src/storage/atomicWrite";
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
const HOURS_REPLY = "Tours run every day, 8 AM to midnight. Which day works for you?";
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
    for (const phrase of ["what are your tour times?", "when can I tour?", "what hours do you do tours"]) {
      const replies = await a.textFrom(phone, phrase);
      expect(replies, phrase).toEqual([HOURS_REPLY]);
    }
    expect((await a.grok("list_exceptions")).exceptions).toEqual([]);
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
});

describe("restore upload drain", () => {
  it("stops reading a declared over-cap body at 1 MB and still answers 413 for a short body", async () => {
    const h = installHarness({
      env: { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app", PORT: "8080" },
    });
    cleanups.push(h.cleanup);
    h.inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    h.inst.files.setPublicBaseUrl("https://demo.up.railway.app", "RAILWAY");
    const server = createSetupServer({ workspace: new PropertyWorkspace(h.root), installation: h.inst, log: () => {} });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const upload = await h.ok("begin_restore_upload");
    const total = 8 * 1024 * 1024;
    const sent = await new Promise<number>((resolve, reject) => {
      let written = 0;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(written);
      };
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: String(upload.handoff.path),
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(60_000_000),
            "x-tourcore-capability": String(upload.handoff.capability),
          },
        },
        (res) => {
          // A 413 by itself is not the cut. Keep writing until the socket stops or the whole body is accepted.
          res.resume();
        },
      );
      req.on("error", finish);
      req.on("close", finish);
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const write = () => {
        if (settled) return;
        try {
          while (written < total) {
            const n = Math.min(chunk.length, total - written);
            const piece = n === chunk.length ? chunk : chunk.subarray(0, n);
            const ok = req.write(piece);
            written += n;
            if (!ok) {
              req.once("drain", write);
              return;
            }
          }
          req.end();
          finish();
        } catch {
          finish();
        }
      };
      write();
      setTimeout(() => reject(new Error("over-cap upload did not stop")), 20_000);
    });
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(4 * 1024 * 1024);

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
