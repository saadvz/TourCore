import type { TourCoreConfig } from "../config/tourCoreConfig";
import { pausedPropertyVisitorText, pausedUnitVisitorText, removedPropertyVisitorText } from "../core/availabilityCopy";
import type { PropertyState } from "./workspace";

export function isRemoved(state: PropertyState | undefined): boolean {
  return !!state?.removedAt;
}

export function pausedUnitIdList(state: PropertyState | undefined): string[] {
  return state?.pausedUnitIds ?? [];
}

export function isUnitPaused(state: PropertyState | undefined, unitId: string): boolean {
  if (!state) return false;
  return !!state.paused || isRemoved(state) || pausedUnitIdList(state).includes(unitId);
}

export function isEffectivelyPaused(state: PropertyState | undefined, unitIds: string[]): boolean {
  if (!state) return false;
  if (state.paused || isRemoved(state)) return true;
  return unitIds.length > 0 && unitIds.every((id) => pausedUnitIdList(state).includes(id));
}

export function openUnits<T extends { id: string }>(units: T[], state: PropertyState | undefined): T[] {
  if (!state || isRemoved(state) || state.paused) return state && (isRemoved(state) || state.paused) ? [] : units;
  const paused = new Set(pausedUnitIdList(state));
  return units.filter((unit) => !paused.has(unit.id));
}

export function bookingRefusal(state: PropertyState | undefined, config: TourCoreConfig, unitId?: string): { reason: "removed" | "paused-property" | "paused-unit"; message: string } | undefined {
  if (!state) return undefined;
  const unitIds = config.units.map((unit) => unit.id);
  if (isRemoved(state)) {
    return { reason: "removed", message: removedPropertyVisitorText(config.property.address, config.operator.visitorContact) };
  }
  if (isEffectivelyPaused(state, unitIds)) {
    return {
      reason: "paused-property",
      message: pausedPropertyVisitorText(config.property.address, config.operator.name, config.operator.visitorContact),
    };
  }
  if (unitId && isUnitPaused(state, unitId)) {
    const unit = config.units.find((item) => item.id === unitId);
    return { reason: "paused-unit", message: pausedUnitVisitorText(unit?.name ?? "That unit") };
  }
  return undefined;
}
