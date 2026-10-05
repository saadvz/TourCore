import { createHash, randomBytes } from "node:crypto";
import type { RuntimeStore } from "../storage/runtimeStore";

/**
 * Short-lived download tokens for a day's audit export. Backup handoff is
 * header-only (not a clickable URL) and secure setup uses a page fragment,
 * so neither can protect a file the operator opens in a browser. This
 * mirrors verification links: a random token in the URL, only its hash
 * stored, expiry checked on each GET.
 */

export const AUDIT_EXPORT_LINK_MINUTES = 30;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

interface StoredLink {
  schemaVersion: 1;
  propertyId: string;
  exportId: string;
  file: string;
  issuedAt: number;
  expiresAt: number;
}

export type AuditExportLinkCheck = { ok: true } | { ok: false; reason: "missing" | "unknown" | "expired" | "mismatch" };

const keyFor = (token: string) => `ae_${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 40)}`;

export class AuditExportLinks {
  constructor(
    private readonly store: RuntimeStore,
    private readonly now: () => number = Date.now,
  ) {}

  static tokenFrom(search: URLSearchParams): string | undefined {
    const token = search.get("t")?.trim();
    return token && TOKEN.test(token) ? token : undefined;
  }

  static parsePath(pathname: string): { propertyId: string; exportId: string; file: string } | undefined {
    const m = /^\/api\/properties\/([a-z0-9_]+)\/audit-exports\/([^/]+)\/([^/]+)$/.exec(pathname);
    return m ? { propertyId: m[1]!, exportId: m[2]!, file: m[3]! } : undefined;
  }

  static downloadUrl(base: string, propertyId: string, exportId: string, file: string, token: string): string {
    const root = base.replace(/\/$/, "");
    return `${root}/api/properties/${propertyId}/audit-exports/${exportId}/${file}?t=${token}`;
  }

  static localUrl(base: string, propertyId: string, exportId: string, file: string): string {
    return `${base.replace(/\/$/, "")}/api/properties/${propertyId}/audit-exports/${exportId}/${file}`;
  }

  issue(propertyId: string, exportId: string, file: string, minutes = AUDIT_EXPORT_LINK_MINUTES): { token: string; expiresAt: number } {
    this.prune();
    const token = randomBytes(24).toString("base64url");
    const issuedAt = this.now();
    const expiresAt = issuedAt + minutes * 60_000;
    this.store.put("audit-export-links", keyFor(token), {
      schemaVersion: 1,
      propertyId,
      exportId,
      file,
      issuedAt,
      expiresAt,
    } satisfies StoredLink);
    return { token, expiresAt };
  }

  check(token: string | undefined, propertyId: string, exportId: string, file: string): AuditExportLinkCheck {
    if (!token || !TOKEN.test(token)) return { ok: false, reason: token ? "unknown" : "missing" };
    let stored: StoredLink | undefined;
    try {
      stored = this.store.get<StoredLink>("audit-export-links", keyFor(token));
    } catch {
      return { ok: false, reason: "unknown" };
    }
    if (!stored) return { ok: false, reason: "unknown" };
    if (stored.expiresAt <= this.now()) {
      this.store.delete("audit-export-links", keyFor(token));
      return { ok: false, reason: "expired" };
    }
    if (stored.propertyId !== propertyId || stored.exportId !== exportId || stored.file !== file) {
      return { ok: false, reason: "mismatch" };
    }
    return { ok: true };
  }

  private prune(): void {
    const t = this.now();
    for (const { key, value } of this.store.list<StoredLink>("audit-export-links").entries) {
      if (value.expiresAt <= t) this.store.delete("audit-export-links", key);
    }
  }
}
