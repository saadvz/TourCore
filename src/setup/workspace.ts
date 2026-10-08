import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { auditToCsv } from "../audit/audit";
import { classifyChange, describeContentChanges, fullHash, legacySendblueFingerprints, legacyVisitorHelpSafetyHash, safetyHash } from "../config/changeKinds";
import { TourCoreConfigSchema, TourCoreConfigShape, validateConfig, type TourCoreConfig } from "../config/tourCoreConfig";
import { ExportBundleSchema, type ExportBundle } from "../export/exportBundle";
import { writeFileAtomic, writeFolderAtomic, writeJsonAtomic } from "../storage/atomicWrite";
import type { DryTourCheck, DryTourResult } from "./dryTour";
import { runReadinessCheck, type ReadinessResult } from "./readiness";
import { canonicalAddressKey } from "./address";
import { normalizeStoredDraft } from "./normalizeDraft";
import { SetupInputError } from "./setupActions";
import { enforceVerificationWrite, VERIFICATION_BELOW_FLOOR } from "./verificationFloor";

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
  /** Fingerprint of the whole saved config (used to detect unsaved drafts and interrupted saves). */
  configHash: string;
  /**
   * Fingerprint of the structural/safety part only (src/config/changeKinds.ts).
   * Readiness, practice tours and publication are tied to this, so approved
   * content edits (facts, unit details) don't invalidate them. Always
   * recomputed on load.
   */
  safetyHash?: string;
  savedAt: string;
  readiness?: { passed: boolean; checkedAt: string; configHash: string; safetyHash?: string; problems: string[] };
  dryTour?: { passed: boolean; ranAt: string; configHash: string; safetyHash?: string; failure?: string; recordsFolder?: string; tourId?: string };
  publishedAt?: string;
  /** Operator paused new bookings for the whole property. Not a config change. */
  paused?: boolean;
  /** Unit ids that are paused for new bookings. */
  pausedUnitIds?: string[];
  /** Set when the property is removed (archived). Records stay; it leaves operator lists. */
  removedAt?: string;
}

/** An approved-content change, kept in an append-only log next to the setup. */
export interface ContentChange {
  at: string;
  changes: string[];
}

/**
 * Whether a readiness or practice-tour result still vouches for the saved
 * setup. Results recorded before safety fingerprints existed fall back to the
 * whole-config fingerprint.
 */
function retargetFingerprint<T extends { configHash: string; safetyHash?: string }>(record: T, old: { full: string; safety: string }, next: { full: string; safety: string }): T {
  return {
    ...record,
    ...(record.configHash === old.full ? { configHash: next.full } : {}),
    ...(record.safetyHash === old.safety ? { safetyHash: next.safety } : {}),
  };
}

