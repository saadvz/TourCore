/** Properties that already exist on the hosted line. The live eval must never name them. */
export const FORBIDDEN_PROPERTY_PATTERNS: RegExp[] = [/145\s+tenafly\s+road/i, /\b914b\b/i];

/** The pattern source when `value` mentions a protected property, otherwise undefined. */
export function forbiddenHit(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const pattern of FORBIDDEN_PROPERTY_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return pattern.source;
  }
  return undefined;
}
