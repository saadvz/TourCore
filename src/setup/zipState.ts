import { spokenStateName } from "./address";

/**
 * Inclusive ZIP3 ranges. A prefix that is not listed is not checked.
 * A listed prefix belongs to that state; a different state is a mismatch.
 * Ranges are the USPS allocations, with no network lookup.
 */
const ZIP3: Array<[number, number, string]> = [
  [5, 5, "NY"],
  [6, 9, "PR"],
  [10, 27, "MA"],
  [28, 29, "RI"],
  [30, 38, "NH"],
  [39, 49, "ME"],
  [50, 59, "VT"],
  [60, 69, "CT"],
  [70, 89, "NJ"],
  [100, 149, "NY"],
  [150, 196, "PA"],
  [197, 199, "DE"],
  [200, 205, "DC"],
  [206, 219, "MD"],
  [220, 246, "VA"],
  [247, 268, "WV"],
  [270, 289, "NC"],
  [290, 299, "SC"],
  [300, 319, "GA"],
  [320, 349, "FL"],
  [350, 369, "AL"],
  [370, 385, "TN"],
  [386, 397, "MS"],
  [398, 399, "GA"],
  [400, 427, "KY"],
  [430, 459, "OH"],
  [460, 479, "IN"],
  [480, 499, "MI"],
  [500, 528, "IA"],
  [530, 549, "WI"],
  [550, 567, "MN"],
  [570, 577, "SD"],
  [580, 588, "ND"],
  [590, 599, "MT"],
  [600, 629, "IL"],
  [630, 658, "MO"],
  [660, 679, "KS"],
  [680, 693, "NE"],
  [700, 714, "LA"],
  [716, 729, "AR"],
  [730, 749, "OK"],
  [750, 799, "TX"],
  [800, 816, "CO"],
  [820, 831, "WY"],
  [832, 838, "ID"],
  [840, 847, "UT"],
  [850, 865, "AZ"],
  [870, 884, "NM"],
  [885, 885, "TX"],
  [889, 898, "NV"],
  [900, 961, "CA"],
  [967, 968, "HI"],
  [970, 979, "OR"],
  [980, 994, "WA"],
  [995, 999, "AK"],
];

/** The state a five-digit ZIP belongs to, or undefined when the prefix is not allocated here. */
export function stateForZip(zip: string): string | undefined {
  const prefix = Number(zip.slice(0, 3));
  if (!Number.isInteger(prefix)) return undefined;
  for (const [from, to, state] of ZIP3) {
    if (prefix >= from && prefix <= to) return state;
  }
  return undefined;
}

/** The question when a ZIP and state were both entered and they disagree. Undefined when they match or the prefix is unknown. */
export function zipStateMismatchQuestion(state: string, zip: string): string | undefined {
  const owner = stateForZip(zip);
  if (!owner || owner === state) return undefined;
  return `That ZIP doesn't look like it's in ${spokenStateName(state)}. Which one should I fix, the ZIP or the state?`;
}
