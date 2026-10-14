/** Guesty Lite is polled once an hour. Three missed polls is the default stale threshold. */
export const GUESTY_POLL_MS = 60 * 60 * 1000;
export const DEFAULT_STALE_AFTER_MS = 3 * GUESTY_POLL_MS;

export type FreshnessStatus = "fresh" | "stale" | "unknown";
export type InterpretationStatus = "ok" | "unreadable" | "permission-denied";

export interface SourceRecord {
  kind: string;
  fetchedAt: string | null;
  fingerprint: string;
  freshness: FreshnessStatus;
  interpretation: InterpretationStatus;
}

export function staleAfterMs(env: NodeJS.ProcessEnv = process.env, explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return explicit;
  const raw = env.CLEANER_CORE_STALE_AFTER_MS?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (parsed > 0) return parsed;
  }
  return DEFAULT_STALE_AFTER_MS;
}

/** A missing fetch time is unknown, not a blocked turn. A clock older than the threshold is stale. */
export function freshnessOf(fetchedAt: string | null | undefined, nowMs: number, thresholdMs: number): FreshnessStatus {
  if (!fetchedAt) return "unknown";
  const readAt = Date.parse(fetchedAt);
  if (Number.isNaN(readAt)) return "unknown";
  return nowMs - readAt > thresholdMs ? "stale" : "fresh";
}

export function fingerprintOf(parts: readonly string[]): string {
  return parts.join("\n");
}
