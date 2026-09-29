import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashSecret } from "../mcp/oauth/store";
import type { Installation } from "./installation";
import type { HostedOwnerSecret } from "./secretStore";

/**
 * One-time claim for the single hosted demo installation, then a browser
 * session for that owner. The distributor normally types
 * TOURCORE_HOSTED_OWNER_BOOTSTRAP_SECRET on /claim. SecretStore keeps only
 * hashes. An optional CLI file is a developer fallback. Google Drive, MCP
 * results, logs and ordinary pages never receive either secret.
 *
 * This exists only because HOSTED_RAILWAY_P0 is one shared demo. It is not
 * the future Marketplace sign-in. The owner cookie proves who may approve.
 * An OAuth request id does not.
 */

export const HOSTED_OWNER_BOOTSTRAP_SECRET = "TOURCORE_HOSTED_OWNER_BOOTSTRAP_SECRET";

export const HOSTED_OWNER_RESET = "reset-hosted-owner";
export const OWNER_COOKIE = "tourcore_owner";
export const OWNER_CSRF_COOKIE = "tourcore_csrf";
export const OWNER_CSRF_HEADER = "x-tourcore-csrf";
/** Absolute lifetime of an owner session from the moment of claim. */
export const OWNER_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const OWNER_SESSION_SECONDS = OWNER_SESSION_MS / 1000;
const CLAIM_FILE = "owner-claim.once";
const TOKEN = /^[A-Za-z0-9_-]{20,80}$/;
export const OAUTH_REQUEST_ID = /^[A-Za-z0-9_-]{16,80}$/;

export const claimFilePath = (root: string) => join(root, "install", CLAIM_FILE);

export interface ClaimSuccess {
  ok: true;
  token: string;
  csrf: string;
  ownerId: string;
  expiresAt: number;
}

export type ClaimFailure = { ok: false; reason: "invalid" | "used" | "spent" | "missing" };
export type OwnerCheck = { ok: true; ownerId: string } | { ok: false; reason: "missing" | "unknown" | "expired" };

const MIN_CLAIM_CODE = 16;
const MAX_CLAIM_CODE = 256;

/** Hash both sides, then compare in constant time. Length differences do not skip the compare. */
const hashesEqual = (given: string, expectedHex: string) => {
  const actual = Buffer.from(hashSecret(given), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && expected.length > 0 && timingSafeEqual(actual, expected);
};

const acceptableClaimCode = (code: string) => code.length >= MIN_CLAIM_CODE && code.length <= MAX_CLAIM_CODE && !/[\r\n\0]/.test(code);

/** The Railway variable, when it is strong enough to be a claim credential. The value is never stored. */
export function bootstrapSecretFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[HOSTED_OWNER_BOOTSTRAP_SECRET]?.trim();
  if (!value || !acceptableClaimCode(value)) return undefined;
  return value;
}

function writeClaimFile(root: string, secret: string): void {
  const path = claimFilePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
}

function readClaimFile(root: string): string | undefined {
  const path = claimFilePath(root);
  if (!existsSync(path)) return undefined;
  try {
    const secret = readFileSync(path, "utf8").trim();
    return TOKEN.test(secret) ? secret : undefined;
  } catch {
    return undefined;
  }
}

function deleteClaimFile(root: string): void {
  rmSync(claimFilePath(root), { force: true });
}

/**
 * Prepares a claim on a fresh hosted installation. A second call does not
 * mint another secret. If the plaintext file was lost before anyone claimed,
 * a replacement is issued. After a claim, a leftover plaintext file is removed.
 */
export function ensureHostedOwnerClaim(inst: Installation): { created: boolean; claimed: boolean } {
  const existing = inst.secrets.hostedOwner();
  if (existing?.claimed) {
    deleteClaimFile(inst.root);
    return { created: false, claimed: true };
  }
  if (existing && readClaimFile(inst.root)) return { created: false, claimed: false };
  const secret = randomBytes(32).toString("base64url");
  inst.secrets.saveHostedOwner({
    schemaVersion: 1,
    claimHash: hashSecret(secret),
    claimed: false,
    ...(existing?.consumedBootstrapHash ? { consumedBootstrapHash: existing.consumedBootstrapHash } : {}),
  });
  writeClaimFile(inst.root, secret);
  return { created: true, claimed: false };
}

