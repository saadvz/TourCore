import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StoreBusyError } from "./errors";
import { sha256Json, type DocumentStore } from "./documentStore";

/** Runtime namespaces that hold credentials or session secrets. Never copied to Drive. */
const SKIP_PREFIXES = ["runtime/oauth/", "runtime/setup-sessions/", "runtime/approval-sessions/", "runtime/probe/"];
const SKIP_FILES = new Set(["install/secrets.json"]);
const SECRET_FIELDS = new Set(["refreshToken", "refresh_token", "accessToken", "access_token", "clientSecret", "client_secret", "apiSecret", "apiKey", "webhookSecret", "password"]);

export interface CanonicalFile {
  path: string;
  kind: string;
  body: unknown;
  sha256: string;
}

export function looksLikeSecret(value: unknown, secretValues: string[] = []): boolean {
  const text = JSON.stringify(value) ?? "";
  if (secretValues.some((secret) => secret.length >= 6 && text.includes(secret))) return true;
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (SECRET_FIELDS.has(key) && typeof child === "string" && child.length > 0) return true;
      if (walk(child)) return true;
    }
    return false;
  };
  return walk(value);
}

/** Local canonical JSON, excluding secrets. Paths use forward slashes and are relative to the data folder. */
export function collectCanonical(root: string, secretValues: string[] = []): CanonicalFile[] {
  const files: CanonicalFile[] = [];
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = rel ? `${rel}/${name}` : name;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!SKIP_PREFIXES.some((prefix) => `${path}/`.startsWith(prefix) || path.startsWith(prefix.replace(/\/$/, "")))) walk(full, path);
        continue;
      }
      if (!name.endsWith(".json") || SKIP_FILES.has(path) || SKIP_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
      let body: unknown;
      try {
        body = JSON.parse(readFileSync(full, "utf8"));
      } catch {
        continue;
      }
      if (looksLikeSecret(body, secretValues)) continue;
      files.push({ path, kind: kindOf(path), body, sha256: sha256Json(body) });
    }
  };
  for (const top of ["install", "properties", "runtime"]) walk(join(root, top), top);
  return files;
}

function kindOf(path: string): string {
  if (path.endsWith("/tourcore.config.json")) return "property";
  if (path.endsWith("/status.json")) return "property-state";
  if (path.endsWith("/content-changes.json")) return "content-changes";
  if (path.includes("/tour-export.json")) return "tour-export";
  if (path.endsWith("/record.json")) return "tour-record";
  if (path.startsWith("runtime/sessions/")) return "session";
  if (path.startsWith("runtime/verification/")) return "verification-link";
  if (path.startsWith("runtime/messaging-ledger/")) return "messaging-ledger";
  if (path.startsWith("runtime/endpoints/")) return "endpoint";
  if (path.startsWith("runtime/operator-events/")) return "operator-event";
  if (path === "install/manifest.json") return "installation";
  if (path === "install/storage-audit.json") return "storage-audit";
  return "record";
}

export interface LookupIndex {
  schemaVersion: 1;
  properties: { id: string; name: string }[];
  phones: { phone: string; propertyId: string }[];
  prospects: { id: string; propertyId?: string; phone?: string }[];
  reservations: { id: string; propertyId?: string; status?: string }[];
  tours: { tourId: string; propertyId?: string; outcome?: string }[];
}

/** Small indexes so an inbound text doesn't scan Drive. Rebuilt from canonical files. */
export function buildLookup(files: CanonicalFile[]): LookupIndex {
  const index: LookupIndex = { schemaVersion: 1, properties: [], phones: [], prospects: [], reservations: [], tours: [] };
  for (const file of files) {
    const body = file.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") continue;
    if (file.kind === "property") {
      const property = body.property as { id?: string; name?: string } | undefined;
      if (property?.id) index.properties.push({ id: property.id, name: property.name ?? property.id });
    }
    if (file.kind === "endpoint") {
      const address = body.address;
      const propertyId = body.propertyId;
      if (typeof address === "string" && typeof propertyId === "string") index.phones.push({ phone: address, propertyId });
    }
    if (file.kind === "tour-record") {
      const tourId = body.tourId;
      if (typeof tourId === "string") index.tours.push({ tourId, outcome: typeof body.outcome === "string" ? body.outcome : undefined });
    }
    if (file.kind === "tour-export") {
      const propertyId = (body.property as { id?: string } | undefined)?.id;
      for (const prospect of (body.prospects as { id?: string; phone?: string }[] | undefined) ?? []) {
        if (prospect.id) index.prospects.push({ id: prospect.id, propertyId, phone: prospect.phone });
      }
      for (const reservation of (body.reservations as { id?: string; status?: string; propertyId?: string }[] | undefined) ?? []) {
        if (reservation.id) index.reservations.push({ id: reservation.id, propertyId: reservation.propertyId ?? propertyId, status: reservation.status });
      }
    }
  }
  return index;
}

