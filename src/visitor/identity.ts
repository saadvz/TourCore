import type { PropertyType } from "../config/tourCoreConfig";

/**
 * What a visitor should hear. An internal tourable-space label ("Main Home")
 * is not a property name. A public name is used only when the operator gave
 * one that isn't that internal label.
 */
export function visitorTourOf(property: { address: string; displayName?: string; name?: string; canonicalAddress?: { street?: string } }): string {
  const place = visitorPlace(property);
  const street = property.canonicalAddress?.street?.trim();
  return place.publicName ? `${place.publicName} at ${place.address}` : street || place.address;
}

export function visitorSubject(
  property: { address: string; displayName?: string; propertyType?: PropertyType; name?: string; canonicalAddress?: { street?: string } },
  unitName: string,
): string {
  if (property.propertyType === "SINGLE_FAMILY") return visitorTourOf(property);
  return unitName;
}

/** Address visitors see: the public name plus the address when one was given, otherwise the address alone. */
export function visitorPlace(property: { address: string; displayName?: string; name?: string }): { address: string; publicName?: string } {
  const address = property.address.trim();
  const named = property.displayName?.trim();
  const publicName = named && named.toLowerCase() !== address.toLowerCase() ? named : undefined;
  return { address, ...(publicName ? { publicName } : {}) };
}
