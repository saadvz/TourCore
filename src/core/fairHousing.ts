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
 * Fair housing even with no eligibility verb. "support" or "minimum" alone
 * is not enough, so an ordinary pets question and a minimum lease stay put.
 */
const STANDALONE =
  /\b(?:service animals?|assistance animals?|support animals?|emotional support (?:animals?|dogs?|cats?)|esas?|pregnant|pregnancy|newborns?|baby(?:s)? on the way|adults only|immigrants?|immigration status|minimum age|age limits?|discriminat(?:e|es|ed|ing|ion))\b/;

export function isFairHousingQuestion(text: string): boolean {
  const t = norm(text);
  if (!t) return false;
  if (STANDALONE.test(t)) return true;
  if (!PROTECTED_CLASS.test(t)) return false;
  if (ELIGIBILITY.test(t)) return true;
  return HOUSING_SUBSIDY.test(t) && SUBSIDY_TAKE.test(t);
}
