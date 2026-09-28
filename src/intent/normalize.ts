/**
 * Folds the ways people type the same thing into one form: case, curly
 * apostrophes, punctuation, emoji, contractions and spacing. "I’m HERE!!" and
 * "im here" both become "i am here".
 */

const CONTRACTIONS: [RegExp, string][] = [
  [/\bi'?m\b/g, "i am"],
  [/\bwe're\b/g, "we are"],
  [/\byou're\b/g, "you are"],
  [/\bi'?ve\b/g, "i have"],
  [/\bwe've\b/g, "we have"],
  [/\bi'll\b/g, "i will"],
  [/\bwe'll\b/g, "we will"],
  [/\bi'd\b/g, "i would"],
  [/\bthat'?d\b/g, "that would"],
  [/\bit'?d\b/g, "it would"],
  [/\bthat'?s\b/g, "that is"],
  [/\bit's\b/g, "it is"],
  [/\bwhat'?s\b/g, "what is"],
  [/\bwhere'?s\b/g, "where is"],
  [/\bthere'?s\b/g, "there is"],
  [/\bhow'?s\b/g, "how is"],
  [/\blet'?s\b/g, "let us"],
  [/\bcan'?t\b/g, "cannot"],
  [/\bwon'?t\b/g, "will not"],
  [/\bdon'?t\b/g, "do not"],
  [/\bdoesn'?t\b/g, "does not"],
  [/\bdidn'?t\b/g, "did not"],
  [/\bisn'?t\b/g, "is not"],
  [/\baren'?t\b/g, "are not"],
  [/\bwouldn'?t\b/g, "would not"],
  [/\bcouldn'?t\b/g, "could not"],
  [/\bain'?t\b/g, "is not"],
  [/\bwanna\b/g, "want to"],
  [/\bgonna\b/g, "going to"],
  [/\blemme\b/g, "let me"],
  [/\bgotta\b/g, "have to"],
  [/\bu\b/g, "you"],
  [/\bur\b/g, "your"],
  [/\b(pls|plz|plez)\b/g, "please"],
  [/\b(thx|ty|tysm)\b/g, "thanks"],
];

export function normalize(text: string): string {
  let t = text
    .normalize("NFKC")
    .replace(/[\u{1F44D}\u{1F44C}\u2705\u2714]/gu, " yes ")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc\u0060\u00b4]/g, "'")
    .replace(/(\d)\.(\d{2})\b/g, "$1:$2")
    .replace(/[^a-z0-9':#\s]/g, " ")
    .replace(/(?<!\d):|:(?!\d)/g, " ")
    .replace(/(^|\s)'+|'+(?=\s|$)/g, "$1");
  for (const [pattern, replacement] of CONTRACTIONS) t = t.replace(pattern, replacement);
  return t.replace(/\s+/g, " ").trim();
}

const LEADING_FILLER = /^(ok|okay|k|hey|hi|hello|yo|so|um+|uh+|well|alright|all right|oh|and|thanks|thank you|hey there|hi there|great|cool)\s+/;
const TRAILING_FILLER = /\s+(thanks|thank you|now|lol|haha|bye|goodbye|cheers|thx)$/;

/** Drops conversational padding at either end ("ok so i am here now thanks" -> "i am here"). Never empties a message. */
export function stripFiller(t: string): string {
  let out = t;
  for (let i = 0; i < 4; i++) {
    const next = out.replace(LEADING_FILLER, "").replace(TRAILING_FILLER, "");
    if (next === out || !next) break;
    out = next;
  }
  return out;
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ORDINALS: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5 };

export function numberWord(word: string): number | undefined {
  if (/^#?\d{1,2}$/.test(word)) return Number(word.replace("#", ""));
  return NUMBER_WORDS[word] ?? ORDINALS[word];
}

export function ordinalWord(word: string): number | undefined {
  return ORDINALS[word];
}
