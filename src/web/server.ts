import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { createLiveMessagingTransport } from "../createTourCore";
import { MessagingLedger } from "../messaging/ledger";
import { SENDBLUE_WEBHOOK_PATH, sendblueRuntime } from "../messaging/sendblue/runtime";
import { handleSendblueWebhook } from "../messaging/sendblue/webhook";
import { createIntentInterpreter, intentModelFromEnv, type IntentInterpreter } from "../intent";
import { mcpAuthModeFromEnv, type McpAuthMode } from "../mcp/authMode";
import { authorized, handleMcpMessage, MCP_PATH } from "../mcp/mcpBridge";
import { endpointsFor, isOAuthLocalPath, isOAuthPublicPath, McpOAuth } from "../mcp/oauth";
import { grokLegacyCompatFromEnv, redirectPolicyFromEnv } from "../mcp/oauth/clients";
import { ConfirmationBook } from "../operator/confirmations";
import type { ToolContext } from "../operator/tools";
import { PropertyWorkspace } from "../setup";
import { MessagingEndpoints } from "../messaging/endpoints";
import { FileRuntimeStore } from "../storage/runtimeStore";
import { VisitorDemoRegistry, type VisitorDemoSession } from "../visitor";
import { adoptLegacyLine, MessagingConversations } from "../visitor/messagingRouter";
import { VerificationLinks } from "../visitor/verificationLinks";
import { ExceptionAlerts } from "../alerts/exceptionAlerts";
import { HEALTH_PATH, publicHealth, runtimeHealth } from "../install/checks";
import { resolveDeploymentMode } from "../install/deployment";
import { Installation } from "../install/installation";
import { handleSecureSetupApi, INSTALL_PAGE_PATHS, isInstallApiPath, PROXY_HEADERS } from "../install/secureSetup";
import { clearRuntimeInfo, writeRuntimeInfo } from "../install/service";
import { useSettingsSource } from "../install/settings";
import { handleApi } from "./api";
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
}

