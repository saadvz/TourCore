import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RuntimeStore } from "../storage/runtimeStore";

/**
 * A short-lived, single-use session for the hosted approval page. The token
 * and CSRF secret travel in the URL fragment (never a query string, never a
 * log line). Reaching /mcp is not this session. Grok's bearer token is not
 * accepted on the approval request.
 */

export const APPROVAL_SESSION_HEADER = "x-tourcore-approval-session";
export const APPROVAL_CSRF_HEADER = "x-tourcore-csrf";
const MINUTES = 10;

interface Stored {
  schemaVersion: 1;
  createdAt: number;
  expiresAt: number;
  csrfHash: string;
  used: boolean;
}

const keyFor = (token: string) => `ap_${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 40)}`;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest();
const tokenOk = (token: string | undefined): token is string => !!token && /^[A-Za-z0-9_-]{20,80}$/.test(token);

export class ApprovalSessions {
  private live?: { token: string; csrf: string; expiresAt: number };

  constructor(
    private readonly store: RuntimeStore,
    private readonly now: () => number = Date.now,
  ) {}

  mint(): { token: string; csrf: string; expiresAt: number } {
    const token = randomBytes(24).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const createdAt = this.now();
    const expiresAt = createdAt + MINUTES * 60_000;
    this.store.put("approval-sessions", keyFor(token), { schemaVersion: 1, createdAt, expiresAt, csrfHash: hash(csrf).toString("hex"), used: false } satisfies Stored);
    return { token, csrf, expiresAt };
  }

  /** One unexpired link for this process, so status polls don't mint a pile of sessions. */
  pageUrl(publicBaseUrl: string | undefined): { url: string; expiresAt: number } | undefined {
    if (!publicBaseUrl) return undefined;
    if (!this.live || this.live.expiresAt <= this.now() + 15_000) this.live = this.mint();
    const base = publicBaseUrl.replace(/\/$/, "");
    return { url: `${base}/connect#s=${this.live.token}&c=${this.live.csrf}`, expiresAt: this.live.expiresAt };
  }

  /** Valid, unexpired, unused, and the CSRF secret matches. Does not consume the session. */
  check(token: string | undefined, csrf: string | undefined): { ok: true } | { ok: false; reason: "missing" | "unknown" | "expired" | "used" | "csrf" } {
    const found = this.read(token);
    if (!found.ok) return found;
    const given = csrf ? hash(csrf) : undefined;
    const expected = Buffer.from(found.stored.csrfHash, "hex");
    if (!given || given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "csrf" };
    return { ok: true };
  }

  /** Checks, then marks the session used. A second call fails. Wrong CSRF does not consume it. */
  consume(token: string | undefined, csrf: string | undefined): { ok: true } | { ok: false; reason: "missing" | "unknown" | "expired" | "used" | "csrf" } {
    const checked = this.check(token, csrf);
    if (!checked.ok) return checked;
    const found = this.read(token);
    if (!found.ok) return found;
    this.store.put("approval-sessions", found.key, { ...found.stored, used: true });
    if (token && this.live?.token === token) this.live = undefined;
    return { ok: true };
  }

  private read(token: string | undefined): { ok: true; key: string; stored: Stored } | { ok: false; reason: "missing" | "unknown" | "expired" | "used" } {
    if (!tokenOk(token)) return { ok: false, reason: token ? "unknown" : "missing" };
    const key = keyFor(token);
    let stored: Stored | undefined;
    try {
      stored = this.store.get<Stored>("approval-sessions", key);
    } catch {
      return { ok: false, reason: "unknown" };
    }
    if (!stored) return { ok: false, reason: "unknown" };
    if (stored.used) return { ok: false, reason: "used" };
    if (stored.expiresAt <= this.now()) {
      this.store.delete("approval-sessions", key);
      return { ok: false, reason: "expired" };
    }
    return { ok: true, key, stored };
  }
}
