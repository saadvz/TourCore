import { parsePhone } from "../core/phone";

/**
 * Numbers this demo is allowed to text.
 * Area code 555 is not a real US area code. 555-0100 through 555-0199 is the
 * fictional exchange block. Anything else is refused, flag on or off.
 */
export function isScratchTestNumber(raw: string): boolean {
  const e164 = parsePhone(raw);
  if (!e164?.startsWith("+1")) return false;
  const national = e164.slice(2);
  if (national.length !== 10) return false;
  const area = national.slice(0, 3);
  const exchange = national.slice(3, 6);
  const line = Number(national.slice(6));
  if (area === "555") return true;
  return exchange === "555" && line >= 100 && line <= 199;
}
