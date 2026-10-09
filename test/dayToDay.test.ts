import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { FAIR_HOUSING_REFUSAL } from "../src/operator/exceptions";
import { installHarness } from "./installHarness";
import { grokHarness } from "./grokHarness";
import { liveApp } from "./liveApp";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((run) => run()));

const proof: Record<string, unknown> = {};

function remember(name: string, value: unknown) {
  proof[name] = value;
  writeFileSync("/tmp/day-to-day-proof.json", JSON.stringify(proof, null, 2));
}

function codeOf(result: { confirmation?: { code?: string } }): string {
  const code = result.confirmation?.code;
  if (!code) throw new Error(`expected a confirmation, got ${JSON.stringify(result).slice(0, 400)}`);
  return code;
}

function tourIdOf(tourRef: string): { propertyId: string; tourId: string } {
  const [propertyId, tourId] = tourRef.split("~");
  if (!propertyId || !tourId) throw new Error(`bad tourRef ${tourRef}`);
  return { propertyId, tourId };
}

describe("day-to-day writes", () => {
  it("calls a tour off and switches door access off", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const propertyId = await h.publish();
    await h.touringVisitor(propertyId, { name: "Pat Smith" });
    const listed = await h.ok("get_tours", { property: propertyId });
    const tourRef = listed.active[0].tourRef as string;
    expect(tourRef).toBeTruthy();
    const before = h.workspace.loadTour(propertyId, tourIdOf(tourRef).tourId)!;
    const active = before.bundle.accessGrants.filter((grant) => grant.status === "ACTIVE");
    expect(active.length).toBeGreaterThan(0);

    const missing = await h.ok("hold_tour", { tourRef, hold: "on" });
    expect(missing).toMatchObject({ status: "blocked", code: "REASON_MISSING" });
    const holdAsked = await h.ok("hold_tour", { tourRef, hold: "on", reason: "Checking the lobby door" });
    expect(holdAsked.status).toBe("next");
    const held = await h.ok("hold_tour", { tourRef, hold: "on", reason: "Checking the lobby door", confirmationCode: codeOf(holdAsked) });
    expect(held.status).toBe("done");
    const resumeAsked = await h.ok("hold_tour", { tourRef, hold: "off" });
    expect(resumeAsked.status).toBe("next");
    const resumed = await h.ok("hold_tour", { tourRef, hold: "off", confirmationCode: codeOf(resumeAsked) });
    expect(resumed.status).toBe("done");

    const asked = await h.ok("cancel_tour", { tourRef, reason: "They asked to stop" });
    expect(asked.status).toBe("next");
    const done = await h.ok("cancel_tour", { tourRef, reason: "They asked to stop", confirmationCode: codeOf(asked) });
    expect(done).toMatchObject({ status: "done", accessSwitchedOff: true });
    const after = h.workspace.loadTour(propertyId, tourIdOf(tourRef).tourId)!;
    const grants = after.bundle.accessGrants.filter((grant) => active.some((item) => item.id === grant.id));
    expect(grants.length).toBe(active.length);
    expect(grants.every((grant) => grant.status === "REVOKED")).toBe(true);

    remember("hold_tour", { blocked: missing, next: holdAsked, done: held, resumeNext: resumeAsked, resumeDone: resumed });
    remember("cancel_tour", { next: asked, done });
    remember("get_tours", listed);
  });

  it("books, pauses, and replies with done, blocked, and next", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await a.text("Is there a gym?");
    await a.text("Can I change it to 3:15?");
    const before = await a.grok("get_inbox");
    const items = before.items as Array<{ kind?: string; status?: string; summary?: string; exceptionId?: string; tourTimeRequestId?: string; proposeDraft?: boolean }>;
    const flagged = items.find((item) => item.kind === "flagged-question" && item.status === "open" && /gym/i.test(item.summary ?? ""));
    const custom = items.find((item) => item.kind === "custom-time" && item.status === "waiting");
    expect(flagged?.exceptionId).toBeTruthy();
    expect(custom?.tourTimeRequestId).toBeTruthy();
    const eventId = a.routineEvents().find((event) => event.eventType === "exception.created")!.eventId;
    const event = await a.grok("get_inbox", { eventId });
    expect(event.instructions).toContain("resolve_issue");
    expect(event.instructions).not.toContain("answer_flagged_question");
    const old = await a.grok("get_operator_update", { eventId });
    expect(old.instructions).toContain("resolve_issue");
    expect(old.instructions).not.toContain("answer_flagged_question");

    const answerAsked = await a.grok("resolve_issue", { action: "answer", exceptionId: flagged!.exceptionId, approvedFact: "There's no gym" });
    expect(answerAsked.status).toBe("next");
    const answered = await a.grok("resolve_issue", {
      action: "answer",
      exceptionId: flagged!.exceptionId,
      approvedFact: "There's no gym",
      confirmationCode: codeOf(answerAsked),
    });
    expect(answered.status).toBe("done");
    const after = await a.grok("get_inbox");
    const still = (after.items as Array<{ status?: string; summary?: string }>).some((item) => item.status === "open" && /gym/i.test(item.summary ?? ""));
    expect(still).toBe(false);

    const timeAsked = await a.grok("reply_to_time_request", { action: "approve", tourTimeRequestId: custom!.tourTimeRequestId });
    expect(timeAsked.status).toBe("next");
    const timeDone = await a.grok("reply_to_time_request", {
      action: "approve",
      tourTimeRequestId: custom!.tourTimeRequestId,
      confirmationCode: codeOf(timeAsked),
    });
    expect(timeDone.status).toBe("done");
    const proposeBlocked = await a.grok("reply_to_time_request", { action: "propose", tourTimeRequestId: custom!.tourTimeRequestId });
    expect(proposeBlocked).toMatchObject({ status: "blocked", code: "TIME_UNCLEAR" });

    const pauseAsked = await a.grok("pause_tours", { unit: "Unit 2B", paused: true });
    expect(pauseAsked.status).toBe("next");
    const paused = await a.grok("pause_tours", {
      unit: "Unit 2B",
      paused: true,
      ...(typeof pauseAsked.bookedTours === "number" && pauseAsked.bookedTours > 0 ? { bookedTours: "keep" } : {}),
      confirmationCode: codeOf(pauseAsked),
    });
    expect(paused.status).toBe("done");
    const resumeAsked = await a.grok("pause_tours", { unit: "Unit 2B", paused: false });
    expect(resumeAsked.status).toBe("next");
    const resumed = await a.grok("pause_tours", { unit: "Unit 2B", paused: false, confirmationCode: codeOf(resumeAsked) });
    expect(resumed.status).toBe("done");

    const scheduleBlocked = await a.grok("schedule_tour", { phone: "+15555550111", visitorName: "Dana" });
    expect(scheduleBlocked).toMatchObject({ status: "blocked", code: "TOUR_UNCLEAR" });
    a.ws.recordDryTour("prop_100_alfred_way", { passed: true, ranAt: new Date(a.clock.t).toISOString(), checks: [], audit: [] });
    expect((await a.ws.publishDemoProperty("prop_100_alfred_way", new Date(a.clock.t))).published).toBe(true);
    const overlap = await a.grok("schedule_tour", {
      property: "prop_100_alfred_way",
      phone: "+15555550111",
      visitorName: "Dana",
      unit: "1A",
      startsAt: "3:15 PM today",
    });
    expect(overlap).toMatchObject({ status: "blocked", code: "SLOT_OVERLAP" });
    const scheduleAsked = await a.grok("schedule_tour", {
      property: "prop_100_alfred_way",
      phone: "+15555550111",
      visitorName: "Dana",
      unit: "1A",
      startsAt: "4:15 PM tomorrow",
    });
    expect(scheduleAsked.status).toBe("next");
    const scheduled = await a.grok("schedule_tour", {
      property: "prop_100_alfred_way",
      phone: "+15555550111",
      visitorName: "Dana",
      unit: "1A",
      startsAt: "4:15 PM tomorrow",
      confirmationCode: codeOf(scheduleAsked),
    });
    expect(scheduled, JSON.stringify({ status: scheduled.status, code: scheduled.code, message: scheduled.message })).toMatchObject({ status: "done", scheduled: true });

    const closeNote = await a.grok("resolve_issue", {
      action: "close",
      exceptionId: flagged!.exceptionId,
      resolutionNote: "Already answered.",
    });
    expect(closeNote.status).toBe("done");

    remember("get_inbox_before", { list: before, event });
    remember("get_inbox_after", after);
    remember("resolve_issue", { next: answerAsked, done: answered, close: closeNote });
    remember("reply_to_time_request", { next: timeAsked, done: timeDone, blocked: proposeBlocked });
    remember("pause_tours", { next: pauseAsked, done: paused, resumeNext: resumeAsked, resumeDone: resumed });
    remember("schedule_tour", { blocked: scheduleBlocked, overlap, next: scheduleAsked, done: scheduled });
    expect(JSON.stringify({ before, after, event })).not.toMatch(/145\s+Tenafly/i);
    expect(JSON.stringify({ before, after, event })).not.toMatch(/\b914B\b/);
  });

  it("refuses a fair-housing item with no draft", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    const before = a.fake.sent.length;
    await a.text("Do you rent to families with kids?");
    const listed = await a.grok("get_inbox");
    const item = (listed.items as Array<{ exceptionId?: string; proposeDraft?: boolean; summary?: string; kind?: string }>).find((row) =>
      /families/i.test(row.summary ?? ""),
    );
    expect(item).toMatchObject({ kind: "flagged-question", proposeDraft: false });
    const refused = await a.grok("resolve_issue", { action: "answer", exceptionId: item!.exceptionId, approvedFact: "Yes, that's fine." });
    expect(refused).toMatchObject({ status: "blocked", code: "NO_DRAFT", message: FAIR_HOUSING_REFUSAL });
    expect(a.fake.sent).toHaveLength(before + 1);
    remember("resolve_issue_fair_housing", { inbox: listed, blocked: refused });
  });

  it("creates a backup, confirms it, and restores it on this computer", async () => {
    const origin = installHarness();
    cleanups.push(origin.cleanup);
    const declined = await origin.ok("backup_records", { action: "decline" });
    expect(declined.status).toBe("done");
    remember("backup_records_decline", declined);

    const source = installHarness();
    cleanups.push(source.cleanup);
    const propertyId = await source.setUpAlfredWay();
    await source.ok("update_unit", { unit: "Unit 101", facts: ["In-unit laundry."] });
    const created = await source.ok("backup_records", { action: "create", reason: "operator" });
    expect(created.status).toBe("done");
    expect(created.fileName).toMatch(/tour-core-backup/);
    const artifactId = String(created.handoff.path).split("/").pop()!;
    const downloaded = source.inst.backups.handoff.takeDownload(artifactId, created.handoff.capability);
    expect(downloaded.body).toContain("In-unit laundry.");

    const destination = await source.ok("backup_records", { action: "confirm_destination", provider: "google_drive", folderName: "Tour Core" });
    expect(destination.status).toBe("done");
    const stored = await source.ok("backup_records", { action: "confirm_stored", fileName: created.fileName, checksum: created.checksum });
    expect(stored.status).toBe("done");
    const status = await source.ok("backup_records", { action: "status" });
    expect(status.status).toBe("done");
    expect(status.lastBackupConfirmedInDriveAt).toBeTruthy();
    const mismatch = await source.ok("backup_records", { action: "confirm_stored", fileName: created.fileName, checksum: "a".repeat(64) });
    expect(mismatch).toMatchObject({ status: "blocked" });
    expect(mismatch.message).toMatch(/doesn't match the backup/);

    const clean = installHarness();
    cleanups.push(clean.cleanup);
    expect(clean.workspace.list()).toHaveLength(0);
    const upload = await clean.ok("restore_records", { action: "upload" });
    expect(upload.status).toBe("done");
    const uploadId = String(upload.handoff.path).split("/").pop()!;
    clean.inst.backups.receive(uploadId, upload.handoff.capability, downloaded.body);
    const preview = await clean.ok("restore_records", { action: "preview", uploadId });
    expect(preview.status).toBe("done");
    expect(preview.counts.properties).toBeGreaterThanOrEqual(1);
    expect(clean.workspace.list()).toHaveLength(0);
    const importAsked = await clean.ok("restore_records", { action: "import", uploadId });
    expect(importAsked.status).toBe("next");
    const imported = await clean.ok("restore_records", { action: "import", uploadId, confirmationCode: codeOf(importAsked) });
    expect(imported.status).toBe("done");
    expect(clean.workspace.list().map((property) => property.config.property.name)).toContain("100 Alfred Way");
    expect(JSON.stringify(clean.workspace.list())).toContain("In-unit laundry.");

    const occupied = installHarness();
    cleanups.push(occupied.cleanup);
    await occupied.setUpAlfredWay();
    const again = await occupied.ok("restore_records", { action: "upload" });
    const againId = String(again.handoff.path).split("/").pop()!;
    const second = installHarness();
    cleanups.push(second.cleanup);
    await second.setUpAlfredWay();
    const secondBackup = await second.ok("backup_records", { action: "create" });
    const secondArtifact = String(secondBackup.handoff.path).split("/").pop()!;
    const secondBody = second.inst.backups.handoff.takeDownload(secondArtifact, secondBackup.handoff.capability).body;
    occupied.inst.backups.receive(againId, again.handoff.capability, secondBody);
    const replaced = await occupied.ok("restore_records", { action: "import", uploadId: againId });
    expect(replaced).toMatchObject({ status: "blocked", code: "REPLACE_REQUIRED" });
    expect(occupied.workspace.list()).toHaveLength(1);
    expect(occupied.workspace.list()[0]!.config.property.id).toBe(propertyId);

    remember("backup_records", {
      create: { ...created, handoff: { ...created.handoff, capability: "[redacted]" } },
      confirm_destination: destination,
      confirm_stored: stored,
      status,
      blocked: mismatch,
    });
    remember("restore_records", {
      upload: { ...upload, handoff: { ...upload.handoff, capability: "[redacted]" } },
      preview,
      next: importAsked,
      done: imported,
      blocked: replaced,
    });
    expect(JSON.stringify(proof)).not.toMatch(/145\s+Tenafly/i);
    expect(JSON.stringify(proof)).not.toMatch(/\b914B\b/);
  });
});
