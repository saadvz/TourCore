import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { auditToCsv } from "../audit/audit";
import { TourCoreConfigSchema, TourCoreConfigShape, validateConfig, type TourCoreConfig } from "../config/tourCoreConfig";
import { ExportBundleSchema, type ExportBundle } from "../export/exportBundle";
import { writeFileAtomic, writeFolderAtomic, writeJsonAtomic } from "../storage/atomicWrite";
import type { DryTourCheck, DryTourResult } from "./dryTour";
import { runReadinessCheck, type ReadinessResult } from "./readiness";
import { SetupInputError } from "./setupActions";

/**
 * PUBLISHED_FOR_DEMO is NOT a production launch. It only means the setup is
 * valid, the readiness check passed and a practice tour passed for this exact
 * configuration. Messaging, storage, verification and Durin access still run
 * in demo mode, and no physical door is controlled.
 */
export type PublicationStatus = "DRAFT" | "PUBLISHED_FOR_DEMO";

export interface PropertyState {
  propertyId: string;
  status: PublicationStatus;
  /** Fingerprint of the saved config; any edit invalidates earlier checks. */
  configHash: string;
  savedAt: string;
  readiness?: { passed: boolean; checkedAt: string; configHash: string; problems: string[] };
  dryTour?: { passed: boolean; ranAt: string; configHash: string; failure?: string; recordsFolder?: string; tourId?: string };
  publishedAt?: string;
}

export interface SavedProperty {
  config: TourCoreConfig;
  state: PropertyState;
}

export interface PublishBlocker {
  code: string;
  message: string;
}

export type PublishResult = { published: true; state: PropertyState } | { published: false; blockers: PublishBlocker[] };

export interface ConversationItem {
  from: "tourcore" | "visitor" | "demo";
  text: string;
  at: string;
  /** The stored message this item shows, when there is one. */
  messageId?: string;
  /** Provider-neutral delivery details (never credentials). */
  delivery?: { provider?: string; channel?: string; status?: string; providerMessageId?: string };
}

/** One practice tour or visitor demo, kept so the operator can reopen it later. */
export interface TourRecord {
  schemaVersion: 1;
  tourId: string;
  /** practice = simulated tour; visitor-demo = browser phone; messaging = a real phone over a messaging provider. */
  kind: "practice" | "visitor-demo" | "messaging";
  ranAt: string;
  updatedAt: string;
  outcome: "passed" | "stopped" | "in-progress" | "finished";
  unitId?: string;
  visitorName?: string;
  visitorPhone?: string;
  checks?: DryTourCheck[];
  failure?: string;
  /** The visitor-facing thread as shown, including demo notes (visitor demos). */
  conversation?: ConversationItem[];
}

export function configHash(config: TourCoreConfig): string {
  return createHash("sha256").update(JSON.stringify(TourCoreConfigShape.parse(config))).digest("hex").slice(0, 16);
}

export function defaultWorkspaceRoot(): string {
  return resolve(process.env.TOURCORE_HOME ?? "tourcore-data");
}

