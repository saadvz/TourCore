import { randomBytes } from "node:crypto";

export interface LinkEntry {
  sessionId: string;
  reservationId: string;
  /** The number the visitor is texting from; the form's phone must match it. */
  phone: string;
  expiresAt: number;
  usedAt?: number;
}

export type LinkCheck = { ok: true; entry: LinkEntry } | { ok: false; reason: "unknown" | "expired" | "used" };

/**
 * Short-lived, single-use links to the basic identity form for visitors on a
 * messaging channel. The link carries only a random token: no names, numbers
 * or ids in the URL. Issuing a new link for a tour retires the old one.
 */
export class VerificationLinks {
  private readonly links = new Map<string, LinkEntry>();

  constructor(
    private readonly options: {
      /** Public https base, e.g. from PUBLIC_BASE_URL. No base means no links can be issued. */
      baseUrl: () => string | undefined;
      ttlMinutes?: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  issue(input: { sessionId: string; reservationId: string; phone: string }): string | undefined {
    const base = this.options.baseUrl();
    if (!base) return undefined;
    for (const [token, entry] of this.links) if (entry.reservationId === input.reservationId && !entry.usedAt) this.links.delete(token);
    const token = randomBytes(18).toString("base64url");
    this.links.set(token, { ...input, expiresAt: this.now() + (this.options.ttlMinutes ?? 30) * 60_000 });
    return `${base}/verify/${token}`;
  }

  check(token: string): LinkCheck {
    const entry = /^[A-Za-z0-9_-]{16,64}$/.test(token) ? this.links.get(token) : undefined;
    if (!entry) return { ok: false, reason: "unknown" };
    if (entry.usedAt) return { ok: false, reason: "used" };
    if (this.now() > entry.expiresAt) return { ok: false, reason: "expired" };
    return { ok: true, entry };
  }

  markUsed(token: string): void {
    const entry = this.links.get(token);
    if (entry) entry.usedAt = this.now();
  }
}
