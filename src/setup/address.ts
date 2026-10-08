/**
 * A US mailing address, kept apart from internal labels. Nothing here invents
 * a missing ZIP, city or state.
 */

export interface CanonicalAddress {
  street: string;
  city: string;
  state: string;
  postalCode?: string;
  /** One line: "144 Hillside Ave, Teaneck, NJ 07666". */
  formatted: string;
}

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};

const SUFFIX = new Set(["ave", "avenue", "st", "street", "rd", "road", "ln", "lane", "dr", "drive", "blvd", "boulevard", "way", "ct", "court", "pl", "place", "ter", "terrace", "cir", "circle", "pkwy", "parkway"]);

/**
 * The address already stored for a property, read back through the same
 * formatter. A legacy "Ave" becomes "Avenue". This is the line to show when
 * someone types the address again, not the raw characters they just typed.
 */
export function savedFullAddress(property: { address: string; canonicalAddress?: { formatted?: string } }): string {
  const stored = property.canonicalAddress?.formatted?.trim() || property.address;
  const parsed = parseUsAddress(stored);
  if (parsed?.address.street && parsed.address.city && parsed.address.state) return parsed.address.formatted;
  return property.address;
}

export function formatCanonical(parts: { street: string; city: string; state: string; postalCode?: string }): string {
  const place = parts.postalCode ? `${parts.city}, ${parts.state} ${parts.postalCode}` : `${parts.city}, ${parts.state}`;
  return `${parts.street}, ${place}`;
}

/** Two lines for reading back: street, then "City, ST ZIP". */
export function addressReadback(parts: { street: string; city: string; state: string; postalCode?: string }): string {
  const place = parts.postalCode ? `${parts.city}, ${parts.state} ${parts.postalCode}` : `${parts.city}, ${parts.state}`;
  return `${parts.street}\n${place}`;
}

function stateOf(text: string): string | undefined {
  const lower = text.toLowerCase().replace(/\./g, "").trim();
  if (/^[a-z]{2}$/.test(lower) && Object.values(STATE_NAMES).includes(lower.toUpperCase())) return lower.toUpperCase();
  return STATE_NAMES[lower];
}

export type AddressPart = "street" | "city" | "state" | "postalCode";

/** Pulls street, city, state and ZIP out of what the operator typed. Missing pieces are listed, never filled in. */
export function parseUsAddress(raw: string): { address: CanonicalAddress; missing: AddressPart[] } | undefined {
  let text = raw.trim().replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ");
  if (text.length < 5) return undefined;
  const zipMatch = text.match(/\b(\d{5})(?:-\d{4})?\b/);
  const postalCode = zipMatch?.[1];
  if (zipMatch) text = text.replace(zipMatch[0], " ").replace(/\s+/g, " ").replace(/\s+,/g, ",").replace(/,\s*$/, "").trim();

  let street = "";
  let city = "";
  let state = "";
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) {
    street = parts[0]!;
    city = parts[1]!;
    state = stateOf(parts.slice(2).join(" ")) ?? "";
  } else if (parts.length === 2) {
    street = parts[0]!;
    const rest = parts[1]!.split(" ");
    const found = stateOf(rest[rest.length - 1] ?? "") ?? stateOf(rest.slice(-2).join(" "));
    if (found && stateOf(rest.slice(-2).join(" ")) === found && rest.length >= 3) {
      state = found;
      city = rest.slice(0, -2).join(" ");
    } else if (found) {
      state = found;
      city = rest.slice(0, -1).join(" ");
    }
  } else {
    const tokens = text.split(" ").filter(Boolean);
    const last = tokens[tokens.length - 1] ?? "";
    const lastTwo = tokens.slice(-2).join(" ");
    if (stateOf(lastTwo) && tokens.length >= 3) {
      state = stateOf(lastTwo)!;
      tokens.splice(-2, 2);
    } else if (stateOf(last)) {
      state = stateOf(last)!;
      tokens.pop();
    }
    if (tokens.length >= 2) {
      city = tokens[tokens.length - 1]!;
      street = tokens.slice(0, -1).join(" ");
      if (SUFFIX.has(city.toLowerCase())) {
        city = "";
      }
    }
  }

  street = canonicalizeStreet(street.replace(/,\s*$/, "").trim());
  city = titleCasePlace(city.replace(/,\s*$/, "").trim());
  const missing: AddressPart[] = [];
  if (!street) missing.push("street");
  if (!city) missing.push("city");
  if (!state) missing.push("state");
  if (!postalCode) missing.push("postalCode");
  if (!street && !city && !state) return undefined;
  const address: CanonicalAddress = {
    street,
    city,
    state,
    ...(postalCode ? { postalCode } : {}),
    formatted: street && city && state ? formatCanonical({ street, city, state, ...(postalCode ? { postalCode } : {}) }) : raw.trim(),
  };
  return { address, missing };
}