export function tourHistoryCsv(index: LookupIndex): string {
  const lines = ["tourId,propertyId,outcome", ...index.tours.map((tour) => [tour.tourId, tour.propertyId ?? "", tour.outcome ?? ""].join(","))];
  return lines.join("\n") + "\n";
}

export interface StoreLease {
  schemaVersion: 1;
  storeId: string;
  writerHostId: string;
  installationId: string;
  expiresAt: string;
  heartbeatAt: string;
}

const LEASE_PATH = "lease.json";

export async function readLease(store: DocumentStore): Promise<{ lease?: StoreLease; revision?: string }> {
  const doc = await store.get(LEASE_PATH);
  return { lease: doc?.body as StoreLease | undefined, revision: doc?.revision };
}

export async function claimLease(
  store: DocumentStore,
  identity: { storeId: string; writerHostId: string; installationId: string },
  now: number,
  ttlMs: number,
  takeover = false,
): Promise<{ lease: StoreLease; tookOver: boolean; expired: boolean }> {
  const current = await readLease(store);
  const lease = current.lease;
  const expiry = lease ? Date.parse(lease.expiresAt) : 0;
  const liveOther = !!lease && lease.writerHostId !== identity.writerHostId && expiry > now;
  const expired = !!lease && lease.writerHostId !== identity.writerHostId && expiry <= now;
  if (liveOther && !takeover) throw new StoreBusyError();
  const next: StoreLease = {
    schemaVersion: 1,
    storeId: identity.storeId,
    writerHostId: identity.writerHostId,
    installationId: identity.installationId,
    expiresAt: new Date(now + ttlMs).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
  };
  await store.put(LEASE_PATH, next, { schemaVersion: 1, kind: "lease", ...(current.revision ? { ifRevision: current.revision } : {}) });
  return { lease: next, tookOver: liveOther || expired, expired };
}

export async function releaseLease(store: DocumentStore, hostId: string): Promise<void> {
  const current = await readLease(store);
  if (!current.lease || current.lease.writerHostId !== hostId || !current.revision) return;
  await store.delete(LEASE_PATH, { ifRevision: current.revision });
}

export interface MigrationProgress {
  id: string;
  phase: "PREPARED" | "COPYING" | "COPIED" | "VERIFIED" | "FAILED" | "ACTIVATED";
  startedAt: string;
  updatedAt: string;
  copied: string[];
  hashes: Record<string, string>;
  error?: string;
}

export function prepareMigration(root: string, now: Date, secretValues: string[] = []): MigrationProgress {
  const files = collectCanonical(root, secretValues);
  return {
    id: `mig_${createHash("sha256").update(now.toISOString()).digest("hex").slice(0, 12)}`,
    phase: "PREPARED",
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    copied: [],
    hashes: Object.fromEntries(files.map((file) => [file.path, file.sha256])),
  };
}

/** Copies local canonical files to Drive. Already-copied paths with the same hash are skipped, so a rerun finishes an interrupted copy. */
export async function copyMigration(store: DocumentStore, root: string, progress: MigrationProgress, secretValues: string[] = [], now = new Date()): Promise<MigrationProgress> {
  const files = collectCanonical(root, secretValues);
  const next: MigrationProgress = { ...progress, phase: "COPYING", hashes: Object.fromEntries(files.map((file) => [file.path, file.sha256])), updatedAt: now.toISOString(), error: undefined };
  for (const file of files) {
    if (next.copied.includes(file.path) && progress.hashes[file.path] === file.sha256) continue;
    const existing = await store.get(file.path);
    if (existing?.sha256 === file.sha256) {
      next.copied = [...new Set([...next.copied, file.path])];
      continue;
    }
    await store.put(file.path, file.body, { schemaVersion: 1, kind: file.kind, ...(existing ? { ifRevision: existing.revision } : {}) });
    next.copied = [...new Set([...next.copied, file.path])];
  }
  const index = buildLookup(files);
  const indexDoc = await store.get("indexes/lookup.json");
  await store.put("indexes/lookup.json", index, { schemaVersion: 1, kind: "index", ...(indexDoc ? { ifRevision: indexDoc.revision } : {}) });
  const summary = { schemaVersion: 1, role: "export", properties: index.properties, generatedAt: now.toISOString() };
  const summaryDoc = await store.get("exports/property-summary.json");
  await store.put("exports/property-summary.json", summary, { schemaVersion: 1, kind: "export", ...(summaryDoc ? { ifRevision: summaryDoc.revision } : {}) });
  const csvDoc = await store.get("exports/tour-history.csv.json");
  await store.put("exports/tour-history.csv.json", { schemaVersion: 1, role: "export", csv: tourHistoryCsv(index) }, { schemaVersion: 1, kind: "export", ...(csvDoc ? { ifRevision: csvDoc.revision } : {}) });
  next.phase = "COPIED";
  next.updatedAt = now.toISOString();
  return next;
}

