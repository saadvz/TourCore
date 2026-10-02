/**
 * The public https address every messaging provider uses to build webhook
 * and identity-form links. Hosting is not part of this: PUBLIC_BASE_URL is.
 */

/** Only https URLs count. Trailing slashes are dropped. */
export function publicBase(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return publicBase(env.PUBLIC_BASE_URL?.trim());
}
