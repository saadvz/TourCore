import {
  DEMO_VERIFICATION_FORM_URL,
  PROPERTY_TYPE_LABELS,
  PropertyTypeSchema,
  validateConfig,
  type Door,
  type PropertyType,
  type TourCoreConfig,
  type TourHours,
  type Unit,
} from "../config/tourCoreConfig";
import { nextProfileQuestion, parseProfileValue, PROFILE_FIELDS, ProfileValueError, type ProfileField, type UnitProfile } from "../config/unitProfile";
import type { ConfigIssue, ConfigSection } from "../config/validateConfig";
import { formatPhone, parsePhone } from "../core/phone";
import { formatClockTime, friendlyTimeZone, WEEKDAYS, type Weekday } from "../core/timezone";
import { visitorSubject } from "../visitor/identity";
import { inferTimeZone, resolveTimeZone, slugify } from "./parse";
import { formatCanonical, parseUsAddress } from "./address";

/**
 * Setup actions. Each takes the current draft and returns a new one; nothing
 * here does I/O or knows about the terminal. A Grok Bot skill can call these
 * same functions one answer at a time.
 */

/** A TourCoreConfig that may not be complete or valid yet. */
export type SetupDraft = TourCoreConfig;

/** Setup copy for the team name visitors hear after "the". Rendered exactly as entered. */
export class OperatorTeamCopy {
  static hint(): string {
    return 'Use a team name that reads naturally after "the", for example leasing team or Maple Leasing team.';
  }

  static cliPrompt(): string {
    return `Who should we alert if a visitor needs help? ${this.hint()}`;
  }
}

/** Visible, overridable defaults. Policy values live in config, never in code paths. */
export const SETUP_DEFAULTS = {
  operatorName: "leasing team",
  operatorContact: "Shown on screen (demo)",
  entranceName: "Main Entrance",
  tourHours: {
    days: ["MON", "TUE", "WED", "THU", "FRI"],
    start: "09:00",
    end: "17:00",
    slotEveryMinutes: 60,
    tourLengthMinutes: 45,
    earlyArrivalMinutes: 10,
  } satisfies TourHours,
  verificationMode: "basic-form",
  verificationValidForDays: 30,
  messagingMode: "demo",
  storageMode: "memory",
  accessMode: "durin-mock",
} as const;

/** What the operator sees instead of mode ids. */
export const CHOICE_LABELS = {
  verification: {
    "basic-form": "Basic identity form",
    mock: "Practice verification (everyone passes)",
    "document-check": "Full ID check",
  },
  messaging: { demo: "Demo messaging (texts show on screen)", live: "Real texts to visitors' phones" },
  storage: { memory: "Demo records (kept on this computer)", "google-drive": "Google Drive" },
  access: { "durin-mock": "Durin demo mode (no real doors open)", durin: "Durin" },
} as const;

/**
 * One sentence about what's real and what's demo, per subsystem. Never a
 * blanket "everything is in demo mode": visitor texting can be live while
 * door access is still demo.
 */
export function modeSentence(textingLive: boolean, accessDemo: boolean): string {
  const texting = textingLive ? "Visitor texting is live." : "Visitor texts are practice only, so nobody is texted.";
  const doors = accessDemo ? "Door access is still in demo mode, so no physical locks will open." : "Door access is connected.";
  return `${texting} ${doors}`;
}

export class SetupInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const clone = <T>(v: T): T => structuredClone(v);

function uniqueId(base: string, taken: Iterable<string>, fallback: string): string {
  const used = new Set(taken);
  const root = base || fallback;
  if (!used.has(root)) return root;
  for (let i = 2; ; i++) if (!used.has(`${root}_${i}`)) return `${root}_${i}`;
}

function requireName(name: string | undefined, code: string, message: string): string {
  const trimmed = name?.trim();
  if (!trimmed) throw new SetupInputError(code, message);
  return trimmed;
}

