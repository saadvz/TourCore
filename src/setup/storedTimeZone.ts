/**
 * A street saved before a state or ZIP was known used to store this computer's
 * offset as the property's time zone. Those labels are not a place's zone.
 * An older file is left on disk; the in-memory setup reads the zone as unset.
 */

const COMPUTER_OFFSET_ZONES = new Set(["GMT+00:00", "+00:00", "GMT", "UTC", "Etc/UTC", "Etc/GMT", "Etc/GMT+0"]);

/** Said to the landlord while a published property has no usable zone. Guessing one would open doors hours off. */
export const UNSET_ZONE_LINE =
  "This property doesn't have a time zone set yet, so tours can't run. What time zone should tours use, like Eastern or Pacific?";

export function presentStoredTimeZone<T extends { property: { timezone: string; timezoneConfirmed?: boolean; canonicalAddress?: { state?: string } } }>(config: T): T {
  const state = config.property.canonicalAddress?.state?.trim() ?? "";
  if (state || config.property.timezoneConfirmed === true) return config;
  if (!COMPUTER_OFFSET_ZONES.has(config.property.timezone.trim())) return config;
  return { ...config, property: { ...config.property, timezone: "" } };
}
