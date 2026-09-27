import type { TourCoreConfig } from "../config/tourCoreConfig";

/** A statement the operator wrote and approved. Tour guidance may only repeat these. */
export interface ApprovedFact {
  scope: "property" | "unit";
  /** Set when scope is "unit". */
  unitId?: string;
  /** What the fact is about, e.g. "100 Alfred Way" or "Unit 101". */
  subject: string;
  text: string;
  source: "operator";
}

/** Property-wide facts plus, when given, one unit's description and facts. Nothing is generated. */
export function approvedFacts(config: TourCoreConfig, unitId?: string): ApprovedFact[] {
  const out: ApprovedFact[] = config.property.facts.map((text) => ({ scope: "property", subject: config.property.name, text, source: "operator" }));
  const units = unitId ? config.units.filter((u) => u.id === unitId) : config.units;
  for (const unit of units) {
    for (const text of [unit.summary, ...unit.facts].filter((t) => t.trim())) {
      out.push({ scope: "unit", unitId: unit.id, subject: unit.name, text, source: "operator" });
    }
  }
  return out;
}