function requireTimeZone(input: string): string {
  const tz = resolveTimeZone(input);
  if (!tz) throw new SetupInputError("TIMEZONE_INVALID", `I don't recognize the time zone "${input}". Try something like America/New_York or "Eastern".`);
  return tz;
}

// ------------------------------------------------------------------ property

/** How the property is named to visitors and the operator: their own name for it, otherwise the canonical address. */
export function propertyLabel(property: { address: string; displayName?: string; name?: string }): string {
  return property.displayName?.trim() || property.address.trim() || property.name?.trim() || "";
}

function withLabel(property: SetupDraft["property"]): SetupDraft["property"] {
  const displayName = property.displayName?.trim();
  const { displayName: _dropped, ...rest } = property;
  return { ...rest, ...(displayName ? { displayName } : {}), name: displayName || property.address.trim() };
}

function requirePropertyType(input: string): PropertyType {
  const parsed = PropertyTypeSchema.safeParse(input);
  if (!parsed.success) throw new SetupInputError("PROPERTY_TYPE_UNKNOWN", "Choose a single-family home, a multifamily home, an apartment building, or other.");
  return parsed.data;
}

export function createPropertySetup(input: {
  address: string;
  /** Only a name the operator gave themselves. Leave out to use the address. */
  name?: string;
  propertyType?: string;
  timezone?: string;
  /** Property ids already in use, so a new one never collides. */
  existingPropertyIds?: string[];
  /** The installation's real visitor texting, when it has one: a new property uses it instead of demo messaging. */
  messagingMode?: SetupDraft["messagingMode"];
}): SetupDraft {
  const parsed = parseUsAddress(input.address);
  const address = parsed?.address.formatted || requireName(input.address, "ADDRESS_MISSING", "Please enter the property's address.");
  const displayName = input.name?.trim() || undefined;
  const timezone = input.timezone ? requireTimeZone(input.timezone) : inferTimeZone(address).timezone;
  const propertyType = input.propertyType ? requirePropertyType(input.propertyType) : undefined;
  const zip = parsed?.address.postalCode;
  const confirmed = !!zip && !!propertyType && !parsed!.missing.some((part) => part !== "postalCode");
  return {
    schemaVersion: 1,
    property: withLabel({
      id: uniqueId(`prop_${slugify(displayName ?? address)}`, input.existingPropertyIds ?? [], "prop_property"),
      name: "",
      address,
      ...(parsed ? { canonicalAddress: parsed.address } : {}),
      addressConfirmed: confirmed,
      ...(displayName ? { displayName } : {}),
      ...(propertyType ? { propertyType } : {}),
      timezone,
      facts: [],
    }),
    operator: { name: SETUP_DEFAULTS.operatorName, contact: SETUP_DEFAULTS.operatorContact },
    doors: [],
    units: [],
    routes: [],
    tourHours: clone(SETUP_DEFAULTS.tourHours),
    verificationMode: SETUP_DEFAULTS.verificationMode,
    verificationFormUrl: DEMO_VERIFICATION_FORM_URL,
    verificationValidForDays: SETUP_DEFAULTS.verificationValidForDays,
    messagingMode: input.messagingMode ?? SETUP_DEFAULTS.messagingMode,
    storageMode: SETUP_DEFAULTS.storageMode,
    accessMode: SETUP_DEFAULTS.accessMode,
  };
}

/**
 * The property id never changes after creation, even if the name does. An
 * empty name removes the operator's own name, so the address is used again.
 */