export function isCurrent(record: { configHash: string; safetyHash?: string } | undefined, state: PropertyState): boolean {
  if (!record) return false;
  return record.safetyHash !== undefined && state.safetyHash !== undefined ? record.safetyHash === state.safetyHash : record.configHash === state.configHash;
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
  /** For a typed visitor message: how Tour Core read it. Developer details only; no model reasoning is kept. */
  interpretation?: {
    intent: string;
    confidence: number;
    interpreter: "rules" | "semantic";
    /** Tour Core asked a question back instead of acting. */
    clarification: boolean;
    entities?: Record<string, string>;
    manipulation?: boolean;
  };
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
  return fullHash(config);
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
  private installedProvider?: () => string | undefined;
  private verificationNotices = new Map<string, string>();

  constructor(readonly root: string = defaultWorkspaceRoot()) {}

  /** Live installation provider, read at save time. Does not write a messaging choice. */
  useInstalledMessaging(read: () => { provider?: string } | undefined): void {
    this.installedProvider = () => read()?.provider;
  }

  /** The sentence from the last save that raised or held the identity check, if the caller has not read it yet. */
  takeVerificationNotice(propertyId: string): string | undefined {
    const notice = this.verificationNotices.get(propertyId);
    this.verificationNotices.delete(propertyId);
    return notice;
  }

  /**
   * The saved property whose address is the same place, including a pre-normalization
   * spelling ("Oak Ave" and "Oak Avenue"). Removed properties are not matches.
   */
  findByAddress(address: string): string | undefined {
    const key = canonicalAddressKey(address) ?? address.trim().toLowerCase();
    if (!key) return undefined;
    for (const id of this.propertyIds()) {
      if (this.has(id) && this.load(id).state.removedAt) continue;
      const property = this.openDraft(id).draft.property;
      const candidates = [property.address, property.canonicalAddress?.formatted].filter((value): value is string => !!value);
      const keys = candidates.map((value) => canonicalAddressKey(value) ?? value.trim().toLowerCase());
      if (keys.includes(key)) return id;
    }
    return undefined;
  }

  private installedSnapshot(): { provider?: string } | undefined {
    const provider = this.installedProvider?.();
    return provider ? { provider } : undefined;
  }

  private rememberNotice(propertyId: string, notice: string | undefined): void {
    if (notice) this.verificationNotices.set(propertyId, notice);
    else this.verificationNotices.delete(propertyId);
  }

  list(): SavedProperty[] {
    return this.propertyIds()
      .filter((id) => this.has(id))
      .map((id) => this.load(id))
      .filter((saved) => !saved.state.removedAt)
      .sort((a, b) => a.config.property.name.localeCompare(b.config.property.name));
  }

  /** Operational status only (pause / remove). Does not change the setup or its fingerprints. */
  patchState(propertyId: string, patch: Partial<PropertyState>): PropertyState {
    const { state } = this.load(propertyId);
    const next: PropertyState = { ...state, ...patch, propertyId };
    this.writeState(next);
    return next;
  }

  has(propertyId: string): boolean {
    return existsSync(this.configPath(propertyId));
  }

  load(propertyId: string): SavedProperty {
    if (!this.has(propertyId)) throw new SetupInputError("PROPERTY_NOT_FOUND", "I couldn't find that property.");
    const raw = JSON.parse(readFileSync(this.configPath(propertyId), "utf8")) as { messagingMode?: string };
    const config = TourCoreConfigShape.parse(raw);
    const hash = configHash(config);
    const statePath = this.statePath(propertyId);
    let stored: PropertyState | undefined = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : undefined;
    if (raw.messagingMode === "sendblue") stored = this.migrateLiveMessaging(propertyId, config, stored);
    stored = this.migrateVisitorHelpFingerprint(config, stored);
    // If a save was interrupted between the config and status files, fail closed: treat it as an unchecked draft.
    const state: PropertyState =
      stored && stored.configHash === hash
        ? stored
        : { ...(stored ?? {}), propertyId, status: "DRAFT", configHash: hash, savedAt: stored?.savedAt ?? new Date().toISOString(), publishedAt: undefined };
    return { config, state: { ...state, safetyHash: safetyHash(config) } };
  }

  /**
   * Older property files stored live texting as "sendblue". Rewrite that one
   * field to "live" and move the readiness and publication fingerprints with
   * it. Nothing else about the property changes, so it does not need a new
   * readiness check or a republish.
   */
  private migrateLiveMessaging(propertyId: string, config: TourCoreConfig, stored: PropertyState | undefined): PropertyState | undefined {
    writeJsonAtomic(this.configPath(propertyId), config);
    if (!stored) return stored;
    const old = legacySendblueFingerprints(config);
    const nextHash = configHash(config);
    const nextSafety = safetyHash(config);
    if (stored.configHash !== old.full && stored.configHash !== nextHash) return stored;
    const moved = retargetFingerprint(stored, old, { full: nextHash, safety: nextSafety });
    const next: PropertyState = {
      ...moved,
      configHash: nextHash,
      safetyHash: nextSafety,
      ...(stored.readiness ? { readiness: retargetFingerprint(stored.readiness, old, { full: nextHash, safety: nextSafety }) } : {}),
      ...(stored.dryTour ? { dryTour: retargetFingerprint(stored.dryTour, old, { full: nextHash, safety: nextSafety }) } : {}),
    };
    this.writeState(next);
    return next;
  }

  /**
   * The visitor help number used to sit in the safety fingerprint, so saving
   * one sent a published property back to draft. It is approved content now.
   * Fingerprints that still match the old hash move forward. A real
   * structural change does not match, so those checks stay out of date.
   */
  private migrateVisitorHelpFingerprint(config: TourCoreConfig, stored: PropertyState | undefined): PropertyState | undefined {
    if (!stored) return stored;
    const legacy = legacyVisitorHelpSafetyHash(config);
    const nextSafety = safetyHash(config);
    if (legacy === nextSafety) return stored;
    if (stored.safetyHash !== legacy && stored.readiness?.safetyHash !== legacy && stored.dryTour?.safetyHash !== legacy) return stored;
    const old = { full: stored.configHash, safety: legacy };
    const next = { full: stored.configHash, safety: nextSafety };
    const migrated: PropertyState = {
      ...retargetFingerprint(stored, old, next),
      ...(stored.readiness ? { readiness: retargetFingerprint(stored.readiness, old, next) } : {}),
      ...(stored.dryTour ? { dryTour: retargetFingerprint(stored.dryTour, old, next) } : {}),
    };
    this.writeState(migrated);
    return migrated;
  }

  /**
   * Only valid setups can be saved. A structural change sends a saved setup
   * back to draft; an approved-content change (facts, unit details) keeps its
   * checks and publication, and is recorded in the content log.
   */
  save(draft: TourCoreConfig, now = new Date()): SavedProperty & { change: "new" | "none" | "content" | "structural" } {
    const parsed = TourCoreConfigSchema.safeParse(normalizeStoredDraft(draft));
    if (!parsed.success) {
      const error = new SetupInputError("CONFIG_INVALID", "Some answers still need attention before this can be saved.");
      Object.assign(error, { issues: validateConfig(draft) });
      throw error;
    }
    const id = parsed.data.property.id;
    const before = this.has(id) ? this.load(id) : undefined;
    const enforced = enforceVerificationWrite(before?.config, parsed.data, this.installedSnapshot());
    if (enforced.refused) throw new SetupInputError(enforced.refused.code, enforced.refused.message);
    const config = enforced.config === parsed.data ? parsed.data : TourCoreConfigSchema.parse(enforced.config);
    this.rememberNotice(id, enforced.notice);
    const hash = configHash(config);
    const previous = before?.state;
    const change = before ? classifyChange(before.config, config) : "new";
    let state: PropertyState;
    if (previous && (change === "none" || change === "content")) {
      const old = { full: configHash(before!.config), safety: safetyHash(before!.config) };
      const next = { full: hash, safety: safetyHash(config) };
      const spellingOnly = old.safety !== next.safety;
      state = {
        ...previous,
        configHash: hash,
        safetyHash: next.safety,
        savedAt: now.toISOString(),
        ...(spellingOnly && previous.readiness ? { readiness: retargetFingerprint(previous.readiness, old, next) } : {}),
        ...(spellingOnly && previous.dryTour ? { dryTour: retargetFingerprint(previous.dryTour, old, next) } : {}),
      };
      if (change === "content") this.appendContentChange(id, { at: now.toISOString(), changes: describeContentChanges(before!.config, config) });
    } else {
      // Earlier check results stay for history, but their fingerprint no longer matches, so they no longer count.
      // Keep publishedAt so a previously published property that is back in draft still keeps records on remove.
      state = { ...(previous ?? { propertyId: id }), propertyId: id, status: "DRAFT", configHash: hash, safetyHash: safetyHash(config), savedAt: now.toISOString() };
    }
    writeJsonAtomic(this.configPath(id), config);
    this.writeState(state);
    this.discardDraft(id);
    return { config, state, change };
  }

  /** Approved-content changes, oldest first (append-only). */
  contentChanges(propertyId: string): ContentChange[] {
    const path = join(this.dir(propertyId), "content-changes.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { changes: ContentChange[] }).changes : [];
  }

  private appendContentChange(propertyId: string, entry: ContentChange): void {
    writeJsonAtomic(join(this.dir(propertyId), "content-changes.json"), { schemaVersion: 1, changes: [...this.contentChanges(propertyId), entry] });
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
    const normalized = normalizeStoredDraft(draft);
    const id = normalized.property.id;
    const before = this.has(id) ? this.load(id).config : this.loadDraft(id);
    const enforced = enforceVerificationWrite(before, normalized, this.installedSnapshot());
    if (enforced.refused) throw new SetupInputError(enforced.refused.code, enforced.refused.message);
    this.rememberNotice(id, enforced.notice);
    writeJsonAtomic(this.draftPath(id), enforced.config);
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

  /**
   * Deletes an unpublished setup (draft-only, or saved but never published):
   * the folder, units, doors, routes, and any other setup files. Published
   * properties stay on disk and are marked removed instead. Refuses when
   * real visitor tour or reservation records exist, even if status is no
   * longer PUBLISHED_FOR_DEMO. A practice tour alone does not refuse.
   */
  removeInProgressSetup(propertyId: string): void {
    if (this.has(propertyId) && this.load(propertyId).state.status === "PUBLISHED_FOR_DEMO") {
      throw new SetupInputError("PROPERTY_PUBLISHED", "That property is already published.");
    }
    if (this.hasTourOrReservationRecords(propertyId)) {
      throw new SetupInputError("PROPERTY_PUBLISHED", "That property is already published.");
    }
    if (!this.has(propertyId) && !this.loadDraft(propertyId)) throw new SetupInputError("PROPERTY_NOT_FOUND", "I couldn't find that property.");
    rmSync(this.dir(propertyId), { recursive: true, force: true });
  }

  /** Real visitor tour folders or reservations on disk. Practice tours do not count. */
  hasTourOrReservationRecords(propertyId: string): boolean {
    return this.visitorTours(propertyId).length > 0;
  }

  /**
   * True when this property was published or has evidence it was: current
   * publication, a kept publishedAt, visitor tour/reservation records, or a
   * real publish event in the property audit. Practice tours do not count.
   */
  wasEverPublished(propertyId: string): boolean {
    if (this.has(propertyId)) {
      const { state } = this.load(propertyId);
      if (state.status === "PUBLISHED_FOR_DEMO" || state.publishedAt) return true;
    }
    return this.hasTourOrReservationRecords(propertyId) || this.hasPublishAuditEvidence(propertyId);
  }

  hasPublishAuditEvidence(propertyId: string): boolean {
    const dir = this.dir(propertyId);
    if (!existsSync(dir)) return false;
    if (fileHasPublishEvidence(join(dir, "operator", "availability-events.json"))) return true;
    return this.visitorTours(propertyId).some((tour) => {
      const folder = join(this.toursDir(propertyId), tour.tourId);
      return fileHasPublishEvidence(join(folder, "audit.csv")) || fileHasPublishEvidence(join(folder, "tour-export.json"));
    });
  }

  private dryTourId(propertyId: string): string | undefined {
    if (!this.has(propertyId)) return undefined;
    return this.load(propertyId).state.dryTour?.tourId;
  }

  private visitorTours(propertyId: string): TourRecord[] {
    const practiceId = this.dryTourId(propertyId);
    return this.listTours(propertyId).filter((tour) => isRealVisitorTour(tour, practiceId));
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
      readiness: { passed: result.passed, checkedAt: result.checkedAt, configHash: state.configHash, safetyHash: state.safetyHash, problems: result.checks.flatMap((c) => c.problems) },
    };
    this.writeState(next);
    return next;
  }

  /**
   * Something outside the setup answers changed (e.g. the texting number), so
   * earlier checks no longer prove anything: back to draft until readiness
   * passes again. Kept for history, but no longer counted.
   */
  invalidateReadiness(propertyId: string, reason: string): PropertyState {
    const { state } = this.load(propertyId);
    const { publishedAt: _dropped, ...rest } = state;
    const next: PropertyState = {
      ...rest,
      status: "DRAFT",
      ...(state.readiness ? { readiness: { ...state.readiness, passed: false, problems: [reason] } } : {}),
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
        safetyHash: state.safetyHash,
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

    if (validateConfig(config).length) blockers.push({ code: "CONFIG_INVALID", message: "Some setup answers still need attention." });

    const installed = this.installedSnapshot();
    const liveCheck = await runReadinessCheck(config, { now, installed });
    const floorProblem = liveCheck.checks.flatMap((check) => check.details).find((problem) => problem.code === VERIFICATION_BELOW_FLOOR);

    const r = state.readiness;
    if (!r) blockers.push({ code: "READINESS_NOT_RUN", message: "Run the readiness check first." });
    else if (!isCurrent(r, state)) blockers.push({ code: "READINESS_OUT_OF_DATE", message: "The setup changed after the last readiness check. Please check again." });
    else if (!r.passed) blockers.push({ code: "READINESS_FAILED", message: "The last readiness check found problems. Fix them and check again." });
    else if (!liveCheck.passed) {
      blockers.push({ code: "READINESS_FAILED_NOW", message: "Something isn't ready anymore. Please run the readiness check again." });
    }

    const d = state.dryTour;
    if (!d) blockers.push({ code: "DRY_TOUR_NOT_RUN", message: "Run a practice tour first." });
    else if (!isCurrent(d, state)) blockers.push({ code: "DRY_TOUR_OUT_OF_DATE", message: "The setup changed after the last practice tour. Please run it again." });
    else if (!d.passed) blockers.push({ code: "DRY_TOUR_FAILED", message: "The last practice tour didn't finish cleanly. Fix the problem and run it again." });

    if (floorProblem) blockers.unshift({ code: floorProblem.code, message: floorProblem.message });
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

const VISITOR_TOUR_ID = /_(visitor|text)(?:_\d+)?$/;

function isRealVisitorTour(record: TourRecord, dryTourId?: string): boolean {
  if (dryTourId && record.tourId === dryTourId) return false;
  if (record.kind === "practice") return false;
  if (record.kind === "visitor-demo" || record.kind === "messaging") return true;
  return VISITOR_TOUR_ID.test(record.tourId);
}

function fileHasPublishEvidence(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const raw = readFileSync(path, "utf8");
    if (/\b(?:PROPERTY_PUBLISHED|DEMO_PUBLISHED)\b/.test(raw)) return true;
    const parsed = JSON.parse(raw) as { events?: unknown[]; auditEvents?: unknown[] } | unknown[];
    const events = Array.isArray(parsed) ? parsed : [...(parsed.events ?? []), ...(parsed.auditEvents ?? [])];
    return events.some((event) => {
      if (!event || typeof event !== "object") return false;
      return /^(?:PROPERTY_PUBLISHED|DEMO_PUBLISHED)$/.test(String((event as { type?: unknown }).type ?? ""));
    });
  } catch {
    try {
      return /\b(?:PROPERTY_PUBLISHED|DEMO_PUBLISHED)\b/.test(readFileSync(path, "utf8"));
    } catch {
      return false;
    }
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
  if (state.removedAt) return "Removed";
  const unitIds = saved.config.units.map((unit) => unit.id);
  const paused = !!state.paused || (unitIds.length > 0 && unitIds.every((id) => (state.pausedUnitIds ?? []).includes(id)));
  if (state.status === "PUBLISHED_FOR_DEMO") return paused ? "Published for demo · paused" : "Published for demo";
  if (state.readiness?.passed && isCurrent(state.readiness, state) && state.dryTour?.passed && isCurrent(state.dryTour, state)) {
    return paused ? "Ready to publish for demo · paused" : "Ready to publish for demo";
  }
  return paused ? "Paused" : "Draft";
}
