import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Which OAuth clients may be sent an authorization code, and where. Grok
 * registers itself (RFC 7591 Dynamic Client Registration) with redirect URIs
 * on its own hosts; a client using a Client ID Metadata Document names its
 * redirect URIs there. Either way every redirect URI must pass the same rule:
 * https on an allowed host, or a loopback address (RFC 8252 native apps).
 * Nothing else: no wildcards, custom schemes, fragments or credentials. The
 * one opt-in exception is a short list of exact URIs (Grok legacy compat).
 */

/** Grok's hosts. Extend with TOURCORE_OAUTH_REDIRECT_HOSTS (comma-separated). Subdomains are included. */
export const DEFAULT_REDIRECT_HOSTS = ["grok.com", "x.ai", "x.com"];
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The callbacks Grok Bot (through Cursor's MCP client) was seen registering
 * that the strict rule refuses. Accepted only with
 * TOURCORE_GROK_LEGACY_OAUTH_COMPAT=true, and only as these exact strings.
 * (Its third callback, http://localhost:8787/callback, is loopback and
 * already allowed.)
 */
export const GROK_LEGACY_REDIRECT_URIS = ["cursor://anysphere.cursor-mcp/oauth/callback", "https://www.cursor.com/agents/mcp/oauth/callback"] as const;

export interface RedirectPolicy {
  /** https hosts (and their subdomains). */
  hosts: string[];
  /** Individual redirect URIs allowed by exact string match, outside the host rule. */
  exact: readonly string[];
}

export const grokLegacyCompatFromEnv = (env: NodeJS.ProcessEnv = process.env) => env.TOURCORE_GROK_LEGACY_OAUTH_COMPAT?.trim().toLowerCase() === "true";

export function redirectHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.TOURCORE_OAUTH_REDIRECT_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^\*?\./, ""))
    .filter((h) => /^[a-z0-9.-]+$/.test(h) && h.includes("."));
  return [...new Set([...DEFAULT_REDIRECT_HOSTS, ...extra])];
}

export function redirectPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RedirectPolicy {
  return { hosts: redirectHostsFromEnv(env), exact: grokLegacyCompatFromEnv(env) ? GROK_LEGACY_REDIRECT_URIS : [] };
}

export const strictPolicy = (hosts: string[] = DEFAULT_REDIRECT_HOSTS): RedirectPolicy => ({ hosts, exact: [] });

