import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { RuntimeStore } from "../../storage/runtimeStore";

/**
 * Who may call Tour Core's operator tools over OAuth: the registered clients
 * and the grants the operator approved. One small JSON document in the
 * runtime folder. Access tokens, refresh tokens and client secrets are kept
 * only as SHA-256 hashes, so the file can't be replayed as a credential.
 * Nothing here touches properties, tours, messaging or Durin.
 */

export const hashSecret = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export const newSecret = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

export interface StoredClient {
  /** client_secret, when present, is the hash. */
  info: OAuthClientInformationFull;
  /** The authorization server (PUBLIC_BASE_URL origin) the client registered with. */
  issuer: string;
  registeredAt: number;
}

export interface Grant {
  id: string;
  clientId: string;
  clientName?: string;
  issuer: string;
  /** RFC 8707 audience: the MCP endpoint the tokens are for. */
  resource: string;
  scopes: string[];
  createdAt: number;
  /** Hard end of this approval; refreshing never extends past it. */
  expiresAt: number;
  accessHash: string;
  accessExpiresAt: number;
  refreshHash?: string;
  refreshExpiresAt?: number;
  /** Refresh tokens already rotated out. Seeing one again means it leaked: the grant is revoked. */
  retiredRefreshHashes: string[];
  refreshedAt?: number;
}

interface Doc {
  schemaVersion: 1;
  clients: Record<string, StoredClient>;
  grants: Grant[];
}

const KEY = "grok-access";
const MAX_RETIRED = 50;
const MAX_IDLE_CLIENTS = 50;
const PLACEHOLDER_NAMES = new Set(["an mcp client", "unnamed"]);

function usableClientName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed || PLACEHOLDER_NAMES.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

/** A wording name when the registration never stored client_name. Cursor's callbacks and Grok's hosts select Grok wording only. */
function wordingFromRegistration(info: { software_id?: string; redirect_uris?: string[] } | undefined): string | undefined {
  if (!info) return undefined;
  const blob = `${info.software_id ?? ""} ${(info.redirect_uris ?? []).join(" ")}`.toLowerCase();
  if (/\bgrok\b|grok\.com|\bx\.ai\b|\bx\.com\b/.test(blob)) return "Grok";
  if (blob.includes("cursor")) return "Cursor";
  return undefined;
}

