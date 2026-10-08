/**
 * Visitor verification choices. Writable values are `basic-form` (the default)
 * and `none`. Older files may still say `mock` or `document-check`; those are
 * read as `basic-form` and are not offered again.
 */

export const VERIFICATION_QUESTION =
  "Should visitors fill out a short identity form before their tour? I recommend it, so you know who's coming in.";

export const NO_FORM_QUESTION =
  "Without a form, anyone who texts can book a tour and get in without telling you who they are. Want to go ahead with no form?";

export const BASIC_FORM_CHOICE = "Basic identity form (recommended)";
export const NO_FORM_CHOICE = "No form";

export const NO_FORM_WARNING =
  "Without a form, anyone who texts can book a tour and get in without telling you who they are.";

/** Older stored modes. Read as the basic identity form. Not a writable choice. */
export const LEGACY_VERIFICATION_MODES = ["mock", "document-check"] as const;

export function isLegacyVerification(mode: string | undefined): boolean {
  return mode === "mock" || mode === "document-check";
}

/** In-memory view of a stored setup. Does not write the file. */
export function presentVerification<T extends { verificationMode: string }>(config: T): T {
  if (!isLegacyVerification(config.verificationMode)) return config;
  return { ...config, verificationMode: "basic-form" };
}

export function verificationChoiceLabel(mode: string | undefined): string {
  return mode === "none" ? NO_FORM_CHOICE : BASIC_FORM_CHOICE;
}
