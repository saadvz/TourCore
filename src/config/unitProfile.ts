import { z } from "zod";

/**
 * The minimum leasing information for each tourable unit, as approved facts.
 *
 * Every field is either PROVIDED (with the operator's value) or explicitly
 * NOT_PROVIDED (the operator said they don't know or don't want it listed).
 * A field that's absent hasn't been asked yet. These three are never
 * confused: "$0" is a provided rent, "0 bedrooms" is a studio, and NOT_PROVIDED
 * is neither. Nothing here is ever invented; visitor answers are generated
 * deterministically from these values.
 */

const at = z.string().optional();
const NotProvided = z.object({ status: z.literal("NOT_PROVIDED"), note: z.string().max(120).optional(), updatedAt: at });
const provided = <T extends z.ZodType>(value: T) => z.object({ status: z.literal("PROVIDED"), value, updatedAt: at });
const field = <T extends z.ZodType>(value: T) => z.union([provided(value), NotProvided]).optional();

export const AvailabilitySchema = z.object({
  /** The operator's words, e.g. "now" or "October 15". */
  text: z.string().min(1).max(80),
  /** YYYY-MM-DD when the operator gave an exact date. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  now: z.boolean().optional(),
});

export const UnitProfileSchema = z.object({
  /** 0 means a studio. */
  bedrooms: field(z.number().int().min(0).max(20)),
  bathrooms: field(z.number().min(0).max(20)),
  /** Asking rent per month; 0 is a real value, not "missing". */
  monthlyRent: field(z.object({ amount: z.number().min(0).max(1_000_000), currency: z.literal("USD") })),
  availability: field(AvailabilitySchema),
  squareFeet: field(z.number().int().min(1).max(100_000)),
  floor: field(z.string().max(40)),
  parking: field(z.string().max(200)),
  laundry: field(z.string().max(200)),
  pets: field(z.string().max(200)),
  utilities: field(z.string().max(200)),
  furnished: field(z.boolean()),
  features: field(z.string().max(300)),
});
export type UnitProfile = z.infer<typeof UnitProfileSchema>;
export type ProfileField = keyof UnitProfile;

export const REQUIRED_PROFILE_FIELDS = ["bedrooms", "bathrooms", "monthlyRent", "availability"] as const satisfies readonly ProfileField[];
export const OPTIONAL_PROFILE_FIELDS = ["squareFeet", "floor", "parking", "laundry", "pets", "utilities", "furnished", "features"] as const satisfies readonly ProfileField[];
export const PROFILE_FIELDS: ProfileField[] = [...REQUIRED_PROFILE_FIELDS, ...OPTIONAL_PROFILE_FIELDS];

export const FIELD_WORDS: Record<ProfileField, string> = {
  bedrooms: "bedrooms",
  bathrooms: "bathrooms",
  monthlyRent: "rent",
  availability: "availability",
  squareFeet: "square footage",
  floor: "floor",
  parking: "parking",
  laundry: "laundry",
  pets: "pet policy",
  utilities: "utilities",
  furnished: "furnished",
  features: "features",
};

interface UnitLike {
  name: string;
  profile?: UnitProfile;
}

