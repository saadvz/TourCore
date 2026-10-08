import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { createStore, liveTransportFor } from "../createTourCore";
import { MessagingLedger } from "../messaging/ledger";
import type { InboundMessage } from "../messaging/inbound";
import { handleProviderWebhook } from "../messaging/pipeline";
import { anyPropertyUsesLocal, usesLocalMessaging } from "../messaging/propertyScope";
import { activeFromNumber, bindMessagingInstallation, createMessagingProvider, selectionFromInstallation } from "../messaging/registry";
import { consentModeForProvider } from "../messaging/consentPolicy";
import { SENDBLUE_WEBHOOK_PATH } from "../messaging/sendblue/runtime";
import { handleSendblueWebhook } from "../messaging/sendblue/webhook";
import { LOCAL_WEBHOOK_PATH } from "../messaging/local/provider";
import { resetLocalSmsOutbox } from "../messaging/local/outbox";
import { PHOTON_WEBHOOK_PATH } from "../messaging/photon/provider";
import { TWILIO_WEBHOOK_PATH } from "../messaging/twilio/provider";
import { publicBaseUrl } from "../messaging/publicUrl";
import { createIntentInterpreter, intentModelFromEnv, type IntentInterpreter } from "../intent";
import { mcpAuthModeFromEnv, type McpAuthMode } from "../mcp/authMode";
import { authorized, handleMcpMessage, MCP_PATH } from "../mcp/mcpBridge";
import { reportedClientFromInitialize, type ReportedClient } from "../playbooks/select";
import { endpointsFor, isOAuthLocalPath, isOAuthPublicPath, McpOAuth } from "../mcp/oauth";
import { grokLegacyCompatFromEnv, hostedCompatStartupLine, redirectPolicyFor } from "../mcp/oauth/clients";
import { AuditExportLinks } from "../operator/auditExportLinks";
import { ConfirmationBook } from "../operator/confirmations";
import type { ToolContext } from "../operator/tools";
import { PropertyWorkspace } from "../setup";
import { rememberWaiter } from "../setup/pauseWaiters";
import { MessagingEndpoints } from "../messaging/endpoints";
import { FileRuntimeStore } from "../storage/runtimeStore";
import { VisitorDemoRegistry, type VisitorDemoSession } from "../visitor";
import { adoptLegacyLine, MessagingConversations } from "../visitor/messagingRouter";
import { VerificationLinks } from "../visitor/verificationLinks";
import { OperatorUpdates } from "../alerts/operatorUpdates";
import { HEALTH_PATH, publicHealth, runtimeHealth } from "../install/checks";
import { isHostedRailway, resolveDeploymentMode } from "../install/deployment";
import { handleHostedApproval } from "../install/hostedApproval";
import { HOSTED_OWNER_RESET, OAUTH_REQUEST_ID } from "../install/hostedOwner";
import { RAILWAY_HEALTHCHECK_HOST, redactSecrets, startupLines, validateHostedConfig } from "../install/hostedRuntime";
import { applyHostedStorageGuard, runStorageCheck } from "../install/persistentVolume";
import { Installation, TOURCORE_VERSION } from "../install/installation";
import { bindHostedTenant, clearHostedTenant, hostedTenantDecision, HOSTED_TENANT_RESET } from "../install/tenant";
import { installedMessaging } from "../install/status";
import { handleSecureSetupApi, INSTALL_PAGE_PATHS, isInstallApiPath, PROXY_HEADERS } from "../install/secureSetup";
import { clearRuntimeInfo, writeRuntimeInfo } from "../install/service";
import { secretValues, useSettingsSource } from "../install/settings";
import { handlePortableRequest } from "../backup/http";
import { handleApi } from "./api";
import { buildComplianceConfig, isPublicCompliancePath, matchCompliancePath } from "./compliance/config";
import { renderCompliancePage } from "./compliance/pages";
import { loadLocalEnv } from "./env";

const PUBLIC_DIR = new URL("./public/", import.meta.url);
const JS = "text/javascript; charset=utf-8";
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/visitor": { file: "visitor.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: JS },
  "/ui.js": { file: "ui.js", type: JS },
  "/tours.js": { file: "tours.js", type: JS },
  "/visitor.js": { file: "visitor.js", type: JS },
  "/verify.js": { file: "verify.js", type: JS },
  "/grok": { file: "grok.html", type: "text/html; charset=utf-8" },
  "/grok.js": { file: "grok.js", type: JS },
  "/connect": { file: "connect.html", type: "text/html; charset=utf-8" },
  "/connect.js": { file: "connect.js", type: JS },
  "/oauth.js": { file: "oauth.js", type: JS },
  "/install": { file: "install.html", type: "text/html; charset=utf-8" },
  "/install.js": { file: "install.js", type: JS },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};
const MAX_BODY_BYTES = 1_000_000;

