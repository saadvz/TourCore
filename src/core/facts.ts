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

const STOPWORDS = new Set(
  ("a an and any are as at be by can could do does for from get got has have here how i if in is it its me my of on or " +
    "our place please property so tell that the there this to unit apartment what whats which with would you your " +
    "about much many there's it's is there where when will").split(" "),
);

/** Words people use for the same thing, folded to one key. */
const SYNONYMS: Record<string, string> = {
  bed: "bedroom", beds: "bedroom", br: "bedroom", bedroom: "bedroom", bedrooms: "bedroom",
  bath: "bathroom", baths: "bathroom", bathroom: "bathroom", bathrooms: "bathroom", ba: "bathroom",
  park: "parking", parking: "parking", garage: "parking", car: "parking", cars: "parking",
  washer: "laundry", dryer: "laundry", laundry: "laundry",
  pet: "pet", pets: "pet", dog: "pet", dogs: "pet", cat: "pet", cats: "pet",
  include: "include", included: "include", includes: "include", utilities: "include", utility: "include",
  window: "window", windows: "window", light: "window", sunny: "window",
  sqft: "size", square: "size", feet: "size", size: "size", big: "size", large: "size",
};

function keywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .map((w) => SYNONYMS[w] ?? w.replace(/(ing|ed|es|s)$/, ""))
    .filter((w) => w.length > 1);
}

/**
 * Deterministic lookup: returns the approved facts that share a topic word
 * with the question, best first (at most two). Empty means "no approved
 * answer", never a guess.
 */
export function findApprovedAnswer(facts: ApprovedFact[], question: string): ApprovedFact[] {
  const asked = new Set(keywords(question));
  if (!asked.size) return [];
  return facts
    .map((fact) => ({ fact, score: new Set(keywords(fact.text).filter((k) => asked.has(k))).size }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => x.fact);
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
