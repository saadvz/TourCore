import { formatClockTime, isValidTimeZone } from "../core/timezone";
import { parseEmail } from "../core/email";
import { parsePhone } from "../core/phone";
import { minutesOfDay } from "../core/schedule";
import type { TourCoreConfig } from "./tourCoreConfig";

export type ConfigSection = "property" | "hours" | "units" | "routes" | "verification" | "services";

export interface ConfigIssue {
  /** Machine-readable, stable. */
  code: string;
  section: ConfigSection;
  /** Operator-facing, plain language. */
  message: string;
  /** Technical detail for dev mode only. */
  detail?: string;
  /** The unit this issue is about, when there is one. */
  unitId?: string;
}

export const MAX_FACT_LENGTH = 300;

export const POLICY_LIMITS = {
  tourLengthMinutes: { min: 15, max: 240 },
  slotEveryMinutes: { min: 15, max: 480 },
  earlyArrivalMinutes: { min: 0, max: 60 },
  verificationValidForDays: { min: 1, max: 365 },
} as const;

export function semanticIssues(cfg: TourCoreConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  let currentUnit: string | undefined;
  const add = (section: ConfigSection, code: string, message: string) => {
    if (!issues.some((i) => i.code === code && i.message === message)) {
      issues.push({ code, section, message, ...(currentUnit ? { unitId: currentUnit } : {}) });
    }
  };
  const doorById = new Map(cfg.doors.map((d) => [d.id, d]));
  const unitById = new Map(cfg.units.map((u) => [u.id, u]));
  const doorName = (id: string) => doorById.get(id)?.name || "a door";

  // Property
  if (!cfg.property.name.trim()) add("property", "PROPERTY_NAME_MISSING", "The property needs a name.");
  if (!cfg.property.address.trim()) add("property", "PROPERTY_ADDRESS_MISSING", "The property needs an address.");
  if (!cfg.property.propertyType) add("property", "PROPERTY_TYPE_MISSING", "Say what type of property this is: a single-family home, a multifamily home, an apartment building, or something else.");
  const singleFamily = cfg.property.propertyType === "SINGLE_FAMILY";
  if (singleFamily && cfg.units.length > 1) add("units", "SINGLE_FAMILY_ONE_SPACE", "A single-family home has one tourable space. If people tour more than one space here, choose \"Other\" as the property type.");
  if (!isValidTimeZone(cfg.property.timezone)) {
    add("property", "TIMEZONE_INVALID", `We don't recognize the time zone "${cfg.property.timezone}". Try something like America/New_York.`);
  }
  if (!cfg.operator.name.trim()) add("property", "OPERATOR_MISSING", "Tell us who should get alerts if a visitor needs help.");
  if (cfg.operator.visitorContact?.trim() && !parsePhone(cfg.operator.visitorContact)) {
    add("property", "VISITOR_CONTACT_INVALID", "The number visitors can call doesn't look like a full phone number.");
  }
  if (cfg.operator.supportEmail?.trim() && !parseEmail(cfg.operator.supportEmail)) {
    add("property", "SUPPORT_EMAIL_INVALID", "The support email doesn't look like a real email address.");
  }
  const allFacts = [...cfg.property.facts, ...cfg.units.flatMap((u) => [u.summary, ...u.facts])];
  if (allFacts.some((f) => f.length > MAX_FACT_LENGTH)) add("units", "FACT_TOO_LONG", `Keep each description or fact under ${MAX_FACT_LENGTH} characters.`);

  // Units and doors
  for (const id of duplicates(cfg.doors.map((d) => d.id))) add("units", "DUPLICATE_DOOR_ID", `Two doors are labeled "${id}". Give each door its own name.`);
  for (const id of duplicates(cfg.units.map((u) => u.id))) add("units", "DUPLICATE_UNIT_ID", `Two units are labeled "${id}". Give each unit its own name.`);
  for (const id of duplicates(cfg.routes.map((r) => r.id))) add("routes", "DUPLICATE_ROUTE_ID", `Two routes are labeled "${id}". Each unit should have one route.`);

  if (cfg.units.length === 0) add("units", "NO_UNITS", "Add at least one unit people can tour.");
  if (!cfg.doors.some((d) => d.kind === "ENTRANCE")) add("units", "NO_ENTRANCE", "Add the main entrance visitors will use.");
  if (cfg.doors.some((d) => !d.name.trim())) add("units", "DOOR_NAME_MISSING", "Every door needs a name.");

  const unitDoorOwners = new Map<string, string[]>();
  for (const unit of cfg.units) {
    const label = unit.name.trim() || "A unit";
    currentUnit = unit.id;
    if (!unit.name.trim()) add("units", "UNIT_NAME_MISSING", "Every unit needs a name.");
    if (!unit.doorId) {
      add("units", "UNIT_DOOR_MISSING", `${label} doesn't have a door yet.`);
      continue;
    }
    const door = doorById.get(unit.doorId);
    if (!door) add("units", "UNIT_DOOR_UNKNOWN", `${label} is linked to a door that no longer exists.`);
    // A single-family home's own door is its entrance; everywhere else a unit has its own unit door.
    else if (door.kind !== "UNIT" && !(singleFamily && door.kind === "ENTRANCE")) add("units", "UNIT_DOOR_NOT_UNIT", `${label} is linked to ${door.name}, which isn't a unit door. Give the unit its own door.`);
    unitDoorOwners.set(unit.doorId, [...(unitDoorOwners.get(unit.doorId) ?? []), label]);
  }
  currentUnit = undefined;
  for (const [doorId, owners] of unitDoorOwners) {
    if (owners.length > 1) add("units", "UNIT_DOOR_SHARED", `${owners.join(" and ")} share ${doorName(doorId)}. Each unit needs its own door.`);
  }

  // Routes
  for (const unit of cfg.units) {
    currentUnit = unit.id;
    const label = unit.name.trim() || "A unit";
    const routes = cfg.routes.filter((r) => r.unitId === unit.id);
    if (routes.length === 0) add("routes", "UNIT_ROUTE_MISSING", `${label} does not have a complete route.`);
    if (routes.length > 1) add("routes", "UNIT_ROUTE_DUPLICATE", `${label} has more than one route. Keep just one.`);
  }
  for (const route of cfg.routes) {
    const unit = unitById.get(route.unitId);
    currentUnit = unit?.id;
    if (!unit) {
      add("routes", "ROUTE_UNIT_UNKNOWN", "A route belongs to a unit that no longer exists.");
      continue;
    }
    const label = unit.name.trim() || "A unit";
    const ids = route.stops.map((s) => s.doorId);
    if (ids.length === 0) {
      add("routes", "UNIT_ROUTE_MISSING", `${label} does not have a complete route.`);
      continue;
    }
    if (ids.some((id) => !doorById.has(id))) add("routes", "ROUTE_DOOR_MISSING", `${label}'s route refers to a door that no longer exists.`);
    if (doorById.get(ids[0]!)?.kind !== "ENTRANCE") add("routes", "ROUTE_START_NOT_ENTRANCE", `${label}'s route needs to start at an entrance.`);
    if (ids[ids.length - 1] !== unit.doorId) add("routes", "ROUTE_END_NOT_UNIT", `${label}'s route needs to end at ${label}'s own door.`);
    if (duplicates(ids).length) add("routes", "ROUTE_REPEATS_DOOR", `${label}'s route lists the same door twice.`);
    for (const id of ids) {
      const door = doorById.get(id);
      if (door?.kind === "UNIT" && id !== unit.doorId) {
        add("routes", "ROUTE_THROUGH_OTHER_UNIT", `${label}'s route goes through ${door.name}, which belongs to another unit.`);
      }
    }
    if (route.stops.some((s) => !s.guidance.trim())) add("routes", "ROUTE_GUIDANCE_MISSING", `${label}'s route is missing directions for a stop.`);
  }
  currentUnit = undefined;

  // Tour hours and access windows
  const th = cfg.tourHours;
  if (th.days.length === 0) add("hours", "TOUR_DAYS_MISSING", "Pick at least one day when people can tour.");
  const start = minutesOfDay(th.start);
  const end = minutesOfDay(th.end);
  const lengthOk = within(th.tourLengthMinutes, POLICY_LIMITS.tourLengthMinutes);
  if (start >= end) {
    add("hours", "TOUR_HOURS_BACKWARDS", `Tours need to end after they start. Right now they run from ${formatClockTime(th.start)} to ${formatClockTime(th.end)}.`);
  }
  if (!lengthOk) add("hours", "TOUR_LENGTH_INVALID", "Each tour should last between 15 minutes and 4 hours.");
  if (!within(th.slotEveryMinutes, POLICY_LIMITS.slotEveryMinutes)) add("hours", "SLOT_SPACING_INVALID", "New tours should start between 15 minutes and 8 hours apart.");
  if (!within(th.earlyArrivalMinutes, POLICY_LIMITS.earlyArrivalMinutes)) add("hours", "EARLY_ARRIVAL_INVALID", "Early arrival should be between 0 and 60 minutes.");
  if (start < end && lengthOk && end - start < th.tourLengthMinutes) {
    add("hours", "TOUR_HOURS_TOO_SHORT", `The tour hours are too short to fit a ${th.tourLengthMinutes}-minute tour.`);
  }
  const visit = th.tourLengthMinutes + th.earlyArrivalMinutes;
  if (th.slotEveryMinutes > 0 && th.slotEveryMinutes < visit) {
    add(
      "hours",
      "ACCESS_WINDOWS_OVERLAP",
      `Tours start every ${th.slotEveryMinutes} minutes, but each visit (including ${th.earlyArrivalMinutes} minutes early) takes ${visit} minutes, so visitors would overlap. Space tours at least ${visit} minutes apart.`,
    );
  }

  // Verification
  if (!within(cfg.verificationValidForDays, POLICY_LIMITS.verificationValidForDays)) {
    add("verification", "VERIFICATION_REUSE_INVALID", "A visitor check should stay good for between 1 and 365 days.");
  }

  return issues;
}

function duplicates(ids: string[]): string[] {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

function within(n: number, range: { min: number; max: number }): boolean {
  return Number.isFinite(n) && n >= range.min && n <= range.max;
}
