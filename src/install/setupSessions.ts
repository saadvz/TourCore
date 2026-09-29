import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
export const SETUP_CSRF_HEADER = "x-tourcore-csrf";
export const DEFAULT_SETUP_SESSION_MINUTES = 30;
/** Hosted setup links are shorter and can save credentials only a few times. */
export const HOSTED_SETUP_SESSION_MINUTES = 15;
export const HOSTED_SETUP_WRITES = 6;
const MAX_LIVE = 20;

interface StoredSession {
  schemaVersion: 1;
  createdAt: number;
  expiresAt: number;
  csrfHash?: string;
  writesRemaining?: number;
}

export interface SetupMintOptions {
  /** Required on every hosted write. Omitted for the local-computer page. */
  csrf?: boolean;
  /** Hosted sessions stop accepting writes after this many successful saves. */
  writes?: number;
}

const keyFor = (token: string) => `ss_${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 40)}`;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest();
const same = (given: Buffer, expectedHex: string) => {
  const expected = Buffer.from(expectedHex, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
};

export class SetupSessions {
  constructor(
    private readonly store: RuntimeStore,
    private readonly now: () => number = Date.now,
  ) {}

  mint(minutes = DEFAULT_SETUP_SESSION_MINUTES, options: SetupMintOptions = {}): { token: string; expiresAt: number; csrf?: string } {
    this.prune();
    const token = randomBytes(24).toString("base64url");
    const csrf = options.csrf ? randomBytes(24).toString("base64url") : undefined;
    const createdAt = this.now();
    const expiresAt = createdAt + minutes * 60_000;
    this.store.put("setup-sessions", keyFor(token), {
      schemaVersion: 1,
      createdAt,
      expiresAt,
      ...(csrf ? { csrfHash: hash(csrf).toString("hex") } : {}),
      ...(options.writes !== undefined ? { writesRemaining: options.writes } : {}),
    } satisfies StoredSession);
    return { token, expiresAt, ...(csrf ? { csrf } : {}) };
  }

  /** Valid and not expired. An expired session is removed on sight. */
  check(token: string | undefined, csrf?: string): { ok: true; expiresAt: number; csrfOk?: boolean; writesRemaining?: number } | { ok: false; reason: "missing" | "unknown" | "expired" | "spent" } {
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
    if (stored.writesRemaining !== undefined && stored.writesRemaining <= 0) {
      this.store.delete("setup-sessions", key);
      return { ok: false, reason: "spent" };
    }
    const csrfOk = !!stored.csrfHash && !!csrf && same(hash(csrf), stored.csrfHash);
    return {
      ok: true,
      expiresAt: stored.expiresAt,
      ...(stored.csrfHash ? { csrfOk } : {}),
      ...(stored.writesRemaining !== undefined ? { writesRemaining: stored.writesRemaining } : {}),
    };
  }

  /** Counts one hosted write. A session with no write budget is unchanged. */
  noteWrite(token: string): void {
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return;
    const key = keyFor(token);
    const stored = this.store.get<StoredSession>("setup-sessions", key);
    if (!stored || stored.writesRemaining === undefined) return;
    const writesRemaining = stored.writesRemaining - 1;
    this.store.put("setup-sessions", key, { ...stored, writesRemaining });
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