export function setPropertyDetails(
  draft: SetupDraft,
  input: { name?: string; address?: string; propertyType?: string; timezone?: string; facts?: string[]; postalCode?: string; confirmAddress?: boolean },
): SetupDraft {
  const next = clone(draft);
  // A setup saved before names and addresses were kept apart: an earlier name that isn't the address was the operator's.
  if (next.property.displayName === undefined && next.property.name.trim() && next.property.name.trim() !== next.property.address.trim()) next.property.displayName = next.property.name.trim();
  if (input.name !== undefined) next.property.displayName = input.name.trim() || undefined;
  if (input.address !== undefined) {
    const parsed = parseUsAddress(input.address);
    next.property.address = parsed?.address.formatted || requireName(input.address, "ADDRESS_MISSING", "Please enter the property's address.");
    if (parsed) next.property.canonicalAddress = parsed.address;
    next.property.addressConfirmed = false;
  }
  if (input.postalCode !== undefined) {
    const zip = input.postalCode.trim();
    if (!/^\d{5}(?:-\d{4})?$/.test(zip)) throw new SetupInputError("ZIP_INVALID", "A ZIP code is five digits, like 07666.");
    const current = next.property.canonicalAddress ?? parseUsAddress(next.property.address)?.address;
    if (!current?.street || !current.city || !current.state) throw new SetupInputError("ADDRESS_INCOMPLETE", "I still need the street, city and state before a ZIP code.");
    const canonicalAddress = { ...current, postalCode: zip.slice(0, 5), formatted: formatCanonical({ ...current, postalCode: zip.slice(0, 5) }) };
    next.property.canonicalAddress = canonicalAddress;
    next.property.address = canonicalAddress.formatted;
    next.property.addressConfirmed = false;
  }
  if (input.confirmAddress) {
    if (!next.property.canonicalAddress?.postalCode) throw new SetupInputError("ADDRESS_INCOMPLETE", "I still need the ZIP code before that address can be confirmed.");
    next.property.addressConfirmed = true;
  }
  if (input.propertyType !== undefined) next.property.propertyType = requirePropertyType(input.propertyType);
  if (input.timezone !== undefined) next.property.timezone = requireTimeZone(input.timezone);
  if (input.facts !== undefined) next.property.facts = cleanFacts(input.facts);
  next.property = withLabel(next.property);
  return next;
}

/** What Tour Core suggests calling the one tourable space of a single-family home. The operator can rename it. */
export const SINGLE_FAMILY_SPACE_NAME = "Main Home";
/** The single-family home's own door, when the operator hasn't named one. */
export const SINGLE_FAMILY_DOOR_NAME = "Front Door";

/**
 * The one setup question that depends on the property type: how to ask about
 * the tourable spaces. Undefined until the type is known.
 */
export function tourableSpacesQuestion(draft: SetupDraft): { question: string; suggestedName?: string } | undefined {
  switch (draft.property.propertyType) {
    case "SINGLE_FAMILY":
      return { question: `People will tour the whole home. Should I call it "${SINGLE_FAMILY_SPACE_NAME}", or would you like another name?`, suggestedName: SINGLE_FAMILY_SPACE_NAME };
    case "MULTIFAMILY_HOME":
    case "APARTMENT_BUILDING":
      return { question: "Which units can people tour?" };
    case "OTHER":
      return { question: "How would you like the spaces people tour to be named?" };
    default:
      return undefined;
  }
}

/** Keeps operator wording as written; only trims and drops blanks. */
function cleanFacts(facts: string[]): string[] {
  const cleaned = facts.map((f) => f.trim()).filter(Boolean);
  if (cleaned.length > 30) throw new SetupInputError("TOO_MANY_FACTS", "Please keep it to 30 facts or fewer.");
  return [...new Set(cleaned)];
}

/** The door label setup suggests for a unit, e.g. "Unit 101" -> "Unit 101 Door". */
export function defaultUnitDoorName(unitName: string): string {
  return `${unitName.trim()} Door`;
}

export const VISITOR_HELP_NUMBER_QUESTION =
  "What number can stuck visitors call? Pick one someone answers during tour hours.";
export const VISITOR_HELP_QUESTION = VISITOR_HELP_NUMBER_QUESTION;

export function visitorHelpDecided(operator: SetupDraft["operator"]): boolean {
  return !!operator.visitorHelpDecided || !!operator.visitorContact;
}

