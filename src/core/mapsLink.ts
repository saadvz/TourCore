import { formatCanonical } from "../setup/address";

/**
 * A directions link to the property, sent to a visitor once their tour is all
 * set. Built only from the street, city, state and ZIP saved on the property:
 * nothing is guessed, so a missing or unconfirmed address sends no link.
 */

interface MappableProperty {
  canonicalAddress?: { street: string; city: string; state: string; postalCode?: string };
  addressConfirmed?: boolean;
}

/** Directions to the address from wherever the visitor is; opens in the maps app or browser on iPhone and Android alike. */
export function directionsUrl(parts: { street: string; city: string; state: string; postalCode: string }): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(formatCanonical(parts))}`;
}

/** The property's directions link, or undefined unless street, city, state and ZIP are all on file and not awaiting confirmation. */
export function propertyDirectionsUrl(property: MappableProperty): string | undefined {
  if (property.addressConfirmed === false) return undefined;
  const saved = property.canonicalAddress;
  if (!saved) return undefined;
  const parts = {
    street: saved.street?.trim() ?? "",
    city: saved.city?.trim() ?? "",
    state: saved.state?.trim() ?? "",
    postalCode: saved.postalCode?.trim() ?? "",
  };
  if (!parts.street || !parts.city || !parts.state || !parts.postalCode) return undefined;
  return directionsUrl(parts);
}

/** Critiquito-locked (for a directions URL). Sent as its own text right after the all-set line. */
export function tourDirectionsText(url: string): string {
  return `Here's how to get there: ${url}`;
}