const TOUR_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Where setups live on disk. The operator never edits these files; the config
 * file is the same canonical TourCoreConfig any setup surface writes. Every
 * write is atomic (temp file + rename), so a crash leaves old or new, not half.
 *   <root>/properties/<propertyId>/tourcore.config.json
 *   <root>/properties/<propertyId>/status.json
 *   <root>/properties/<propertyId>/draft.json            (changes that aren't valid yet)
 *   <root>/properties/<propertyId>/practice-tours/<tourId>/{record.json,tour-export.json,audit.csv}
 */
export class PropertyWorkspace {
  constructor(readonly root: string = defaultWorkspaceRoot()) {}

  list(): SavedProperty[] {
    return this.propertyIds()
      .filter((id) => this.has(id))
      .map((id) => this.load(id))
      .sort((a, b) => a.config.property.name.localeCompare(b.config.property.name));
  }

  has(propertyId: string): boolean {
    return existsSync(this.configPath(propertyId));
  }

  load(propertyId: string): SavedProperty {
    if (!this.has(propertyId)) throw new SetupInputError("PROPERTY_NOT_FOUND", "I couldn't find that property.");
    const config = TourCoreConfigShape.parse(JSON.parse(readFileSync(this.configPath(propertyId), "utf8")));
    const hash = configHash(config);
    const statePath = this.statePath(propertyId);
    const stored: PropertyState | undefined = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : undefined;
    // If a save was interrupted between the config and status files, fail closed: treat it as an unchecked draft.
    const state: PropertyState =
      stored && stored.configHash === hash
        ? stored
        : { ...(stored ?? {}), propertyId, status: "DRAFT", configHash: hash, savedAt: stored?.savedAt ?? new Date().toISOString(), publishedAt: undefined };
    return { config, state };
  }

  /** Only valid setups can be saved. Changing a saved setup sends it back to draft. */
  save(draft: TourCoreConfig, now = new Date()): SavedProperty {
    const parsed = TourCoreConfigSchema.safeParse(draft);
    if (!parsed.success) {
      const error = new SetupInputError("CONFIG_INVALID", "Some answers still need attention before this can be saved.");
      Object.assign(error, { issues: validateConfig(draft) });
      throw error;
    }
    const config = parsed.data;
    const id = config.property.id;
    const hash = configHash(config);
    const previous = this.has(id) ? this.load(id).state : undefined;
    let state: PropertyState;
    if (previous && previous.configHash === hash) state = { ...previous, savedAt: now.toISOString() };
    else {
      // Earlier check results stay for history, but their fingerprint no longer matches, so they no longer count.
      const { publishedAt: _dropped, ...rest } = previous ?? { propertyId: id };
      state = { ...rest, propertyId: id, status: "DRAFT", configHash: hash, savedAt: now.toISOString() };
    }
    writeJsonAtomic(this.configPath(id), config);
    this.writeState(state);
    this.discardDraft(id);
    return { config, state };
  }

  // ------------------------------------------------ work-in-progress drafts

  /** Every property folder with a saved setup or an unsaved draft. */
  propertyIds(): string[] {
    const dir = join(this.root, "properties");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[a-z0-9_]+$/.test(e.name))
      .filter((e) => existsSync(join(dir, e.name, "tourcore.config.json")) || existsSync(join(dir, e.name, "draft.json")))
      .map((e) => e.name);
  }

  loadDraft(propertyId: string): TourCoreConfig | undefined {
    const path = this.draftPath(propertyId);
    if (!existsSync(path)) return undefined;
    const parsed = TourCoreConfigShape.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  }

  /** Unfinished setups may be invalid; they're kept apart from the saved setup until they pass validation. */
  saveDraft(draft: TourCoreConfig): void {
    writeJsonAtomic(this.draftPath(draft.property.id), draft);
  }

  /**
   * Persists an edit as soon as it's safe: a valid setup is saved for real,
   * an invalid one is kept as a draft. Returns which happened.
   */
  persistEdit(draft: TourCoreConfig, now = new Date()): "saved" | "draft" {
    if (validateConfig(draft).length === 0) {
      this.save(draft, now);
      return "saved";
    }
    this.saveDraft(draft);
    return "draft";
  }

  discardDraft(propertyId: string): void {
    rmSync(this.draftPath(propertyId), { force: true });
    if (!this.has(propertyId)) rmSync(this.dir(propertyId), { recursive: true, force: true });
  }

  /** The copy to edit: unsaved changes if there are any, otherwise the saved setup. */
  openDraft(propertyId: string): { draft: TourCoreConfig; unsavedChanges: boolean } {
    const draft = this.loadDraft(propertyId);
    if (!this.has(propertyId)) {
      if (!draft) throw new SetupInputError("PROPERTY_NOT_FOUND", "I couldn't find that property.");
      return { draft, unsavedChanges: true };
    }
    const saved = this.load(propertyId);
    if (!draft) return { draft: saved.config, unsavedChanges: false };
    return { draft, unsavedChanges: configHash(draft) !== saved.state.configHash };
  }

  private draftPath(propertyId: string): string {
    return join(this.dir(propertyId), "draft.json");
  }

  // ----------------------------------------------------- checks and publish

  recordReadiness(propertyId: string, result: ReadinessResult): PropertyState {
    const { state } = this.load(propertyId);
    const next: PropertyState = {
      ...state,
      readiness: { passed: result.passed, checkedAt: result.checkedAt, configHash: state.configHash, problems: result.checks.flatMap((c) => c.problems) },
    };
    this.writeState(next);
    return next;
  }

  recordDryTour(propertyId: string, result: DryTourResult): PropertyState {
    const { state } = this.load(propertyId);
    let tourId: string | undefined;
    if (result.bundle) {
      tourId = uniqueTourId(this.toursDir(propertyId), stamp(result.ranAt));
      const record: TourRecord = {
        schemaVersion: 1,
        tourId,
        kind: "practice",
        ranAt: result.ranAt,
        updatedAt: result.ranAt,
        outcome: result.passed ? "passed" : "stopped",
        ...(result.unitId ? { unitId: result.unitId } : {}),
        visitorName: "Pat Practice",
        checks: result.checks,
        ...(result.failure ? { failure: result.failure } : {}),
      };
      writeFolderAtomic(join(this.toursDir(propertyId), tourId), {
        "record.json": JSON.stringify(record, null, 2) + "\n",
        "tour-export.json": JSON.stringify(result.bundle, null, 2) + "\n",
        "audit.csv": auditToCsv(result.bundle.auditEvents),
      });
    }
    const next: PropertyState = {
      ...state,
      dryTour: {
        passed: result.passed,
        ranAt: result.ranAt,
        configHash: state.configHash,
        ...(result.failure ? { failure: result.failure } : {}),
        ...(tourId ? { tourId, recordsFolder: join(this.toursDir(propertyId), tourId) } : {}),
      },
    };
    this.writeState(next);
    return next;
  }

  /** Creates or updates a visitor demo's records. Called after every visitor step. */
  recordVisitorDemo(propertyId: string, record: TourRecord, bundle: ExportBundle): void {
    if (!TOUR_ID.test(record.tourId)) throw new SetupInputError("TOUR_ID_INVALID", "That tour label isn't valid.");
    const folder = join(this.toursDir(propertyId), record.tourId);
    writeJsonAtomic(join(folder, "tour-export.json"), bundle);
    writeFileAtomic(join(folder, "audit.csv"), auditToCsv(bundle.auditEvents));
    writeJsonAtomic(join(folder, "record.json"), record);
  }

  /** Why this property can't be published for demo yet. Empty = it can. */
  async publishBlockers(propertyId: string, now = new Date()): Promise<PublishBlocker[]> {
    const { config, state } = this.load(propertyId);
    const blockers: PublishBlocker[] = [];
    const hash = configHash(config);

    if (validateConfig(config).length) blockers.push({ code: "CONFIG_INVALID", message: "Some setup answers still need attention." });

    const r = state.readiness;
    if (!r) blockers.push({ code: "READINESS_NOT_RUN", message: "Run the readiness check first." });
    else if (r.configHash !== hash) blockers.push({ code: "READINESS_OUT_OF_DATE", message: "The setup changed after the last readiness check. Please check again." });
    else if (!r.passed) blockers.push({ code: "READINESS_FAILED", message: "The last readiness check found problems. Fix them and check again." });
    else if (!(await runReadinessCheck(config, { now })).passed) {
      blockers.push({ code: "READINESS_FAILED_NOW", message: "Something isn't ready anymore. Please run the readiness check again." });
    }

    const d = state.dryTour;
    if (!d) blockers.push({ code: "DRY_TOUR_NOT_RUN", message: "Run a practice tour first." });
    else if (d.configHash !== hash) blockers.push({ code: "DRY_TOUR_OUT_OF_DATE", message: "The setup changed after the last practice tour. Please run it again." });
    else if (!d.passed) blockers.push({ code: "DRY_TOUR_FAILED", message: "The last practice tour didn't finish cleanly. Fix the problem and run it again." });

    return blockers;
  }

  async publishDemoProperty(propertyId: string, now = new Date()): Promise<PublishResult> {
    const blockers = await this.publishBlockers(propertyId, now);
    if (blockers.length) return { published: false, blockers };
    const { state } = this.load(propertyId);
    const next: PropertyState = { ...state, status: "PUBLISHED_FOR_DEMO", publishedAt: now.toISOString() };
    this.writeState(next);
    return { published: true, state: next };
  }

  // ------------------------------------------------------------ tour records

  /** Practice tours and visitor demos, newest first. */
  listTours(propertyId: string): TourRecord[] {
    const dir = this.toursDir(propertyId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && TOUR_ID.test(e.name) && existsSync(join(dir, e.name, "tour-export.json")))
      .map((e) => this.readRecord(propertyId, e.name))
      .sort((a, b) => b.ranAt.localeCompare(a.ranAt));
  }

  loadTour(propertyId: string, tourId: string): { record: TourRecord; bundle: ExportBundle; folder: string } | undefined {
    if (!TOUR_ID.test(tourId)) return undefined;
    const folder = join(this.toursDir(propertyId), tourId);
    if (!existsSync(join(folder, "tour-export.json"))) return undefined;
    const bundle = ExportBundleSchema.parse(JSON.parse(readFileSync(join(folder, "tour-export.json"), "utf8")));
    return { record: this.readRecord(propertyId, tourId), bundle, folder };
  }

  latestPracticeTour(propertyId: string): { folder: string; bundle: ExportBundle } | undefined {
    const latest = this.listTours(propertyId)[0];
    return latest ? this.loadTour(propertyId, latest.tourId) : undefined;
  }

  /** A tour's records as downloadable text; the latest tour when no id is given. */
  exportTour(propertyId: string, tourId?: string): { json: string; csv: string } | undefined {
    const id = tourId ?? this.listTours(propertyId)[0]?.tourId;
    const tour = id ? this.loadTour(propertyId, id) : undefined;
    if (!tour) return undefined;
    return { json: JSON.stringify(tour.bundle, null, 2) + "\n", csv: auditToCsv(tour.bundle.auditEvents) };
  }

  exportLatest(propertyId: string): { json: string; csv: string } | undefined {
    return this.exportTour(propertyId);
  }

  /** Folder name for a new visitor conversation's records ("visitor" = browser phone, "text" = real phone). */
  newVisitorTourId(propertyId: string, startedAt: Date, suffix: "visitor" | "text" = "visitor"): string {
    return uniqueTourId(this.toursDir(propertyId), `${stamp(startedAt.toISOString())}_${suffix}`);
  }

  private readRecord(propertyId: string, tourId: string): TourRecord {
    const path = join(this.toursDir(propertyId), tourId, "record.json");
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
    // Tours saved before records existed: rebuild the essentials from the export.
    const bundle = JSON.parse(readFileSync(join(this.toursDir(propertyId), tourId, "tour-export.json"), "utf8")) as ExportBundle;
    const done = bundle.auditEvents.some((e) => e.type === "TOUR_COMPLETED");
    return { schemaVersion: 1, tourId, kind: "practice", ranAt: bundle.exportedAt, updatedAt: bundle.exportedAt, outcome: done ? "passed" : "stopped" };
  }

  private toursDir(propertyId: string): string {
    return join(this.dir(propertyId), "practice-tours");
  }

  private dir(propertyId: string): string {
    if (!/^[a-z0-9_]+$/.test(propertyId)) throw new SetupInputError("PROPERTY_ID_INVALID", "That property label isn't valid.");
    return join(this.root, "properties", propertyId);
  }

  private configPath(propertyId: string): string {
    return join(this.dir(propertyId), "tourcore.config.json");
  }

  private statePath(propertyId: string): string {
    return join(this.dir(propertyId), "status.json");
  }

  private writeState(state: PropertyState): void {
    writeJsonAtomic(this.statePath(state.propertyId), state);
  }
}

function stamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

function uniqueTourId(dir: string, base: string): string {
  if (!existsSync(join(dir, base))) return base;
  for (let i = 2; ; i++) if (!existsSync(join(dir, `${base}_${i}`))) return `${base}_${i}`;
}

/** Short operator-facing status. */
export function statusLabel(saved: SavedProperty): string {
  const { state } = saved;
  if (state.status === "PUBLISHED_FOR_DEMO") return "Published for demo";
  const hash = state.configHash;
  if (state.readiness?.passed && state.readiness.configHash === hash && state.dryTour?.passed && state.dryTour.configHash === hash) {
    return "Ready to publish for demo";
  }
  return "Draft";
}