/** Required fields that are neither provided nor explicitly marked not provided. */
export function missingProfileFields(unit: UnitLike): ProfileField[] {
  return REQUIRED_PROFILE_FIELDS.filter((f) => !unit.profile?.[f]);
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const sentence = (s: string) => {
  const t = s.trim().replace(/\s+/g, " ");
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** One plain sentence per provided value. NOT_PROVIDED and absent fields produce nothing (so visitors get the safe unknown flow). */
export function profileFacts(unit: UnitLike): { field: ProfileField; text: string }[] {
  const p = unit.profile ?? {};
  const n = unit.name;
  const out: { field: ProfileField; text: string }[] = [];
  const add = (f: ProfileField, text: string) => out.push({ field: f, text });
  if (p.bedrooms?.status === "PROVIDED") add("bedrooms", p.bedrooms.value === 0 ? `${n} is a studio (no separate bedroom).` : `${n} has ${plural(p.bedrooms.value, "bedroom", "bedrooms")}.`);
  if (p.bathrooms?.status === "PROVIDED") add("bathrooms", `${n} has ${plural(p.bathrooms.value, "bathroom", "bathrooms")}.`);
  if (p.monthlyRent?.status === "PROVIDED") add("monthlyRent", `${n} rents for ${money(p.monthlyRent.value.amount)} a month.`);
  if (p.availability?.status === "PROVIDED") add("availability", p.availability.value.now ? `${n} is available now.` : `${n} is available ${p.availability.value.text.replace(/^available\s+/i, "")}.`);
  if (p.squareFeet?.status === "PROVIDED") add("squareFeet", `${n} is about ${p.squareFeet.value.toLocaleString("en-US")} square feet.`);
  if (p.floor?.status === "PROVIDED") add("floor", `${n} is on ${/floor/i.test(p.floor.value) ? `the ${p.floor.value}` : `floor ${p.floor.value}`}.`);
  if (p.parking?.status === "PROVIDED") add("parking", sentence(`Parking for ${n}: ${p.parking.value}`));
  if (p.laundry?.status === "PROVIDED") add("laundry", sentence(`Laundry for ${n}: ${p.laundry.value}`));
  if (p.pets?.status === "PROVIDED") add("pets", sentence(`Pets in ${n}: ${p.pets.value}`));
  if (p.utilities?.status === "PROVIDED") add("utilities", sentence(`Utilities for ${n}: ${p.utilities.value}`));
  if (p.furnished?.status === "PROVIDED") add("furnished", `${n} is ${p.furnished.value ? "furnished" : "unfurnished"}.`);
  if (p.features?.status === "PROVIDED") add("features", sentence(`${n} features: ${p.features.value}`));
  return out;
}

/** "1A — 2 bed · 1 bath · $2,200 · availability not given yet" */
export function profileSummaryLine(unit: UnitLike): string {
  const p = unit.profile ?? {};
  const part = (f: ProfileField, show: (v: never) => string) => {
    const v = p[f];
    if (!v) return `${FIELD_WORDS[f]} not given yet`;
    if (v.status === "NOT_PROVIDED") return `${FIELD_WORDS[f]} not listed`;
    return show(v.value as never);
  };
  const parts = [
    part("bedrooms", (b: number) => (b === 0 ? "studio" : `${b} bed`)),
    part("bathrooms", (b: number) => `${b} bath`),
    part("monthlyRent", (r: { amount: number }) => `${money(r.amount)}/month`),
    part("availability", (a: { text: string; now?: boolean }) => (a.now ? "available now" : `available ${a.text.replace(/^available\s+/i, "")}`)),
  ];
  if (p.squareFeet?.status === "PROVIDED") parts.push(`~${p.squareFeet.value.toLocaleString("en-US")} sq ft`);
  return `${unit.name} — ${parts.join(" · ")}`;
}

// ------------------------------------------------------------- everyday input

const NOT_PROVIDED_WORDS = /^(i\s+)?(don'?t|do not)\s+(know|list|want)|^not\s+(sure|known|available|provided|listed)|^unknown$|^n\/?a$|^none given$|^skip$|^leave (it )?(blank|out|off)|^tbd$|^no idea$|^don'?t list/i;

export class ProfileValueError extends Error {}

const NUMBER_WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

function parseCount(raw: string): number | undefined {
  const t = raw.trim().toLowerCase();
  if (/^studio$/.test(t)) return 0;
  const m = /^(\d+(?:\.\d+)?|zero|one|two|three|four|five|six)(?:\s*(?:-\s*)?(?:bed(?:room)?s?|br|bd|bath(?:room)?s?|ba))?$/.exec(t);
  if (!m) return undefined;
  return NUMBER_WORDS[m[1]!] ?? Number(m[1]);
}

function parseMoney(raw: string): number | undefined {
  const m = /^\$?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k)?\s*(?:\/\s*mo(?:nth)?|a month|per month|monthly)?$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]!.replace(/,/g, ""));
  return m[2] ? n * 1000 : n;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function parseAvailability(raw: string, now: Date): z.infer<typeof AvailabilitySchema> | undefined {
  const text = raw.trim().replace(/^available\s+/i, "").replace(/[.]$/, "");
  if (!text) return undefined;
  if (/^(now|immediately|right away|today|asap)$/i.test(text)) return { text: "now", now: true };
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return { text, date: text };
  const md = /^(?:on\s+)?([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?$/i.exec(text);
  const month = md ? MONTHS.findIndex((m) => m.startsWith(md[1]!.toLowerCase().slice(0, 3))) : -1;
  if (md && month >= 0) {
    const day = Number(md[2]);
    let year = md[3] ? Number(md[3]) : now.getUTCFullYear();
    if (!md[3] && new Date(Date.UTC(year, month, day)) < new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))) year++;
    return { text: `${MONTHS[month]![0]!.toUpperCase()}${MONTHS[month]!.slice(1)} ${day}`, date: `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
  }
  return text.length <= 80 ? { text } : undefined;
}

/**
 * One field from the operator's words. "I don't know", "not sure", "not
 * available yet", "don't list the price" become an explicit NOT_PROVIDED.
 * Anything unreadable is refused rather than guessed.
 */
export function parseProfileValue(f: ProfileField, raw: string | number | boolean, now = new Date()): NonNullable<UnitProfile[ProfileField]> {
  const updatedAt = now.toISOString();
  if (typeof raw === "string" && NOT_PROVIDED_WORDS.test(raw.trim())) return { status: "NOT_PROVIDED", note: raw.trim().slice(0, 120), updatedAt };
  const bad = (hint: string): never => {
    throw new ProfileValueError(`I didn't understand the ${FIELD_WORDS[f]} "${String(raw)}". ${hint}`);
  };
  const text = String(raw).trim();
  switch (f) {
    case "bedrooms": {
      const n = typeof raw === "number" ? raw : parseCount(text);
      if (n === undefined || !Number.isInteger(n) || n < 0) bad('Try "2", "studio" or "not sure".');
      return { status: "PROVIDED", value: n!, updatedAt };
    }
    case "bathrooms": {
      const n = typeof raw === "number" ? raw : parseCount(text);
      if (n === undefined || n < 0 || (n * 2) % 1) bad('Try "1", "1.5" or "not sure".');
      return { status: "PROVIDED", value: n!, updatedAt };
    }
    case "monthlyRent": {
      const n = typeof raw === "number" ? raw : parseMoney(text);
      if (n === undefined || n < 0) bad('Try "$2,200" or "don\'t list the price".');
      return { status: "PROVIDED", value: { amount: n!, currency: "USD" as const }, updatedAt };
    }
    case "availability": {
      const v = parseAvailability(text, now);
      if (!v) bad('Try "now", "October 15" or "not sure yet".');
      return { status: "PROVIDED", value: v!, updatedAt };
    }
    case "squareFeet": {
      const n = typeof raw === "number" ? raw : Number(/^~?\s*(\d[\d,]*)\s*(?:sq\.?\s*ft\.?|square feet|sf)?$/i.exec(text)?.[1]?.replace(/,/g, ""));
      if (!Number.isInteger(n) || n <= 0) bad('Try "900" or "900 sq ft".');
      return { status: "PROVIDED", value: n, updatedAt };
    }
    case "furnished": {
      const v = typeof raw === "boolean" ? raw : /^(yes|furnished|y|true)$/i.test(text) ? true : /^(no|unfurnished|n|false)$/i.test(text) ? false : undefined;
      if (v === undefined) bad('Try "furnished" or "unfurnished".');
      return { status: "PROVIDED", value: v!, updatedAt };
    }
    default: {
      if (!text) bad("Please say it in a few words.");
      return { status: "PROVIDED", value: text.slice(0, f === "features" ? 300 : f === "floor" ? 40 : 200), updatedAt };
    }
  }
}

// ---------------------------------------------------------------- bulk input

export interface BulkUnitDetails {
  /** Values found per unit name, as they'd be passed to parseProfileValue. */
  units: { unit: string; values: Partial<Record<ProfileField, string>> }[];
  /** Unit-like names mentioned that aren't units on file. */
  unknownUnits: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Reads a natural answer that covers several units at once, e.g. "1A and 1B
 * are 2 bed 1 bath for $2,200. 2A is 3 bed 2 bath for $2,800 and 2B is 2 bed
 * 2 bath for $2,500." Each value belongs to the unit (or group of units)
 * named just before it. Only values that are actually stated are returned.
 */
export function parseBulkUnitDetails(text: string, unitNames: string[]): BulkUnitDetails {
  const aliases = unitNames.flatMap((name) => {
    const short = name.replace(/^(unit|apt\.?|apartment|suite)\s+/i, "");
    return [...new Set([name, short])].map((alias) => ({ name, alias }));
  });
  aliases.sort((a, b) => b.alias.length - a.alias.length);
  const pattern = new RegExp(`(?<![A-Za-z0-9])(?:(?:unit|apt\\.?|apartment|suite)\\s+)?(${aliases.map((a) => escape(a.alias)).join("|")})(?![A-Za-z0-9])`, "gi");
  const mentions: { name: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(pattern)) {
    const alias = aliases.find((a) => a.alias.toLowerCase() === m[1]!.toLowerCase())!;
    mentions.push({ name: alias.name, start: m.index!, end: m.index! + m[0].length });
  }
  const groups: { names: string[]; end: number }[] = [];
  for (const m of mentions) {
    const last = groups.at(-1);
    if (last && /^\s*(,|&|and|,\s*and)\s*$/i.test(text.slice(last.end, m.start))) {
      last.names.push(m.name);
      last.end = m.end;
    } else groups.push({ names: [m.name], end: m.end });
  }
  const out = new Map<string, Partial<Record<ProfileField, string>>>();
  groups.forEach((g, i) => {
    const nextStart = mentions.find((m) => m.start >= g.end)?.start;
    const segment = text.slice(g.end, groups[i + 1] ? (nextStart ?? text.length) : text.length);
    const values = extractValues(segment);
    for (const name of g.names) out.set(name, { ...out.get(name), ...values });
  });
  const unknownUnits = [...text.matchAll(/\b(?:unit|apt\.?|apartment|suite)\s+([A-Za-z0-9-]+)/gi)].map((m) => m[1]!).filter((n) => !aliases.some((a) => a.alias.toLowerCase() === n.toLowerCase() || a.name.toLowerCase() === `unit ${n}`.toLowerCase()));
  return { units: [...out.entries()].filter(([, v]) => Object.keys(v).length).map(([unit, values]) => ({ unit, values })), unknownUnits: [...new Set(unknownUnits)] };
}

function extractValues(segment: string): Partial<Record<ProfileField, string>> {
  const s = segment.replace(/\s+/g, " ");
  const values: Partial<Record<ProfileField, string>> = {};
  const bed = /\b(\d+|one|two|three|four|five)\s*(?:-\s*)?(?:bed(?:room)?s?|br|bd)\b/i.exec(s) ?? (/\bstudio\b/i.test(s) ? ["studio", "studio"] : null);
  if (bed) values.bedrooms = bed[1] ?? bed[0];
  const bath = /\b(\d+(?:\.\d)?|one|two|three)\s*(?:-\s*)?(?:bath(?:room)?s?|ba)\b/i.exec(s);
  if (bath) values.bathrooms = bath[1]!;
  const rent = /\$\s?\d[\d,]*(?:\.\d{1,2})?\s*k?/i.exec(s) ?? /\b\d[\d,]{2,}(?:\.\d{1,2})?\s*(?:\/\s*mo(?:nth)?|a month|per month)\b/i.exec(s);
  if (rent) values.monthlyRent = rent[0].replace(/\s*(\/\s*mo(nth)?|a month|per month)$/i, "").trim();
  const sqft = /\b(\d[\d,]*)\s*(?:sq\.?\s*ft\.?|square feet|sf)\b/i.exec(s);
  if (sqft) values.squareFeet = sqft[1]!;
  const avail = /\bavailable\s+(now|immediately|right away|(?:on\s+)?[a-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?|\d{4}-\d{2}-\d{2})/i.exec(s);
  if (avail) values.availability = avail[1]!;
  if (/\b(?:availability|available)\b[^.,;]{0,20}\b(?:not sure|unknown|tbd|don'?t know)\b/i.test(s)) values.availability = "not sure";
  if (/\b(?:don'?t|do not) list the (?:price|rent)\b/i.test(s)) values.monthlyRent = "don't list the price";
  return values;
}

const TOPICS: [ProfileField, RegExp][] = [
  ["bedrooms", /\b(bed(room)?s?|br|studio)\b/i],
  ["bathrooms", /\bbath(room)?s?\b/i],
  ["monthlyRent", /\b(rent|price|cost|costs|how much|per month|monthly)\b/i],
  ["availability", /\b(availab\w*|move[\s-]?in|vacant|when can i)\b/i],
  ["squareFeet", /\b(square f(ee|oo)t|sq\.?\s*ft|how big|size)\b/i],
  ["parking", /\b(parking|park|garage)\b/i],
  ["laundry", /\b(laundry|washer|dryer)\b/i],
  ["pets", /\b(pets?|dogs?|cats?)\b/i],
  ["utilities", /\butilit(y|ies)\b/i],
  ["furnished", /\bfurnish(ed)?\b/i],
  ["floor", /\b(what floor|which floor|floor is)\b/i],
];

/** Which unit detail a visitor's question is about, if it's clearly one. */
export function questionTopic(question: string): ProfileField | undefined {
  const hits = TOPICS.filter(([, re]) => re.test(question)).map(([f]) => f);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * The operator's answer to a question about one unit detail, as a structured
 * value ("2 bedrooms", "Unit 1A has 2 bedrooms", "$2,200", "available Oct 15"),
 * or undefined when it isn't clearly that value (then it's kept as their own
 * words instead).
 */
export function structuredAnswer(field: ProfileField, answer: string, now = new Date()): NonNullable<UnitProfile[ProfileField]> | undefined {
  const candidates = [answer.trim().replace(/[.!]$/, "")];
  const extracted = extractValues(answer)[field];
  if (extracted) candidates.push(extracted);
  for (const c of candidates) {
    try {
      const v = parseProfileValue(field, c, now);
      if (v.status !== "PROVIDED") continue;
      if (field === "availability" && !(v.value as { now?: boolean; date?: string }).now && !(v.value as { date?: string }).date) continue;
      if ((["bedrooms", "bathrooms", "monthlyRent", "availability", "squareFeet"] as ProfileField[]).includes(field)) return v;
    } catch {
      // Not this form; try the next.
    }
  }
  return undefined;
}

/** "When are these units available?" — the one question for what's still missing, or undefined when nothing is. */
export function nextProfileQuestion(units: UnitLike[]): { question: string; field: ProfileField; units: string[] } | undefined {
  for (const f of REQUIRED_PROFILE_FIELDS) {
    const missing = units.filter((u) => !u.profile?.[f]).map((u) => u.name);
    if (!missing.length) continue;
    const which = missing.length === units.length ? (units.length === 1 ? units[0]!.name : "these units") : missing.join(", ");
    const plural = missing.length > 1;
    const question = {
      bedrooms: `How many bedrooms ${plural ? "do" : "does"} ${which} have?`,
      bathrooms: `How many bathrooms ${plural ? "do" : "does"} ${which} have?`,
      monthlyRent: `What's the monthly rent for ${which}?`,
      availability: `When ${plural ? "are" : "is"} ${which} available?`,
    }[f];
    return { question, field: f, units: missing };
  }
  return undefined;
}
