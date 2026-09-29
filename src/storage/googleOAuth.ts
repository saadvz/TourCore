import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { GOOGLE_SCOPES } from "./googleDrive";

/**
 * Tour Core's own Google authorization. Current Google guidance for a web
 * app: Authorization Code with PKCE (S256), an exact redirect URI, and a
 * one-time state value. Refresh tokens stay in SecretStore, never in Drive
 * and never in a URL after the callback is exchanged.
 *
 * xAI does not document a way for an outside program to use Grok's Google
 * Drive connector token, so this consent is separate from Grok's connector.
 */

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const USERINFO = "https://www.googleapis.com/oauth2/v2/userinfo";

export interface GoogleClientConfig {
  clientId?: string;
  clientSecret?: string;
}

export function googleClientConfig(env: NodeJS.ProcessEnv, secret: (name: string) => string | undefined): GoogleClientConfig {
  return {
    clientId: env.TOURCORE_GOOGLE_OAUTH_CLIENT_ID?.trim() || undefined,
    clientSecret: secret("GOOGLE_OAUTH_CLIENT_SECRET") || env.TOURCORE_GOOGLE_OAUTH_CLIENT_SECRET?.trim() || undefined,
  };
}

export interface OAuthPending {
  state: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
}

export function createPending(redirectUri: string, now: number, ttlMs = 10 * 60_000): OAuthPending {
  assertRedirect(redirectUri);
  return { state: randomBytes(24).toString("base64url"), verifier: randomBytes(32).toString("base64url"), redirectUri, expiresAt: now + ttlMs };
}

export function authorizationUrl(config: GoogleClientConfig, pending: OAuthPending): string {
  if (!config.clientId) throw new Error("Tour Core's Google app isn't configured.");
  const url = new URL(AUTH);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", pending.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("state", pending.state);
  url.searchParams.set("code_challenge", createHash("sha256").update(pending.verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

export function assertRedirect(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error("That Google redirect address isn't valid.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && local) return;
  throw new Error("Google must redirect to this Tour Core's https address.");
}

export function redirectUriFor(publicBaseUrl: string | undefined): string {
  if (!publicBaseUrl) throw new Error("Tour Core needs its secure public connection before Google can send the operator back.");
  const uri = `${publicBaseUrl.replace(/\/$/, "")}/google/oauth/callback`;
  assertRedirect(uri);
  return uri;
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function checkState(pending: OAuthPending | undefined, state: string | undefined, now: number): void {
  if (!pending || !state || pending.expiresAt <= now || !same(pending.state, state)) {
    throw new Error("That Google approval didn't match this Tour Core. Start the connection again.");
  }
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Exchanges a code. The code and tokens are never put in an Error message. */
export async function exchangeCode(config: GoogleClientConfig, pending: OAuthPending, code: string, fetchImpl: FetchLike = fetch): Promise<TokenSet> {
  if (!config.clientId || !config.clientSecret) throw new Error("Tour Core's Google app isn't configured.");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
  });
  return readToken(await fetchImpl(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }), Date.now());
}

export async function refreshAccess(config: GoogleClientConfig, refreshToken: string, fetchImpl: FetchLike = fetch): Promise<TokenSet> {
  if (!config.clientId || !config.clientSecret) throw new Error("Tour Core's Google app isn't configured.");
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: config.clientId, client_secret: config.clientSecret });
  const token = await readToken(await fetchImpl(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }), Date.now());
  return { ...token, refreshToken: token.refreshToken ?? refreshToken };
}

export async function revokeToken(token: string, fetchImpl: FetchLike = fetch): Promise<void> {
  await fetchImpl(REVOKE, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() }).catch(() => undefined);
}

export async function googleEmail(accessToken: string, fetchImpl: FetchLike = fetch): Promise<string | undefined> {
  const res = await fetchImpl(USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status !== 200) return undefined;
  const body = (await res.json()) as { email?: string };
  return body.email;
}

async function readToken(res: { status: number; json(): Promise<unknown> }, now: number): Promise<TokenSet> {
  if (res.status !== 200) throw new Error("Google didn't accept that approval. Start the connection again.");
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!body.access_token) throw new Error("Google didn't accept that approval. Start the connection again.");
  return {
    accessToken: body.access_token,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    expiresAt: now + (body.expires_in ?? 3600) * 1000,
    ...(body.scope ? { scope: body.scope } : {}),
  };
}