export function visitorHelpLines(operator: SetupDraft["operator"]): string[] {
  return [`Visitors can call: ${operator.visitorContact ? formatPhone(operator.visitorContact) : "not set"}`];
}

/** Asked once the rest of the setup is saveable, so it sits with the alert step. */
export function visitorHelpQuestion(draft: SetupDraft): { nextQuestion: string } | undefined {
  if (visitorHelpDecided(draft.operator)) return undefined;
  if (nextProfileQuestion(draft.units)) return undefined;
  if (validateConfig(draft).length) return undefined;
  return { nextQuestion: VISITOR_HELP_QUESTION };
}

export function setAlertContact(
  draft: SetupDraft,
  input: { name?: string; contact?: string; visitorContact?: string; skipVisitorHelp?: boolean },
): SetupDraft {
  const next = clone(draft);
  if (input.name !== undefined) next.operator.name = requireName(input.name, "OPERATOR_MISSING", "Please say who should get alerts.");
  if (input.contact !== undefined) next.operator.contact = input.contact.trim() || SETUP_DEFAULTS.operatorContact;
  if (input.visitorContact !== undefined) {
    const raw = input.visitorContact.trim();
    if (!raw) delete next.operator.visitorContact;
    else {
      const phone = parsePhone(raw);
      if (!phone) throw new SetupInputError("PHONE_INVALID", "Please enter a full phone number.");
      next.operator.visitorContact = phone;
    }
  }
  if (input.skipVisitorHelp || input.visitorContact !== undefined) {
    next.operator.visitorHelpDecided = true;
  }
  return next;
}

// ------------------------------------------------------------- doors, units

export function addDoor(draft: SetupDraft, input: { name: string; kind: Door["kind"]; unitId?: string }): { draft: SetupDraft; door: Door } {
  const name = requireName(input.name, "DOOR_NAME_MISSING", "Please give the door a name.");
  if (draft.doors.some((d) => d.name.toLowerCase() === name.toLowerCase())) {
    throw new SetupInputError("DOOR_NAME_TAKEN", `There's already a door called "${name}".`);
  }
  const next = clone(draft);
  const door: Door = { id: uniqueId(slugify(name), next.doors.map((d) => d.id), "door"), name, kind: input.kind };
  next.doors.push(door);
  if (input.unitId) {
    const unit = next.units.find((u) => u.id === input.unitId);
    if (!unit) throw new SetupInputError("UNIT_NOT_FOUND", "That unit isn't part of this property.");
    unit.doorId = door.id;
  }
  return { draft: next, door };
}

export function renameDoor(draft: SetupDraft, doorId: string, name: string): SetupDraft {
  const clean = requireName(name, "DOOR_NAME_MISSING", "Please give the door a name.");
  if (draft.doors.some((d) => d.id !== doorId && d.name.toLowerCase() === clean.toLowerCase())) {
    throw new SetupInputError("DOOR_NAME_TAKEN", `There's already a door called "${clean}".`);
  }
  const next = clone(draft);
  const door = next.doors.find((d) => d.id === doorId);
  if (!door) throw new SetupInputError("DOOR_NOT_FOUND", "That door isn't part of this property.");
  door.name = clean;
  return next;
}

/** Routes that used this door are left alone so the review flags them. */
export function removeDoor(draft: SetupDraft, doorId: string): SetupDraft {
  const next = clone(draft);
  next.doors = next.doors.filter((d) => d.id !== doorId);
  for (const unit of next.units) if (unit.doorId === doorId) unit.doorId = "";
  return next;
}

export function addUnit(
  draft: SetupDraft,
  input: { name: string; summary?: string; facts?: string[] },
): { draft: SetupDraft; unit: Unit } {
  const name = requireName(input.name, "UNIT_NAME_MISSING", "Please give the unit a name.");
  if (draft.units.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
    throw new SetupInputError("UNIT_NAME_TAKEN", `There's already a unit called "${name}".`);
  }
  const next = clone(draft);
  const unit: Unit = {
    id: uniqueId(slugify(name), next.units.map((u) => u.id), "unit"),
    name,
    doorId: "",
    summary: input.summary?.trim() ?? "",
    facts: cleanFacts(input.facts ?? []),
  };
  next.units.push(unit);
  return { draft: next, unit };
}

