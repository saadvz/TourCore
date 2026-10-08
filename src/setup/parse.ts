import { canonicalTimeZone, hostTimeZone, type Weekday } from "../core/timezone";

/**
 * Turns everyday answers ("Mon-Fri", "9am", "an hour", "Eastern") into config
 * values. Shared by every setup surface (terminal now, Grok Bot later).
 * Each returns undefined when it can't understand the answer.
 */

const WEEK: Weekday[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

const DAY_NAMES: Record<string, Weekday> = {
  mon: "MON", monday: "MON",
  tue: "TUE", tues: "TUE", tuesday: "TUE",
  wed: "WED", weds: "WED", wednesday: "WED",
  thu: "THU", thur: "THU", thurs: "THU", thursday: "THU",
  fri: "FRI", friday: "FRI",
  sat: "SAT", saturday: "SAT",
  sun: "SUN", sunday: "SUN",
};

export function parseDays(input: string): Weekday[] | undefined {
  const text = input.toLowerCase().trim().replace(/\.$/, "");
  if (/^(every ?day|daily|all week|7 days( a week)?)$/.test(text)) return [...WEEK];
  if (/^week ?days$/.test(text)) return WEEK.slice(0, 5);
  if (/^week ?ends$/.test(text)) return WEEK.slice(5);

  const tokens = text.split(/[\s,;&+]+/).filter((token) => token && token !== "and" && token !== "plus");
  const days = new Set<Weekday>();
  const addRange = (from: Weekday, to: Weekday) => {
    for (let i = WEEK.indexOf(from); ; i = (i + 1) % 7) {
      days.add(WEEK[i]!);
      if (WEEK[i] === to) break;
    }
  };
  let last: Weekday | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "to" || token === "through" || token === "thru" || token === "-" || token === "\u2013") {
      const end = DAY_NAMES[tokens[++i] ?? ""];
      if (!last || !end) return undefined;
      addRange(last, end);
      last = end;
      continue;
    }
    const hyphen = token.split(/[-\u2013]/);
    if (hyphen.length === 2) {
      const from = DAY_NAMES[hyphen[0]!];
      const to = DAY_NAMES[hyphen[1]!];
      if (!from || !to) return undefined;
      addRange(from, to);
      last = to;
      continue;
    }
    const day = DAY_NAMES[token];
    if (!day) return undefined;
    days.add(day);
    last = day;
  }
  return days.size ? WEEK.filter((d) => days.has(d)) : undefined;
}

export const SAME_DAY_HOURS = "Tour hours have to end later the same day. What time should tours end?";

/** True when the end clock is later on the same day. An earlier end is overnight. */
export function tourHoursEndSameDay(start: string, end: string): boolean {
  return end > start;
}

