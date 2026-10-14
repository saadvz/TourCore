import { isMedicalEmergency } from "../intent";

const INJURY_FORM =
  /\b(?:hurting|hurts|hurt|injuring|injuries|injury|injured|bleeding|bleeds|bled|blood|falling|fallen|falls|fell|fall)\b/i;

export function isInjuryReport(text: string): boolean {
  return INJURY_FORM.test(text) || isMedicalEmergency(text);
}