/** True when the unit's door still carries the label setup suggested, so it can safely follow a rename. */
export function doorFollowsUnitName(draft: SetupDraft, unitId: string): boolean {
  const unit = draft.units.find((u) => u.id === unitId);
  const door = draft.doors.find((d) => d.id === unit?.doorId);
  return !!unit && !!door && door.name === defaultUnitDoorName(unit.name);
}

/**
 * Renames one unit. Its door is renamed too only when asked AND the door still
 * has the suggested label; a door the operator named themselves is never touched.
 */
export function renameUnit(draft: SetupDraft, unitId: string, name: string, options: { alsoRenameDoor?: boolean } = {}): SetupDraft {
  const clean = requireName(name, "UNIT_NAME_MISSING", "Please give the unit a name.");
  if (draft.units.some((u) => u.id !== unitId && u.name.toLowerCase() === clean.toLowerCase())) {
    throw new SetupInputError("UNIT_NAME_TAKEN", `There's already a unit called "${clean}".`);
  }
  const renameDoorToo = options.alsoRenameDoor === true && doorFollowsUnitName(draft, unitId);
  let next = clone(draft);
  const unit = next.units.find((u) => u.id === unitId);
  if (!unit) throw new SetupInputError("UNIT_NOT_FOUND", "That unit isn't part of this property.");
  const old = unit.name;
  unit.name = clean;
  for (const route of next.routes.filter((r) => r.unitId === unitId)) {
    for (const stop of route.stops) stop.guidance = stop.guidance.split(old).join(clean);
  }
  if (renameDoorToo) next = renameDoor(next, unit.doorId, defaultUnitDoorName(clean));
  return next;
}

export function setUnitDetails(draft: SetupDraft, unitId: string, input: { summary?: string; facts?: string[] }): SetupDraft {
  const next = clone(draft);
  const unit = next.units.find((u) => u.id === unitId);
  if (!unit) throw new SetupInputError("UNIT_NOT_FOUND", "That unit isn't part of this property.");
  if (input.summary !== undefined) unit.summary = input.summary.trim();
  if (input.facts !== undefined) unit.facts = cleanFacts(input.facts);
  return next;
}

/**
 * Sets unit details (bedrooms, bathrooms, rent, availability, ...) from the
 * operator's words. "I don't know" / "don't list it" become an explicit
 * NOT_PROVIDED; anything unreadable is refused, never guessed. Unchanged
 * values keep their original timestamp.
 */
export function setUnitProfile(draft: SetupDraft, unitId: string, values: Partial<Record<ProfileField, string | number | boolean>>, now = new Date()): SetupDraft {
  const next = clone(draft);
  const unit = next.units.find((u) => u.id === unitId);
  if (!unit) throw new SetupInputError("UNIT_NOT_FOUND", "That unit isn't part of this property.");
  const profile: UnitProfile = { ...(unit.profile ?? {}) };
  for (const [key, raw] of Object.entries(values) as [ProfileField, string | number | boolean | undefined][]) {
    if (!PROFILE_FIELDS.includes(key)) throw new SetupInputError("UNIT_DETAIL_UNKNOWN", `"${key}" isn't a unit detail Tour Core keeps.`);
    if (raw === undefined || (typeof raw === "string" && !raw.trim())) continue;
    let parsed;
    try {
      parsed = parseProfileValue(key, raw, now);
    } catch (err) {
      if (err instanceof ProfileValueError) throw new SetupInputError("UNIT_DETAIL_UNREADABLE", `${unit.name}: ${err.message}`);
      throw err;
    }
    const old = profile[key];
    const same = old && old.status === parsed.status && JSON.stringify("value" in old ? old.value : null) === JSON.stringify("value" in parsed ? parsed.value : null);
    if (!same) (profile as Record<string, unknown>)[key] = parsed;
  }
  unit.profile = profile;
  return next;
}

