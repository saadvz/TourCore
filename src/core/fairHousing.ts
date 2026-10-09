/**
 * Fair-housing questions are detected here, before any rent sentence, keyword
 * match, or saved answer. The list is not a playbook. A match is eligibility
 * language plus a protected class, a housing subsidy, a phrase that is fair
 * housing on its own, or neighborhood composition / steering. "How much is
 * rent?" has neither a class nor an eligibility phrase, so it stays a rent
 * question. "Do you allow pets?" and "Is there a minimum lease?" do not match.
 * A church, parking, or a playground nearby, room for kids' bikes, how many
 * bedrooms, and whether the building is quiet do not match either.
 */

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[-/]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Audit code on a flagged fair-housing question. No draft is proposed. */
export const FAIR_HOUSING_CODE = "FAIR_HOUSING";

/**
 * One list for eligibility and suitability. Suitability used to keep a second
 * copy, which dropped newborns and immigrants. Toddlers, babies, infants,
 * teens, retirees, older people, blind, deaf, and wheelchair belong here too.
 */
const PROTECTED_INNER = [
  "familial status",
  "people of color",
  "national origin",
  "country of origin",
  "older people",
  "single (?:moms?|mothers?|dads?|fathers?|parents?)",
  "section\\s*8",
  "teenagers?",
  "newborns?",
  "toddlers?",
  "infants?",
  "wheelchairs?",
  "disabilities",
  "disability",
  "handicapped",
  "handicap",
  "families",
  "family",
  "children",
  "babies",
  "baby",
  "child",
  "retirees",
  "elderly",
  "seniors?",
  "teens?",
  "kids?",
  "vouchers?",
  "disabled",
  "pregnant",
  "pregnancy",
  "immigrants?",
  "nationality",
  "religious",
  "religion",
  "racial",
  "race",
  "color",
  "gender",
  "blind",
  "deaf",
  "ages?",
  "sex",
].join("|");

const PROTECTED_CLASS = new RegExp(`\\b(?:${PROTECTED_INNER})\\b`);

/** Eligibility phrasing. A bare "rent" or "monthly" is not enough. */
const ELIGIBILITY =
  /\b(?:rent(?:s|ing)?\s+to|allowed|allow(?:s|ing)?|accept(?:s|ed|ing)?|(?:okay|ok|fine)\s+with|live(?:s|ing)?\s+(?:there|here|in)|welcom(?:e|es|ing)|discriminat(?:e|es|ed|ing|ion)|qualif(?:y|ies|ied))\b/;

const HOUSING_SUBSIDY = /\b(?:section\s*8|vouchers?)\b/;
const SUBSIDY_TAKE = /\b(?:take|takes|taking|consider|considers|considering)\b/;

/**
 * Suitability for a protected class: "good for families", "a good place for
 * kids", "accessible for a wheelchair", "family friendly", "is the building
 * for families", "good for raising a family", "a family building". After
 * "for", a determiner or adjective may come first, and any words may follow
 * the class, including another sentence. "Good for a family car" does not
 * match, because the next word is car. The same for room, size, style,
 * offenders, and neutral. "Good for ages 20-30" does: age is a protected
 * class. A home office, parking, or pets is not a class.
 */
const FRIENDLY = /\b(?:family|kid|child) friendly\b/;
const FAMILY_BUILDING = /\bfamily buildings?\b/;
const SUITABILITY_LEAD =
  /\b(?:good (?:place|home|area|neighborhood) for|(?:good|suitable|right|okay|ok|safe|fit|accessible) for|a fit for|raising)\b/g;
const SUITABILITY_PLACE =
  /\b(?:is|are) the (?:area|neighborhood|building|property|block)\b(?: \w+){0,6} for\b/g;
const SUITABILITY_PREFIX =
  /^(?:someone who is|a|an|the|my|our|your|their|young|small|little|large|growing|elderly|older|single|disabled|raising)\s+/;
/** The class word only modifies this thing. It is not a question about the class. */
const CLASS_STOP = /^\s+(?:car|room|size|style|offenders|neutral)\b/;

/**
 * Fair housing even with no eligibility verb. A bare "pets", "dogs", or
 * "minimum" is not enough, so an ordinary pets question, a dog park, and a
 * minimum lease stay put. Assistance animals include dog, cat, and pet, and
 * emotional support is any following word. A therapy dog or animal is the same
 * kind of question. Matching is on the lowercased text.
 */