/** The one-time secret, if it has not been claimed yet. For the distributor CLI only. */
export function pendingClaimSecret(inst: Installation): string | undefined {
  const record = inst.secrets.hostedOwner();
  if (!record || record.claimed) return undefined;
  const secret = readClaimFile(inst.root);
  if (!secret || !hashesEqual(secret, record.claimHash)) return undefined;
  return secret;
}

/**
 * Text the optional developer CLI prints. Contains the fallback claim secret
 * when one is waiting. Server startup must not call this. The recommended
 * hosted setup is the /claim page, not this command.
 */
export function ownerClaimInstructions(inst: Installation): string {
  const record = inst.secrets.hostedOwner();
  if (record?.claimed) {
    return "This hosted installation is already claimed. To issue a new one-time claim, set TOURCORE_HOSTED_OWNER_RESET=reset-hosted-owner for one deploy, then remove it. A bootstrap secret that was already used will not work again.";
  }
  const secret = pendingClaimSecret(inst);
  const base = inst.publicBaseUrl()?.replace(/\/$/, "");
  if (!secret || !base) return "No one-time claim is waiting. Start the hosted Tour Core service once, then run this command again.";
  return [
    "Optional admin fallback. The recommended claim is to open /claim and enter TOURCORE_HOSTED_OWNER_BOOTSTRAP_SECRET.",
    "This link is the one-time developer fallback. The code is in the fragment and is not written to the service log.",
    "",
    `${base}/claim#c=${secret}`,
    "",
    "It works once. After a successful claim it stops working.",
  ].join("\n");
}

export function claimHostedInstallation(inst: Installation, code: string): ClaimSuccess | ClaimFailure {
  if (typeof code !== "string") return { ok: false, reason: "invalid" };
  const trimmed = code.trim();
  if (!acceptableClaimCode(trimmed)) return { ok: false, reason: "invalid" };
  const record = inst.secrets.hostedOwner();
  if (record?.claimed) return { ok: false, reason: "used" };
  if (record?.consumedBootstrapHash && hashesEqual(trimmed, record.consumedBootstrapHash)) return { ok: false, reason: "spent" };
  const fileMatch = !!record && hashesEqual(trimmed, record.claimHash);
  const envSecret = bootstrapSecretFromEnv(inst.env());
  const envMatch = !!envSecret && hashesEqual(trimmed, hashSecret(envSecret));
  if (!fileMatch && !envMatch) return { ok: false, reason: record ? "invalid" : "missing" };
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const ownerId = `own_${randomBytes(9).toString("base64url")}`;
  const now = inst.now();
  const consumedBootstrapHash = envMatch ? hashSecret(trimmed) : record?.consumedBootstrapHash;
  const next: HostedOwnerSecret = {
    schemaVersion: 1,
    claimHash: record?.claimHash ?? hashSecret(trimmed),
    claimed: true,
    ownerId,
    sessionHash: hashSecret(token),
    csrfHash: hashSecret(csrf),
    sessionExpiresAt: now + OWNER_SESSION_MS,
    claimedAt: new Date(now).toISOString(),
    ...(consumedBootstrapHash ? { consumedBootstrapHash } : {}),
  };
  inst.secrets.saveHostedOwner(next);
  deleteClaimFile(inst.root);
  return { ok: true, token, csrf, ownerId, expiresAt: next.sessionExpiresAt! };
}

