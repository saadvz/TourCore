/** Minimal E.164-ish normalization; good enough for a US demo. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

/** A full phone number: 10–15 digits. Same bar as other visitor phone fields. */
export function parsePhone(raw: string): string | undefined {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return undefined;
  return normalizePhone(raw);
}

/** Casual US formatting for visitor-facing texts. Other numbers stay as stored. */
export function formatPhone(e164: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : e164;
}

/** True when the text is only a phone number, so it must not be shown as a place. */
export function looksLikePhone(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return false;
  return /^[+\d\s().-]+$/.test(trimmed);
}

/** ` near {place}` for a help record, or nothing when the place is missing or is a phone number. */
export function helpNear(detail: string | undefined): string {
  const place = detail?.trim() ?? "";
  if (!place || looksLikePhone(place)) return "";
  return ` near ${place}`;
}
