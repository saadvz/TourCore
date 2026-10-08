import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addDays, formatLocalDate, localDateOf, zonedTimeToUtc, type LocalDate } from "../core/timezone";
import type { AuditEvent } from "../domain/model";
import { ExportBundleSchema, type ExportBundle } from "../export/exportBundle";
import { SetupInputError } from "../setup/setupActions";
import type { PropertyWorkspace } from "../setup/workspace";
import { writeFolderAtomic } from "../storage/atomicWrite";
import { AccessWindows } from "./accessWindows";
import { readAvailabilityEvents } from "./availability";
import { listExceptions, readResolutions } from "./exceptions";
import type { OperatorServices } from "./services";
import { currentReservation, tourSnapshots, type TourSnapshot } from "./tours";

/**
 * One day's tour records for a property, as a provider-neutral, validated
 * export: every tour's bundle (the same schema as a single tour's download),
 * the operator's exception resolutions, and one CSV of all audit events.
 */

export const AUDIT_EXPORT_FILES = ["audit-export.json", "audit.csv"] as const;
const EXPORT_ID = /^\d{4}-\d{2}-\d{2}_[A-Za-z0-9-]+$/;

function exportsDir(ws: PropertyWorkspace, propertyId: string): string {
  if (!/^[a-z0-9_]+$/.test(propertyId)) throw new SetupInputError("PROPERTY_ID_INVALID", "That property label isn't valid.");
  return join(ws.root, "properties", propertyId, "audit-exports");
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: LocalDate) => `${d.year}-${pad(d.month)}-${pad(d.day)}`;

export function parseLocalDate(input: string): LocalDate | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : undefined;
}

function outcomeOf(tour: TourSnapshot): "completed" | "active" | "stopped" {
  const r = currentReservation(tour);
  if (tour.bundle.auditEvents.some((e) => e.type === "TOUR_COMPLETED") || tour.outcome === "passed" || tour.outcome === "finished") return "completed";
  if (tour.outcome === "in-progress" && (!r || !["CANCELLED", "REVOKED", "EXPIRED", "VERIFICATION_FAILED"].includes(r.status))) return "active";
  return "stopped";
}

const csvCell = (v: unknown) => {
  const s = v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function combinedCsv(rows: Array<{ tourId: string; kind: string; event: AuditEvent }>): string {
  const header = ["tour", "tourKind", "seq", "at", "type", "reservationId", "prospectId", "doorId", "code", "statusFrom", "statusTo", "detail"];
  const lines = rows.map(({ tourId, kind, event: e }) =>
    [tourId, kind, e.seq, e.at, e.type, e.reservationId, e.prospectId, e.doorId, e.code, e.statusChange?.from, e.statusChange?.to, e.detail].map(csvCell).join(","),
  );
  return [header.join(","), ...lines].join("\n") + "\n";
}

export async function exportAudit(services: OperatorServices, propertyId: string, options: { day?: LocalDate; now: Date }) {
  const ws = services.workspace;
  if (!ws.has(propertyId)) throw new SetupInputError("PROPERTY_NOT_FOUND", "I couldn't find that property.");
  const { config } = ws.load(propertyId);
  const tz = config.property.timezone;
  const day = options.day ?? localDateOf(options.now, tz);
  const from = zonedTimeToUtc({ ...day, hour: 0, minute: 0 }, tz).toISOString();
  const to = zonedTimeToUtc({ ...addDays(day, 1), hour: 0, minute: 0 }, tz).toISOString();

  const tours = (await tourSnapshots(services, { propertyId, includePractice: true })).filter((t) => t.startedAt < to && t.updatedAt >= from);
  const bundles: Array<{ tourId: string; kind: string; outcome: string; bundle: ExportBundle }> = tours.map((t) => ({
    tourId: t.tourId,
    kind: t.kind,
    outcome: outcomeOf(t),
    bundle: ExportBundleSchema.parse(t.bundle),
  }));
  const propertyEvents = readAvailabilityEvents(ws.root, propertyId).filter((e) => e.at >= from && e.at < to);
  const events = [
    ...bundles.flatMap((b) => b.bundle.auditEvents.filter((e) => e.at >= from && e.at < to).map((event) => ({ tourId: b.tourId, kind: b.kind, event }))),
    ...propertyEvents.map((event) => ({ tourId: "property", kind: "property", event })),
  ].sort((a, b) => a.event.at.localeCompare(b.event.at) || a.event.seq - b.event.seq);

  const exceptions = (await listExceptions(services, { propertyId, includeClosed: true })).filter((x) => x.happenedAt >= from && x.happenedAt < to);
  const resolutions = readResolutions(services, propertyId).filter((r) => r.resolvedAt >= from && r.resolvedAt < to);
  const visitorTours = bundles.filter((b) => b.kind !== "practice");
  const summary = {
    day: formatLocalDate(day, tz),
    tours: visitorTours.length,
    practiceTours: bundles.length - visitorTours.length,
    completed: visitorTours.filter((b) => b.outcome === "completed").length,
    active: visitorTours.filter((b) => b.outcome === "active").length,
    stopped: visitorTours.filter((b) => b.outcome === "stopped").length,
    accessDenials: events.filter((e) => e.kind !== "practice" && e.event.type === "ACCESS_DENIED").length,
    questionsNeedingAttention: exceptions.filter((x) => x.kind === "unanswered-question" || x.kind === "needs-help").length,
    openIssues: exceptions.filter((x) => x.status === "open").length,
    resolvedIssues: exceptions.filter((x) => x.status === "resolved").length,
    auditEvents: events.length,
  };

  const exportId = `${isoDate(day)}_${options.now.toISOString().replace(/[:.]/g, "-")}`;
  const document = {
    schemaVersion: 1,
    kind: "tour-core-audit-export",
    exportedAt: options.now.toISOString(),
    property: config.property,
    day: isoDate(day),
    timezone: tz,
    summary,
    tours: bundles,
    propertyEvents,
    exceptions: exceptions.map(({ nextSteps: _n, ...x }) => x),
    resolutions,
  };
  const dir = exportsDir(ws, propertyId);
  let folder = join(dir, exportId);
  for (let i = 2; existsSync(folder); i++) folder = join(dir, `${exportId}-${i}`);
  const finalId = folder.slice(dir.length + 1);
  writeFolderAtomic(folder, {
    "audit-export.json": JSON.stringify(document, null, 2) + "\n",
    "audit.csv": combinedCsv(events),
  });
  const windows = AccessWindows.fromTours(tours, { from, to });
  return { exportId: finalId, summary, files: [...AUDIT_EXPORT_FILES], folder, accessGrants: windows.accessGrants, denials: windows.accessDenials };
}

/** One file of an earlier audit export, for download. */
export function auditExportFile(ws: PropertyWorkspace, propertyId: string, exportId: string, file: string): { contentType: string; content: string } | undefined {
  if (!EXPORT_ID.test(exportId) || !(AUDIT_EXPORT_FILES as readonly string[]).includes(file)) return undefined;
  const path = join(exportsDir(ws, propertyId), exportId, file);
  if (!existsSync(path)) return undefined;
  return { contentType: file.endsWith(".json") ? "application/json" : "text/csv", content: readFileSync(path, "utf8") };
}