export interface SetupServerOptions {
  workspace?: PropertyWorkspace;
  dev?: boolean;
  now?: () => Date;
  /** Clock for real-phone conversations; tests move it to reach tour times. */
  realNow?: () => number;
  /** How typed visitor messages are read. Defaults to the built-in rules, plus a language model when one is configured. */
  interpreter?: IntentInterpreter;
  /** Live conversations for this process. Tests pass their own to look inside. */
  visitors?: VisitorDemoRegistry;
  log?: (line: string) => void;
  /** Defaults to TOURCORE_MCP_AUTH_MODE (oauth unless set to static). */
  mcpAuth?: McpAuthMode;
  /** Static mode's bearer token. Passing it without `mcpAuth` selects static mode. Unset means the connector is off. */
  operatorToken?: () => string | undefined;
  /** Clock for OAuth codes and tokens. */
  authNow?: () => number;
  /** Fetches OAuth Client ID Metadata Documents. Tests replace the network here. */
  fetchClientMetadata?: (clientId: string) => Promise<unknown>;
  /** A client asked to connect; the owner approves at this local address. */
  onApprovalRequest?: (approvalPageUrl: string) => void;
  /** Tests only: turn off the OAuth endpoints' rate limits. */
  oauthRateLimit?: false;
  /** This installation (manifest, provider settings, alert outbox). Defaults to one in the workspace's folder. */
  installation?: Installation;
  /** How often pending operator alerts are retried. */
  alertRetryMs?: number;
  /** Test hook: pause inside the property slot lock. */
  slotLockBarrier?: import("../core/TourCore").TourCoreDeps["slotLockBarrier"];
}

