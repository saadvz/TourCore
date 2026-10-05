import { readFileSync } from "node:fs";
import { z } from "zod";
import { WEEKDAYS } from "../core/timezone";
import { UnitProfileSchema } from "./unitProfile";
import { semanticIssues, type ConfigIssue, type ConfigSection } from "./validateConfig";

const Id = z.string().regex(/^[a-z0-9_]+$/, "ids use lowercase letters, digits and underscores");
const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use 24-hour HH:MM");

export const DEMO_VERIFICATION_FORM_URL = "https://forms.example/tour-core-basic-id";

export const DoorSchema = z.object({
  id: Id,
  name: z.string(),
  /** COMMON = hallway, stairwell or other shared door a route can pass through. */
  kind: z.enum(["ENTRANCE", "UNIT", "COMMON"]),
});

/**
 * Operator-approved facts only. Tour Core never invents or generates these;
 * tour guidance may only repeat what is stored here.
 */
const ApprovedFacts = z.array(z.string()).default([]);

export const UnitSchema = z.object({
  id: Id,
  name: z.string(),
  /** Empty until the unit's door is added during setup. */
  doorId: z.string(),
  /** Short operator-written description, e.g. "One-bedroom on the first floor." */
  summary: z.string().default(""),
  facts: ApprovedFacts,
  /** Minimum leasing information (bedrooms, bathrooms, rent, availability, ...). Absent until asked. */
  profile: UnitProfileSchema.optional(),
});

export const RouteSchema = z.object({
  id: Id,
  unitId: z.string(),
  /** Operator's own words for getting from the entrance to the unit. */
  directions: z.string().optional(),
  stops: z.array(z.object({ doorId: z.string(), guidance: z.string() })),
});

export const PROPERTY_TYPES = ["SINGLE_FAMILY", "MULTIFAMILY_HOME", "APARTMENT_BUILDING", "OTHER"] as const;
export const PropertyTypeSchema = z.enum(PROPERTY_TYPES);
export type PropertyType = z.infer<typeof PropertyTypeSchema>;

export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  SINGLE_FAMILY: "Single-family home",
  MULTIFAMILY_HOME: "Multifamily home",
  APARTMENT_BUILDING: "Apartment building",
  OTHER: "Other",
};

export const PropertySchema = z.object({
  id: Id,
  /**
   * How visitors and the operator hear the property named: the operator's own
   * displayName when they gave one, otherwise the canonical address. Kept in
   * step with those two by the setup actions; never an invented nickname.
   */
  name: z.string(),
  /** The canonical physical address. Authoritative for the property's identity. */
  address: z.string(),
  /**
   * Street, city, state and ZIP kept apart from any internal label. Absent on
   * setups saved before this was recorded. A missing ZIP means the address
   * isn't finished.
   */
  canonicalAddress: z
    .object({
      street: z.string(),
      city: z.string(),
      state: z.string(),
      postalCode: z.string().optional(),
      formatted: z.string(),
    })
    .optional(),
  /** The operator confirmed the read-back. Absent means an older setup, which is already in use. */
  addressConfirmed: z.boolean().optional(),
  /** A property or building name the operator said themselves. Absent means "use the address". */
  displayName: z.string().optional(),
  /** Asked right after the address, never inferred from it. Shapes which setup questions are asked. */
  propertyType: PropertyTypeSchema.optional(),
  /** IANA zone, e.g. America/New_York. All tour hours are read in this zone. */
  timezone: z.string(),
  facts: ApprovedFacts,
});

export const TourHoursSchema = z.object({
  days: z.array(z.enum(WEEKDAYS)),
  start: TimeOfDay,
  end: TimeOfDay,
  slotEveryMinutes: z.number().int(),
  tourLengthMinutes: z.number().int(),
  earlyArrivalMinutes: z.number().int(),
});

/**
 * The single configuration object for a Tour Core install. The setup flow
 * (terminal today, Grok Bot later) produces exactly this. Shape only; meaning
 * is checked by validateConfig so problems come back in plain language.
 */
