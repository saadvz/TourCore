import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handlePortableRequest } from "../src/backup/http";
import { CHECKSUM_COVERS, CHECKSUM_COVERS_RESULT, checksumOf, parsePortableBackup } from "../src/backup/portable";
import { OPERATOR_TOOLS } from "../src/operator/tools";
import { sha256Json } from "../src/storage/documentStore";
import { InMemoryStore } from "../src/storage/Store";
import { installHarness, SB_KEY, SB_SECRET, type InstallHarness } from "./installHarness";

const FILE_CHANGED = "This backup file was changed or damaged after it was made, so nothing was restored. Try the original file.";
const PART_CHANGED = "Part of this backup file was changed or damaged, so nothing was restored. Try the original file.";
const NOT_A_BACKUP = "This file doesn't look like a Tour Core backup, so nothing was restored. Try the original file.";
const PART_BROKEN = "Part of this backup file is broken, so nothing was restored. Try the original file.";
const NOT_MADE = "The backup wasn't made because some saved records don't fit together. Nothing was changed.";
const NOT_MADE_SECRET = "The backup wasn't made because it would have included a password or key. Nothing was changed.";

/** Compact JSON with sorted keys: the documented input to the backup checksum. */
function compactSortedJson(value: unknown): string {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  const walk = (node: unknown): string => {
    if (node === null || typeof node !== "object") return JSON.stringify(node) ?? "null";
    if (Array.isArray(node)) return `[${node.map((item) => walk(item)).join(",")}]`;
    const obj = node as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${walk(obj[key])}`)
      .join(",")}}`;
  };
  return walk(normalized);
}

function documentedChecksum(contents: unknown): string {
  return createHash("sha256").update(compactSortedJson(contents), "utf8").digest("hex");
}

type BackupFile = {
  checksum: string;
  contents: { files: Array<{ path: string; sha256: string; body: Record<string, unknown> }> };
};

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((run) => run()));

function hosted(): InstallHarness {
  const h = installHarness({
    env: { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app", PORT: "8080" },
  });
  cleanups.push(h.cleanup);
  h.inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
  h.inst.files.setPublicBaseUrl("https://demo.up.railway.app", "RAILWAY");
  h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at: new Date(h.now()).toISOString(), message: "ok", url: "https://demo.up.railway.app" });
  return h;
}

function readyTexting(h: InstallHarness) {
  h.connectGrok();
  h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550109999" });
  h.inst.files.recordCheck("visitorMessaging", { ok: true, at: new Date(h.now()).toISOString(), message: "ok", problems: [], publicBaseUrl: h.inst.publicBaseUrl()! });
}

describe("hosted volume onboarding", () => {
  it("does not require Tour Core Google OAuth and offers the property after the backup destination is confirmed", async () => {
    const h = hosted();
    readyTexting(h);
    const step = await h.ok("get_next_installation_step");
    expect(step).toMatchObject({
      component: "STORAGE",
      action: "CONFIRM_BACKUP_DESTINATION",
      tool: "confirm_backup_destination",
      operatorMessage: "Visitor texting is connected. Next I recommend Google Drive so I can keep portable backups and exports of your Tour Core records there.",
    });
    expect(step.operatorMessage).not.toMatch(/OAuth client|client secret|canonical/i);
    expect(step.grokInstructions).toMatch(/native Google Drive connector/);
    expect(step.grokInstructions).toMatch(/Do not call begin_google_drive_connect/);
    expect(h.inst.records.beginConnect().configured).toBe(false);
    expect(JSON.stringify(await h.ok("get_installation_status"))).not.toMatch(/Tour Core Google OAuth client is missing|Google Drive canonical/);

    await h.ok("confirm_backup_destination", { provider: "google_drive", folderName: "Tour Core", accountLabel: "Ada" });
    expect((await h.ok("get_next_installation_step")).action).toBe("SET_UP_PROPERTY");
    const storage = await h.component("STORAGE");
    expect(storage.summary).toMatch(/Operational records: Stored by hosted Tour Core/);
    expect(storage.summary).toMatch(/Portable backup: Google Drive connected/);
    const resumed = await h.inst.records.resumeCanonical();
    expect(resumed.ok).toBe(true);
    expect(resumed.summary).not.toMatch(/lease|canonical/i);
  });

  it("does not let a direct Drive lease block hosted setup", async () => {
    const h = hosted();
    readyTexting(h);
    expect(() => h.inst.records.prepare()).toThrow(/live store/);
    expect((await h.ok("get_next_installation_step")).action).toBe("CONFIRM_BACKUP_DESTINATION");
  });

  it("continues to the property when portable backups are declined", async () => {
    const h = hosted();
    readyTexting(h);
    await h.ok("decline_portable_backup");
    expect((await h.ok("get_next_installation_step")).action).toBe("SET_UP_PROPERTY");
    expect((await h.component("STORAGE")).summary).toMatch(/Portable backup: not connected/);
  });
});

