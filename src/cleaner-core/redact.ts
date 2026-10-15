/** One redaction layer for logs, metrics, backups, replay output, and evidence. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4 || !out.includes(secret)) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** Last four digits only. The full number never goes into a log or metric. */
export function redactPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `***${digits.slice(-4)}`;
}

export function redactCalendarUrl(text: string): string {
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[calendar]");
}

export function redactLine(text: string, secrets: readonly string[]): string {
  return redactCalendarUrl(redactSecrets(text, secrets));
}

/**
 * True when `code` stands on its own in `text`: no letter, digit, `_`, or `-` right before or after
 * it. The at-rest write guards use it, so a random id that only contains the digits (a Twilio SID, a
 * UUID, a booking UID) can still be saved. A code right after a JSON escape like `\n` or `\u001f`
 * still counts, because in the stored JSON that letter is not part of the text.
 *
 * Only for the "can this file be written" guards. The checks on what a text, reply, or log line
 * carries keep matching the code anywhere.
 */
export function containsCodeToken(text: string, code: string): boolean {
  if (!code) return false;
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:(?<![A-Za-z0-9_-])|(?<=\\\\[bfnrt])|(?<=\\\\u[0-9A-Fa-f]{4}))${escaped}(?![A-Za-z0-9_-])`).test(text);
}