const ASSISTANCE_ANIMAL =
  /\b(?:(?:service|assistance|support|guide|seeing eye|therapy) (?:dogs?|animals?|cats?|pets?)|emotional support \w+|esas?)\b/;

/**
 * Faith and creed names, including plurals. Place words such as church,
 * temple, and mosque are not names, so "Is there a church nearby?" stays out.
 */
const FAITH =
  /\b(?:christians?|catholics?|protestants?|jewish|jews?|muslims?|islamic|hindus?|buddhists?|sikhs?|mormons?|atheists?)\b/;

/** A social security number is tied to immigration and national origin. */
const SSN = /\b(?:ssns?|social security(?: numbers?)?)\b/;

const STANDALONE =
  /\b(?:pregnant|pregnancy|newborns?|baby(?:s)? on the way|adults only|immigrants?|immigration status|minimum age|age limits?|age restrictions?|55 and over|senior community|housing assistance|housing vouchers?|section\s*8|hud|undocumented|sexual orientation|gender identity|gays?|lesbians?|lgbtq?|same sex couples?|transgender|religions?|religious|discriminat(?:e|es|ed|ing|ion))\b/;

/** "55+" loses the plus when punctuation is stripped, so it is checked on the raw text. */
const FIFTY_FIVE_PLUS = /55\s*\+/;

/**
 * People words that can pair with an area phrase. Race plurals count as
 * people. A singular race word or "color" does not, unless it sits beside
 * one of these.
 */
const PEOPLE_BESIDE =
  /\b(?:people|families|family|folks|residents|neighbors|tenants|kids|children|child|hispanics|latinos|latinas|asians|blacks|whites|arabs)\b/;

/**
 * Race, ethnicity, or color. Quantity phrases count these only beside a
 * people word. Place phrases count them on their own.
 */
const RACE_OR_COLOR = /\b(?:hispanic|latino|latina|asian|black|white|arab|color)\b/;

/** How many. A race or color word counts here only beside a people word. */
const QUANTITY = /\b(?:many|a lot of|lots of)\b/;

/** Where, or what the place is like. A race or color word counts on its own. */
const PLACE =
  /\b(?:mostly|around here|in the area|neighborhood|nearby|on the block|in the building)\b/;

/**
 * Things a race or color word can describe without being about people.
 * "Asian restaurants", "white picket fence", "Black Friday", "color of the doors".
 */
const OBJECT_NOUN =
  /\b(?:foods?|restaurants?|stores?|markets?|grocer(?:y|ies)|shops?|cafes?|baker(?:y|ies)|cuisines?|dishes?|meals?|fences?|doors?|walls?|paints?|fridays?|sales?|kitchens?|trim|siding|carpets?|tiles?|cabinets?|floors?|ceilings?|roofs?|appliances?|counters?|windows?|blinds?)\b/;

const OBJECT_FILLER = "(?:picket|painted|front|back|garage|exterior|interior|local|nearby|the|a|an|some|any)";

/** Other area language. Pairs with a class, a faith, or a people word. */
const OTHER_AREA = /\b(?:neighbors|lives? around|any other)\b/;

/** Steering even with no class word beside it. */
const STEERING =
  /\b(?:what kind of people|what type of people|who lives (?:there|here|in the building|nearby)|is the (?:neighborhood|area) safe|safe neighborhood|safe area|crime rate|good neighborhood|bad neighborhood)\b/;

