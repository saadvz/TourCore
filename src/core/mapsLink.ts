import { formatCanonical } from "../setup/address";

/**
 * A maps link to the property, sent to a visitor once their tour is all set.
 * Built only from the street, city, state and ZIP saved on the property:
 * nothing is guessed, so a missing or unconfirmed address sends no link.
 */

interface MappableProperty {
  canonicalAddress?: { street: string; city: string; state: string; postalCode?: string };
  addressConfirmed?: boolean;
}

/** Opens Google Maps (app or browser) on iPhone and Android alike. */
export function mapsUrl(parts: { street: string; city: string; state: string; postalCode: string }): string {
  return `https://maps.google.com/?q=${encodeURIComponent(formatCanonical(parts))}`;
}

/** The property's maps link, or undefined unless street, city, state and ZIP are all on file and not awaiting confirmation. */
export function propertyMapsUrl(property: MappableProperty): string | undefined {
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
  return mapsUrl(parts);
}

/** DRAFT for Critiquito: not yet approved. Sent as its own text right after the all-set line. */
export function tourMapText(url: string): string {
  return `Here's a map: ${url}`;
}
