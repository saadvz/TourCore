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

  street = street.replace(/,\s*$/, "").trim();
  city = city.replace(/,\s*$/, "").trim();
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
