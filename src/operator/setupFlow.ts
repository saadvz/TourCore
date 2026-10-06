import { isLiveMessaging, validateConfig, type TourCoreConfig } from "../config/tourCoreConfig";
import { localLoopbackNumber, usesLocalMessaging } from "../messaging/propertyScope";
import { isRemoved } from "../setup/availability";
import { runDryTour, type DryTourResult } from "../setup/dryTour";
import { runReadinessCheck, type ReadinessResult } from "../setup/readiness";
import { SetupInputError } from "../setup/setupActions";
import { isCurrent, type PropertyState, type PublishBlocker, type PublishResult } from "../setup/workspace";
import { streetLine } from "../visitor/identity";
import type { InstalledMessaging, OperatorServices } from "./services";

/**
 * The readiness, practice-tour and publish flow shared by every operator
 * surface. The browser API and the Grok Bot tools both call these, so the
 * gates are identical no matter who asks.
 */

/**
 * Connects this computer's texting number to a real-phone property before its
 * readiness check (freeing it when the property stops using real phones).
 * Returns why it can't, e.g. another property already answers on it.
 */
export function connectLine(services: OperatorServices, propertyId: string, messagingMode: string, now: Date): string | undefined {
  const endpoints = services.endpoints;
  if (!endpoints) return undefined;
  if (!isLiveMessaging(messagingMode)) {
    endpoints.detach(propertyId);
    return undefined;
  }
  const config = services.workspace.has(propertyId) ? services.workspace.load(propertyId).config : services.workspace.openDraft(propertyId).draft;
  const installed = services.installedMessaging?.();
  const local = usesLocalMessaging(config, installed);
  const line = local ? localLoopbackNumber() : services.messagingLine?.();
  if (!line) return undefined;
  try {
    const provider = local ? "local" : (installed?.provider ?? "sendblue");
    const { changed, previous } = endpoints.attach({ address: line, provider, propertyId }, now, {
      replaceIf: (id) => services.workspace.has(id) && isRemoved(services.workspace.load(id).state),
      nameOf: (id) => ownerStreetLine(services, id),
    });
    if (changed && previous) services.workspace.invalidateReadiness(propertyId, "The texting number changed. Run the readiness check again.");
    return undefined;
  } catch (err) {
    if (err instanceof SetupInputError) return err.message;
    throw err;
  }
}

