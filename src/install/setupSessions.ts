import { createHash, randomBytes } from "node:crypto";
import type { RuntimeStore } from "../storage/runtimeStore";

/**
 * Short-lived sessions for the secure setup page. A session is minted by
 * something already running on the Tour Core computer (the bootstrap, the
 * local server at startup, or an operator tool) and handed to the browser in
 * the URL fragment, which never reaches the server's logs or a Referer. The
 * page sends it back in a header; every change to provider settings needs a
 * live one. Only the token's hash is stored, so the runtime folder can't be
 * replayed as a session.
 *
 * A session lets a browser on this computer *write* provider settings. It can
 * never read a credential back.
 */

export const SETUP_SESSION_HEADER = "x-tourcore-setup-session";
export const DEFAULT_SETUP_SESSION_MINUTES = 30;
const MAX_LIVE = 20;

interface StoredSession {
  schemaVersion: 1;
  createdAt: number;
  expiresAt: number;
}

const keyFor = (token: string) => `ss_${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 40)}`;

export class SetupSessions {
  constructor(
    private readonly store: RuntimeStore,
    private readonly now: () => number = Date.now,
  ) {}

  mint(minutes = DEFAULT_SETUP_SESSION_MINUTES): { token: string; expiresAt: number } {
    this.prune();
    const token = randomBytes(24).toString("base64url");
    const createdAt = this.now();
    const expiresAt = createdAt + minutes * 60_000;
    this.store.put("setup-sessions", keyFor(token), { schemaVersion: 1, createdAt, expiresAt } satisfies StoredSession);
    return { token, expiresAt };
  }

  /** Valid and not expired. An expired session is removed on sight. */
  check(token: string | undefined): { ok: true; expiresAt: number } | { ok: false; reason: "missing" | "unknown" | "expired" } {
    if (!token || !/^[A-Za-z0-9_-]{20,80}$/.test(token)) return { ok: false, reason: token ? "unknown" : "missing" };
    const key = keyFor(token);
    let stored: StoredSession | undefined;
    try {
      stored = this.store.get<StoredSession>("setup-sessions", key);
    } catch {
      return { ok: false, reason: "unknown" };
    }
    if (!stored) return { ok: false, reason: "unknown" };
    if (stored.expiresAt <= this.now()) {
      this.store.delete("setup-sessions", key);
      return { ok: false, reason: "expired" };
    }
    return { ok: true, expiresAt: stored.expiresAt };
  }

  end(token: string): void {
    if (/^[A-Za-z0-9_-]{20,80}$/.test(token)) this.store.delete("setup-sessions", keyFor(token));
  }

  private prune(): void {
    const { entries } = this.store.list<StoredSession>("setup-sessions");
    const t = this.now();
    const live = entries.filter((e) => {
      if (e.value.expiresAt > t) return true;
      this.store.delete("setup-sessions", e.key);
      return false;
    });
    for (const old of live.sort((a, b) => a.value.createdAt - b.value.createdAt).slice(0, Math.max(0, live.length - MAX_LIVE + 1))) this.store.delete("setup-sessions", old.key);
  }
}
