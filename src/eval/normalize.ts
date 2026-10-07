import type { TourCoreConfig } from "../config/tourCoreConfig";

/**
 * Drops ids and timestamps so the diff is about the landlord's answers.
 * Door and unit references become names. Arrays stay in stored order.
 */
export function normalizeStoredConfig(config: TourCoreConfig): unknown {
  const doorNames = new Map(config.doors.map((door) => [door.id, door.name]));
  const unitNames = new Map(config.units.map((unit) => [unit.id, unit.name]));
  const copy = structuredClone(config) as unknown;
  rewrite(copy, doorNames, unitNames);
  return copy;
}

function rewrite(node: unknown, doorNames: Map<string, string>, unitNames: Map<string, string>): void {
  if (Array.isArray(node)) {
    for (const item of node) rewrite(item, doorNames, unitNames);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (typeof record.doorId === "string") {
    const name = doorNames.get(record.doorId);
    if (name) record.doorId = name;
  }
  if (typeof record.unitId === "string") {
    const name = unitNames.get(record.unitId);
    if (name) record.unitId = name;
  }
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (key === "id" || key === "updatedAt") {
      delete record[key];
      continue;
    }
    if (typeof value === "string" && key.endsWith("At") && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      delete record[key];
      continue;
    }
    rewrite(value, doorNames, unitNames);
  }
}