/** "9am" | "9:30 PM" | "17:00" | "noon" -> "HH:MM". Bare 1-7 is read as afternoon. */
export function parseTimeOfDay(input: string): string | undefined {
  const text = input.toLowerCase().replace(/\./g, "").trim();
  if (text === "noon") return "12:00";
  if (text === "midnight") return "00:00";
  const m = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3];
  if (minute > 59) return undefined;
  if (ampm) {
    if (hour < 1 || hour > 12) return undefined;
    if (ampm.startsWith("p") && hour !== 12) hour += 12;
    if (ampm.startsWith("a") && hour === 12) hour = 0;
  } else {
    if (hour > 23) return undefined;
    if (!m[2] && hour >= 1 && hour <= 7) hour += 12;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "45" | "45 min" | "1 hour" | "1.5 hours" | "an hour" -> minutes. */
export function parseMinutes(input: string): number | undefined {
  const text = input.toLowerCase().trim().replace(/^(an?|one)\s+(hour|hr)s?$/, "1 hour");
  const m = text.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const minutes = m[2]?.startsWith("h") ? n * 60 : n;
  return Number.isFinite(minutes) ? Math.round(minutes) : undefined;
}

/** "1, 3" | "1 3" | "1 then 3" -> zero-based indexes, in order. */
export function parseChoiceList(input: string, count: number): number[] | undefined {
  const parts = input.toLowerCase().split(/\s*(?:,|then|and|->|>|\s)\s*/).filter(Boolean);
  if (!parts.length) return undefined;
  const picks = parts.map(Number);
  if (picks.some((n) => !Number.isInteger(n) || n < 1 || n > count)) return undefined;
  if (new Set(picks).size !== picks.length) return undefined;
  return picks.map((n) => n - 1);
}

const ZONE_ALIASES: Record<string, string> = {
  eastern: "America/New_York", et: "America/New_York", est: "America/New_York", edt: "America/New_York",
  central: "America/Chicago", ct: "America/Chicago", cst: "America/Chicago", cdt: "America/Chicago",
  mountain: "America/Denver", mt: "America/Denver", mst: "America/Denver", mdt: "America/Denver",
  arizona: "America/Phoenix",
  pacific: "America/Los_Angeles", pt: "America/Los_Angeles", pst: "America/Los_Angeles", pdt: "America/Los_Angeles",
  alaska: "America/Anchorage", hawaii: "Pacific/Honolulu",
  utc: "UTC", gmt: "UTC",
};

/** "Eastern" | "ET" | "america/new_york" -> canonical IANA zone. */
export function resolveTimeZone(input: string): string | undefined {
  const text = input.trim();
  const alias = ZONE_ALIASES[text.toLowerCase().replace(/\s+(standard\s+|daylight\s+)?time$/, "")];
  return alias ?? canonicalTimeZone(text.replace(/\s+/g, "_"));
}

const STATE_ZONES: Record<string, string> = {};
const zone = (tz: string, codes: string) => codes.split(" ").forEach((c) => (STATE_ZONES[c] = tz));
zone("America/New_York", "CT DE DC FL GA IN KY ME MD MA MI NH NJ NY NC OH PA RI SC VT VA WV");
zone("America/Chicago", "AL AR IL IA KS LA MN MS MO NE ND OK SD TN TX WI");
zone("America/Denver", "CO ID MT NM UT WY");
zone("America/Phoenix", "AZ");
zone("America/Los_Angeles", "CA NV OR WA");
zone("America/Anchorage", "AK");
zone("Pacific/Honolulu", "HI");

const STATE_NAMES: Record<string, string> = {
  "new york": "NY", "new jersey": "NJ", massachusetts: "MA", pennsylvania: "PA", florida: "FL", georgia: "GA",
  "north carolina": "NC", "south carolina": "SC", virginia: "VA", maryland: "MD", ohio: "OH", michigan: "MI",
  connecticut: "CT", illinois: "IL", texas: "TX", tennessee: "TN", minnesota: "MN", wisconsin: "WI", missouri: "MO",
  louisiana: "LA", colorado: "CO", utah: "UT", arizona: "AZ", california: "CA", oregon: "OR", washington: "WA",
  nevada: "NV", alaska: "AK", hawaii: "HI",
};

/** Best guess from the address; falls back to this computer's zone. Always confirm with the operator. */
export function inferTimeZone(address: string): { timezone: string; basis: "address" | "computer" } {
  const upper = address.toUpperCase();
  const code = upper.match(/(?:,|\s)\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,\s*(?:USA|US|UNITED STATES))?\s*$/)?.[1];
  if (code && STATE_ZONES[code]) return { timezone: STATE_ZONES[code]!, basis: "address" };
  const lower = address.toLowerCase();
  for (const [name, abbr] of Object.entries(STATE_NAMES)) {
    if (lower.includes(name) && STATE_ZONES[abbr]) return { timezone: STATE_ZONES[abbr]!, basis: "address" };
  }
  return { timezone: hostTimeZone(), basis: "computer" };
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}
