import { validateConfig, type TourCoreConfig } from "../config/tourCoreConfig";
import { runDryTour, type DryTourResult } from "../setup/dryTour";
import { runReadinessCheck, type ReadinessResult } from "../setup/readiness";
import { SetupInputError } from "../setup/setupActions";
import type { PropertyState } from "../setup/workspace";
import type { OperatorServices } from "./services";

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
  if (messagingMode !== "sendblue") {
    endpoints.detach(propertyId);
    return undefined;
  }
  const line = services.messagingLine?.();
  if (!line) return undefined;
  try {
    const { changed, previous } = endpoints.attach({ address: line, provider: "sendblue", propertyId }, now);
    if (changed && previous) services.workspace.invalidateReadiness(propertyId, "The texting number changed. Run the readiness check again.");
    return undefined;
  } catch (err) {
    if (err instanceof SetupInputError) return err.message;
    throw err;
  }
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
  if (!state.readiness?.passed || state.readiness.configHash !== state.configHash) {
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