const hostAllowed = (hostname: string, hosts: string[]) => hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`));

export interface RedirectProblem {
  uri: string;
  reason: string;
  /** For logs: the URI's parts without its query or fragment. */
  scheme?: string;
  host?: string;
  path?: string;
}

/** Undefined when the redirect URI is acceptable; otherwise why not. */
export function checkRedirectUri(uri: string, policy: RedirectPolicy, applicationType?: "web" | "native"): RedirectProblem | undefined {
  if (typeof uri === "string" && policy.exact.includes(uri)) return undefined;
  let parts: Pick<RedirectProblem, "scheme" | "host" | "path"> = {};
  try {
    const u = new URL(uri);
    parts = { scheme: u.protocol.replace(/:$/, ""), host: u.host.toLowerCase() || undefined, path: u.pathname || "/" };
  } catch {
    // Reported below as not a web address.
  }
  const problem = (reason: string): RedirectProblem => ({ uri, reason, ...parts });
  const hosts = policy.hosts;
  if (typeof uri !== "string" || !uri || uri.length > 2000) return problem("isn't a web address");
  if (uri.includes("*")) return problem("uses a wildcard");
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return problem("isn't a web address");
  }
  if (url.hash || uri.includes("#")) return problem("has a fragment");
  if (url.username || url.password) return problem("contains credentials");
  const hostname = url.hostname.toLowerCase();
  if (url.protocol === "http:") {
    if (!LOOPBACK.has(hostname)) return problem("isn't https");
    if (applicationType === "web") return problem("is a loopback address, which a web client can't use");
    return undefined;
  }
  if (url.protocol !== "https:") return problem(url.protocol === "cursor:" ? "uses a custom scheme (cursor://)" : "isn't https");
  if (!hostAllowed(hostname, hosts)) return problem("isn't on an allowed host");
  return undefined;
}

export class ClientMetadataError extends Error {
  constructor(
    readonly code: "invalid_redirect_uri" | "invalid_client_metadata",
    message: string,
    /** Every refused redirect URI in the request, not just the first. */
    readonly redirects: RedirectProblem[] = [],
  ) {
    super(message);
  }
}

const GRANTS = new Set(["authorization_code", "refresh_token"]);
const AUTH_METHODS = new Set(["none", "client_secret_post", "client_secret_basic"]);

type Metadata = Record<string, unknown>;
const stringArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * RFC 7591 / OpenID registration checks the SDK's schema doesn't make
 * (it strips application_type and accepts any grant or auth method).
 * Returns the metadata with RFC 7591 defaults filled in.
 */
export function checkClientMetadata(body: unknown, policy: RedirectPolicy, allowedAuthMethods: Set<string> = AUTH_METHODS): Metadata {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ClientMetadataError("invalid_client_metadata", "Client metadata must be a JSON object.");
  const m = body as Metadata;
  if (m.application_type !== undefined && m.application_type !== "web" && m.application_type !== "native") {
    throw new ClientMetadataError("invalid_client_metadata", "application_type must be web or native.");
  }
  const appType = m.application_type as "web" | "native" | undefined;
  if (!stringArray(m.redirect_uris) || !(m.redirect_uris as string[]).length) throw new ClientMetadataError("invalid_redirect_uri", "redirect_uris must list at least one address.");
  if ((m.redirect_uris as string[]).length > 10) throw new ClientMetadataError("invalid_redirect_uri", "Too many redirect_uris.");
  // One bad URI refuses the whole registration (never silently dropped), but every bad one is reported.
  const refused = (m.redirect_uris as string[]).map((uri) => checkRedirectUri(uri, policy, appType)).filter((p): p is RedirectProblem => !!p);
  if (refused.length) throw new ClientMetadataError("invalid_redirect_uri", `redirect_uri ${refused[0]!.reason}.`, refused);
  const grantTypes = m.grant_types === undefined ? ["authorization_code"] : m.grant_types;
  if (!stringArray(grantTypes) || !(grantTypes as string[]).every((g) => GRANTS.has(g)) || !(grantTypes as string[]).includes("authorization_code")) {
    throw new ClientMetadataError("invalid_client_metadata", "grant_types must be authorization_code, optionally with refresh_token.");
  }
  const responseTypes = m.response_types === undefined ? ["code"] : m.response_types;
  if (!stringArray(responseTypes) || (responseTypes as string[]).length !== 1 || (responseTypes as string[])[0] !== "code") {
    throw new ClientMetadataError("invalid_client_metadata", "response_types must be code.");
  }
  const authMethod = m.token_endpoint_auth_method === undefined ? "client_secret_basic" : m.token_endpoint_auth_method;
  if (typeof authMethod !== "string" || !allowedAuthMethods.has(authMethod)) {
    throw new ClientMetadataError("invalid_client_metadata", `token_endpoint_auth_method must be one of ${[...allowedAuthMethods].join(", ")}.`);
  }
  if (m.client_name !== undefined && (typeof m.client_name !== "string" || m.client_name.length > 200)) {
    throw new ClientMetadataError("invalid_client_metadata", "client_name must be a short string.");
  }
  return { ...m, grant_types: grantTypes, response_types: responseTypes, token_endpoint_auth_method: authMethod };
}

// ---- Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document) ----

export const isMetadataDocumentClientId = (clientId: string) => /^https:\/\//i.test(clientId);

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) PRIVATE.addSubnet(net, bits, "ipv6");

const isPrivateAddress = (address: string) => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return PRIVATE.check(mapped, "ipv4");
  return PRIVATE.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
};

/** The client_id URL itself: https, a real path, and a public host (the server fetches it, so no internal addresses). */
export function checkMetadataDocumentUrl(clientId: string): URL {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new ClientMetadataError("invalid_client_metadata", "client_id isn't a valid URL.");
  }
  if (url.protocol !== "https:" || url.pathname === "/" || url.hash || url.username || url.password || url.href !== clientId || /\/\.\.?(\/|$)/.test(url.pathname)) {
    throw new ClientMetadataError("invalid_client_metadata", "client_id must be an https URL with a path.");
  }
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, "")) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new ClientMetadataError("invalid_client_metadata", "client_id must be on a public host.");
  }
  return url;
}

const MAX_DOCUMENT_BYTES = 5 * 1024;

/** Fetches a Client ID Metadata Document with SSRF guards: public addresses only, no redirects, 5 KB, 5 seconds. */
export async function fetchMetadataDocument(clientId: string): Promise<unknown> {
  const url = checkMetadataDocumentUrl(clientId);
  const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new ClientMetadataError("invalid_client_metadata", "client_id must resolve to a public address.");
  }
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" } });
  if (!res.ok) throw new ClientMetadataError("invalid_client_metadata", "The client metadata document couldn't be fetched.");
  if (Number(res.headers.get("content-length") ?? 0) > MAX_DOCUMENT_BYTES) throw new ClientMetadataError("invalid_client_metadata", "The client metadata document is too large.");
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) throw new ClientMetadataError("invalid_client_metadata", "The client metadata document is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new ClientMetadataError("invalid_client_metadata", "The client metadata document isn't JSON.");
  }
}

/** Validates a fetched document. Such clients have no shared secret with Tour Core, so only public-client auth ("none") is accepted. */
export function parseMetadataDocument(clientId: string, document: unknown, policy: RedirectPolicy): OAuthClientInformationFull {
  checkMetadataDocumentUrl(clientId);
  const doc = document as Metadata;
  if (!doc || typeof doc !== "object" || doc.client_id !== clientId) throw new ClientMetadataError("invalid_client_metadata", "The metadata document's client_id doesn't match its URL.");
  if (doc.client_secret !== undefined || doc.client_secret_expires_at !== undefined) {
    throw new ClientMetadataError("invalid_client_metadata", "A client metadata document can't carry a client secret.");
  }
  const checked = checkClientMetadata({ token_endpoint_auth_method: "none", ...doc }, policy, new Set(["none"]));
  return {
    client_id: clientId,
    client_name: typeof doc.client_name === "string" ? doc.client_name : undefined,
    client_uri: typeof doc.client_uri === "string" ? doc.client_uri : undefined,
    redirect_uris: checked.redirect_uris as string[],
    grant_types: checked.grant_types as string[],
    response_types: checked.response_types as string[],
    token_endpoint_auth_method: "none",
  };
}
