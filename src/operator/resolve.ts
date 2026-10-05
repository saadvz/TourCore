import type { Door, TourCoreConfig, Unit } from "../config/tourCoreConfig";
import { SetupInputError } from "../setup/setupActions";
import type { PropertyWorkspace } from "../setup/workspace";

/**
 * Turns what an operator calls something ("the lobby", "101") into the one
 * record it means. Deterministic and conservative: an exact id or name wins;
 * otherwise every word the operator used must appear in exactly one name.
 * Anything that fits more than one, or nothing, is sent back as a question.
 * Nothing is ever created here.
 */

export type Match<T> =
  | { kind: "exact"; item: T }
  | { kind: "inferred"; item: T }
  | { kind: "ambiguous"; candidates: T[] }
  | { kind: "unknown" };

const STOP = new Set(["the", "a", "an", "door", "doors", "apartment", "apt", "#", "no", "number"]);
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !STOP.has(w));

export function match<T>(ref: string, items: T[], keys: (item: T) => string[]): Match<T> {
  const text = ref.trim();
  if (!text) return { kind: "unknown" };
  const lower = text.toLowerCase();
  const exact = items.filter((i) => keys(i).some((k) => k.toLowerCase() === lower));
  if (exact.length === 1) return { kind: "exact", item: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };
  const wanted = words(text);
  if (!wanted.length) return { kind: "unknown" };
  const fits = items.filter((i) => keys(i).some((k) => {
    const have = new Set(words(k));
    return wanted.every((w) => have.has(w));
  }));
  if (fits.length === 1) return { kind: "inferred", item: fits[0]! };
  if (fits.length > 1) return { kind: "ambiguous", candidates: fits };
  return { kind: "unknown" };
}

export function matchUnit(config: TourCoreConfig, ref: string): Match<Unit> {
  return match(ref, config.units, (u) => [u.id, u.name]);
}

/** Door references; within a unit's route, "unit door" / "its door" mean that unit's own door. */
export function matchDoor(config: TourCoreConfig, ref: string, forUnit?: Unit): Match<Door> {
  if (forUnit && /^(the |its |their )?(own )?unit( door)?$|^(its|their) (own )?door$/i.test(ref.trim())) {
    const own = config.doors.find((d) => d.id === forUnit.doorId);
    if (own) return { kind: "inferred", item: own };
  }
  return match(ref, config.doors, (d) => [d.id, d.name]);
}

export function requireUnit(config: TourCoreConfig, ref: string): Unit {
  const m = matchUnit(config, ref);
  if (m.kind === "exact" || m.kind === "inferred") return m.item;
  if (m.kind === "ambiguous") {
    throw new SetupInputError("UNIT_AMBIGUOUS", `"${ref}" could be ${m.candidates.map((u) => u.name).join(" or ")}. Which one?`);
  }
  const known = config.units.map((u) => u.name);
  throw new SetupInputError("UNIT_NOT_FOUND", `I don't have a unit called "${ref}".${known.length ? ` The units are ${known.join(", ")}.` : " No units have been added yet."}`);
}

/** Which property a request is about: the one named, or the only one there is. */
export function resolvePropertyId(ws: PropertyWorkspace, ref: string | undefined): string {
  const all = ws.propertyIds().filter((id) => ws.has(id) || !!ws.loadDraft(id));
  const visible = all.filter((id) => !ws.has(id) || !ws.load(id).state.removedAt);
  const ids = visible;
  const describe = () => ids.map((id) => nameOf(ws, id)).join(", ");
  if (!ref?.trim()) {
    if (ids.length === 1) return ids[0]!;
    if (ids.length === 0) throw new SetupInputError("NO_PROPERTIES", "There aren't any properties set up yet.");
    throw new SetupInputError("PROPERTY_AMBIGUOUS", `Which property? There are ${ids.length}: ${describe()}.`);
  }
  const visibleEntries = visible.filter((id) => ws.has(id) || !!ws.loadDraft(id)).map((id) => ({ id, ...labelsOf(ws, id) }));
  const shown = match(ref, visibleEntries, (e) => [e.id, e.name, e.address]);
  if (shown.kind === "exact" || shown.kind === "inferred") return shown.item.id;
  if (shown.kind === "ambiguous") throw new SetupInputError("PROPERTY_AMBIGUOUS", `"${ref}" could be ${shown.candidates.map((c) => c.name).join(" or ")}. Which one?`);
  const entries = all.filter((id) => ws.has(id) || !!ws.loadDraft(id)).map((id) => ({ id, ...labelsOf(ws, id) }));
  const hidden = match(ref, entries, (e) => [e.id, e.name, e.address]);
  if (hidden.kind === "exact" || hidden.kind === "inferred") return hidden.item.id;
  if (hidden.kind === "ambiguous") throw new SetupInputError("PROPERTY_AMBIGUOUS", `"${ref}" could be ${hidden.candidates.map((c) => c.name).join(" or ")}. Which one?`);
  throw new SetupInputError("PROPERTY_NOT_FOUND", `I couldn't find a property called "${ref}".${ids.length ? ` The properties are ${describe()}.` : ""}`);
}

function labelsOf(ws: PropertyWorkspace, id: string): { name: string; address: string } {
  const { draft } = ws.openDraft(id);
  return { name: draft.property.name, address: draft.property.address };
}

function nameOf(ws: PropertyWorkspace, id: string): string {
  return labelsOf(ws, id).name;
}