const STREET_SUFFIX: Record<string, string> = {
  st: "Street",
  street: "Street",
  ave: "Avenue",
  av: "Avenue",
  avenue: "Avenue",
  rd: "Road",
  road: "Road",
  ln: "Lane",
  lane: "Lane",
  dr: "Drive",
  drive: "Drive",
  blvd: "Boulevard",
  boulevard: "Boulevard",
  way: "Way",
  ct: "Court",
  court: "Court",
  pl: "Place",
  place: "Place",
  ter: "Terrace",
  terr: "Terrace",
  terrace: "Terrace",
  cir: "Circle",
  circle: "Circle",
  pkwy: "Parkway",
  parkway: "Parkway",
};

/**
 * One stored spelling for a token.
 * An all-lowercase token is title-cased. A token the landlord already
 * capitalized is kept: mixed case (McArthur, O'Neil, Dr, 2nd) and short
 * all-caps (QA, NE, SW). A longer all-caps word is the same word shouted,
 * so it stores as title case and matches the lowercase and title-case
 * spellings. Ordinals keep a lowercase ending (1st, 2nd).
 */
function canonicalToken(token: string): string {
  const trailingPeriod = token.endsWith(".");
  const cleaned = token.replace(/\./g, "");
  if (!cleaned) return token;
  const ordinal = /^(\d+)(st|nd|rd|th)$/i.exec(cleaned);
  if (ordinal) return `${ordinal[1]}${ordinal[2]!.toLowerCase()}`;
  const letters = cleaned.replace(/[^A-Za-z]/g, "");
  const stored = !letters
    ? cleaned
    : letters === letters.toLowerCase() || (letters === letters.toUpperCase() && letters.length > 2)
      ? titleCaseToken(cleaned)
      : cleaned;
  return trailingPeriod ? `${stored}.` : stored;
}

function titleCaseToken(token: string): string {
  const lower = token.toLowerCase();
  if (!/[a-z]/.test(lower.charAt(0))) return lower;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Spacing collapses. Only an all-lowercase word is title-cased. */
export function titleCasePlace(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map(canonicalToken)
    .join(" ");
}

const DIRECTIONAL = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west"]);

function bareWord(word: string): string {
  return word.replace(/\./g, "").toLowerCase();
}

function expandSuffix(word: string): string | undefined {
  return STREET_SUFFIX[bareWord(word)];
}

/** "Apt 2" and "#2" (no space before the number) start a unit clause. */
function isUnitClause(word: string): boolean {
  const bare = bareWord(word);
  if (/^(apt|apartment|suite|unit|#)$/.test(bare)) return true;
  return /^#\d/.test(word.replace(/\./g, ""));
}

/**
 * One street line. Spacing collapses. The street type expands when it is the
 * last word of the street ("Rd" → "Road"), or the word before a trailing
 * direction ("Ave S" → "Avenue S", "St NW" → "Street NW"). A unit clause
 * ("Apt 2", "#2") stays after that type and does not hide it. An earlier
 * "St" or "Dr" stays, and a non-final "St." keeps its period, so
 * "St. Marks Place" never becomes "Street Marks". The first word is a suffix
 * only when a direction follows it. A direction's own trailing period is
 * dropped ("Ave. S." → "Avenue S"). Casing follows canonicalToken.
 */
export function canonicalizeStreet(street: string): string {
  const words = street.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  const unitAt = words.findIndex((word, index) => index > 0 && isUnitClause(word));
  const head = unitAt > 0 ? words.slice(0, unitAt) : words;
  const tail = unitAt > 0 ? words.slice(unitAt) : [];
  const last = head.length - 1;
  let suffixAt = -1;
  if (last >= 0 && isTrailingDirection(head, last)) suffixAt = last - 1;
  else if (last > 0) suffixAt = last;
  const stored = head.map((word, index) => {
    if (index === suffixAt) return expandSuffix(word) ?? canonicalToken(word);
    if (index === last && suffixAt === last - 1) return canonicalToken(word.replace(/\.+$/, ""));
    return canonicalToken(word);
  });
  return [...stored, ...tail.map(canonicalToken)].join(" ");
}

function isTrailingDirection(head: string[], last: number): boolean {
  return last > 0 && DIRECTIONAL.has(bareWord(head[last]!)) && expandSuffix(head[last - 1]!) !== undefined;
}

/**
 * One identity for "Oak Ave" and "Oak Avenue", and for "St." and "St".
 * The stored display line keeps the period the landlord typed. This key
 * ignores that period so the two spellings are the same place.
 */
export function canonicalAddressKey(address: string): string | undefined {
  const formatted = parseUsAddress(address)?.address.formatted?.trim();
  if (!formatted) return undefined;
  return formatted.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}