export class OAuthGrantStore {
  constructor(
    private readonly runtime: RuntimeStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Read on every use, so `npm run grok:disconnect` takes effect in a running Tour Core. A damaged file throws (fail closed). */
  private read(): Doc {
    const doc = this.runtime.get<Doc>("oauth", KEY);
    return doc ?? { schemaVersion: 1, clients: {}, grants: [] };
  }

  private write(doc: Doc): void {
    const t = this.now();
    doc.grants = doc.grants.filter((g) => g.expiresAt > t && (g.accessExpiresAt > t || (g.refreshExpiresAt ?? 0) > t));
    this.runtime.put("oauth", KEY, doc);
  }

  getClient(clientId: string): StoredClient | undefined {
    return this.read().clients[clientId];
  }

  /**
   * The name stored for this signed-in caller: the newest live grant's
   * clientName, otherwise the name the client registered with, otherwise a
   * name read from the registration's software id or redirect URIs.
   * Placeholders ("An MCP client", "unnamed") count as missing. A name
   * found that way is written onto the grant the next time this caller
   * presents a token. Nothing here is a token or a secret. The name only
   * picks playbook wording.
   */
  clientName(clientId: string): string | undefined {
    if (!clientId) return undefined;
    const doc = this.read();
    const t = this.now();
    const live = doc.grants
      .filter((g) => g.clientId === clientId && g.expiresAt > t && (g.accessExpiresAt > t || (g.refreshExpiresAt ?? 0) > t))
      .sort((a, b) => (b.refreshedAt ?? b.createdAt) - (a.refreshedAt ?? a.createdAt));
    for (const grant of live) {
      const name = usableClientName(grant.clientName);
      if (name) return name;
    }
    const info = doc.clients[clientId]?.info;
    const recovered = usableClientName(info?.client_name) ?? wordingFromRegistration(info);
    if (recovered) this.backfillClientName(clientId, recovered);
    return recovered;
  }

  /** Writes a recovered display name onto grants that never stored one. */
  private backfillClientName(clientId: string, name: string): void {
    const doc = this.read();
    let changed = false;
    for (const grant of doc.grants) {
      if (grant.clientId !== clientId || usableClientName(grant.clientName)) continue;
      grant.clientName = name;
      changed = true;
    }
    if (changed) this.write(doc);
  }

  /** Registration is open (RFC 7591), so only the most recent clients are kept; ones with a live approval always stay. */
  putClient(client: StoredClient): void {
    const doc = this.read();
    doc.clients[client.info.client_id] = client;
    const inUse = new Set(doc.grants.map((g) => g.clientId));
    const idle = Object.values(doc.clients).filter((c) => !inUse.has(c.info.client_id)).sort((a, b) => a.registeredAt - b.registeredAt);
    for (const old of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_CLIENTS))) delete doc.clients[old.info.client_id];
    this.write(doc);
  }

  addGrant(grant: Omit<Grant, "id" | "retiredRefreshHashes">): Grant {
    const doc = this.read();
    const full: Grant = { ...grant, id: randomUUID(), retiredRefreshHashes: [] };
    doc.grants.push(full);
    this.write(doc);
    return full;
  }

  findByAccessHash(hash: string): Grant | undefined {
    return this.read().grants.find((g) => g.accessHash === hash);
  }

  findByRefreshHash(hash: string): { grant: Grant; retired: boolean } | undefined {
    for (const grant of this.read().grants) {
      if (grant.refreshHash === hash) return { grant, retired: false };
      if (grant.retiredRefreshHashes.includes(hash)) return { grant, retired: true };
    }
    return undefined;
  }

  /** Swaps in a new token pair; the old refresh token is remembered only to detect reuse. */
  rotate(grantId: string, next: { accessHash: string; accessExpiresAt: number; refreshHash?: string; refreshExpiresAt?: number }): Grant | undefined {
    const doc = this.read();
    const grant = doc.grants.find((g) => g.id === grantId);
    if (!grant) return undefined;
    if (grant.refreshHash) grant.retiredRefreshHashes = [...grant.retiredRefreshHashes, grant.refreshHash].slice(-MAX_RETIRED);
    Object.assign(grant, next, { refreshedAt: this.now() });
    this.write(doc);
    return grant;
  }

  revokeGrant(grantId: string): boolean {
    const doc = this.read();
    const before = doc.grants.length;
    doc.grants = doc.grants.filter((g) => g.id !== grantId);
    if (doc.grants.length === before) return false;
    this.write(doc);
    return true;
  }

  /** "Disconnect Grok": every grant and every registered client goes; tokens stop working immediately. */
  revokeAll(): { grants: number; clients: number } {
    const doc = this.read();
    const counts = { grants: doc.grants.length, clients: Object.keys(doc.clients).length };
    this.runtime.put("oauth", KEY, { schemaVersion: 1, clients: {}, grants: [] } satisfies Doc);
    return counts;
  }

  /** For the operator's connection page and `grok:status`. No token material. */
  connections(): Array<{ clientName: string; connectedAt: number; refreshedAt?: number; approvalEndsAt: number; address: string }> {
    const doc = this.read();
    const t = this.now();
    return doc.grants
      .filter((g) => g.expiresAt > t && (g.accessExpiresAt > t || (g.refreshExpiresAt ?? 0) > t))
      .map((g) => ({ clientName: g.clientName ?? "An MCP client", connectedAt: g.createdAt, refreshedAt: g.refreshedAt, approvalEndsAt: g.expiresAt, address: g.resource }));
  }
}