/** The server plus a handle tests use to wait for background operator alerts. */
export interface TourCoreServer extends Server {
  tourCore: {
    installation: Installation;
    alerts: OperatorUpdates;
    /** Resolves once every alert scan and delivery started so far has finished. */
    settled(): Promise<void>;
    storageReady: Promise<{ ok: boolean; summary: string }>;
    tickOverstay(): Promise<void>;
  };
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export const operatorTokenFromEnv = () => process.env.TOURCORE_OPERATOR_TOKEN?.trim() || undefined;

/**
 * What the public (tunnel) address may reach: the webhook, the identity form,
 * the operator tools for an agent host (authorization required) and, in OAuth
 * mode, the OAuth endpoints. Never the browser operator app, and never the
 * page where the owner approves a connection.
 */
function publicRouteAllowed(method: string, path: string, oauth: boolean, hosted: boolean): boolean {
  if (path === MCP_PATH) return true;
  if (method === "GET" && path === HEALTH_PATH) return true;
  if (method === "GET" && path === "/google/oauth/callback") return true;
  if (/^\/portable\/(?:artifacts|uploads)\/art_[A-Za-z0-9_-]{20,80}$/.test(path)) {
    return (method === "GET" && path.startsWith("/portable/artifacts/")) || (method === "POST" && path.startsWith("/portable/uploads/"));
  }
  if (oauth && (isOAuthPublicPath(path, MCP_PATH) || (method === "GET" && path === "/oauth.js"))) return true;
  if (method === "POST" && (path === SENDBLUE_WEBHOOK_PATH || path === TWILIO_WEBHOOK_PATH || path === PHOTON_WEBHOOK_PATH || path === LOCAL_WEBHOOK_PATH)) return true;
  if (method === "GET" && isPublicCompliancePath(path)) return true;
  if (method === "GET" && (/^\/verify\/[A-Za-z0-9_-]+$/.test(path) || path === "/verify.js" || path === "/styles.css")) return true;
  if (hosted && method === "GET" && (path === "/connect" || path === "/connect.js" || path === "/install" || path === "/install.js" || path === "/styles.css")) return true;
  if (hosted && (path === "/api/connect" || path === "/api/connect/approve" || path === "/api/connect/deny" || isInstallApiPath(path))) return true;
  if (method === "GET" && AuditExportLinks.parsePath(path)) return true;
  return /^\/api\/verify\/[A-Za-z0-9_-]+$/.test(path) && (method === "GET" || method === "POST");
}

const forwardedProto = (req: IncomingMessage) => String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim().toLowerCase();

function safeManifestProvider(installation: Installation) {
  try {
    return installation.files.manifest()?.messagingProvider;
  } catch {
    return undefined;
  }
}

/**
 * The local setup app plus the two things a real phone needs: the messaging
 * receive webhook and the identity-form page. Operator pages and APIs answer
 * only on this computer's own address.
 */
export function createSetupServer(options: SetupServerOptions = {}): TourCoreServer {
  const workspace = options.workspace ?? new PropertyWorkspace();
  const visitors = options.visitors ?? new VisitorDemoRegistry();
  visitors.useApprovedContent((id) => (workspace.has(id) ? workspace.load(id).config : undefined));
  visitors.useAvailability((id) => (workspace.has(id) ? workspace.load(id).state : undefined));
  visitors.usePauseWaiters((id, waiter) => rememberWaiter(workspace.root, id, waiter));
  const dev = options.dev ?? false;
  const log = options.log ?? ((line: string) => console.log(`  ${line}`));
  const runtime = options.installation?.runtime ?? new FileRuntimeStore(join(workspace.root, "runtime"));
  const installation = options.installation ?? new Installation({ root: workspace.root, runtime, log });
  // Adapters read credentials through the settings layer; this installation's secure-setup values join the environment's.
  const restoreSettings = useSettingsSource(installation.settingsSource());
  const restoreMessaging = bindMessagingInstallation(() => ({
    env: installation.env(),
    sendblue: installation.sendblueEnv(),
    choice: installation.files.state().messagingProviderChoice,
    manifestProvider: safeManifestProvider(installation),
  }));
  const ledger = new MessagingLedger(join(workspace.root, "runtime", "messaging-ledger", "ledger.json"), 5000, join(workspace.root, "messaging", "ledger.json"));
  const links = new VerificationLinks({ baseUrl: () => installation.publicBaseUrl() ?? publicBaseUrl(installation.env()), now: options.realNow, store: runtime });
  const endpoints = new MessagingEndpoints(runtime);
  const messagingLine = () => activeFromNumber(installation);
  try {
    adoptLegacyLine(workspace, endpoints, messagingLine(), log, selectionFromInstallation(installation).provider);
  } catch (err) {
    log(`Couldn't connect the texting number to a property: ${err instanceof Error ? err.message : "unknown error"}`);
  }
  let transport: ReturnType<typeof liveTransportFor> | undefined;
  let localTransport: ReturnType<typeof liveTransportFor> | undefined;
  const resetMessaging = () => {
    transport = undefined;
    localTransport = undefined;
  };
  const transportFor = (propertyId?: string) => {
    if (propertyId) {
      try {
        const draft = workspace.openDraft(propertyId).draft;
        if (usesLocalMessaging(draft, selectionFromInstallation(installation))) {
          return (localTransport ??= createMessagingProvider("local", { env: () => installation.env(), sendblue: () => installation.sendblueEnv(), ledger, now: options.now }));
        }
      } catch {
        // Unknown property uses the installation transport.
      }
    }
    return (transport ??= liveTransportFor(installation, ledger));
  };
  // Operator updates run after the visitor has been answered and saved; a failure here never reaches the visitor.
  let alertWork: Promise<void> = Promise.resolve();
  const afterSave = (propertyId: string) => {
    alertWork = alertWork
      .then(async () => {
        if (await alerts.scan(propertyId)) await installation.outbox.drain();
      })
      .catch((err) => log(`Couldn't queue an operator alert: ${err instanceof Error ? err.message : "unknown error"}`));
  };
  const conversations = new MessagingConversations({
    workspace,
    registry: visitors,
    links,
    runtime,
    endpoints,
    defaultLine: messagingLine,
    transport: transportFor,
    now: options.now,
    realNow: options.realNow,
    interpreter: options.interpreter ?? createIntentInterpreter({ log }),
    log,
    consentMode: () => consentModeForProvider(installation.env(), selectionFromInstallation(installation).provider),
    publicBaseUrl: () => installation.publicBaseUrl(),
    onSaved: (session) => afterSave(session.propertyId),
    storeFor: (config) => installation.records.wrapStore(createStore(config)),
    storageRead: () => installation.records.storageRead(),
    beforeAccess: () => installation.records.beforeAccess(),
    ...(options.slotLockBarrier ? { slotLockBarrier: options.slotLockBarrier } : {}),
  });
  const restored = installation.records
    .warm()
    .catch((err) => log(`Couldn't open Google Drive: ${err instanceof Error ? err.message : "unknown error"}`))
    .then(() => conversations
    .restoreSaved()
    .then((n) => {
      const needsAttention = conversations.attentionCount;
      if (n) log(`Picked up ${n} text-message tour${n === 1 ? "" : "s"} where ${n === 1 ? "it" : "they"} left off.`);
      if (needsAttention) log(`${needsAttention} text-message tour${needsAttention === 1 ? "" : "s"} couldn't be restored safely and need${needsAttention === 1 ? "s" : ""} attention.`);
    })
    .catch((err) => log(`Couldn't restore earlier text-message tours: ${err instanceof Error ? err.message : "unknown error"}`)));
  // First start with alerts: issues that already exist are recorded, not announced. Then retry anything left pending before a restart.
  alertWork = restored.then(async () => {
    try {
      const state = installation.files.state();
      if (!state.alertsBaselineAt) {
        await alerts.baseline();
        installation.files.writeState({ ...installation.files.state(), alertsBaselineAt: new Date(installation.now()).toISOString() });
      }
      await conversations.tickOverstay();
      await installation.outbox.drain();
    } catch (err) {
      log(`Couldn't check for pending operator alerts: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  });
  const api = {
    workspace,
    visitors,
    links,
    dev,
    now: options.now,
    runtime,
    endpoints,
    messagingLine,
    persist: (session: VisitorDemoSession) => conversations.save(session),
    openMessagingSession: (propertyId: string, phone: string) => conversations.openOutbound(propertyId, phone),
    releaseUnconfirmedTours: () => conversations.releaseUnconfirmed(),
    needsAttention: (propertyId: string) => conversations.needsAttention(propertyId),
    installedMessaging: () => installedMessaging(installation),
    receiveInbound: (message: InboundMessage) => conversations.receive(message),
  };
  const alerts = new OperatorUpdates({ services: api, outbox: installation.outbox, preferences: () => installation.files.state().operatorUpdates, log });
  installation.setRelevanceCheck((event) => alerts.stillRelevant(event));
  const operatorToken = options.operatorToken ?? operatorTokenFromEnv;
  const authMode = options.mcpAuth ?? (options.operatorToken ? "static" : mcpAuthModeFromEnv());
  let server: Server;
  const approvalPage = () => `${tools.localUrl?.() ?? "http://localhost:4321"}/grok`;
  let lastApprovalWindow = 0;
  const hostedMode = () => isHostedRailway(installation.deploymentMode());
  let storageGate: { settled: boolean; ok: boolean; summary: string } = { settled: !hostedMode(), ok: true, summary: "local" };
  const storageReady = (async () => {
    if (!hostedMode()) return storageGate;
    const result = await installation.records.resumeCanonical();
    storageGate = { settled: true, ok: result.ok, summary: result.summary };
    if (!result.ok) log(result.summary);
    return storageGate;
  })();
  const oauth =
    authMode === "oauth"
      ? new McpOAuth({
          runtime,
          mcpPath: MCP_PATH,
          endpoints: () => {
            const base = installation.publicBaseUrl();
            return base ? endpointsFor(base, MCP_PATH) : undefined;
          },
          redirectPolicy: () => redirectPolicyFor(installation.env(), installation.deploymentMode()),
          legacyCompatNote: () =>
            installation.env().TOURCORE_GROK_LEGACY_OAUTH_COMPAT?.trim().toLowerCase() === "false"
              ? "  That is Cursor's known legacy OAuth callback. Compatibility is off because TOURCORE_GROK_LEGACY_OAUTH_COMPAT=false."
              : undefined,
          now: options.authNow,
          fetchClientMetadata: options.fetchClientMetadata,
          tenantPolicy: (clientId) => (hostedMode() ? hostedTenantDecision(installation.files.state(), clientId) : { allowed: true }),
          onOwnerApproved: (clientId) => {
            if (hostedMode()) bindHostedTenant(installation.files, clientId, new Date(installation.now()));
          },
          approvalPlace: () => (hostedMode() ? "hosted" : "computer"),
          publicApproval: (clientId) => {
            if (!hostedMode()) return false;
            const bound = installation.files.state().hostedTenant?.clientId;
            return !bound || bound === clientId;
          },
          hostedClaimed: () => hostedMode() && !!installation.files.state().hostedTenant?.clientId,
          onApprovalRequest: (request) => {
            log(`${request.clientName} is asking to connect to Tour Core (code ${request.matchCode}).`);
            if (hostedMode()) return;
            log(`Approve or deny it at ${approvalPage()}`);
            // Anyone with the tunnel URL can ask; one window at a time is enough, the page lists every request.
            if (request.createdAt - lastApprovalWindow < 20_000) return;
            lastApprovalWindow = request.createdAt;
            options.onApprovalRequest?.(approvalPage());
          },
          log,
          rateLimit: options.oauthRateLimit,
        })
      : undefined;
  const confirmations = new ConfirmationBook();
  /** Playbook client, keyed by MCP session id, signed-in caller, or the one static token. */
  const playbookClients = new Map<string, ReportedClient>();
  const sessionHeader = (req: IncomingMessage) => {
    const raw = req.headers["mcp-session-id"];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    return value || undefined;
  };
  const playbookKey = (sessionId: string | undefined, caller?: { clientId?: string }) => {
    if (sessionId) return `session:${sessionId}`;
    if (caller?.clientId) return `caller:${caller.clientId}`;
    return "static";
  };
  const tools: ToolContext = {
    services: api,
    confirmations,
    now: () => options.now?.() ?? new Date(),
    localUrl: () => {
      const address = server?.address();
      return typeof address === "object" && address ? `http://localhost:${address.port}` : undefined;
    },
    installation,
    resetMessaging,
    messagingLedger: ledger,
    forgetLiveState: () => {
      ledger.clear();
      visitors.clear();
      conversations.dropLive();
      confirmations.clear();
      oauth?.provider.discardPending();
      installation.approvals.discard();
      resetLocalSmsOutbox();
    },
  };

  server = createServer(async (req, res) => {
    const send = (status: number, type: string, body: string, extra: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
      res.end(body);
    };

    // Local addresses get everything; the configured public address gets only the phone-facing routes.
    // Anything else is refused (blocks DNS-rebinding tricks).
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    const publicBase = installation.publicBaseUrl();
    const publicHost = publicBase ? new URL(publicBase).hostname.toLowerCase() : undefined;
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const isLocal = LOCAL_HOSTS.includes(host);
    const hosted = hostedMode();
    const railwayHealth = host === RAILWAY_HEALTHCHECK_HOST && method === "GET" && url.pathname === HEALTH_PATH;
    if (method === "GET" && url.pathname === HEALTH_PATH && (isLocal || railwayHealth || (publicHost && host === publicHost))) {
      if (hosted && (!storageGate.settled || !storageGate.ok)) return send(503, "application/json; charset=utf-8", JSON.stringify({ ok: false, service: "tour-core" }));
      return send(200, "application/json; charset=utf-8", JSON.stringify(isLocal ? { ...publicHealth(installation), ...runtimeHealth(installation) } : publicHealth(installation)));
    }
    if (!isLocal && !(publicHost && host === publicHost && publicRouteAllowed(method, url.pathname, !!oauth, hosted))) {
      return send(isLocal || host === publicHost ? 404 : 403, "text/plain", isLocal || host === publicHost ? "Not found" : "Forbidden");
    }

    const secretPage =
      INSTALL_PAGE_PATHS.includes(url.pathname) ||
      isInstallApiPath(url.pathname) ||
      url.pathname === "/connect" ||
      url.pathname === "/connect.js" ||
      url.pathname === "/api/connect" ||
      url.pathname === "/api/connect/approve" ||
      url.pathname === "/api/connect/deny";
    if (secretPage) {
      if (hosted) {
        const proto = forwardedProto(req);
        if (proto !== "https") return send(404, "text/plain", "Not found");
      } else if (url.pathname !== "/connect" && url.pathname !== "/connect.js" && !isLocal) {
        return send(404, "text/plain", "Not found");
      } else if (!hosted && (INSTALL_PAGE_PATHS.includes(url.pathname) || isInstallApiPath(url.pathname)) && (!isLocal || PROXY_HEADERS.some((h) => req.headers[h] !== undefined))) {
        return send(404, "text/plain", "Not found");
      }
    }

    if (method === "GET") {
      const compliance = matchCompliancePath(url.pathname);
      if (compliance) {
        if (!compliance.exact) return send(301, "text/plain; charset=utf-8", "Redirecting", { Location: compliance.canonical });
        const html = renderCompliancePage(compliance.id, buildComplianceConfig(process.env, publicBase));
        return send(200, "text/html; charset=utf-8", html);
      }
    }

    await restored;
    try {
      if (method === "GET" && url.pathname === "/google/oauth/callback") {
        const result = await installation.records.completeCallback(url.searchParams);
        const page = `<!doctype html><meta name="referrer" content="no-referrer"><title>Tour Core</title><p>${result.ok ? "Google Drive is connected to Tour Core. You can return to the chat." : "Google Drive wasn't connected. Return to the chat and try again."}</p>`;
        return send(result.ok ? 200 : 400, "text/html; charset=utf-8", page, { "Referrer-Policy": "no-referrer" });
      }
      const portable = await handlePortableRequest(installation.backups, method, url.pathname, req);
      if (portable) return send(portable.status, portable.type, portable.body, { "Referrer-Policy": "no-referrer" });
      if (url.pathname === "/api/connect" || url.pathname === "/api/connect/approve" || url.pathname === "/api/connect/deny") {
        if (!hosted) return send(404, "text/plain", "Not found");
        if (method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return send(415, "application/json", JSON.stringify({ error: { message: "Unsupported request." } }));
        }
        const body = method === "POST" ? JSON.parse((await readRaw(req)).toString("utf8") || "{}") : undefined;
        const result = handleHostedApproval(installation, oauth, method, url, req.headers, body);
        return send(result.status, "application/json; charset=utf-8", JSON.stringify(result.json), { "Referrer-Policy": "no-referrer" });
      }
      if (hosted && method === "GET" && url.pathname === "/connect") {
        const requestId = url.searchParams.get("request") ?? "";
        if (!OAUTH_REQUEST_ID.test(requestId)) {
          const missing = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Connect to Tour Core</title><link rel="stylesheet" href="/styles.css"></head><body><main><h1>Connect to Tour Core</h1><p>This approval link is missing or was opened without its code.</p></main></body></html>`;
          return send(400, "text/html; charset=utf-8", missing, { "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
        }
        return send(200, "text/html; charset=utf-8", readFileSync(new URL("connect.html", PUBLIC_DIR), "utf8"), { "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
      }
      if (isInstallApiPath(url.pathname)) {
        if (method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return send(415, "application/json", JSON.stringify({ error: { message: "Unsupported request." } }));
        }
        const body = method === "POST" ? JSON.parse((await readRaw(req)).toString("utf8") || "{}") : undefined;
        const result = await handleSecureSetupApi({ installation, services: api, resetMessaging }, method, url.pathname, req.headers, body);
        return send(result.status, "application/json; charset=utf-8", JSON.stringify(result.json), { "Referrer-Policy": "no-referrer" });
      }
      if (oauth && isOAuthPublicPath(url.pathname, MCP_PATH)) return await oauth.handle(req, res);
      if (isOAuthLocalPath(url.pathname)) {
        if (!isLocal) return send(404, "text/plain", "Not found");
        if (oauth) return await oauth.handleLocal(req, res);
        return send(200, "application/json; charset=utf-8", JSON.stringify({ mode: typeof authMode === "string" ? authMode : "off" }));
      }
      if (url.pathname === MCP_PATH) {
        const json = "application/json; charset=utf-8";
        if (typeof authMode !== "string") {
          return send(503, json, JSON.stringify({ error: { message: "The Tour Core connector is off: TOURCORE_MCP_AUTH_MODE must be oauth or static." } }));
        }
        let caller: { clientId?: string } | undefined;
        if (oauth) {
          // Token checked before the body is read; failures have already been answered (401/403).
          const auth = await oauth.authenticate(req, res);
          if (!auth) return;
          caller = { clientId: auth.clientId };
        } else {
          const token = operatorToken();
          if (!token) return send(503, json, JSON.stringify({ error: { message: "The Tour Core connector is off. Run `npm run grok:connect -- --static` on the Tour Core computer to turn it on." } }));
          if (!authorized(req.headers.authorization, token)) {
            return send(401, json, JSON.stringify({ error: { message: "Missing or wrong Tour Core connector token." } }), { "WWW-Authenticate": 'Bearer realm="tour-core"' });
          }
        }
        if (method !== "POST") return send(405, json, JSON.stringify({ error: { message: "Send MCP requests with POST." } }), { Allow: "POST" });
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(415, json, JSON.stringify({ error: { message: "Unsupported request." } }));
        let message: unknown;
        try {
          message = JSON.parse((await readRaw(req)).toString("utf8"));
        } catch {
          return send(400, json, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "That request couldn't be read." } }));
        }
        const seen = reportedClientFromInitialize(message);
        const incomingSession = sessionHeader(req);
        const key = playbookKey(incomingSession, caller);
        if (seen) playbookClients.set(key, seen);
        const reportedClient = seen ?? playbookClients.get(key);
        const reply = await handleMcpMessage({ ...tools, ...(caller ? { caller } : {}), ...(reportedClient ? { client: reportedClient } : {}) }, message);
        const sessionHeaders: Record<string, string> = incomingSession ? { "Mcp-Session-Id": incomingSession } : {};
        if (reply.body === undefined) {
          res.writeHead(reply.status, { "Cache-Control": "no-store", ...sessionHeaders });
          return res.end();
        }
        return send(reply.status, json, JSON.stringify(reply.body), sessionHeaders);
      }
      if (method === "POST" && (url.pathname === SENDBLUE_WEBHOOK_PATH || url.pathname === TWILIO_WEBHOOK_PATH || url.pathname === PHOTON_WEBHOOK_PATH || url.pathname === LOCAL_WEBHOOK_PATH)) {
        const rawBody = await readRaw(req);
        const providerId = url.pathname === TWILIO_WEBHOOK_PATH ? "twilio" : url.pathname === PHOTON_WEBHOOK_PATH ? "photon" : url.pathname === LOCAL_WEBHOOK_PATH ? "local" : "sendblue";
        const selection = selectionFromInstallation(installation);
        const signedUrl = installation.publicBaseUrl() ? `${installation.publicBaseUrl()}${url.pathname}${url.search}` : undefined;
        const provider = createMessagingProvider(providerId, { env: () => installation.env(), sendblue: () => installation.sendblueEnv(), ledger, now: options.now });
        if (providerId === "sendblue") {
          if (selection.provider && selection.provider !== "sendblue") {
            const auth = provider.verifyWebhook({ rawBody, headers: req.headers, url: signedUrl });
            if (!auth.ok) return send(401, "application/json; charset=utf-8", JSON.stringify({ error: "unauthorized" }));
            try {
              JSON.parse(rawBody.toString("utf8") || " ");
            } catch {
              return send(400, "application/json; charset=utf-8", JSON.stringify({ error: "invalid json" }));
            }
            return send(200, "application/json; charset=utf-8", JSON.stringify({ ignored: "inactive provider" }));
          }
          const result = await handleSendblueWebhook(
            { rawBody, headers: req.headers },
            { secret: installation.sendblueEnv().webhookSecret, ledger, receive: (m) => conversations.receive(m), now: options.now, log },
          );
          return send(result.status, "application/json; charset=utf-8", JSON.stringify(result.body));
        }
        const result = await handleProviderWebhook(provider, { rawBody, headers: req.headers, url: signedUrl }, {
          ledger,
          receive: (m) => conversations.receive(m),
          now: options.now,
          log,
          active: selection.provider === providerId || (providerId === "local" && anyPropertyUsesLocal(workspace)),
        });
        return send(result.status, "application/json; charset=utf-8", JSON.stringify(result.body));
      }
      if (method === "GET" && /^\/verify\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
        return send(200, "text/html; charset=utf-8", readFileSync(new URL("verify.html", PUBLIC_DIR), "utf8"), { "Referrer-Policy": "no-referrer" });
      }
      if (url.pathname.startsWith("/api/")) {
        if (method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return send(415, "application/json", JSON.stringify({ error: { message: "Unsupported request." } }));
        }
        const exportTarget = method === "GET" ? AuditExportLinks.parsePath(url.pathname) : undefined;
        if (exportTarget && !isLocal) {
          const token = AuditExportLinks.tokenFrom(url.searchParams);
          const allowed = new AuditExportLinks(installation.runtime, () => installation.now()).check(token, exportTarget.propertyId, exportTarget.exportId, exportTarget.file);
          if (!allowed.ok) {
            return send(401, "application/json; charset=utf-8", JSON.stringify({ error: { message: "This download link isn't valid or has expired." } }));
          }
        }
        const body = method === "POST" ? JSON.parse((await readRaw(req)).toString("utf8") || "{}") : undefined;
        const result = await handleApi(api, method, url.pathname, body);
        if ("download" in result) {
          const { filename, contentType, content } = result.download;
          return send(result.status, `${contentType}; charset=utf-8`, content, { "Content-Disposition": `attachment; filename="${filename}"` });
        }
        return send(result.status, "application/json; charset=utf-8", JSON.stringify(result.json));
      }
      const asset = req.method === "GET" ? STATIC[url.pathname] : undefined;
      if (!asset) return send(404, "text/plain", "Not found");
      const pageHeaders: Record<string, string> = url.pathname === "/install" ? { "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" } : {};
      return send(200, asset.type, readFileSync(new URL(asset.file, PUBLIC_DIR), "utf8"), pageHeaders);
    } catch {
      return send(400, "application/json", JSON.stringify({ error: { message: "That request couldn't be read." } }));
    }
  });
  const retry = setInterval(() => {
    alertWork = alertWork
      .then(() => conversations.releaseUnconfirmed())
      .then(() => conversations.tickOverstay())
      .then(() => installation.outbox.drain().then(() => undefined))
      .catch(() => undefined);
  }, options.alertRetryMs ?? 15_000);
  retry.unref();
  server.on("close", () => {
    clearInterval(retry);
    restoreSettings();
    restoreMessaging();
  });
  return Object.assign(server, {
    tourCore: {
      installation,
      alerts,
      settled: async () => {
        await restored;
        let seen: Promise<void>;
        do {
          seen = alertWork;
          await seen;
        } while (seen !== alertWork);
      },
      storageReady,
      tickOverstay: () => conversations.tickOverstay(),
    },
  });
}

function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening the browser is a convenience; the printed link always works.
  }
}

export async function startSetupServer(options: SetupServerOptions & { port?: number; host?: string; open?: boolean } = {}): Promise<{ server: TourCoreServer; url: string }> {
  const server = createSetupServer(options);
  const host = options.host ?? "127.0.0.1";
  const first = options.port ?? 4321;
  const attempts = host === "0.0.0.0" ? 1 : 20;
  for (let offset = 0; offset < attempts; offset++) {
    try {
      const actual = await listen(server, first + offset, host);
      const url = `http://localhost:${actual}/`;
      if (options.open) openBrowser(url);
      return { server, url };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error("No free port found for the setup app");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadLocalEnv();
  const args = process.argv.slice(2);
  if (args.includes("--check-storage")) {
    const pathArg = args.find((a) => a !== "--check-storage" && !a.startsWith("--"));
    const env = pathArg ? { ...process.env, TOURCORE_HOME: pathArg } : process.env;
    process.exit(runStorageCheck(env));
  }
  // PowerShell drops the "--" in `npm run setup -- --dev`, so npm keeps the flag and exposes it as npm_config_dev.
  const dev = args.includes("--dev") || process.env.npm_config_dev === "true";
  const portArg = args.find((a) => a.startsWith("--port="));
  const preview = resolveDeploymentMode(process.env);
  const hosted = isHostedRailway(preview.mode);
  if (hosted) {
    const config = validateHostedConfig(process.env);
    if (!config.ok) {
      for (const problem of config.problems) console.error(`  ${redactSecrets(problem, secretValues())}`);
      process.exit(1);
    }
    if (!process.env.TOURCORE_HOME) process.env.TOURCORE_HOME = config.dataDir;
    const storage = applyHostedStorageGuard(preview.mode, process.env, (line) => console.error(`  ${line}`));
    if (!storage.ok) process.exit(1);
  }
  const open = hosted ? false : !args.includes("--no-open") && !process.env.CI;
  const workspace = new PropertyWorkspace();
  const installation = new Installation({ root: workspace.root, runtime: new FileRuntimeStore(join(workspace.root, "runtime")) });
  const recorded = (() => {
    try {
      return installation.files.manifest();
    } catch {
      return undefined;
    }
  })();
  const deployment = resolveDeploymentMode(process.env, recorded?.deploymentMode);
  const { manifest } = installation.files.ensure({ deploymentMode: deployment.mode });
  if (hosted) {
    const config = validateHostedConfig(process.env, manifest.publicBaseUrl);
    if (!config.ok) {
      for (const problem of config.problems) console.error(`  ${redactSecrets(problem, secretValues())}`);
      process.exit(1);
    }
    installation.files.setPublicBaseUrl(config.publicUrl, "RAILWAY");
    if (process.env.TOURCORE_HOSTED_TENANT_RESET === HOSTED_TENANT_RESET && clearHostedTenant(installation.files)) {
      console.log("  Cleared the hosted demo operator binding. Tour records were not deleted. Remove TOURCORE_HOSTED_TENANT_RESET after this deploy.");
    }
    if (process.env.TOURCORE_HOSTED_OWNER_RESET === HOSTED_OWNER_RESET && clearHostedTenant(installation.files)) {
      console.log("  Cleared the hosted demo owner. The next approved Grok connection becomes the owner. Tour records were not deleted. Remove TOURCORE_HOSTED_OWNER_RESET after this deploy.");
    }
  }
  if (manifest.options?.grokLegacyOAuthCompat && process.env.TOURCORE_GROK_LEGACY_OAUTH_COMPAT === undefined) process.env.TOURCORE_GROK_LEGACY_OAUTH_COMPAT = "true";
  const hostedConfig = hosted ? validateHostedConfig(process.env, manifest.publicBaseUrl) : undefined;
  const { server, url } = await startSetupServer({
    dev,
    open,
    workspace,
    installation,
    host: hostedConfig && hostedConfig.ok ? hostedConfig.host : "127.0.0.1",
    port: hostedConfig && hostedConfig.ok ? hostedConfig.port : portArg ? Number(portArg.split("=")[1]) : undefined,
    onApprovalRequest: (page) => {
      if (!hosted && !process.env.CI) openBrowser(page);
    },
  });
  const gate = await server.tourCore.storageReady;
  if (!gate.ok) {
    console.error(`  ${redactSecrets(gate.summary, secretValues())}`);
    server.close();
    process.exit(1);
  }
  const port = Number(new URL(url).port);
  writeRuntimeInfo(workspace.root, { pid: process.pid, port, url: url.replace(/\/$/, ""), startedAt: new Date().toISOString() });
  if (hosted && hostedConfig && hostedConfig.ok) {
    const storage =
      installation.records.model() === "DIRECT_GOOGLE_DRIVE"
        ? "Google Drive (optional direct mode)"
        : installation.records.model() === "HOSTED_P0_VOLUME"
          ? "Railway volume (live operational store)"
          : "local demo (not canonical)";
    const lines = startupLines({ version: TOURCORE_VERSION, mode: deployment.mode, port, host: hostedConfig.host, publicHost: new URL(hostedConfig.publicUrl).host, storage }).map((line) => redactSecrets(line, secretValues()));
    console.log("");
    for (const line of lines) console.log(`  ${line}`);
    console.log("  Hosted Railway P0 is single-tenant. Marketplace publication requires tenant isolation.");
    console.log("");
  }
  if (!hosted) {
    console.log("\n  Tour Core setup is running.");
    console.log(`\n  Open this link in your browser:  ${url}\n`);
    console.log(open ? "  (It should open by itself in a moment.)" : "");
    console.log("  Keep this window open while you work. Press Ctrl+C to stop.\n");
    console.log(`  Deployment:           ${deployment.mode}${deployment.invalid ? ` (TOURCORE_DEPLOYMENT_MODE "${deployment.invalid}" isn't recognized)` : ""}, installation ${manifest.installationId}`);
    console.log(`  Secure setup:         ${url}install#s=${installation.sessions.mint().token}  (this computer only; expires in 30 minutes)\n`);
  }
  const line = activeFromNumber(installation);
  const base = installation.publicBaseUrl();
  const selected = selectionFromInstallation(installation).provider;
  if (line || base) {
    console.log(`  Real-phone messaging: ${selected ?? "not chosen"} ${line ?? "(number not set)"}`);
    console.log(`  Incoming messages:    ${base && selected ? `${base}/webhooks/${selected}` : "(set PUBLIC_BASE_URL to receive replies)"}`);
    const model = intentModelFromEnv();
    console.log(`  Reading texts:        built-in rules${model ? ` + language model ${model.name}` : " only"}\n`);
  }
  const mcpUrl = base ? `${new URL(base).origin}${MCP_PATH}` : "(set PUBLIC_BASE_URL so Grok Bot can reach it)";
  const mode = mcpAuthModeFromEnv();
  if (mode === "oauth") {
    console.log(hosted ? `  Grok connects at ${mcpUrl}. The first Allow on the authorization page claims this demo.\n` : `  Grok Bot connector:   ${mcpUrl} (OAuth: approve connections at ${url}grok)\n`);
    const compatLine = hostedCompatStartupLine(process.env, deployment.mode);
    if (compatLine) console.log(`  ${redactSecrets(compatLine, secretValues())}\n`);
    else if (grokLegacyCompatFromEnv()) {
      console.log("  WARNING: Grok legacy OAuth compatibility is enabled for this P0 demo. Tour Core is");
      console.log("  accepting Cursor's known legacy OAuth callback. Disable this mode when Grok");
      console.log("  no longer requires it. (TOURCORE_GROK_LEGACY_OAUTH_COMPAT=true in .env)\n");
    }
  } else if (mode === "static") {
    console.log(`  Grok Bot connector:   ${mcpUrl} (static token, development only${operatorTokenFromEnv() ? "" : "; no token set, so it's off"})\n`);
  } else {
    console.log(`  Grok Bot connector:   off (TOURCORE_MCP_AUTH_MODE="${mode.invalid}" isn't oauth or static)\n`);
  }
  if (dev) console.log(`  Developer mode is on. Records folder: ${workspace.root}\n  Static files: ${fileURLToPath(PUBLIC_DIR)}\n`);
  const stop = () => {
    console.log("\n  Tour Core setup stopped. Your work is saved.");
    clearRuntimeInfo(workspace.root, process.pid);
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
