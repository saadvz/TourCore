import { EvalGuardError, type GuardState } from "./guard";
import { forbiddenHit } from "./forbidden";

/**
 * Display names the live harness writes: `eval-` plus `r` and 8 hex characters.
 * The sweep may remove a property only when its listed name matches this exactly.
 */
export const HARNESS_EVAL_NAME = /^eval-r[0-9a-f]{8}$/;

export interface SweepProperty {
  propertyId?: string;
  name?: string;
  address?: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function looksLikeEvalPrefix(value: string): boolean {
  return value.toLowerCase().startsWith("eval-");
}

/**
 * Property ids the cleanup sweep may remove.
 * A name that merely resembles the harness prefix is ambiguous: the sweep
 * aborts and returns nothing, so a real property is never selected.
 */
export function selectEvalSweepIds(properties: SweepProperty[]): string[] {
  const ids: string[] = [];
  for (const property of properties) {
    const name = text(property.name);
    const address = text(property.address);
    const id = text(property.propertyId);
    const exact = HARNESS_EVAL_NAME.test(name);
    const protectedHit = forbiddenHit(name) || forbiddenHit(address) || forbiddenHit(id);
    const ambiguous =
      (looksLikeEvalPrefix(name) && !exact) ||
      (looksLikeEvalPrefix(address) && !exact) ||
      (exact && !!protectedHit) ||
      (exact && !/^[a-z0-9_]+$/.test(id));
    if (ambiguous) {
      throw new EvalGuardError(
        `Aborting the eval cleanup sweep. "${name || address || id}" is not an exact harness eval property, so nothing will be removed.`,
      );
    }
    if (!exact) continue;
    ids.push(id);
  }
  return ids;
}

/** Reads a list_properties result. An unreadable list aborts the sweep. */
export function parseListedProperties(result: unknown): SweepProperty[] {
  const properties = (result as { properties?: unknown } | null)?.properties;
  if (!Array.isArray(properties)) {
    throw new EvalGuardError("Aborting the eval cleanup sweep. The property list was not readable, so nothing will be removed.");
  }
  return properties.map((property) => {
    if (!property || typeof property !== "object") {
      throw new EvalGuardError("Aborting the eval cleanup sweep. A listed property was not readable, so nothing will be removed.");
    }
    const row = property as Record<string, unknown>;
    return {
      propertyId: typeof row.propertyId === "string" ? row.propertyId : undefined,
      name: typeof row.name === "string" ? row.name : undefined,
      address: typeof row.address === "string" ? row.address : undefined,
    };
  });
}

/**
 * Marks exact harness properties for remove_property only.
 * Throws before adding any id when the list is ambiguous.
 */
export function admitSweepRemovals(state: GuardState, result: unknown): string[] {
  const ids = selectEvalSweepIds(parseListedProperties(result));
  for (const id of ids) state.sweepPropertyIds.add(id);
  return ids;
}