/** Street line the operator hears for another property. Never an id, never "Main Home". */
function ownerStreetLine(services: OperatorServices, propertyId: string): string | undefined {
  try {
    const property = services.workspace.has(propertyId)
      ? services.workspace.load(propertyId).config.property
      : services.workspace.openDraft(propertyId).draft.property;
    const street = streetLine(property);
    return street && !/^main home$/i.test(street) ? street : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether visitors who text this property's number reach it, in the words
 * the operator hears. Separate from door access and records, which have
 * their own modes.
 */
export type VisitorTexting =
  | { state: "connected"; label: "Connected"; line?: string }
  | { state: "not-using-it"; label: "Not connected to this property yet"; problem: string }
  | { state: "not-working"; label: "Not working yet"; problem: string }
  | { state: "number-in-use"; label: "Number used by another property"; problem: string }
  | { state: "practice"; label: "Practice only (nobody is texted)" };

export const TEXTING_NOT_USED =
  "Visitor texting is connected, but this property isn't using it yet. I'll connect the property to your touring number before publishing.";

export function visitorTexting(services: OperatorServices, propertyId: string, messagingMode: string, installed = services.installedMessaging?.()): VisitorTexting {
  let config: { messagingMode?: string; messagingProvider?: string } = { messagingMode };
  try {
    config = services.workspace.openDraft(propertyId).draft;
  } catch {
    // Property isn't on file yet; use the mode the caller already has.
  }
  if (usesLocalMessaging({ ...config, messagingMode }, installed)) {
    const line = services.endpoints?.forProperty(propertyId)?.address ?? localLoopbackNumber();
    return { state: "connected", label: "Connected", line };
  }
  if (!isLiveMessaging(messagingMode)) {
    return installed ? { state: "not-using-it", label: "Not connected to this property yet", problem: TEXTING_NOT_USED } : { state: "practice", label: "Practice only (nobody is texted)" };
  }
  if (installed && !installed.ready) return { state: "not-working", label: "Not working yet", problem: "Visitor texting isn't working yet, so texts to your touring number wouldn't reach this property." };
  const line = services.messagingLine?.();
  const owner = line ? services.endpoints?.resolve(line) : undefined;
  if (owner && owner.propertyId !== propertyId) {
    const takenByRemoved = services.workspace.has(owner.propertyId) && isRemoved(services.workspace.load(owner.propertyId).state);
    if (!takenByRemoved) {
      return { state: "number-in-use", label: "Number used by another property", problem: "Your touring number already answers for another property, so texts wouldn't reach this one." };
    }
  }
  return { state: "connected", label: "Connected", ...(line ? { line } : {}) };
}

/**
 * Publish rules that depend on the installation, not the setup answers: a
 * property must never look live while real texts to it have nowhere to go.
 */
export function publishGuards(services: OperatorServices, propertyId: string, messagingMode: string, installed: InstalledMessaging | undefined = services.installedMessaging?.()): PublishBlocker[] {
  if (!installed?.requiredForPublish) return [];
  const config = (() => {
    try {
      return services.workspace.openDraft(propertyId).draft;
    } catch {
      return { messagingMode, messagingProvider: undefined as "local" | undefined };
    }
  })();
  const local = usesLocalMessaging({ ...config, messagingMode }, installed);
  const texting = visitorTexting(services, propertyId, messagingMode, installed);
  if (texting.state === "not-using-it") return [{ code: "TEXTING_NOT_CONNECTED", message: texting.problem }];
  if (texting.state === "not-working" || texting.state === "number-in-use") return [{ code: "TEXTING_NOT_WORKING", message: texting.problem }];
  const attached = services.endpoints?.forProperty(propertyId);
  const line = local ? localLoopbackNumber() : services.messagingLine?.();
  if (services.endpoints && line && !attached) {
    return [{ code: "TEXTING_NOT_ATTACHED", message: "Visitor texting isn't pointed at this property yet. Run the readiness check again and I'll connect it." }];
  }
  return [];
}

/** Publish for demo through every gate: the saved setup's checks plus the installation's own rules. */
export async function publishProperty(services: OperatorServices, propertyId: string, now: Date): Promise<PublishResult> {
  const ws = services.workspace;
  const guards = ws.has(propertyId) ? publishGuards(services, propertyId, ws.load(propertyId).config.messagingMode) : [];
  const blockers = [...guards, ...(await ws.publishBlockers(propertyId, now))];
  if (blockers.length) return { published: false, blockers };
  return ws.publishDemoProperty(propertyId, now);
}

export async function checkReadiness(services: OperatorServices, propertyId: string, config: TourCoreConfig, now: Date): Promise<ReadinessResult> {
  const lineProblem = connectLine(services, propertyId, config.messagingMode, now);
  return runReadinessCheck(config, { now, runtime: services.runtime, ...(lineProblem ? { lineProblem } : {}) });
}

/**
 * Runs the readiness check on the latest setup. Valid unsaved edits are saved
 * first; invalid ones are checked as-is and nothing is recorded.
 */
export async function readinessForProperty(
  services: OperatorServices,
  propertyId: string,
  now: Date,
): Promise<{ result: ReadinessResult; savedChanges: boolean; recorded: boolean }> {
  const ws = services.workspace;
  const { draft, unsavedChanges } = ws.openDraft(propertyId);
  if (unsavedChanges) {
    if (validateConfig(draft).length) {
      return { result: await runReadinessCheck(draft, { now, runtime: services.runtime }), savedChanges: false, recorded: false };
    }
    ws.save(draft, now);
  }
  const { config } = ws.load(propertyId);
  const result = await checkReadiness(services, propertyId, config, now);
  ws.recordReadiness(propertyId, result);
  return { result, savedChanges: unsavedChanges, recorded: true };
}

export type CheckedConfig =
  | { kind: "unchecked-changes" }
  | { kind: "not-ready"; readiness: ReadinessResult }
  | { kind: "ok"; config: TourCoreConfig };

/** The saved setup, once it's free of unchecked changes and passes readiness (run automatically if needed). */
export async function checkedConfig(services: OperatorServices, propertyId: string, now: Date): Promise<CheckedConfig> {
  const ws = services.workspace;
  if (!ws.has(propertyId) || ws.openDraft(propertyId).unsavedChanges) return { kind: "unchecked-changes" };
  let { config, state } = ws.load(propertyId);
  if (!state.readiness?.passed || !isCurrent(state.readiness, state)) {
    const readiness = await checkReadiness(services, propertyId, config, now);
    ws.recordReadiness(propertyId, readiness);
    if (!readiness.passed) return { kind: "not-ready", readiness };
    ({ config, state } = ws.load(propertyId));
  }
  return { kind: "ok", config };
}

export type PracticeOutcome =
  | { kind: "unchecked-changes" }
  | { kind: "not-ready"; readiness: ReadinessResult }
  | { kind: "ran"; result: DryTourResult; state: PropertyState };

/** One practice tour through the real engine on the checked setup; its records are kept in the tour history. */
export async function runPracticeTour(services: OperatorServices, propertyId: string, options: { unitId?: string; now: Date }): Promise<PracticeOutcome> {
  const gate = await checkedConfig(services, propertyId, options.now);
  if (gate.kind !== "ok") return gate;
  const unitId = options.unitId && gate.config.units.some((u) => u.id === options.unitId) ? options.unitId : undefined;
  const result = await runDryTour(gate.config, { unitId, now: options.now });
  const state = services.workspace.recordDryTour(propertyId, result);
  return { kind: "ran", result, state };
}