function spans(re: RegExp, text: string): Array<{ start: number; end: number }> {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  return [...text.matchAll(new RegExp(re.source, flags))].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/** True when the two words have only whitespace between them. */
function beside(text: string, a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  const left = a.end <= b.start ? a : b;
  const right = left === a ? b : a;
  if (left.end > right.start) return false;
  return /^\s*$/.test(text.slice(left.end, right.start));
}

/**
 * Neighborhood composition or steering. A protected class, a faith, or a
 * people word together with an area phrase. A bare "color" span is not a
 * neighborhood class (eligibility still sees it). Quantity phrases count a
 * race or color word only beside a people word. Place phrases count a race
 * or color word on their own, unless that word directly modifies a non-people
 * noun (a restaurant, a fence, a door, Friday). Wall color and "lots of light"
 * stay ordinary. Standalone steering phrases match on their own.
 */
function modifiesNonPeopleNoun(text: string, word: { start: number; end: number }): boolean {
  const after = text.slice(word.end);
  if (/^\s+(?:people|families|family|folks|residents|neighbors|tenants|kids|children|child|hispanics|latinos|latinas|asians|blacks|whites|arabs)\b/.test(after)) {
    return false;
  }
  if (new RegExp(`^\\s+${OBJECT_FILLER}\\s+${OBJECT_NOUN.source}`, "i").test(after)) return true;
  if (new RegExp(`^\\s+${OBJECT_NOUN.source}`, "i").test(after)) return true;
  const before = text.slice(0, word.start);
  if (new RegExp(`${OBJECT_NOUN.source}\\s+(?:are|is|was|were)\\s+$`, "i").test(before)) return true;
  if (new RegExp(`(?:are|is)\\s+(?:the\\s+)?${OBJECT_NOUN.source}\\s+$`, "i").test(before)) return true;
  if (/\b(?:what|which)\s+$/.test(before) && new RegExp(`^\\s+(?:are|is)\\s+(?:the\\s+)?${OBJECT_NOUN.source}`, "i").test(after)) return true;
  return false;
}

function neighborhoodSteering(text: string): boolean {
  if (STEERING.test(text)) return true;
  const people = spans(PEOPLE_BESIDE, text);
  const race = spans(RACE_OR_COLOR, text);
  const raceBesidePeople = race.filter((word) => people.some((person) => beside(text, word, person)));
  const protectedSpans = spans(PROTECTED_CLASS, text).filter((word) => text.slice(word.start, word.end) !== "color");
  const classes = [...protectedSpans, ...spans(FAITH, text), ...people, ...raceBesidePeople];
  const areas = [...spans(QUANTITY, text), ...spans(PLACE, text), ...spans(OTHER_AREA, text)];
  if (classes.some((word) => areas.some((area) => !overlaps(word, area)))) return true;
  const places = spans(PLACE, text);
  const placeRace = race.filter((word) => !modifiesNonPeopleNoun(text, word));
  return placeRace.some((word) => places.some((place) => !overlaps(word, place)));
}

/**
 * A protected class after optional determiners or adjectives. Any text may
 * follow that class. A class word directly before car, room, size, style,
 * offenders, or neutral is not the class ("family car", "family room",
 * "family-style", "sex offenders", "gender neutral").
 */
function classFollowsFor(after: string): boolean {
  let rest = after.trimStart();
  for (let i = 0; i < 8 && rest; i++) {
    const match = new RegExp(`^(?:${PROTECTED_INNER})\\b`).exec(rest);
    if (match) return !CLASS_STOP.test(rest.slice(match[0].length));
    const prefix = SUITABILITY_PREFIX.exec(rest);
    if (!prefix) return false;
    rest = rest.slice(prefix[0].length);
  }
  return false;
}

/** "Family car" and "sex offenders" are not the protected class. */
function withoutNonPeopleUse(text: string): string {
  return text.replace(new RegExp(`\\b(?:${PROTECTED_INNER})\\s+(?:car|room|size|style|offenders|neutral)\\b`, "g"), "item");
}

function leadThenClass(text: string, lead: RegExp): boolean {
  const flags = lead.flags.includes("g") ? lead.flags : `${lead.flags}g`;
  for (const match of text.matchAll(new RegExp(lead.source, flags))) {
    const after = text.slice((match.index ?? 0) + match[0].length).trimStart();
    if (classFollowsFor(after)) return true;
  }
  return false;
}

function suitabilityForClass(text: string): boolean {
  if (FRIENDLY.test(text) || FAMILY_BUILDING.test(text)) return true;
  return leadThenClass(text, SUITABILITY_LEAD) || leadThenClass(text, SUITABILITY_PLACE);
}

export function isFairHousingQuestion(text: string): boolean {
  if (FIFTY_FIVE_PLUS.test(text.toLowerCase())) return true;
  const t = withoutNonPeopleUse(norm(text));
  if (!t) return false;
  if (ASSISTANCE_ANIMAL.test(t) || FAITH.test(t) || SSN.test(t) || STANDALONE.test(t)) return true;
  if (neighborhoodSteering(t)) return true;
  if (suitabilityForClass(t)) return true;
  if (!PROTECTED_CLASS.test(t)) return false;
  if (ELIGIBILITY.test(t)) return true;
  return HOUSING_SUBSIDY.test(t) && SUBSIDY_TAKE.test(t);
}
