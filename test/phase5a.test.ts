import { request } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safetyHash } from "../src/config/changeKinds";
import { touringHoursLabel } from "../src/core/customSlot";
import { spokenTimeZone } from "../src/core/timezone";
import { interpretByRules } from "../src/intent/ruleBased";
import { hoursStepSay } from "../src/operator/milestones";
import { parseUsAddress } from "../src/setup/address";
import { configHash } from "../src/setup/workspace";
import { writeJsonAtomic } from "../src/storage/atomicWrite";
import { PropertyWorkspace } from "../src/setup";
import { createSetupServer } from "../src/web/server";
import { grokHarness, type GrokHarness } from "./grokHarness";
import { installHarness } from "./installHarness";

/**
 * Phase 5a gate cases. Each case fails on master 8a36c2b and passes here.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((run) => run()));

function use(h: GrokHarness = grokHarness()): GrokHarness {
  cleanups.push(h.cleanup);
  return h;
}

const TIMED_OUT = "That upload timed out. Send me the backup file again and I'll check it.";
const UPLOAD_FIRST = "Upload the backup file first, then I can show you what's in it.";
const ZIP_CA = "That ZIP doesn't look like it's in California. Which one should I fix, the ZIP or the state?";

const DAY_MENU = {
  message: "",
  step: "choose-date" as const,
  units: [{ name: "Unit 1A" }],
  timeChoices: ["Monday, Sep 28", "Tuesday, Sep 29", "Wednesday, Sep 30", "Thursday, Oct 1", "Friday, Oct 2"],
  remainingStops: [],
  doors: [],
  today: { year: 2026, month: 9, day: 28 },
  timezone: "America/New_York",
};

function dayIntent(message: string) {
  return interpretByRules({ ...DAY_MENU, message }).intent;
}

describe("two-word cities", () => {
  it("keeps Fort Lee and New York on one line, and Avenue when the city arrives later", async () => {
    expect(parseUsAddress("12 Main Street Fort Lee NJ")?.address).toMatchObject({
      street: "12 Main Street",
      city: "Fort Lee",
      state: "NJ",
    });
    expect(parseUsAddress("500 Broadway New York NY")?.address).toMatchObject({
      street: "500 Broadway",
      city: "New York",
      state: "NY",
    });
    expect(parseUsAddress("Saddle River NJ")?.address.city).toBe("Saddle River");
    expect(parseUsAddress("Little Ferry NJ")?.address.city).toBe("Little Ferry");
    expect(parseUsAddress("St. Louis MO")?.address).toMatchObject({ city: "St. Louis", state: "MO" });
    expect(parseUsAddress("Salt Lake City UT 84101")?.address).toMatchObject({ city: "Salt Lake City", state: "UT", postalCode: "84101" });
    expect(parseUsAddress("NJ")?.address.state).toBe("NJ");
    expect(parseUsAddress("07670")?.address).toMatchObject({ street: "", city: "", state: "", postalCode: "07670" });
    expect(parseUsAddress("Avenue")?.address.city ?? "").toBe("");

    const h = use();
    const created = await h.ok("create_property_setup", { address: "144 Hillside Avenue" });
    const id = created.setup.propertyId as string;
    expect(created.summary).not.toMatch(/GMT|UTC|time zone|I'm using/);
    await h.ok("update_property_details", { property: id, city: "Fort Lee" });
    await h.ok("update_property_details", { property: id, state: "NJ" });
    const zip = await h.ok("update_property_details", { property: id, postalCode: "07024" });
    expect(zip.nextQuestion).toBe("Did I get that right: 144 Hillside Avenue, Fort Lee, NJ 07024?");
    expect(String(zip.nextQuestion)).toContain("Avenue");
  });
});

describe("state and ZIP", () => {
  it("asks and saves nothing for an NJ ZIP with California, and accepts a matching pair", async () => {
    const h = use();
    expect(await h.fails("create_property_setup", { address: "Tenafly, CA 07670" })).toBe(ZIP_CA);
    expect(h.workspace.propertyIds()).toEqual([]);

    const created = await h.ok("create_property_setup", { address: "10 Oak Street" });
    const id = created.setup.propertyId as string;
    await h.ok("update_property_details", { property: id, city: "Tenafly", state: "CA" });
    expect(await h.fails("update_property_details", { property: id, postalCode: "07670" })).toBe(ZIP_CA);
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress?.postalCode).toBeUndefined();

    await h.ok("update_property_details", { property: id, state: "NJ" });
    const fixed = await h.ok("update_property_details", { property: id, postalCode: "07670" });
    expect(fixed.nextQuestion).toBe("Did I get that right: 10 Oak Street, Tenafly, NJ 07670?");
    expect(h.workspace.openDraft(id).draft.property.canonicalAddress).toMatchObject({ state: "NJ", postalCode: "07670" });

    const other = await h.ok("create_property_setup", { address: "11 Oak Street, Tenafly, CA" });
    const otherId = other.setup.propertyId as string;
    expect(await h.fails("update_property_details", { property: otherId, state: "CA", postalCode: "07670" })).toBe(ZIP_CA);
    await h.ok("update_property_details", { property: otherId, postalCode: "90210" });
    expect(h.workspace.openDraft(otherId).draft.property.canonicalAddress).toMatchObject({ state: "CA", postalCode: "90210" });
  });

  it("loads, publishes and texts an older property whose ZIP and state already disagree", async () => {
    const h = use();
    expect(await h.fails("create_property_setup", { address: "9 Side Street, Tenafly, CA 07670" })).toBe(ZIP_CA);
    const id = await h.publish();
    const saved = h.workspace.load(id);
    const config = structuredClone(saved.config);
    config.property.address = "100 Alfred Way, Tenafly, CA 07670";
    config.property.canonicalAddress = {
      street: "100 Alfred Way",
      city: "Tenafly",
      state: "CA",
      postalCode: "07670",
      formatted: "100 Alfred Way, Tenafly, CA 07670",
    };
    const folder = join(h.root, "properties", id);
    writeJsonAtomic(join(folder, "tourcore.config.json"), config);
    const status = JSON.parse(readFileSync(join(folder, "status.json"), "utf8")) as { configHash: string; safetyHash?: string; status: string };
    status.configHash = configHash(config);
    status.safetyHash = safetyHash(config);
    writeJsonAtomic(join(folder, "status.json"), status);

    const loaded = h.workspace.load(id);
    expect(loaded.state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(loaded.config.property.canonicalAddress).toMatchObject({ state: "CA", postalCode: "07670" });
    const listed = await h.ok("get_property_setup", { property: id });
    expect(listed.summary).not.toContain("Which one should I fix");
    const visitor = await h.visitor(id);
    expect(visitor.session.offeredSlots.length).toBeGreaterThan(0);
    const texts = (await visitor.session.store.list("messages")).map((message) => message.body).join("\n");
    expect(texts).not.toContain("Which one should I fix");
    expect(texts.length).toBeGreaterThan(0);
  });
});

describe("zone copy", () => {
  it("leaves the zone out until a state is known, then says which time it is using", async () => {
    const h = use();
    const street = await h.ok("create_property_setup", { address: "12 Main Street" });
    expect(street.summary).toBe("Started 12 Main Street.");
    expect(JSON.stringify(street.summary)).not.toMatch(/GMT|UTC|I'm using|time zone/);
    expect(street.timezoneGuess).toBeUndefined();

    const eastern = await h.ok("create_property_setup", { address: "18 Maple Street, Teaneck, NJ 07666" });
    expect(eastern.summary).toBe("Started 18 Maple Street, Teaneck, NJ 07666. I'm using Eastern time for tours. Want a different one?");

    const phoenix = await h.ok("create_property_setup", { address: "1 Central Avenue, Phoenix, AZ 85004" });
    expect(phoenix.summary).toContain("I'm using Mountain time for tours. Want a different one?");
    expect(phoenix.summary).not.toMatch(/Standard|GMT|UTC/);
    expect(spokenTimeZone("America/Phoenix")).toBe("Mountain");
    expect(spokenTimeZone("Pacific/Honolulu")).toBe("Hawaii");
    expect(spokenTimeZone("America/Anchorage")).toBe("Alaska");
  });

  it("asks about a locked zone only when save_property actually changes the state", async () => {
    const h = use();
    const id = await h.publish();
    const same = await h.ok("save_property", { property: id, state: "NY" });
    expect(JSON.stringify(same)).not.toContain("Should I switch");
    expect(JSON.stringify(same)).not.toContain("I'm using");

    const changed = await h.ok("save_property", { property: id, state: "CA" });
    expect(changed.message).toContain("Tours still run on Eastern time. Should I switch to Pacific time?");
    expect(h.workspace.load(id).config.property.timezone).toBe("America/New_York");

    const switched = await h.ok("update_property_details", { property: id, timezone: "Pacific" });
    expect(h.workspace.load(id).config.property.timezone).toBe("America/Los_Angeles");
    expect(h.workspace.load(id).config.property.timezoneConfirmed).toBe(true);
    expect(switched.summary).not.toContain("Should I switch");

    await h.ok("set_tour_hours", { property: id, days: "weekdays", start: "10am", end: "4pm" });
    expect(h.workspace.load(id).state.status).toBe("DRAFT");
    expect(h.workspace.load(id).state.publishedAt).toBeTruthy();
    const again = await h.ok("save_property", { property: id, state: "NY" });
    expect(again.message).toContain("Tours still run on Pacific time. Should I switch to Eastern time?");
  });
});

describe("midnight hours", () => {
  it("says midnight while the stored end stays 23:59, and the visitor line matches", async () => {
    const h = use();
    const id = await h.publish();
    const saved = await h.ok("save_hours", { property: id, days: "every day", start: "8am", end: "11:59pm" });
    expect(saved.message).toBe("Tours run every day, 8 AM to midnight.");
    expect(saved.message).not.toContain("11:59");
    const hours = h.workspace.load(id).config.tourHours;
    expect(hours.end).toBe("23:59");
    expect(hours.start).toBe("08:00");
    const operator = hoursStepSay(hours);
    const visitor = touringHoursLabel(h.workspace.load(id).config);
    expect(operator).toBe("Tours run every day, 8 AM to midnight. Want to change that?");
    expect(visitor).toBe("8 AM to midnight");
    expect(operator).toContain(visitor);
    expect(visitor).not.toContain("11:59");
  });
});

describe("day menu", () => {
  it("keeps the master day picks and opens availability asks the old list missed", () => {
    expect(dayIntent("tmrw")).toEqual({ type: "SELECT_DATE", relative: "tomorrow" });
    expect(dayIntent("Fri")).toEqual({ type: "SELECT_DATE", weekday: "FRI" });
    expect(dayIntent("next Tuesday")).toEqual({ type: "SELECT_DATE", weekday: "TUE", nextWeek: true });
    expect(dayIntent("the 14th")).toEqual({ type: "UNKNOWN" });
    expect(dayIntent("Oct 1")).toEqual({ type: "SELECT_DATE", date: { year: 2026, month: 10, day: 1 } });

    const missed = [
      "can I come by Friday?",
      "is Friday a possibility?",
      "any chance Friday is open?",
      "could I swing by Friday?",
      "is Friday doable?",
      "would Friday work out?",
      "can I get in Friday?",
      "is Friday an option?",
      "Friday possible?",
      "mind if I come Friday?",
      "hoping Friday works?",
      "trying to come Friday?",
      "can Friday fit me in?",
      "is Friday still a go?",
      "Friday looking good?",
    ];
    for (const phrase of missed) {
      expect(dayIntent(phrase), phrase).toEqual({ type: "SELECT_DATE", weekday: "FRI" });
    }
    expect(dayIntent("is Friday parking free?")).toEqual({ type: "ASK_PROPERTY_QUESTION", question: "is Friday parking free?" });
    expect(dayIntent("Black Friday sale nearby?")).toEqual({ type: "ASK_PROPERTY_QUESTION", question: "Black Friday sale nearby?" });
    expect(dayIntent("is Friday busy?")).toEqual({ type: "ASK_PROPERTY_QUESTION", question: "is Friday busy?" });
  });
});

describe("day export grants", () => {
  it("keeps a cross-midnight grant on the day it was issued, not the next day", async () => {
    const h = use();
    const id = await h.publish();
    const visitor = await h.touringVisitor(id);
    const tourId = visitor.session.tourId;
    (h.visitors as unknown as { sessions: Map<string, unknown> }).sessions.clear();
    const loaded = h.workspace.loadTour(id, tourId)!;
    const issued = "2026-09-28T03:50:00.000Z";
    const usedNextDay = "2026-09-28T04:10:00.000Z";
    const openUntil = "2026-09-28T04:40:00.000Z";
    for (const grant of loaded.bundle.accessGrants) {
      grant.createdAt = issued;
      grant.validFrom = issued;
      grant.validUntil = openUntil;
    }
    for (const event of loaded.bundle.auditEvents) {
      if (event.type === "ACCESS_ALLOWED" || event.type === "ACCESS_DENIED") event.at = issued;
    }
    writeFileSync(join(loaded.folder, "tour-export.json"), JSON.stringify(loaded.bundle, null, 2) + "\n");
    const recordPath = join(loaded.folder, "record.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { ranAt: string; updatedAt: string };
    record.ranAt = issued;
    record.updatedAt = usedNextDay;
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");

    const issueDay = await h.ok("export_audit", { property: id, day: "2026-09-27" });
    const nextDay = await h.ok("export_audit", { property: id, day: "2026-09-28" });
    const onIssueDay = (issueDay.accessGrants as Array<{ tourRef: string; doorName: string }>).filter((grant) => grant.tourRef.endsWith(tourId));
    const onNextDay = (nextDay.accessGrants as Array<{ tourRef: string }>).filter((grant) => grant.tourRef.endsWith(tourId));
    const denialsNext = (nextDay.denials as Array<{ tourRef?: string }>).filter((denial) => denial.tourRef?.endsWith(tourId));
    expect(onIssueDay.length).toBeGreaterThan(0);
    expect(onNextDay).toEqual([]);
    expect(denialsNext).toEqual([]);

    const again = h.workspace.loadTour(id, tourId)!;
    const door = again.bundle.accessGrants[0]?.doorId;
    const allowed = again.bundle.auditEvents.filter((event) => event.type === "ACCESS_ALLOWED" && event.doorId === door && !event.detail.startsWith("duplicate"));
    expect(allowed.length).toBeGreaterThan(0);
    for (const event of allowed) event.at = usedNextDay;
    writeFileSync(join(again.folder, "tour-export.json"), JSON.stringify(again.bundle, null, 2) + "\n");
    const used = await h.ok("export_audit", { property: id, day: "2026-09-28" });
    const usedHere = (used.accessGrants as Array<{ tourRef: string; doorName: string }>).filter((grant) => grant.tourRef.endsWith(tourId));
    expect(usedHere).toHaveLength(1);
    expect(onIssueDay.map((grant) => grant.doorName)).toContain(usedHere[0]!.doorName);
    const issueAgain = await h.ok("export_audit", { property: id, day: "2026-09-27" });
    const stillIssued = (issueAgain.accessGrants as Array<{ tourRef: string; doorName: string }>).filter((grant) => grant.tourRef.endsWith(tourId));
    expect(stillIssued.map((grant) => grant.doorName).sort()).toEqual(onIssueDay.map((grant) => grant.doorName).sort());
  });
});

describe("restore hardening", () => {
  it("reads a rejected body only up to a limit, then cuts the connection", async () => {
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
    const total = 100 * 1024 * 1024;
    const sent = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: String(upload.handoff.path),
          method: "POST",
          headers: { "content-type": "application/json", "x-tourcore-capability": "wrong-capability" },
        },
        () => resolve(total),
      );
      req.on("error", () => resolve(written));
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let written = 0;
      const write = () => {
        while (written < total) {
          const n = Math.min(chunk.length, total - written);
          written += n;
          if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
            req.once("drain", write);
            return;
          }
        }
        req.end();
      };
      write();
      setTimeout(() => reject(new Error("rejected upload did not stop")), 20_000);
    });
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(4 * 1024 * 1024);
  }, 30_000);

  it("says the upload timed out on a second preview and when the link expires after the file arrives", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    const upload = await h.ok("begin_restore_upload");
    const uploadId = String(upload.handoff.path).split("/").pop()!;
    const path = join(h.root, "portable-handoff", `${uploadId}.json`);
    const opened = JSON.parse(readFileSync(path, "utf8")) as { expiresAt: number };
    writeFileSync(join(h.root, "portable-handoff", `${uploadId}.body`), '{"format":"tourcore-portable-backup"}\n');
    writeFileSync(path, JSON.stringify({ ...opened, bodyFile: true, bytes: 32, expiresAt: h.now() - 1 }, null, 2) + "\n");
    expect(await h.fails("preview_portable_restore", { uploadId })).toBe(TIMED_OUT);
    expect(await h.fails("preview_portable_restore", { uploadId })).toBe(TIMED_OUT);
    expect(await h.fails("import_portable_backup", { uploadId })).toBe(TIMED_OUT);

    const live = await h.ok("begin_restore_upload");
    const liveId = String(live.handoff.path).split("/").pop()!;
    expect(await h.fails("preview_portable_restore", { uploadId: liveId })).toBe(UPLOAD_FIRST);

    const older = await h.ok("begin_restore_upload");
    const olderId = String(older.handoff.path).split("/").pop()!;
    const olderPath = join(h.root, "portable-handoff", `${olderId}.json`);
    const olderRecord = JSON.parse(readFileSync(olderPath, "utf8")) as Record<string, unknown>;
    writeFileSync(olderPath, JSON.stringify({ ...olderRecord, body: '{"format":"old"}', expiresAt: h.now() - 1 }, null, 2) + "\n");
    expect(await h.fails("preview_portable_restore", { uploadId: olderId })).toBe(TIMED_OUT);
    expect(existsSync(olderPath)).toBe(true);
  });
});
