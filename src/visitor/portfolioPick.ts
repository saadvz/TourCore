import type { NamedProperty } from "./identity";
import { streetLine, visitorPlace } from "./identity";

/**
 * How a shared touring number picks a property. One number covers every
 * property on this Tour Core. A first text that names the place, or a listing
 * link that already chose it, starts that tour. Anything else asks once.
 */

export interface PlaceCandidate {
  id: string;
  aliases: string[];
}

const SUFFIX_END = / (street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct|place|pl|terrace|ter)$/;
const GENERIC = new Set(["tour", "home", "unit", "the", "property", "house"]);

/** What the visitor hears in the picker: the public name, or the street when there isn't one. */
export function propertyShortName(property: NamedProperty): string {
  return visitorPlace(property).publicName ?? streetLine(property);
}

export function placeAliases(property: NamedProperty): string[] {
  const street = normalizePlace(streetLine(property));
  const bare = street.replace(SUFFIX_END, "").trim();
  const pub = visitorPlace(property).publicName;
  const names = [street, bare, normalizePlace(property.address), tail(street), tail(bare)];
  if (pub) names.push(normalizePlace(pub));
  return [...new Set(names.filter((name) => name.length >= 3 && !GENERIC.has(name)))];
}

function tail(value: string): string {
  return value.replace(/^\d+\s+/, "").trim();
}

export function propertyPickerText(names: string[], streetPrompt: boolean): string {
  const lines = ["Which place are you touring?", ...names.map((name, i) => `${i + 1}. ${name}`), replyLine(names.length)];
  if (streetPrompt) lines.push("Or text the street name.");
  return lines.join("\n");
}

export function pickerMiss(count: number): string {
  if (count <= 1) return "I didn't catch that. Which place are you touring?";
  if (count === 2) return "I didn't catch that. Reply 1 or 2 for which place.";
  return "I didn't catch that. Reply 1, 2, or 3 for which place.";
}

export const STREET_MISS = "I couldn't find that one. Reply 1, 2, or 3, or text the street name.";

/** A menu number and nothing else ("1", "2."). Undefined when the text isn't just a choice. */
export function menuChoice(text: string): number | undefined {
  const n = /^\s*#?\s*(\d{1,2})\s*[.!]?\s*$/.exec(text)?.[1];
  if (!n) return undefined;
  const value = Number(n);
  return value >= 1 ? value : undefined;
}

/**
 * The one property a first text already chose: a listing link, or the place
 * named in the text. Undefined when it doesn't pick exactly one.
 */
export function resolveNamedPlace(input: { text: string; listingProperty?: string }, places: PlaceCandidate[]): string | undefined {
  if (input.listingProperty) {
    const linked = matchToken(input.listingProperty, places, true);
    if (linked) return linked;
  }
  const fromLink = listingTokenFromText(input.text);
  if (fromLink) {
    const linked = matchToken(fromLink, places, true);
    if (linked) return linked;
  }
  return matchToken(normalizePlace(input.text), places, false);
}

function replyLine(count: number): string {
  if (count <= 1) return "Reply 1.";
  if (count === 2) return "Reply 1 or 2.";
  return "Reply 1, 2, or 3.";
}

function matchToken(token: string, places: PlaceCandidate[], allowId: boolean): string | undefined {
  const norm = normalizePlace(token);
  if (!norm || /^\d+$/.test(norm)) return undefined;
  const hits = new Map<string, number>();
  const note = (id: string, len: number) => hits.set(id, Math.max(hits.get(id) ?? 0, len));
  for (const place of places) {
    if (allowId && (place.id === token.trim() || place.id === norm.replace(/ /g, "_"))) note(place.id, 1000);
    for (const alias of place.aliases) {
      if (alias.length < 3) continue;
      // The text contains the place ("Tour 88 Pine"), or a listing token is that place ("88 Pine").
      if (containsPhrase(norm, alias) || (allowId && containsPhrase(alias, norm))) note(place.id, alias.length);
    }
  }
  return winner(hits);
}

function winner(hits: Map<string, number>): string | undefined {
  let best: { id: string; len: number } | undefined;
  let tied = false;
  for (const [id, len] of hits) {
    if (!best || len > best.len) {
      best = { id, len };
      tied = false;
    } else if (len === best.len && id !== best.id) tied = true;
  }
  return best && !tied ? best.id : undefined;
}

function containsPhrase(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

export function normalizePlace(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A listing link in the text: `?property=`, `?place=`, or `/tour/<token>`. */
export function listingTokenFromText(text: string): string | undefined {
  const raw = text.match(/https?:\/\/\S+/i)?.[0];
  if (!raw) return undefined;
  try {
    const url = new URL(raw.replace(/[)>.,]+$/, ""));
    const query = url.searchParams.get("property") || url.searchParams.get("place") || url.searchParams.get("p");
    if (query?.trim()) return decodeURIComponent(query.trim());
    const parts = url.pathname.split("/").filter(Boolean);
    const tour = parts.findIndex((part) => part.toLowerCase() === "tour");
    const token = tour >= 0 ? parts[tour + 1] : undefined;
    return token ? decodeURIComponent(token) : undefined;
  } catch {
    return undefined;
  }
}
