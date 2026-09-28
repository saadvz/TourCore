import type { IncomingMessage, ServerResponse } from "node:http";
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RuntimeStore } from "../../storage/runtimeStore";
import { checkClientMetadata, ClientMetadataError, GROK_LEGACY_REDIRECT_URIS, type RedirectPolicy } from "./clients";
import { PAGE_HEADERS, problemPage } from "./pages";
import { OPERATOR_SCOPE, TourCoreOAuthProvider, type ApprovalRequestView, type OAuthEndpoints } from "./provider";
import { hashSecret, OAuthGrantStore } from "./store";

export { endpointsFor, OPERATOR_SCOPE, type OAuthEndpoints } from "./provider";
export { OAuthGrantStore } from "./store";

/**
 * OAuth 2.1 for Tour Core's MCP endpoint, as the MCP authorization spec
 * describes: /mcp is the protected resource, and this same server is its
 * authorization server. Every URL comes from PUBLIC_BASE_URL at request time,
 * so a new tunnel address is picked up on restart without code changes.
 *
 * Public (through the tunnel): the two metadata documents, /authorize,
 * /token, /register, /revoke and the approval-request status page.
 * Local only (this computer's address): approving a request and
 * disconnecting Grok.
 */

const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"];
export const OAUTH_PUBLIC_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/authorize",
  "/token",
  "/register",
  "/revoke",
];
const REQUEST_PATH = /^\/oauth\/requests\/[A-Za-z0-9_-]{16,64}(\/(continue|deny))?$/;
export const isOAuthPublicPath = (path: string, mcpPath: string) =>
  OAUTH_PUBLIC_PATHS.includes(path) || path === `/.well-known/oauth-protected-resource${mcpPath}` || REQUEST_PATH.test(path);
export const isOAuthLocalPath = (path: string) => path === "/api/grok" || path.startsWith("/api/grok/");

export interface McpOAuthOptions {
  runtime: RuntimeStore;
  mcpPath: string;
  endpoints: () => OAuthEndpoints | undefined;
  redirectPolicy: () => RedirectPolicy;
  now?: () => number;
  fetchClientMetadata?: (clientId: string) => Promise<unknown>;
  onApprovalRequest?: (request: ApprovalRequestView) => void;
  log?: (line: string) => void;
  /** Passed to the SDK handlers' express-rate-limit. False turns it off (tests only). */
  rateLimit?: false;
}

const AUTH_DONE = Symbol("tourCoreAuthDone");
type GateRequest = Request & { [AUTH_DONE]?: (auth: AuthInfo | undefined) => void; auth?: AuthInfo };

const oauthError = (res: Response, status: number, error: string, description: string) =>
  res.status(status).set("Cache-Control", "no-store").json({ error, error_description: description });

/** RFC 6749 §2.3.1: form-encoded credentials in the Basic header. */
const formDecode = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));

/**
 * The SDK's token and revocation handlers read client credentials from the
 * form body only and compare them as given. This accepts client_secret_basic
 * too, then swaps the presented secret for its hash so the stored hash is
 * what gets compared.
 */
const clientCredentials: RequestHandler[] = [
  express.urlencoded({ extended: false, limit: "20kb" }),
  (req, res, next) => {
    if (req.method !== "POST") return next();
    const body = (req.body ??= {}) as Record<string, unknown>;
    const basic = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(req.headers.authorization ?? "")?.[1];
    if (basic) {
      const decoded = Buffer.from(basic, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon < 0) return oauthError(res, 401, "invalid_client", "Malformed client credentials.");
      let id: string, secret: string;
      try {
        id = formDecode(decoded.slice(0, colon));
        secret = formDecode(decoded.slice(colon + 1));
      } catch {
        return oauthError(res, 401, "invalid_client", "Malformed client credentials.");
      }
      if (body.client_secret !== undefined || (body.client_id !== undefined && body.client_id !== id)) {
        return oauthError(res, 400, "invalid_request", "Use one client authentication method.");
      }
      body.client_id = id;
      body.client_secret = secret;
    }
    if (typeof body.client_secret === "string") body.client_secret = hashSecret(body.client_secret);
    next();
  },
];

export class McpOAuth {
  readonly provider: TourCoreOAuthProvider;
  readonly store: OAuthGrantStore;
  private readonly apps = new Map<string, { app: Express; gate: Express }>();
  private readonly local: Express;
  private readonly log: (line: string) => void;

  constructor(private readonly options: McpOAuthOptions) {
    this.log = options.log ?? (() => {});
    this.store = new OAuthGrantStore(options.runtime, options.now);
    this.provider = new TourCoreOAuthProvider({
      store: this.store,
      endpoints: options.endpoints,
      redirectPolicy: options.redirectPolicy,
      now: options.now,
      fetchClientMetadata: options.fetchClientMetadata,
      onApprovalRequest: options.onApprovalRequest,
      log: this.log,
    });
    this.local = this.buildLocal();
  }

  endpoints(): OAuthEndpoints | undefined {
    return this.options.endpoints();
  }

