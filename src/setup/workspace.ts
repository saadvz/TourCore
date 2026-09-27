import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { auditToCsv } from "../audit/audit";
import { TourCoreConfigSchema, TourCoreConfigShape, validateConfig, type TourCoreConfig } from "../config/tourCoreConfig";
import { ExportBundleSchema, type ExportBundle } from "../export/exportBundle";
import type { DryTourResult } from "./dryTour";
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
  dryTour?: { passed: boolean; ranAt: string; configHash: string; failure?: string; recordsFolder?: string };
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

export function configHash(config: TourCoreConfig): string {
  return createHash("sha256").update(JSON.stringify(TourCoreConfigShape.parse(config))).digest("hex").slice(0, 16);
}

export function defaultWorkspaceRoot(): string {
  return resolve(process.env.TOURCORE_HOME ?? "tourcore-data");
}

/**
 * Where setups live on disk. The operator never edits these files; the config
 * file is the same canonical TourCoreConfig any setup surface writes.
 *   <root>/properties/<propertyId>/tourcore.config.json
 *   <root>/properties/<propertyId>/status.json
 *   <root>/properties/<propertyId>/draft.json            (unsaved changes, if any)
 *   <root>/properties/<propertyId>/practice-tours/<timestamp>/{tour-export.json,audit.csv}
 */
export class PropertyWorkspace {
  constructor(readonly root: string = defaultWorkspaceRoot()) {}

  list(): SavedProperty[] {
    const dir = join(this.root, "properties");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "tourcore.config.json")))
      .map((e) => this.load(e.name))
      .sort((a, b) => a.config.property.name.localeCompare(b.config.property.name));
  }

  has(propertyId: string): boolean {
    return existsSync(this.configPath(propertyId));
  }

  load(propertyId: string): SavedProperty {
    if (!this.has(propertyId)) throw new SetupInputError("PROPERTY_NOT_FOUND", "I couldn't find that property.");
    const config = TourCoreConfigShape.parse(JSON.parse(readFileSync(this.configPath(propertyId), "utf8")));
    const statePath = this.statePath(propertyId);
    const state: PropertyState = existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, "utf8"))
      : { propertyId, status: "DRAFT", configHash: configHash(config), savedAt: new Date().toISOString() };
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
    mkdirSync(this.dir(id), { recursive: true });
    writeFileSync(this.configPath(id), JSON.stringify(config, null, 2) + "\n");
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
    const id = draft.property.id;
    mkdirSync(this.dir(id), { recursive: true });
    writeFileSync(this.draftPath(id), JSON.stringify(draft, null, 2) + "\n");
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

  /** Latest practice tour records as downloadable text. */
  exportLatest(propertyId: string): { json: string; csv: string } | undefined {
    const latest = this.latestPracticeTour(propertyId);
    if (!latest) return undefined;
    return { json: JSON.stringify(latest.bundle, null, 2) + "\n", csv: auditToCsv(latest.bundle.auditEvents) };
  }

  private draftPath(propertyId: string): string {
    return join(this.dir(propertyId), "draft.json");
  }

  recordReadiness(propertyId: string, result: ReadinessResult): PropertyState {
    const { state } = this.load(propertyId);
    const next: PropertyState = {
      ...state,
      readiness: {
        passed: result.passed,
        checkedAt: result.checkedAt,
        configHash: state.configHash,
        problems: result.checks.flatMap((c) => c.problems),
      },
    };
    this.writeState(next);
    return next;
  }

  recordDryTour(propertyId: string, result: DryTourResult): PropertyState {
    const { state } = this.load(propertyId);
    let recordsFolder: string | undefined;
    if (result.bundle) {
      recordsFolder = join(this.dir(propertyId), "practice-tours", result.ranAt.replace(/[:.]/g, "-"));
      mkdirSync(recordsFolder, { recursive: true });
      writeFileSync(join(recordsFolder, "tour-export.json"), JSON.stringify(result.bundle, null, 2) + "\n");
      writeFileSync(join(recordsFolder, "audit.csv"), auditToCsv(result.bundle.auditEvents));
    }
    const next: PropertyState = {
      ...state,
      dryTour: {
        passed: result.passed,
        ranAt: result.ranAt,
        configHash: state.configHash,
        ...(result.failure ? { failure: result.failure } : {}),
        ...(recordsFolder ? { recordsFolder } : {}),
      },
    };
    this.writeState(next);
    return next;
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

  latestPracticeTour(propertyId: string): { folder: string; bundle: ExportBundle } | undefined {
    const dir = join(this.dir(propertyId), "practice-tours");
    if (!existsSync(dir)) return undefined;
    const latest = readdirSync(dir).sort().at(-1);
    if (!latest) return undefined;
    const folder = join(dir, latest);
    const bundle = ExportBundleSchema.parse(JSON.parse(readFileSync(join(folder, "tour-export.json"), "utf8")));
    return { folder, bundle };
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
    mkdirSync(this.dir(state.propertyId), { recursive: true });
    writeFileSync(this.statePath(state.propertyId), JSON.stringify(state, null, 2) + "\n");
  }
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
