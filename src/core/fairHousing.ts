/**
 * Fair-housing questions are detected here, from a fixed list, before any
 * rent sentence, keyword match, or saved answer. The list is not a playbook.
 * A match is eligibility language plus a protected class, a housing subsidy,
 * or a phrase that is fair housing on its own. "How much is rent?" has
 * neither a class nor an eligibility phrase, so it stays a rent question.
 * "Do you allow pets?" and "Is there a minimum lease?" do not match.
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

const PROTECTED_CLASS =
  /\b(?:families|family|familial status|kids?|children|child|section\s*8|vouchers?|single (?:moms?|mothers?|dads?|fathers?|parents?)|race|racial|people of color|color|religion|religious|national origin|nationality|country of origin|sex|gender|disabilities|disability|disabled|handicapped|handicap|ages?|elderly|seniors?|pregnant|pregnancy|newborns?|immigrants?)\b/;

/** Eligibility phrasing. A bare "rent" or "monthly" is not enough. */
const ELIGIBILITY =
  /\b(?:rent(?:s|ing)?\s+to|allowed|allow(?:s|ing)?|accept(?:s|ed|ing)?|(?:okay|ok|fine)\s+with|live(?:s|ing)?\s+(?:there|here|in)|welcom(?:e|es|ing)|discriminat(?:e|es|ed|ing|ion)|qualif(?:y|ies|ied))\b/;

const HOUSING_SUBSIDY = /\b(?:section\s*8|vouchers?)\b/;
const SUBSIDY_TAKE = /\b(?:take|takes|taking|consider|considers|considering)\b/;

/**
 * Fair housing even with no eligibility verb. A bare "pets", "dogs", or
 * "minimum" is not enough, so an ordinary pets question, a dog park, and a
 * minimum lease stay put. Assistance animals include dog, cat, and pet, and
 * emotional support is any following word. Matching is on the lowercased text.
 */
const ASSISTANCE_ANIMAL =
  /\b(?:(?:service|assistance|support|guide|seeing eye) (?:dogs?|animals?|cats?|pets?)|emotional support \w+|esas?)\b/;

const STANDALONE =
  /\b(?:pregnant|pregnancy|newborns?|baby(?:s)? on the way|adults only|immigrants?|immigration status|minimum age|age limits?|age restrictions?|55 and over|senior community|housing assistance|housing vouchers?|section\s*8|hud|undocumented|sexual orientation|gender identity|gays?|lesbians?|lgbtq?|same sex couples?|transgender|religions?|religious|discriminat(?:e|es|ed|ing|ion))\b/;

/** "55+" loses the plus when punctuation is stripped, so it is checked on the raw text. */
const FIFTY_FIVE_PLUS = /55\s*\+/;

export function isFairHousingQuestion(text: string): boolean {
  if (FIFTY_FIVE_PLUS.test(text.toLowerCase())) return true;
  const t = norm(text);
  if (!t) return false;
  if (ASSISTANCE_ANIMAL.test(t) || STANDALONE.test(t)) return true;
  if (!PROTECTED_CLASS.test(t)) return false;
  if (ELIGIBILITY.test(t)) return true;
  return HOUSING_SUBSIDY.test(t) && SUBSIDY_TAKE.test(t);
}