  private limits(): Record<string, unknown> | false {
    if (this.options.rateLimit === false) return false;
    // Through the tunnel every request comes from cloudflared on this computer; Cloudflare names the real client.
    return { validate: false, keyGenerator: (req: IncomingMessage) => String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "local") };
  }

  private appsFor(ep: OAuthEndpoints): { app: Express; gate: Express } {
    const cached = this.apps.get(ep.issuer);
    if (cached) return cached;
    const provider = this.provider;
    const rateLimit = this.limits() as never;

    const sdkMetadata = createOAuthMetadata({ provider, issuerUrl: new URL(ep.issuer), scopesSupported: [OPERATOR_SCOPE] });
    const authorizationServerMetadata = {
      ...sdkMetadata,
      // No trailing slash: this exact string is the issuer clients compare `iss` against.
      issuer: ep.issuer,
      token_endpoint_auth_methods_supported: AUTH_METHODS,
      revocation_endpoint_auth_methods_supported: AUTH_METHODS,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
    const protectedResourceMetadata = {
      resource: ep.resource,
      authorization_servers: [ep.issuer],
      scopes_supported: [OPERATOR_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Tour Core",
    };

    /** RFC 9207: every authorization response names the issuer, including the SDK's error redirects. */
    const withIss: RequestHandler = (_req, res, next) => {
      const redirect = res.redirect.bind(res) as (status: number, url: string) => void;
      res.redirect = ((status: number, url: string) => {
        const target = new URL(url);
        if (!target.searchParams.has("iss")) target.searchParams.set("iss", ep.issuer);
        redirect(status, target.href);
      }) as typeof res.redirect;
      next();
    };

    const registrationChecks: RequestHandler[] = [
      express.json({ limit: "20kb" }),
      (req, res, next) => {
        if (req.method !== "POST") return next();
        const policy = this.options.redirectPolicy();
        try {
          req.body = checkClientMetadata(req.body, policy);
          next();
        } catch (err) {
          if (!(err instanceof ClientMetadataError)) throw err;
          this.logRefusedRegistration(req.body, err, policy);
          oauthError(res, 400, err.code, err.message);
        }
      },
    ];

    const app = express();
    app.disable("x-powered-by");
    app.set("etag", false);
    app.use("/.well-known/oauth-authorization-server", metadataHandler(authorizationServerMetadata as never));
    app.use("/.well-known/oauth-protected-resource", metadataHandler(protectedResourceMetadata as never));
    app.use(`/.well-known/oauth-protected-resource${this.options.mcpPath}`, metadataHandler(protectedResourceMetadata as never));
    app.use("/authorize", withIss, authorizationHandler({ provider, rateLimit }));
    app.use("/token", ...clientCredentials, tokenHandler({ provider, rateLimit }));
    app.use("/register", ...registrationChecks, clientRegistrationHandler({ clientsStore: provider.clientsStore, clientSecretExpirySeconds: 0, rateLimit }));
    app.use("/revoke", ...clientCredentials, revocationHandler({ provider, rateLimit }));

    app.get("/oauth/requests/:id", (req, res) => {
      res.set("Cache-Control", "no-store").json({ status: provider.requestStatus(String(req.params.id)) });
    });
    app.post("/oauth/requests/:id/deny", (req, res) => {
      provider.denyFromBrowser(String(req.params.id));
      res.set("Cache-Control", "no-store").json({ ok: true });
    });
    app.get("/oauth/requests/:id/continue", (req, res) => {
      const id = String(req.params.id);
      const status = provider.requestStatus(id);
      const to = status === "pending" ? undefined : provider.finish(id);
      if (!to) {
        const [code, title, message] =
          status === "pending"
            ? [409, "Still waiting", "Approve or deny this connection on the Tour Core computer first."]
            : [410, "This request is finished", "It was already used or it expired. Start connecting again from Grok."];
        res.status(code).set(PAGE_HEADERS).type("html").send(problemPage(title, message));
        return;
      }
      res.set(PAGE_HEADERS).redirect(302, to);
    });
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (res.headersSent) return;
      oauthError(res, 400, "invalid_request", "That request couldn't be read.");
    });

    const gate = express();
    gate.disable("x-powered-by");
    gate.use(requireBearerAuth({ verifier: provider, requiredScopes: [OPERATOR_SCOPE], resourceMetadataUrl: ep.resourceMetadataUrl }));
    gate.use((req: GateRequest) => req[AUTH_DONE]?.(req.auth));

    const built = { app, gate };
    this.apps.set(ep.issuer, built);
    return built;
  }

  /** The public OAuth routes. Without PUBLIC_BASE_URL there is no issuer, so there's nothing to serve. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ep = this.endpoints();
    if (!ep) return json(res, 404, { error: "not_found", error_description: "Set PUBLIC_BASE_URL so Tour Core can publish its OAuth addresses." });
    return run(this.appsFor(ep).app, req, res);
  }

  /** Local operator app: approve, deny, disconnect. The caller has already checked this is the computer's own address. */
  async handleLocal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return run(this.local, req, res);
  }

  /**
   * Validates the bearer token before any MCP message is read. Resolves with
   * the token's info, or undefined after answering 401/403 itself. There is
   * no unauthenticated fallback.
   */
  async authenticate(req: IncomingMessage, res: ServerResponse): Promise<AuthInfo | undefined> {
    const ep = this.endpoints();
    if (!ep) {
      json(res, 503, { error: { message: "Tour Core's OAuth connector needs PUBLIC_BASE_URL set to its https tunnel address." } });
      return undefined;
    }
    if (!req.headers.authorization) {
      // RFC 6750 §3: no error code when no credentials were sent; point the client at the metadata (RFC 9728 §5.1).
      json(res, 401, { error: { message: "Connect Tour Core in Grok to sign in." } }, { "WWW-Authenticate": `Bearer resource_metadata="${ep.resourceMetadataUrl}", scope="${OPERATOR_SCOPE}"` });
      return undefined;
    }
    const { gate } = this.appsFor(ep);
    return new Promise((resolve) => {
      (req as GateRequest)[AUTH_DONE] = resolve;
      res.once("finish", () => resolve(undefined));
      gate(req as Request, res as Response, () => resolve(undefined));
    });
  }

  /**
   * One line per refused redirect URI: scheme, host, path (no query) and why.
   * Registration requests carry no codes, tokens or verifiers; a client
   * secret is never read here.
   */
  private logRefusedRegistration(body: unknown, err: ClientMetadataError, policy: RedirectPolicy): void {
    if (!err.redirects.length) return;
    const name = typeof (body as { client_name?: unknown })?.client_name === "string" ? String((body as { client_name: string }).client_name).slice(0, 80) : "unnamed";
    const total = Array.isArray((body as { redirect_uris?: unknown })?.redirect_uris) ? (body as { redirect_uris: unknown[] }).redirect_uris.length : 0;
    this.log(`Refused an MCP client registration from "${name}": ${err.redirects.length} of ${total} redirect URIs not allowed (the whole registration is refused).`);
    for (const r of err.redirects) {
      this.log(`  refused redirect: scheme=${r.scheme ?? "?"} host=${r.host ?? "-"} path=${r.path ?? "-"} reason: ${r.reason}`);
    }
    const legacy = err.redirects.filter((r) => (GROK_LEGACY_REDIRECT_URIS as readonly string[]).includes(r.uri));
    if (legacy.length && !policy.exact.length) {
      this.log("  That is Cursor's known legacy OAuth callback used by Grok Bot. For P0 Grok testing only, set TOURCORE_GROK_LEGACY_OAUTH_COMPAT=true and restart.");
    }
    if (err.redirects.some((r) => r.scheme === "https" && r.host && !legacy.includes(r))) {
      this.log("  If one of those https addresses really is Grok's callback, add only that host to TOURCORE_OAUTH_REDIRECT_HOSTS.");
    }
  }

  private buildLocal(): Express {
    const app = express();
    app.disable("x-powered-by");
    app.set("etag", false);
    app.use((req, res, next) => {
      // Belt and braces: anything that came through a proxy isn't the owner at this computer.
      if (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.headers.forwarded) return res.status(403).json({ error: { message: "Forbidden" } });
      res.set("Cache-Control", "no-store");
      if (req.method === "POST" && !req.is("application/json")) return res.status(415).json({ error: { message: "Unsupported request." } });
      next();
    });
    app.get("/api/grok", (_req, res) => {
      const ep = this.endpoints();
      res.json({
        mode: "oauth",
        legacyCompat: this.options.redirectPolicy().exact.length > 0,
        connectUrl: ep?.resource,
        pending: this.provider.pendingRequests().map(({ id, matchCode, clientName, redirectHost, createdAt, expiresAt }) => ({ id, matchCode, clientName, redirectHost, createdAt, expiresAt })),
        connections: this.store.connections(),
      });
    });
    const decide = (decision: "approved" | "denied") => (req: Request, res: Response) => {
      if (!this.provider.decide(String(req.params.id), decision)) return res.status(404).json({ error: { message: "That request isn't waiting any more. Start connecting again from Grok." } });
      res.json({ ok: true });
    };
    app.post("/api/grok/requests/:id/approve", decide("approved"));
    app.post("/api/grok/requests/:id/deny", decide("denied"));
    app.post("/api/grok/disconnect", (_req, res) => {
      const removed = this.provider.disconnectAll();
      this.log(`Disconnected Grok: removed ${removed.grants} approval${removed.grants === 1 ? "" : "s"}. Tours, properties and messaging are unchanged.`);
      res.json({ ok: true, removed });
    });
    return app;
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(JSON.stringify(body));
}

function run(app: Express, req: IncomingMessage, res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    res.once("finish", resolve);
    res.once("close", resolve);
    app(req as Request, res as Response, (err?: unknown) => {
      if (!res.headersSent) json(res, err ? 400 : 404, err ? { error: "invalid_request", error_description: "That request couldn't be read." } : { error: "not_found" });
      resolve();
    });
  });
}