describe("portable backup and restore", () => {
  it("snapshots business state, excludes secrets, and restores a clean host", async () => {
    const origin = hosted();
    origin.inst.secrets.set({
      SENDBLUE_API_API_KEY: SB_KEY,
      SENDBLUE_API_API_SECRET: SB_SECRET,
      SENDBLUE_FROM_NUMBER: "+15550109999",
      GOOGLE_OAUTH_REFRESH_TOKEN: "google-refresh-SECRET-token-xyz",
      TOURCORE_GROK_ROUTINE_KEY: "routine-bearer-SECRETKEY-1a2b3c4d",
    });
    const propertyId = await origin.setUpAlfredWay();
    await origin.ok("update_unit", { unit: "Unit 101", facts: ["In-unit laundry."] });
    const visitor = await origin.touringVisitor(propertyId, { name: "Pat Smith" });
    await visitor.act("finish");

    const created = await origin.ok("create_portable_backup", { reason: "tour" });
    expect(created.schemaVersion).toBe(1);
    expect(created.fileName).toMatch(/^tour-core-backup-\d{4}-\d{2}-\d{2}T\d{6}Z\.json$/);
    const artifactId = String(created.handoff.path).split("/").pop()!;
    const downloaded = origin.inst.backups.handoff.takeDownload(artifactId, created.handoff.capability);
    expect(downloaded.body).toContain("tourcore-portable-backup");
    expect(downloaded.body).toContain("In-unit laundry.");
    expect(downloaded.body).toContain(propertyId);
    for (const secret of [SB_KEY, SB_SECRET, "google-refresh-SECRET-token-xyz", "routine-bearer-SECRETKEY-1a2b3c4d"]) {
      expect(downloaded.body).not.toContain(secret);
    }
    expect(() => origin.inst.backups.handoff.takeDownload(artifactId, created.handoff.capability)).toThrow(/expired/);

    const clean = hosted();
    const upload = await clean.ok("begin_restore_upload");
    const uploadId = String(upload.handoff.path).split("/").pop()!;
    clean.inst.backups.receive(uploadId, upload.handoff.capability, downloaded.body);
    const preview = await clean.ok("preview_portable_restore", { uploadId });
    expect(preview.summary).toMatch(/Backup contains:/);
    expect(preview.counts.properties).toBeGreaterThanOrEqual(1);
    expect(preview.counts.units).toBeGreaterThanOrEqual(2);
    expect(preview.counts.facts).toBeGreaterThanOrEqual(1);
    expect(preview.counts.tours).toBeGreaterThanOrEqual(1);
    const asked = await clean.ok("import_portable_backup", { uploadId });
    expect(asked.requiresConfirmation).toBe(true);
    const restored = await clean.ok("import_portable_backup", { uploadId, confirmationCode: asked.confirmationCode });
    expect(restored.lines).toEqual([
      "Property records: restored",
      "Tour history: restored",
      "Visitor texting: reconnect required",
      "Operator updates: reconnect required",
      "Door provider: reconnect required where applicable",
    ]);
    expect(clean.inst.secrets.get("SENDBLUE_API_API_KEY")).toBeUndefined();
    expect(clean.inst.secrets.get("GOOGLE_OAUTH_REFRESH_TOKEN")).toBeUndefined();
    expect(clean.workspace.list().map((property) => property.config.property.name)).toContain("100 Alfred Way");
    expect(JSON.stringify(clean.workspace.list())).toContain("In-unit laundry.");

    await origin.ok("confirm_backup_stored", { fileName: created.fileName, checksum: created.checksum });
    const status = await origin.ok("get_backup_status");
    expect(status.lastBackupConfirmedInDriveAt).toBeTruthy();
  });

  it("rejects a bad checksum, an unsupported schema, a malformed route, and a secret", async () => {
    const h = hosted();
    await h.setUpAlfredWay();
    const created = await h.ok("create_portable_backup");
    const artifactId = String(created.handoff.path).split("/").pop()!;
    const raw = h.inst.backups.handoff.takeDownload(artifactId, created.handoff.capability).body;
    const backup = JSON.parse(raw) as {
      schemaVersion: number;
      checksum: string;
      contents: { files: Array<{ path: string; sha256: string; body: Record<string, unknown> }> };
    };

    expect(() => parsePortableBackup({ ...backup, checksum: "a".repeat(64) })).toThrow(FILE_CHANGED);
    expect(() => parsePortableBackup({ ...backup, schemaVersion: 2 })).toThrow(/doesn't support/);

    const malformed = structuredClone(backup);
    const config = malformed.contents.files.find((file) => file.path.endsWith("/tourcore.config.json"))!;
    const body = config.body as { routes: Array<{ stops: Array<{ doorId: string }> }> };
    body.routes[0]!.stops[0]!.doorId = "missing_door";
    config.sha256 = sha256Json(body);
    malformed.checksum = checksumOf(malformed.contents);
    expect(() => parsePortableBackup(malformed)).toThrow(PART_BROKEN);

    const configPath = join(h.root, "properties", h.workspace.propertyIds()[0]!, "tourcore.config.json");
    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as { property: { facts?: string[] } };
    onDisk.property.facts = [SB_KEY];
    writeFileSync(configPath, JSON.stringify(onDisk));
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY });
    const secret = await h.fails("create_portable_backup");
    expect(secret).toBe(NOT_MADE_SECRET);
    expect(secret).not.toMatch(/restored/);
  });

  it("refuses a destructive restore unless replacement is explicit", async () => {
    const origin = hosted();
    await origin.setUpAlfredWay();
    const created = await origin.ok("create_portable_backup");
    const artifactId = String(created.handoff.path).split("/").pop()!;
    const body = origin.inst.backups.handoff.takeDownload(artifactId, created.handoff.capability).body;

    const occupied = hosted();
    await occupied.setUpAlfredWay();
    const upload = await occupied.ok("begin_restore_upload");
    const uploadId = String(upload.handoff.path).split("/").pop()!;
    occupied.inst.backups.receive(uploadId, upload.handoff.capability, body);
    const refused = await occupied.ok("import_portable_backup", { uploadId });
    expect(refused.summary).toMatch(/already has records/);
    expect(occupied.workspace.list()).toHaveLength(1);
    const asked = await occupied.ok("import_portable_backup", { uploadId, recovery: "replace" });
    expect(asked.requiresConfirmation).toBe(true);
    expect(asked.summary).toMatch(/Replace the records/);
  });

  it("expires a handoff and does not let a backup failure block a booking", async () => {
    const h = hosted();
    const propertyId = await h.setUpAlfredWay();
    const created = await h.ok("create_portable_backup");
    h.setClock(h.now() + 16 * 60_000);
    const artifactId = String(created.handoff.path).split("/").pop()!;
    expect(() => h.inst.backups.handoff.takeDownload(artifactId, created.handoff.capability)).toThrow(/expired/);

    h.inst.backups.noteFailure("Google Drive didn't answer.");
    h.inst.records.setDriveReachable(false);
    await h.inst.records.beforeAccess();
    expect(h.inst.records.wrapStore(new InMemoryStore())).toBeInstanceOf(InMemoryStore);
    await h.touringVisitor(propertyId);
    expect(h.inst.records.provider()).toBe("HOSTED_VOLUME");
    expect(h.inst.records.storageRead()).toBe("live");
    const status = await h.ok("get_backup_status");
    expect(status.stale).toBe(true);
    expect(status.lastFailureSummary).toMatch(/didn't answer/);
    expect(h.workspace.has(propertyId)).toBe(true);
  });

  it("serves one capability download and hides a missing capability", async () => {
    const h = hosted();
    await h.setUpAlfredWay();
    const created = await h.ok("create_portable_backup");
    const artifactId = String(created.handoff.path).split("/").pop()!;
    const path = `/portable/artifacts/${artifactId}`;
    const hidden = await handlePortableRequest(h.inst.backups, "GET", path, { headers: {} } as never);
    expect(hidden).toMatchObject({ status: 404 });
    const ok = await handlePortableRequest(h.inst.backups, "GET", path, { headers: { "x-tourcore-capability": created.handoff.capability } } as never);
    expect(ok?.status).toBe(200);
    expect(ok?.body).toContain("tourcore-portable-backup");
    expect(ok?.body).not.toContain(SB_KEY);
    const again = await handlePortableRequest(h.inst.backups, "GET", path, { headers: { "x-tourcore-capability": created.handoff.capability } } as never);
    expect(again).toMatchObject({ status: 404 });
  });

  it("reports the checksum of contents, not a hash of the downloaded file", async () => {
    const h = hosted();
    await h.setUpAlfredWay();
    const created = await h.ok("backup_records", { action: "create" });
    const artifactId = String(created.handoff.path).split("/").pop()!;
    const raw = h.inst.backups.handoff.takeDownload(artifactId, created.handoff.capability).body;
    const backup = JSON.parse(raw) as BackupFile;
    const digest = documentedChecksum(backup.contents);
    expect(digest).toBe(created.checksum);
    expect(digest).toBe(backup.checksum);
    expect(createHash("sha256").update(raw, "utf8").digest("hex")).not.toBe(digest);
    const file = compactSortedJson(backup.contents.files[0]);
    expect(file.indexOf('"body"')).toBeLessThan(file.indexOf('"kind"'));
    expect(file.indexOf('"kind"')).toBeLessThan(file.indexOf('"path"'));
    expect(file.indexOf('"path"')).toBeLessThan(file.indexOf('"sha256"'));
    expect(created.checksumCovers).toBe(CHECKSUM_COVERS_RESULT);
    for (const name of ["backup_records", "restore_records"]) {
      expect(OPERATOR_TOOLS.find((tool) => tool.name === name)?.description, name).toContain(CHECKSUM_COVERS);
    }
    const exportDescription = OPERATOR_TOOLS.find((tool) => tool.name === "export_records")?.description ?? "";
    expect(exportDescription).not.toContain(CHECKSUM_COVERS);
    expect(exportDescription).not.toContain("SHA-256");
    expect((await h.ok("restore_records", { action: "upload" })).checksumCovers).toBe(CHECKSUM_COVERS_RESULT);
  });

  it("prefixes checksumCovers so SHA-256 is not read aloud", async () => {
    const h = hosted();
    await h.setUpAlfredWay();
    const results = [
      await h.ok("backup_records", { action: "create" }),
      await h.ok("backup_records", { action: "status" }),
      await h.ok("backup_records", { action: "decline" }),
      await h.ok("restore_records", { action: "upload" }),
    ];
    for (const result of results) {
      expect(result.checksumCovers).toBe(CHECKSUM_COVERS_RESULT);
      expect(String(result.checksumCovers).startsWith("For you, not out loud: ")).toBe(true);
      const spoken = typeof result.message === "string" ? result.message : String(result.summary ?? "");
      expect(spoken).not.toMatch(/SHA-256/);
      expect(String(result.checksumCovers).split("For you, not out loud:")[0]).not.toMatch(/SHA-256/);
    }
  });

  it("restores nothing when the backup file was changed", async () => {
    const origin = hosted();
    await origin.setUpAlfredWay();
    const created = await origin.ok("backup_records", { action: "create" });
    const artifactId = String(created.handoff.path).split("/").pop()!;
    const backup = JSON.parse(origin.inst.backups.handoff.takeDownload(artifactId, created.handoff.capability).body) as BackupFile;
    backup.checksum = "a".repeat(64);

    const dest = hosted();
    const propertyId = await dest.setUpAlfredWay();
    const before = JSON.stringify(dest.workspace.list());
    const upload = await dest.ok("restore_records", { action: "upload" });
    const uploadId = String(upload.handoff.path).split("/").pop()!;
    dest.inst.backups.receive(uploadId, upload.handoff.capability, JSON.stringify(backup));
    const preview = await dest.ok("restore_records", { action: "preview", uploadId });
    const imported = await dest.ok("restore_records", { action: "import", uploadId });

    expect(preview).toMatchObject({ status: "blocked", message: FILE_CHANGED });
    expect(imported).toMatchObject({ status: "blocked", message: FILE_CHANGED });
    expect(JSON.stringify(dest.workspace.list())).toBe(before);
    expect(dest.workspace.list().map((property) => property.config.property.id)).toEqual([propertyId]);
  });

  it("restores nothing when part of the backup was changed", async () => {
    const origin = hosted();
    await origin.setUpAlfredWay();
    const created = await origin.ok("backup_records", { action: "create" });
    const artifactId = String(created.handoff.path).split("/").pop()!;
    const backup = JSON.parse(origin.inst.backups.handoff.takeDownload(artifactId, created.handoff.capability).body) as BackupFile;
    const config = backup.contents.files.find((file) => file.path.endsWith("/tourcore.config.json"))!;
    const body = config.body as { property?: { facts?: string[] } };
    body.property = { ...body.property, facts: [...(body.property?.facts ?? []), "Tampered fact."] };
    backup.checksum = documentedChecksum(backup.contents);

    const dest = hosted();
    await dest.setUpAlfredWay();
    const before = JSON.stringify(dest.workspace.list());
    const upload = await dest.ok("restore_records", { action: "upload" });
    const uploadId = String(upload.handoff.path).split("/").pop()!;
    dest.inst.backups.receive(uploadId, upload.handoff.capability, JSON.stringify(backup));
    const preview = await dest.ok("restore_records", { action: "preview", uploadId });
    const imported = await dest.ok("restore_records", { action: "import", uploadId });

    expect(preview).toMatchObject({ status: "blocked", message: PART_CHANGED });
    expect(imported).toMatchObject({ status: "blocked", message: PART_CHANGED });
    expect(JSON.stringify(dest.workspace.list())).toBe(before);
    expect(JSON.stringify(dest.workspace.list())).not.toContain("Tampered fact.");
  });

  it("restores nothing when the backup has a stray path", async () => {
    const origin = hosted();
    await origin.setUpAlfredWay();
    const created = await origin.ok("backup_records", { action: "create" });
    const artifactId = String(created.handoff.path).split("/").pop()!;
    const backup = JSON.parse(origin.inst.backups.handoff.takeDownload(artifactId, created.handoff.capability).body) as BackupFile & {
      contents: { files: Array<{ path: string; kind: string; sha256: string; body: Record<string, unknown> }> };
    };
    backup.contents.files.push({ path: "notes/stray.json", kind: "record", sha256: "ab".repeat(32), body: {} });
    backup.checksum = checksumOf(backup.contents);

    const dest = hosted();
    await dest.setUpAlfredWay();
    const before = JSON.stringify(dest.workspace.list());
    const upload = await dest.ok("restore_records", { action: "upload" });
    const uploadId = String(upload.handoff.path).split("/").pop()!;
    dest.inst.backups.receive(uploadId, upload.handoff.capability, JSON.stringify(backup));
    const preview = await dest.ok("restore_records", { action: "preview", uploadId });
    const imported = await dest.ok("restore_records", { action: "import", uploadId });

    expect(preview).toMatchObject({ status: "blocked", message: NOT_A_BACKUP, checksumCovers: CHECKSUM_COVERS_RESULT });
    expect(imported).toMatchObject({ status: "blocked", message: NOT_A_BACKUP, checksumCovers: CHECKSUM_COVERS_RESULT });
    expect(JSON.stringify(dest.workspace.list())).toBe(before);
  });

  it("restores nothing when a route in the backup is broken", async () => {
    const origin = hosted();
    await origin.setUpAlfredWay();
    const created = await origin.ok("backup_records", { action: "create" });
    const artifactId = String(created.handoff.path).split("/").pop()!;
    const backup = JSON.parse(origin.inst.backups.handoff.takeDownload(artifactId, created.handoff.capability).body) as BackupFile;
    const config = backup.contents.files.find((file) => file.path.endsWith("/tourcore.config.json"))!;
    const body = config.body as { routes: Array<{ stops: Array<{ doorId: string }> }> };
    body.routes[0]!.stops[0]!.doorId = "missing_door";
    config.sha256 = sha256Json(body);
    backup.checksum = checksumOf(backup.contents);

    const dest = hosted();
    await dest.setUpAlfredWay();
    const before = JSON.stringify(dest.workspace.list());
    const upload = await dest.ok("restore_records", { action: "upload" });
    const uploadId = String(upload.handoff.path).split("/").pop()!;
    dest.inst.backups.receive(uploadId, upload.handoff.capability, JSON.stringify(backup));
    const preview = await dest.ok("restore_records", { action: "preview", uploadId });
    const imported = await dest.ok("restore_records", { action: "import", uploadId });

    expect(preview).toMatchObject({ status: "blocked", message: PART_BROKEN, checksumCovers: CHECKSUM_COVERS_RESULT });
    expect(imported).toMatchObject({ status: "blocked", message: PART_BROKEN, checksumCovers: CHECKSUM_COVERS_RESULT });
    expect(JSON.stringify(dest.workspace.list())).toBe(before);
    expect(JSON.stringify(dest.workspace.list())).not.toContain("missing_door");
  });

  it("restores nothing when the backup has two tours with the same id", async () => {
    const origin = hosted();
    await origin.setUpAlfredWay();
    const created = await origin.ok("backup_records", { action: "create" });
    const artifactId = String(created.handoff.path).split("/").pop()!;
    const backup = JSON.parse(origin.inst.backups.handoff.takeDownload(artifactId, created.handoff.capability).body) as BackupFile & {
      contents: { files: Array<{ path: string; kind: string; sha256: string; body: Record<string, unknown> }> };
    };
    const tour = { tourId: "tour_same" };
    const sha256 = sha256Json(tour);
    backup.contents.files.push(
      { path: "properties/demo/tours/one/record.json", kind: "record", sha256, body: tour },
      { path: "properties/demo/tours/two/record.json", kind: "record", sha256, body: { tourId: "tour_same" } },
    );
    backup.checksum = checksumOf(backup.contents);

    const dest = hosted();
    await dest.setUpAlfredWay();
    const before = JSON.stringify(dest.workspace.list());
    const upload = await dest.ok("restore_records", { action: "upload" });
    const uploadId = String(upload.handoff.path).split("/").pop()!;
    dest.inst.backups.receive(uploadId, upload.handoff.capability, JSON.stringify(backup));
    const preview = await dest.ok("restore_records", { action: "preview", uploadId });
    const imported = await dest.ok("restore_records", { action: "import", uploadId });

    expect(preview).toMatchObject({ status: "blocked", message: PART_BROKEN });
    expect(imported).toMatchObject({ status: "blocked", message: PART_BROKEN });
    expect(JSON.stringify(dest.workspace.list())).toBe(before);
    expect(JSON.stringify(dest.workspace.list())).not.toContain("tour_same");
  });

  it("stores the checksum of raw UTF-8 contents, not a \\u escape or a trailing newline", () => {
    const contents = {
      files: [
        {
          sha256: "ab".repeat(32),
          path: "properties/demo/note.json",
          kind: "record",
          body: {
            note: "café",
            quote: "’",
            emoji: "😀",
            nested: { z: 1, a: 2 },
          },
        },
      ],
    };
    const handwritten =
      '{"files":[{"body":{"emoji":"😀","nested":{"a":2,"z":1},"note":"café","quote":"’"},"kind":"record","path":"properties/demo/note.json","sha256":"abababababababababababababababababababababababababababababababab"}]}';
    const escaped =
      '{"files":[{"body":{"emoji":"\\uD83D\\uDE00","nested":{"a":2,"z":1},"note":"caf\\u00e9","quote":"\\u2019"},"kind":"record","path":"properties/demo/note.json","sha256":"abababababababababababababababababababababababababababababababab"}]}';
    const sha256Utf8 = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
    expect(handwritten.endsWith("\n")).toBe(false);
    expect(handwritten.includes("\\u")).toBe(false);
    const stored = checksumOf(contents);
    expect(stored).toBe(sha256Utf8(handwritten));
    expect(stored).not.toBe(sha256Utf8(escaped));
    expect(stored).not.toBe(sha256Utf8(`${handwritten}\n`));
    expect(CHECKSUM_COVERS).toContain("not \\u-escaped");
    expect(CHECKSUM_COVERS).toContain("no trailing newline");
    expect(CHECKSUM_COVERS).toContain("`contents`");
    expect(CHECKSUM_COVERS).toContain("`checksum`");
  });

  it("puts the checksum note on backup results and leaves it off exports", async () => {
    const h = hosted();
    const propertyId = await h.setUpAlfredWay();
    for (const result of [
      await h.ok("backup_records", { action: "create" }),
      await h.ok("backup_records", { action: "status" }),
      await h.ok("restore_records", { action: "upload" }),
    ]) {
      expect(result.checksumCovers).toBe(`For you, not out loud: ${CHECKSUM_COVERS}`);
    }
    for (const result of [
      await h.ok("export_records", { property: propertyId, day: "today" }),
      await h.ok("export_audit", { property: propertyId, day: "today" }),
      await h.ok("export_records", { kind: "readable" }),
    ]) {
      expect(result.checksumCovers).toBeUndefined();
    }
  });

  it("puts the checksum note on blocked restores and leaves it off a blocked export", async () => {
    const origin = hosted();
    await origin.setUpAlfredWay();
    const created = await origin.ok("backup_records", { action: "create" });
    const artifactId = String(created.handoff.path).split("/").pop()!;
    const body = origin.inst.backups.handoff.takeDownload(artifactId, created.handoff.capability).body;

    const dest = hosted();
    const propertyId = await dest.setUpAlfredWay();
    const upload = await dest.ok("restore_records", { action: "upload" });
    const uploadId = String(upload.handoff.path).split("/").pop()!;
    dest.inst.backups.receive(uploadId, upload.handoff.capability, body);
    const replaced = await dest.ok("restore_records", { action: "import", uploadId });
    expect(replaced).toMatchObject({ status: "blocked", code: "REPLACE_REQUIRED", checksumCovers: CHECKSUM_COVERS_RESULT });

    const missing = await dest.ok("restore_records", { action: "import" });
    expect(missing).toMatchObject({
      status: "blocked",
      message: "Upload the backup file first, then I can show you what's in it.",
      checksumCovers: CHECKSUM_COVERS_RESULT,
    });

    const blockedExport = await dest.ok("export_records", { property: propertyId, day: "not a day" });
    expect(blockedExport).toMatchObject({ status: "blocked" });
    expect(blockedExport.checksumCovers).toBeUndefined();
  });

  it("refuses to create a backup when saved records don't fit together", async () => {
    const h = hosted();
    await h.setUpAlfredWay();
    const configPath = join(h.root, "properties", h.workspace.propertyIds()[0]!, "tourcore.config.json");
    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as { routes: Array<{ stops: Array<{ doorId: string }> }> };
    onDisk.routes[0]!.stops[0]!.doorId = "missing_door";
    writeFileSync(configPath, JSON.stringify(onDisk));
    const before = JSON.stringify(h.workspace.list());
    const created = await h.ok("backup_records", { action: "create" });
    expect(created).toMatchObject({ status: "blocked", message: NOT_MADE });
    expect(String(created.message)).not.toMatch(/restored/);
    expect(JSON.stringify(h.workspace.list())).toBe(before);
    const again = await h.fails("create_portable_backup");
    expect(again).toBe(NOT_MADE);
    expect(again).not.toMatch(/restored/);
  });

  it("refuses to create a backup that would include a password or key", async () => {
    const h = hosted();
    await h.setUpAlfredWay();
    const configPath = join(h.root, "properties", h.workspace.propertyIds()[0]!, "tourcore.config.json");
    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as { property: { facts?: string[] } };
    onDisk.property.facts = [SB_KEY];
    writeFileSync(configPath, JSON.stringify(onDisk));
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY });
    const created = await h.ok("backup_records", { action: "create" });
    expect(created).toMatchObject({ status: "blocked", message: NOT_MADE_SECRET });
    expect(String(created.message)).not.toMatch(/restored/);
  });
});
