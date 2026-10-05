import type { PropertyType } from "../config/tourCoreConfig";

export type NamedProperty = {
  address: string;
  displayName?: string;
  propertyType?: PropertyType;
  name?: string;
  canonicalAddress?: { street?: string };
};

/**
 * What a visitor should hear. An internal tourable-space label ("Main Home")
 * is not a property name. A public name is used only when the operator gave
 * one that isn't that internal label.
 */
export function visitorTourOf(property: NamedProperty): string {
  const place = visitorPlace(property);
  const street = property.canonicalAddress?.street?.trim();
  return place.publicName ? `${place.publicName} at ${place.address}` : street || place.address;
}

/** One tourable place: a whole home, or one apartment or condo unit. Visitors are not asked which unit. */
export function isSingleTourPlace(property: { propertyType?: PropertyType }): boolean {
  return property.propertyType === "SINGLE_FAMILY" || property.propertyType === "APARTMENT_OR_CONDO";
}

export function isApartmentOrCondo(property: { propertyType?: PropertyType }): boolean {
  return property.propertyType === "APARTMENT_OR_CONDO";
}

/** "4B" → "Unit 4B". Leaves "Unit 4B" / "Apt 4B" as the operator wrote them, minus a leading #. */
export function unitLabel(name: string): string {
  const trimmed = name.trim().replace(/^#\s*/, "");
  if (!trimmed) return "";
  if (/^(unit|apt\.?|apartment|suite)\s+/i.test(trimmed)) return trimmed.replace(/^(apt\.?|apartment|suite)\s+/i, "Unit ");
  return `Unit ${trimmed}`;
}

/** Street line visitors hear: "145 Main St", never a made-up building name. */
export function streetLine(property: NamedProperty): string {
  return property.canonicalAddress?.street?.trim() || property.address.split(",")[0]?.trim() || property.address.trim();
}

/** Default apartment or condo nickname: "145 Main St, Unit 4B". Never "Main Home". */
export function streetAndUnit(property: NamedProperty, unitName: string): string {
  const unit = unitLabel(unitName);
  const street = streetLine(property);
  return unit ? `${street}, ${unit}` : street;
}

export function visitorSubject(property: NamedProperty, unitName: string): string {
  if (property.propertyType === "SINGLE_FAMILY") return visitorTourOf(property);
  if (property.propertyType === "APARTMENT_OR_CONDO") return streetAndUnit(property, unitName);
  return unitName;
}

/** Address visitors see: the public name plus the address when one was given, otherwise the address alone. */
export function visitorPlace(property: { address: string; displayName?: string; name?: string }): { address: string; publicName?: string } {
  const address = property.address.trim();
  const named = property.displayName?.trim();
  const publicName = named && named.toLowerCase() !== address.toLowerCase() ? named : undefined;
  return { address, ...(publicName ? { publicName } : {}) };
}