/** Ends the browser session. The installation stays claimed, so the old claim cannot be reused. */
export function revokeHostedOwnerSession(inst: Installation): boolean {
  const record = inst.secrets.hostedOwner();
  if (!record?.sessionHash) return false;
  const next: HostedOwnerSecret = {
    schemaVersion: 1,
    claimHash: record.claimHash,
    claimed: record.claimed,
    ...(record.ownerId ? { ownerId: record.ownerId } : {}),
    ...(record.claimedAt ? { claimedAt: record.claimedAt } : {}),
    ...(record.consumedBootstrapHash ? { consumedBootstrapHash: record.consumedBootstrapHash } : {}),
  };
  inst.secrets.saveHostedOwner(next);
  return true;
}

/** Distributor reset: drops the owner and issues a new CLI fallback claim. A bootstrap secret that was already used stays spent. Does not delete tour records. */
export function resetHostedOwner(inst: Installation): void {
  const consumed = inst.secrets.hostedOwner()?.consumedBootstrapHash;
  inst.secrets.saveHostedOwner(undefined);
  deleteClaimFile(inst.root);
  ensureHostedOwnerClaim(inst);
  if (!consumed) return;
  const record = inst.secrets.hostedOwner();
  if (record) inst.secrets.saveHostedOwner({ ...record, consumedBootstrapHash: consumed });
}

export function hostedInstallationClaimed(inst: Installation): boolean {
  return !!inst.secrets.hostedOwner()?.claimed;
}

export function ownerFromCookie(inst: Installation, cookieHeader: string | undefined): OwnerCheck {
  const token = readCookie(cookieHeader, OWNER_COOKIE);
  if (!token || !TOKEN.test(token)) return { ok: false, reason: token ? "unknown" : "missing" };
  const record = inst.secrets.hostedOwner();
  if (!record?.claimed || !record.sessionHash || !record.ownerId) return { ok: false, reason: "unknown" };
  if (!record.sessionExpiresAt || record.sessionExpiresAt <= inst.now()) return { ok: false, reason: "expired" };
  if (!hashesEqual(token, record.sessionHash)) return { ok: false, reason: "unknown" };
  return { ok: true, ownerId: record.ownerId };
}

export function ownerCsrfOk(inst: Installation, cookieHeader: string | undefined, csrf: string | undefined): boolean {
  const session = ownerFromCookie(inst, cookieHeader);
  if (!session.ok) return false;
  const record = inst.secrets.hostedOwner();
  if (!record?.csrfHash || !csrf || !TOKEN.test(csrf)) return false;
  return hashesEqual(csrf, record.csrfHash);
}

export function ownerSessionCookies(token: string, csrf: string, maxAgeSeconds: number): string[] {
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  const common = `Path=/; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  return [`${OWNER_COOKIE}=${encodeURIComponent(token)}; HttpOnly; ${common}`, `${OWNER_CSRF_COOKIE}=${encodeURIComponent(csrf)}; ${common}`];
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface ClaimHttpResult {
  status: number;
  json: unknown;
  cookies?: string[];
}

const fail = (status: number, message: string): ClaimHttpResult => ({ status, json: { ok: false, error: { message } } });

/** POST /api/claim. The claim code is taken from the body and never echoed. */
export function handleHostedClaim(inst: Installation, method: string, body: unknown): ClaimHttpResult {
  if (method === "GET") return { status: 200, json: { ok: true, claimed: hostedInstallationClaimed(inst) } };
  if (method !== "POST") return fail(404, "That page doesn't exist.");
  const parsed = body as { code?: unknown; requestId?: unknown } | undefined;
  const code = typeof parsed?.code === "string" ? parsed.code : "";
  const result = claimHostedInstallation(inst, code);
  if (!result.ok) {
    const message = result.reason === "used" ? "This installation is already claimed." : "That claim isn't valid.";
    return fail(401, message);
  }
  const requestId = typeof parsed?.requestId === "string" && OAUTH_REQUEST_ID.test(parsed.requestId) ? parsed.requestId : undefined;
  return {
    status: 200,
    json: { ok: true, ...(requestId ? { next: `/connect?request=${requestId}` } : {}) },
    cookies: ownerSessionCookies(result.token, result.csrf, OWNER_SESSION_SECONDS),
  };
}