/** Entrance -> unit door, when both exist. A suggestion only; nothing is saved until setRoute. */
export function suggestRoute(draft: SetupDraft, unitId: string): string[] {
  const unit = draft.units.find((u) => u.id === unitId);
  const entrance = draft.doors.find((d) => d.kind === "ENTRANCE");
  return [...new Set([entrance?.id, unit?.doorId].filter((id): id is string => !!id && draft.doors.some((d) => d.id === id)))];
}

/**
 * Adds a tourable space with its own door. In a single-family home the space
 * is the whole home: it's named "Main Home" unless the operator says
 * otherwise, its door is the home's entrance (added as "Front Door" if there
 * isn't one yet), and its route is just that door.
 */
export function addTourableSpace(draft: SetupDraft, input: { name?: string; summary?: string; facts?: string[]; doorName?: string }): SetupDraft {
  if (draft.property.propertyType !== "SINGLE_FAMILY") {
    const { draft: withUnit, unit } = addUnit(draft, { ...input, name: input.name ?? "" });
    return addDoor(withUnit, { name: input.doorName?.trim() || defaultUnitDoorName(unit.name), kind: "UNIT", unitId: unit.id }).draft;
  }
  if (draft.units.length) throw new SetupInputError("SINGLE_FAMILY_ONE_SPACE", `A single-family home has one tourable space, and it's already set up as ${draft.units[0]!.name}.`);
  const { draft: withUnit, unit } = addUnit(draft, { ...input, name: input.name?.trim() || SINGLE_FAMILY_SPACE_NAME });
  const named = input.doorName?.trim();
  let entrance = withUnit.doors.find((d) => d.kind === "ENTRANCE" && (!named || d.name.toLowerCase() === named.toLowerCase()));
  let next = withUnit;
  if (!entrance) ({ draft: next, door: entrance } = addDoor(withUnit, { name: named || SINGLE_FAMILY_DOOR_NAME, kind: "ENTRANCE" }));
  next = clone(next);
  next.units.find((u) => u.id === unit.id)!.doorId = entrance.id;
  return setRoute(next, unit.id, [entrance.id]);
}

/** Removes the unit, its route, and its own door. */
export function removeUnit(draft: SetupDraft, unitId: string): SetupDraft {
  const unit = draft.units.find((u) => u.id === unitId);
  if (!unit) return draft;
  let next = clone(draft);
  next.units = next.units.filter((u) => u.id !== unitId);
  next.routes = next.routes.filter((r) => r.unitId !== unitId);
  const door = next.doors.find((d) => d.id === unit.doorId);
  if (door?.kind === "UNIT" && !next.units.some((u) => u.doorId === door.id)) next = removeDoor(next, door.id);
  return next;
}

export function setUnitSummary(draft: SetupDraft, unitId: string, summary: string): SetupDraft {
  return setUnitDetails(draft, unitId, { summary });
}

// -------------------------------------------------------------------- routes

/** Door ids in the order the visitor walks through them. Replaces any existing route for the unit. */
export function setRoute(draft: SetupDraft, unitId: string, doorIds: string[], options: { directions?: string } = {}): SetupDraft {
  const unit = draft.units.find((u) => u.id === unitId);
  if (!unit) throw new SetupInputError("UNIT_NOT_FOUND", "That unit isn't part of this property.");
  if (doorIds.length === 0) throw new SetupInputError("ROUTE_EMPTY", "Pick at least one door for this route.");
  if (doorIds.some((id) => !draft.doors.some((d) => d.id === id))) {
    throw new SetupInputError("ROUTE_DOOR_UNKNOWN", "One of those doors isn't part of this property.");
  }
  const directions = options.directions?.trim() || undefined;
  const next = clone(draft);
  next.routes = next.routes.filter((r) => r.unitId !== unitId);
  next.routes.push({
    id: uniqueId(`route_${unit.id}`, next.routes.map((r) => r.id), "route"),
    unitId,
    ...(directions ? { directions } : {}),
    stops: doorIds.map((doorId, i) => ({ doorId, guidance: guidanceFor(draft, unit, doorId, i === doorIds.length - 1, directions) })),
  });
  return next;
}

