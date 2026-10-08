import { normalize, stripFiller } from "./normalize";

const WEEKDAY =
  /\b(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|thurs|thur|tues|mon|tue|wed|thu|fri|sat|sun)\b/;
const NAMED_DAY = /\b(?:today|tomorrow|tonight)\b/;

/**
 * A general ask for when tours run, with no weekday and no specific day.
 * "is Friday open?" stays on the day-menu rules and is not this.
 */
/** The whole message is today or tonight, so it means today's remaining times. */
export function isBareTodayOrTonight(raw: string): boolean {
  const t = stripFiller(normalize(raw));
  return t === "today" || t === "tonight";
}

export function isGeneralTourHoursQuestion(raw: string): boolean {
  const t = stripFiller(normalize(raw));
  if (!t || WEEKDAY.test(t) || NAMED_DAY.test(t)) return false;
  if (/\bwhen can (i|we) tour\b/.test(t)) return true;
  if (/\bwhat (are|is) (your|the) tour times\b/.test(t)) return true;
  if (/\bwhat hours do you do tours\b/.test(t)) return true;
  if (/\btour hours\b/.test(t)) return true;
  if (/\bwhat (are|is) (your|the) (tour )?hours\b/.test(t)) return true;
  return false;
}