/** The server plus a handle tests use to wait for background operator alerts. */
export interface TourCoreServer extends Server {
  tourCore: {
    installation: Installation;
    alerts: ExceptionAlerts;
    /** Resolves once every alert scan and delivery started so far has finished. */
    settled(): Promise<void>;
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
function publicRouteAllowed(method: string, path: string, oauth: boolean): boolean {
  if (path === MCP_PATH) return true;
  if (method === "GET" && path === HEALTH_PATH) return true;
  if (oauth && (isOAuthPublicPath(path, MCP_PATH) || (method === "GET" && path === "/oauth.js"))) return true;
  if (method === "POST" && path === SENDBLUE_WEBHOOK_PATH) return true;
  if (method === "GET" && (/^\/verify\/[A-Za-z0-9_-]+$/.test(path) || path === "/verify.js" || path === "/styles.css")) return true;
  return /^\/api\/verify\/[A-Za-z0-9_-]+$/.test(path) && (method === "GET" || method === "POST");
}

/**
 * The local setup app plus the two things a real phone needs: the Sendblue
 * receive webhook and the identity-form page. Operator pages and APIs answer
 * only on this computer's own address.
 */
export function createSetupServer(options: SetupServerOptions = {}): TourCoreServer {
  const workspace = options.workspace ?? new PropertyWorkspace();
  const visitors = options.visitors ?? new VisitorDemoRegistry();
  visitors.useApprovedContent((id) => (workspace.has(id) ? workspace.load(id).config : undefined));
  const dev = options.dev ?? false;
  const log = options.log ?? ((line: string) => console.log(`  ${line}`));
  const runtime = options.installation?.runtime ?? new FileRuntimeStore(join(workspace.root, "runtime"));
  const installation = options.installation ?? new Installation({ root: workspace.root, runtime, log });
  // Adapters read credentials through the settings layer; this installation's secure-setup values join the environment's.
  const restoreSettings = useSettingsSource(installation.settingsSource());
  const ledger = new MessagingLedger(join(workspace.root, "runtime", "messaging-ledger", "ledger.json"), 5000, join(workspace.root, "messaging", "ledger.json"));
  const links = new VerificationLinks({ baseUrl: () => sendblueRuntime.env().publicBaseUrl, now: options.realNow, store: runtime });
  const endpoints = new MessagingEndpoints(runtime);
  const messagingLine = () => sendblueRuntime.env().fromNumber;
  try {
    adoptLegacyLine(workspace, endpoints, messagingLine(), log);
  } catch (err) {
    log(`Couldn't connect the texting number to a property: ${err instanceof Error ? err.message : "unknown error"}`);
  }
  let transport: ReturnType<typeof createLiveMessagingTransport> | undefined;
  const resetMessaging = () => {
    transport = undefined;
  };
  // Operator alerts run after the visitor has been answered and saved; a failure here never reaches the visitor.
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
    transport: () => (transport ??= createLiveMessagingTransport(ledger)),
    now: options.now,
    realNow: options.realNow,
    interpreter: options.interpreter ?? createIntentInterpreter({ log }),
    log,
    onSaved: (session) => afterSave(session.propertyId),
  });
  const restored = conversations
    .restoreSaved()
    .then((n) => {
      const needsAttention = conversations.attentionCount;
      if (n) log(`Picked up ${n} text-message tour${n === 1 ? "" : "s"} where ${n === 1 ? "it" : "they"} left off.`);
      if (needsAttention) log(`${needsAttention} text-message tour${needsAttention === 1 ? "" : "s"} couldn't be restored safely and need${needsAttention === 1 ? "s" : ""} attention.`);
    })
    .catch((err) => log(`Couldn't restore earlier text-message tours: ${err instanceof Error ? err.message : "unknown error"}`));
  // First start with alerts: issues that already exist are recorded, not announced. Then retry anything left pending before a restart.
  alertWork = restored.then(async () => {
    try {
      const state = installation.files.state();
      if (!state.alertsBaselineAt) {
        await alerts.baseline();
        installation.files.writeState({ ...installation.files.state(), alertsBaselineAt: new Date(installation.now()).toISOString() });
      }
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
    needsAttention: (propertyId: string) => conversations.needsAttention(propertyId),
  };
  const alerts = new ExceptionAlerts({ services: api, outbox: installation.outbox, log });
  installation.setRelevanceCheck((event) => alerts.stillOpen(event));
  const operatorToken = options.operatorToken ?? operatorTokenFromEnv;
  const authMode = options.mcpAuth ?? (options.operatorToken ? "static" : mcpAuthModeFromEnv());
  let server: Server;
  const approvalPage = () => `${tools.localUrl?.() ?? "http://localhost:4321"}/grok`;
  let lastApprovalWindow = 0;
  const oauth =
    authMode === "oauth"
      ? new McpOAuth({
          runtime,
          mcpPath: MCP_PATH,
          endpoints: () => {
            const base = sendblueRuntime.env().publicBaseUrl;
            return base ? endpointsFor(base, MCP_PATH) : undefined;
          },
          redirectPolicy: () => redirectPolicyFromEnv(),
          now: options.authNow,
          fetchClientMetadata: options.fetchClientMetadata,
          onApprovalRequest: (request) => {
            log(`${request.clientName} is asking to connect to Tour Core (code ${request.matchCode}). Approve or deny it at ${approvalPage()}`);
            // Anyone with the tunnel URL can ask; one window at a time is enough, the page lists every request.
            if (request.createdAt - lastApprovalWindow < 20_000) return;
            lastApprovalWindow = request.createdAt;
            options.onApprovalRequest?.(approvalPage());
          },
          log,
          rateLimit: options.oauthRateLimit,
        })
      : undefined;
  const tools: ToolContext = {
    services: api,
    confirmations: new ConfirmationBook(),
    now: () => options.now?.() ?? new Date(),
    localUrl: () => {
      const address = server?.address();
      return typeof address === "object" && address ? `http://localhost:${address.port}` : undefined;
    },
    installation,
    resetMessaging,
  };

  server = createServer(async (req, res) => {
    await restored;
    const send = (status: number, type: string, body: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
      res.end(body);
    };

    // Local addresses get everything; the configured public address gets only the phone-facing routes.
    // Anything else is refused (blocks DNS-rebinding tricks).
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    const publicBase = sendblueRuntime.env().publicBaseUrl;
    const publicHost = publicBase ? new URL(publicBase).hostname.toLowerCase() : undefined;
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const isLocal = LOCAL_HOSTS.includes(host);
    if (!isLocal && !(publicHost && host === publicHost && publicRouteAllowed(method, url.pathname, !!oauth))) {
      return send(isLocal || host === publicHost ? 404 : 403, "text/plain", isLocal || host === publicHost ? "Not found" : "Forbidden");
    }

    // Secure setup: this computer's own browser only. Anything relayed by a proxy or tunnel is refused, whatever its Host.
    if (INSTALL_PAGE_PATHS.includes(url.pathname) || isInstallApiPath(url.pathname)) {
      if (!isLocal || PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return send(404, "text/plain", "Not found");
    }

    try {
      if (method === "GET" && url.pathname === HEALTH_PATH) {
        return send(200, "application/json; charset=utf-8", JSON.stringify(isLocal ? { ...publicHealth(installation), ...runtimeHealth(installation) } : publicHealth(installation)));
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
        if (oauth) {
          // Token checked before the body is read; failures have already been answered (401/403).
          if (!(await oauth.authenticate(req, res))) return;
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
        const reply = await handleMcpMessage(tools, message);
        if (reply.body === undefined) {
          res.writeHead(reply.status, { "Cache-Control": "no-store" });
          return res.end();
        }
        return send(reply.status, json, JSON.stringify(reply.body));
      }
      if (method === "POST" && url.pathname === SENDBLUE_WEBHOOK_PATH) {
        // Raw bytes first: authenticity is checked before anything is parsed.
        const rawBody = await readRaw(req);
        const result = await handleSendblueWebhook(
          { rawBody, headers: req.headers },
          { secret: sendblueRuntime.env().webhookSecret, ledger, receive: (m) => conversations.receive(m), now: options.now, log },
        );
        return send(result.status, "application/json; charset=utf-8", JSON.stringify(result.body));
      }
      if (method === "GET" && /^\/verify\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
        return send(200, "text/html; charset=utf-8", readFileSync(new URL("verify.html", PUBLIC_DIR), "utf8"), { "Referrer-Policy": "no-referrer" });
      }
      if (url.pathname.startsWith("/api/")) {
        if (method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return send(415, "application/json", JSON.stringify({ error: { message: "Unsupported request." } }));
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
    alertWork = alertWork.then(() => installation.outbox.drain().then(() => undefined)).catch(() => undefined);
  }, options.alertRetryMs ?? 15_000);
  retry.unref();
  server.on("close", () => {
    clearInterval(retry);
    restoreSettings();
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

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
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

export async function startSetupServer(options: SetupServerOptions & { port?: number; open?: boolean } = {}): Promise<{ server: TourCoreServer; url: string }> {
  const server = createSetupServer(options);
  const first = options.port ?? 4321;
  for (let port = first; port < first + 20; port++) {
    try {
      const actual = await listen(server, port);
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
  // PowerShell drops the "--" in `npm run setup -- --dev`, so npm keeps the flag and exposes it as npm_config_dev.
  const dev = args.includes("--dev") || process.env.npm_config_dev === "true";
  const portArg = args.find((a) => a.startsWith("--port="));
  const open = !args.includes("--no-open") && !process.env.CI;
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
  if (manifest.options?.grokLegacyOAuthCompat && process.env.TOURCORE_GROK_LEGACY_OAUTH_COMPAT === undefined) process.env.TOURCORE_GROK_LEGACY_OAUTH_COMPAT = "true";
  const { server, url } = await startSetupServer({
    dev,
    open,
    workspace,
    installation,
    port: portArg ? Number(portArg.split("=")[1]) : undefined,
    onApprovalRequest: (page) => {
      if (!process.env.CI) openBrowser(page);
    },
  });
  const port = Number(new URL(url).port);
  writeRuntimeInfo(workspace.root, { pid: process.pid, port, url: url.replace(/\/$/, ""), startedAt: new Date().toISOString() });
  console.log("\n  Tour Core setup is running.");
  console.log(`\n  Open this link in your browser:  ${url}\n`);
  console.log(open ? "  (It should open by itself in a moment.)" : "");
  console.log("  Keep this window open while you work. Press Ctrl+C to stop.\n");
  console.log(`  Deployment:           ${deployment.mode}${deployment.invalid ? ` (TOURCORE_DEPLOYMENT_MODE "${deployment.invalid}" isn't recognized)` : ""}, installation ${manifest.installationId}`);
  console.log(`  Secure setup:         ${url}install#s=${installation.sessions.mint().token}  (this computer only; expires in 30 minutes)\n`);
  const sb = sendblueRuntime.env();
  if (sb.apiKey || sb.publicBaseUrl) {
    console.log(`  Real-phone messaging: Sendblue number ${sb.fromNumber ?? "(not set)"}`);
    console.log(`  Incoming messages:    ${sb.publicBaseUrl ? `${sb.publicBaseUrl}${SENDBLUE_WEBHOOK_PATH}` : "(set PUBLIC_BASE_URL to receive replies)"}`);
    const model = intentModelFromEnv();
    console.log(`  Reading texts:        built-in rules${model ? ` + language model ${model.name}` : " only"}\n`);
  }
  const mcpUrl = sb.publicBaseUrl ? `${new URL(sb.publicBaseUrl).origin}${MCP_PATH}` : "(set PUBLIC_BASE_URL so Grok Bot can reach it)";
  const mode = mcpAuthModeFromEnv();
  if (mode === "oauth") {
    console.log(`  Grok Bot connector:   ${mcpUrl} (OAuth: approve connections at ${url}grok)\n`);
    if (grokLegacyCompatFromEnv()) {
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