function guidanceFor(draft: SetupDraft, unit: Unit, doorId: string, isLast: boolean, directions?: string): string {
  const place = draft.property.propertyType === "SINGLE_FAMILY" ? visitorSubject(draft.property, unit.name) : unit.name;
  if (isLast) return `Welcome to ${place}! Take your time, and text me any questions.`;
  const door = draft.doors.find((d) => d.id === doorId);
  if (door?.kind === "ENTRANCE") {
    return `Come on in. ${directions ? `To get to ${place}: ${directions.replace(/[.!]?$/, ".")}` : `Head to ${place}.`}`;
  }
  return `Keep going toward ${place}.`;
}

// ---------------------------------------------------------- hours, policies

export function setTourHours(draft: SetupDraft, input: Partial<TourHours>): SetupDraft {
  const next = clone(draft);
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (input.days !== undefined) {
    if (input.days.some((d) => !WEEKDAYS.includes(d))) throw new SetupInputError("TOUR_DAYS_UNREADABLE", "I didn't understand those days.");
    next.tourHours.days = WEEKDAYS.filter((d) => input.days!.includes(d));
  }
  for (const key of ["start", "end"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!hhmm.test(value)) throw new SetupInputError("TOUR_TIME_UNREADABLE", "I didn't understand that time.");
    next.tourHours[key] = value;
  }
  for (const key of ["slotEveryMinutes", "tourLengthMinutes", "earlyArrivalMinutes"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value)) throw new SetupInputError("TOUR_MINUTES_UNREADABLE", "Please use a whole number of minutes.");
    next.tourHours[key] = value;
  }
  return next;
}

export function setVerificationPolicy(
  draft: SetupDraft,
  input: { mode?: SetupDraft["verificationMode"]; reuseForDays?: number },
): SetupDraft {
  const next = clone(draft);
  if (input.mode !== undefined) next.verificationMode = input.mode;
  if (input.reuseForDays !== undefined) {
    if (!Number.isInteger(input.reuseForDays)) throw new SetupInputError("VERIFICATION_REUSE_UNREADABLE", "Please use a whole number of days.");
    next.verificationValidForDays = input.reuseForDays;
  }
  return next;
}

export function setServices(
  draft: SetupDraft,
  input: {
    messagingMode?: SetupDraft["messagingMode"];
    messagingProvider?: "local";
    storageMode?: SetupDraft["storageMode"];
    accessMode?: SetupDraft["accessMode"];
  },
): SetupDraft {
  const next = clone(draft);
  if (input.storageMode !== undefined) next.storageMode = input.storageMode;
  if (input.accessMode !== undefined) next.accessMode = input.accessMode;
  if (input.messagingProvider === "local") {
    next.messagingMode = "live";
    next.messagingProvider = "local";
    return next;
  }
  if (input.messagingMode !== undefined) {
    next.messagingMode = input.messagingMode;
    delete next.messagingProvider;
  }
  return next;
}

// -------------------------------------------------------------------- review

export interface ReviewSection {
  /** Which part of setup to revisit to change this. */
  editSection: ConfigSection;
  title: string;
  lines: string[];
}

export interface SetupReview {
  sections: ReviewSection[];
  issues: ConfigIssue[];
  canSave: boolean;
}