export const TourCoreConfigShape = z.object({
  schemaVersion: z.literal(1),
  property: PropertySchema,
  operator: z.object({
    name: z.string(),
    /** Private alert line. Never shown to visitors. */
    contact: z.string(),
    /**
     * Optional number visitors can call when they're stuck. Separate from
     * `contact` on purpose: that line is for the team, not prospects.
     */
    visitorContact: z.string().optional(),
    /** Optional address for HELP replies and compliance pages. */
    supportEmail: z.string().optional(),
    /**
     * The operator answered the optional help-number/support-email step
     * (with values or an explicit skip). Absent on older setups.
     */
    visitorHelpDecided: z.boolean().optional(),
  }),
  doors: z.array(DoorSchema),
  units: z.array(UnitSchema),
  routes: z.array(RouteSchema),
  tourHours: TourHoursSchema,
  verificationMode: z.enum(["basic-form", "mock", "document-check"]),
  verificationFormUrl: z.url().optional(),
  /** How long a passed check can be reused for repeat tours. */
  verificationValidForDays: z.number().int(),
  /**
   * "demo" prints messages. "live" texts real phones through the installation's
   * messaging provider (Sendblue, Twilio, or Photon). The provider is not stored
   * on the property. Older files say "sendblue" for this same live mode.
   */
  messagingMode: z.preprocess((v) => (v === "console" ? "demo" : v === "sendblue" ? "live" : v), z.enum(["demo", "live"])),
  storageMode: z.enum(["memory", "google-drive"]),
  accessMode: z.enum(["durin-mock", "durin"]),
});

export type TourCoreConfig = z.infer<typeof TourCoreConfigShape>;
export type Door = z.infer<typeof DoorSchema>;
export type Unit = z.infer<typeof UnitSchema>;
export type Route = z.infer<typeof RouteSchema>;
export type Property = z.infer<typeof PropertySchema>;
export type TourHours = z.infer<typeof TourHoursSchema>;

/** Real visitor texting, including property files saved before the mode was renamed from "sendblue". */
export function isLiveMessaging(mode: string | undefined): boolean {
  return mode === "live" || mode === "sendblue";
}

/** Shape + meaning. Anything that parses with this is safe to run tours on. */
export const TourCoreConfigSchema = TourCoreConfigShape.superRefine((cfg, ctx) => {
  for (const issue of semanticIssues(cfg)) ctx.addIssue({ code: "custom", message: issue.message, path: [issue.section], params: { code: issue.code } });
});

const SECTION_BY_KEY: Record<string, ConfigSection> = {
  schemaVersion: "property",
  property: "property",
  operator: "property",
  doors: "units",
  units: "units",
  routes: "routes",
  tourHours: "hours",
  verificationMode: "verification",
  verificationFormUrl: "verification",
  verificationValidForDays: "verification",
  messagingMode: "services",
  storageMode: "services",
  accessMode: "services",
};

const SHAPE_MESSAGE: Record<ConfigSection, string> = {
  property: "Some property details are missing or unreadable.",
  units: "Some unit or door details are missing or unreadable.",
  routes: "Some route details are missing or unreadable.",
  hours: "The tour hours aren't filled in correctly.",
  verification: "The visitor check settings aren't filled in correctly.",
  services: "The records, messages or door settings aren't filled in correctly.",
};

/** Every problem with a config, in plain language, with a machine-readable code. Empty = valid. */
export function validateConfig(input: unknown): ConfigIssue[] {
  const shape = TourCoreConfigShape.safeParse(input);
  if (shape.success) return semanticIssues(shape.data);
  const bySection = new Map<ConfigSection, ConfigIssue>();
  for (const issue of shape.error.issues) {
    const section = SECTION_BY_KEY[String(issue.path[0])] ?? "property";
    const detail = `${issue.path.join(".")}: ${issue.message}`;
    const existing = bySection.get(section);
    if (existing) existing.detail = `${existing.detail}; ${detail}`;
    else bySection.set(section, { code: "SHAPE_INVALID", section, message: SHAPE_MESSAGE[section], detail });
  }
  return [...bySection.values()];
}

export const DEMO_CONFIG_PATH = new URL("../../config/demo-property.json", import.meta.url);

export function loadConfig(path: string | URL = DEMO_CONFIG_PATH): TourCoreConfig {
  return TourCoreConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
