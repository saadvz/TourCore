import { createHash, randomBytes } from "node:crypto";
import { MemoryRuntimeStore, type RuntimeStore } from "../storage/runtimeStore";

export interface LinkEntry {
  sessionId: string;
  reservationId: string;
  /** The number the visitor is texting from; the form's phone must match it. */
  phone: string;
  expiresAt: number;
  usedAt?: number;
}

/** What's saved for a link. The token itself is never stored, only its hash. */
interface StoredLink extends LinkEntry {
  schemaVersion: 1;
  issuedAt: number;
  /** A newer link for the same tour was sent; this one no longer works. */
  replacedAt?: number;
}

export type LinkCheck = { ok: true; entry: LinkEntry } | { ok: false; reason: "unknown" | "expired" | "used" };

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
/** Old links are kept a week past expiry so a late tap still gets "expired" rather than "not valid", then dropped. */
const KEEP_AFTER_EXPIRY_MS = 7 * 24 * 60 * 60_000;

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Short-lived, single-use links to the basic identity form for visitors on a
 * messaging channel. The link carries only a random token: no names, numbers
 * or ids in the URL. Issuing a new link for a tour retires the old one. Links
 * are saved (by token hash) so expiry, single use and replacement hold across
 * a restart.
 */
export class VerificationLinks {
  private readonly store: RuntimeStore;

  constructor(
    private readonly options: {
      /** Public https base, e.g. from PUBLIC_BASE_URL. No base means no links can be issued. */
      baseUrl: () => string | undefined;
      ttlMinutes?: number;
      now?: () => number;
      /** Where links are kept. Defaults to memory only. */
      store?: RuntimeStore;
    },
  ) {
    this.store = options.store ?? new MemoryRuntimeStore();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  issue(input: { sessionId: string; reservationId: string; phone: string }): string | undefined {
    const base = this.options.baseUrl();
    if (!base) return undefined;
    const now = this.now();
    for (const { key, value } of this.store.list<StoredLink>("verification").entries) {
      if (value.expiresAt + KEEP_AFTER_EXPIRY_MS < now) this.store.delete("verification", key);
      else if (value.reservationId === input.reservationId && !value.usedAt && !value.replacedAt) this.store.put("verification", key, { ...value, replacedAt: now });
    }
    const token = randomBytes(18).toString("base64url");
    const stored: StoredLink = { schemaVersion: 1, ...input, issuedAt: now, expiresAt: now + (this.options.ttlMinutes ?? 30) * 60_000 };
    this.store.put("verification", hashOf(token), stored);
    return `${base}/verify/${token}`;
  }

  check(token: string): LinkCheck {
    const stored = this.lookup(token);
    if (!stored || stored.replacedAt) return { ok: false, reason: "unknown" };
    if (stored.usedAt) return { ok: false, reason: "used" };
    if (this.now() > stored.expiresAt) return { ok: false, reason: "expired" };
    const { sessionId, reservationId, phone, expiresAt } = stored;
    return { ok: true, entry: { sessionId, reservationId, phone, expiresAt } };
  }

  markUsed(token: string): void {
    const stored = this.lookup(token);
    if (stored && !stored.usedAt) this.store.put("verification", hashOf(token), { ...stored, usedAt: this.now() });
  }

  /** The link currently open for a tour, if any: when it was sent and when it stops working. No token. */
  current(reservationId: string): { issuedAt: number; expiresAt: number } | undefined {
    const open = this.store
      .list<StoredLink>("verification")
      .entries.map((e) => e.value)
      .filter((v) => v.reservationId === reservationId && !v.usedAt && !v.replacedAt)
      .sort((a, b) => b.issuedAt - a.issuedAt)[0];
    return open ? { issuedAt: open.issuedAt, expiresAt: open.expiresAt } : undefined;
  }

  private lookup(token: string): StoredLink | undefined {
    if (!TOKEN.test(token)) return undefined;
    try {
      return this.store.get<StoredLink>("verification", hashOf(token));
    } catch {
      // A damaged link record can't be trusted; treat the link as not valid.
      return undefined;
    }
  }
}