export function reviewSetup(draft: SetupDraft): SetupReview {
  const issues = validateConfig(draft);
  const doorName = (id: string) => draft.doors.find((d) => d.id === id)?.name ?? "(missing door)";
  const th = draft.tourHours;
  const sections: ReviewSection[] = [
    {
      editSection: "property",
      title: "PROPERTY",
      lines: [
        draft.property.address,
        ...(draft.property.displayName ? [`Called: ${draft.property.displayName}`] : []),
        draft.property.propertyType ? PROPERTY_TYPE_LABELS[draft.property.propertyType] : "(property type not chosen yet)",
      ],
    },
    { editSection: "property", title: "TIMEZONE", lines: [`${draft.property.timezone} (${friendlyTimeZone(draft.property.timezone)})`] },
    {
      editSection: "hours",
      title: "TOUR HOURS",
      lines: [
        describeDays(th.days),
        `${formatClockTime(th.start)}-${formatClockTime(th.end)}`,
        `Each tour lasts ${describeMinutes(th.tourLengthMinutes)}; a new tour can start every ${describeInterval(th.slotEveryMinutes)}`,
        `Visitors can get in up to ${describeMinutes(th.earlyArrivalMinutes)} early`,
      ],
    },
    { editSection: "units", title: "UNITS", lines: draft.units.length ? draft.units.map((u) => u.name) : ["(none yet)"] },
    ...draft.units.map((unit) => {
      const route = draft.routes.find((r) => r.unitId === unit.id);
      return {
        editSection: "routes" as const,
        title: `ROUTE: ${unit.name.toUpperCase()}`,
        lines: route?.stops.length ? route.stops.map((s) => doorName(s.doorId)) : ["(no route yet)"],
      };
    }),
    {
      editSection: "verification",
      title: "VERIFICATION",
      lines: [
        CHOICE_LABELS.verification[draft.verificationMode],
        `Checked visitors can book again for ${draft.verificationValidForDays} days without re-checking`,
      ],
    },
    {
      editSection: "services",
      title: "RECORDS, MESSAGES AND DOORS",
      lines: [
        `Records: ${CHOICE_LABELS.storage[draft.storageMode]}`,
        `Messages: ${draft.messagingProvider === "local" ? "Local test texts (no real texts are sent)" : CHOICE_LABELS.messaging[draft.messagingMode]}`,
        `Doors: ${CHOICE_LABELS.access[draft.accessMode]}`,
      ],
    },
    {
      editSection: "property",
      title: "ALERTS",
      lines: [`If a visitor needs help: ${draft.operator.name}`, ...visitorHelpLines(draft.operator)],
    },
  ];
  return { sections, issues, canSave: issues.length === 0 };
}

const DAY_LABEL: Record<Weekday, string> = {
  MON: "Monday", TUE: "Tuesday", WED: "Wednesday", THU: "Thursday", FRI: "Friday", SAT: "Saturday", SUN: "Sunday",
};
const WEEK_ORDER: Weekday[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

export function describeDays(days: readonly Weekday[]): string {
  const ordered = WEEK_ORDER.filter((d) => days.includes(d));
  if (ordered.length === 0) return "No days selected";
  if (ordered.length === 7) return "Every day";
  const idx = ordered.map((d) => WEEK_ORDER.indexOf(d));
  const contiguous = idx.every((n, i) => i === 0 || n === idx[i - 1]! + 1);
  if (contiguous && ordered.length >= 3) return `${DAY_LABEL[ordered[0]!]}-${DAY_LABEL[ordered[ordered.length - 1]!]}`;
  return ordered.map((d) => DAY_LABEL[d]).join(", ");
}

/** For "every ___": 60 -> "hour", 90 -> "1 hour 30 minutes". */
export function describeInterval(n: number): string {
  return n === 60 ? "hour" : describeMinutes(n);
}

export function describeMinutes(n: number): string {
  if (n === 0) return "0 minutes";
  const h = Math.floor(n / 60);
  const m = n % 60;
  const parts = [h ? `${h} hour${h === 1 ? "" : "s"}` : "", m ? `${m} minute${m === 1 ? "" : "s"}` : ""].filter(Boolean);
  return parts.join(" ");
}