export async function verifyMigration(store: DocumentStore, progress: MigrationProgress, now = new Date()): Promise<MigrationProgress> {
  const problems: string[] = [];
  for (const [path, hash] of Object.entries(progress.hashes)) {
    const doc = await store.get(path);
    if (!doc) problems.push(`${path} is missing`);
    else if (doc.sha256 !== hash) problems.push(`${path} doesn't match`);
  }
  return problems.length
    ? { ...progress, phase: "FAILED", error: problems.slice(0, 5).join("; "), updatedAt: now.toISOString() }
    : { ...progress, phase: "VERIFIED", error: undefined, updatedAt: now.toISOString() };
}

/** Writes Drive documents into an empty (or disposable) local folder. Refuses secret-shaped documents. */
export async function restoreCanonical(store: DocumentStore, root: string, secretValues: string[] = []): Promise<{ files: number; skipped: string[] }> {
  const docs = await store.list("");
  const skipped: string[] = [];
  let files = 0;
  for (const doc of docs) {
    if (doc.kind === "lease" || doc.kind === "index" || doc.kind === "export") continue;
    if (SKIP_FILES.has(doc.path) || SKIP_PREFIXES.some((prefix) => doc.path.startsWith(prefix))) {
      skipped.push(doc.path);
      continue;
    }
    if (looksLikeSecret(doc.body, secretValues)) {
      skipped.push(doc.path);
      continue;
    }
    const target = join(root, ...doc.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(doc.body, null, 2) + "\n");
    files += 1;
  }
  return { files, skipped };
}

export const FACT_CACHE_MAX_MS = 5 * 60_000;

/** Drive down: a recently checked cache may answer an approved fact. A stale cache must not. */
export function factReadMode(input: { driveUp: boolean; cacheValidatedAt?: number; now: number; maxAgeMs?: number }): "live" | "cached" | "stale" {
  if (input.driveUp) return "live";
  const maxAge = input.maxAgeMs ?? FACT_CACHE_MAX_MS;
  if (input.cacheValidatedAt !== undefined && input.now - input.cacheValidatedAt <= maxAge) return "cached";
  return "stale";
}

/** When the cache and Drive disagree, Drive wins. A matching revision may use the cache. */
export function resolveCachedRecord<T>(local: { body: T; revision: string } | undefined, remote: { body: T; revision: string }): T {
  if (local && local.revision === remote.revision) return local.body;
  return remote.body;
}

export const STORAGE_AUDIT_TYPES = [
  "GOOGLE_DRIVE_CONNECTED",
  "STORAGE_MIGRATION_STARTED",
  "STORAGE_MIGRATION_COMPLETED",
  "STORAGE_MIGRATION_FAILED",
  "STORE_WRITER_ACQUIRED",
  "STORE_WRITER_RELEASED",
  "STORE_TAKEOVER",
  "GOOGLE_DRIVE_DISCONNECTED",
] as const;
export type StorageAuditType = (typeof STORAGE_AUDIT_TYPES)[number];

export interface StorageAuditEvent {
  type: StorageAuditType;
  at: string;
  detail: string;
}

/** Bytes of the canonical files, so a failed Drive commit can put the local cache back. */
export function rememberCanonical(root: string, secretValues: string[] = []): Map<string, string> {
  return new Map(collectCanonical(root, secretValues).map((file) => [file.path, JSON.stringify(file.body)]));
}

export function revertCanonical(root: string, before: Map<string, string>, secretValues: string[] = []): void {
  const after = collectCanonical(root, secretValues);
  for (const file of after) {
    const previous = before.get(file.path);
    const target = join(root, ...file.path.split("/"));
    if (previous === undefined) rmSync(target, { force: true });
    else if (previous !== JSON.stringify(file.body)) writeFileSync(target, JSON.stringify(JSON.parse(previous), null, 2) + "\n");
  }
  for (const [path, body] of before) {
    if (after.some((file) => file.path === path)) continue;
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(JSON.parse(body), null, 2) + "\n");
  }
}

export function appendStorageAudit(root: string, event: StorageAuditEvent, secretValues: string[] = []): void {
  if (looksLikeSecret(event, secretValues)) throw new Error("An audit entry can't contain a credential.");
  const path = join(root, "install", "storage-audit.json");
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { events?: StorageAuditEvent[] }) : {};
  const events = [...(current.events ?? []), event];
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, events }, null, 2) + "\n");
}
