/** A single-line email address. Same bar as the public compliance pages. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseEmail(raw: string | undefined): string | undefined {
  const trimmed = raw?.replace(/[\r\n]+/g, " ").trim() ?? "";
  return trimmed && EMAIL.test(trimmed) ? trimmed : undefined;
}

/**
 * Support address visitors see. The operator setting is primary;
 * TOURCORE_PUBLIC_CONTACT_EMAIL is only a fallback when that is empty.
 */
export function resolveSupportEmail(operatorEmail?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return parseEmail(operatorEmail) ?? parseEmail(env.TOURCORE_PUBLIC_CONTACT_EMAIL);
}
