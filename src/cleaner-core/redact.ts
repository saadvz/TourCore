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
