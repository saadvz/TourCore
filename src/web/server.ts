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
import { PropertyWorkspace } from "../setup";
import { MessagingEndpoints } from "../messaging/endpoints";
import { FileRuntimeStore } from "../storage/runtimeStore";
import { VisitorDemoRegistry, type VisitorDemoSession } from "../visitor";
import { adoptLegacyLine, MessagingConversations } from "../visitor/messagingRouter";
import { VerificationLinks } from "../visitor/verificationLinks";
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
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** What the public (tunnel) address may reach: the webhook and the identity form. Never the operator app. */
function publicRouteAllowed(method: string, path: string): boolean {
  if (method === "POST" && path === SENDBLUE_WEBHOOK_PATH) return true;
  if (method === "GET" && (/^\/verify\/[A-Za-z0-9_-]+$/.test(path) || path === "/verify.js" || path === "/styles.css")) return true;
  return /^\/api\/verify\/[A-Za-z0-9_-]+$/.test(path) && (method === "GET" || method === "POST");
}

/**
 * The local setup app plus the two things a real phone needs: the Sendblue
 * receive webhook and the identity-form page. Operator pages and APIs answer
 * only on this computer's own address.
 */
export function createSetupServer(options: SetupServerOptions = {}): Server {
  const workspace = options.workspace ?? new PropertyWorkspace();
  const visitors = options.visitors ?? new VisitorDemoRegistry();
  const dev = options.dev ?? false;
  const log = options.log ?? ((line: string) => console.log(`  ${line}`));
  const runtime = new FileRuntimeStore(join(workspace.root, "runtime"));
  const ledger = new MessagingLedger(join(runtime.root, "messaging-ledger", "ledger.json"), 5000, join(workspace.root, "messaging", "ledger.json"));
  const links = new VerificationLinks({ baseUrl: () => sendblueRuntime.env().publicBaseUrl, now: options.realNow, store: runtime });
  const endpoints = new MessagingEndpoints(runtime);
  const messagingLine = () => sendblueRuntime.env().fromNumber;
  try {
    adoptLegacyLine(workspace, endpoints, messagingLine(), log);
  } catch (err) {
    log(`Couldn't connect the texting number to a property: ${err instanceof Error ? err.message : "unknown error"}`);
  }
  let transport: ReturnType<typeof createLiveMessagingTransport> | undefined;
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
  });
  const restored = conversations
    .restoreSaved()
    .then((n) => {
      const needsAttention = conversations.attentionCount;
      if (n) log(`Picked up ${n} text-message tour${n === 1 ? "" : "s"} where ${n === 1 ? "it" : "they"} left off.`);
      if (needsAttention) log(`${needsAttention} text-message tour${needsAttention === 1 ? "" : "s"} couldn't be restored safely and need${needsAttention === 1 ? "s" : ""} attention.`);
    })
    .catch((err) => log(`Couldn't restore earlier text-message tours: ${err instanceof Error ? err.message : "unknown error"}`));
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

  return createServer(async (req, res) => {
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
    if (!isLocal && !(publicHost && host === publicHost && publicRouteAllowed(method, url.pathname))) {
      return send(isLocal || host === publicHost ? 404 : 403, "text/plain", isLocal || host === publicHost ? "Not found" : "Forbidden");
    }

    try {
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
      return send(200, asset.type, readFileSync(new URL(asset.file, PUBLIC_DIR), "utf8"));
    } catch {
      return send(400, "application/json", JSON.stringify({ error: { message: "That request couldn't be read." } }));
    }
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

export async function startSetupServer(options: SetupServerOptions & { port?: number; open?: boolean } = {}): Promise<{ server: Server; url: string }> {
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
  const { server, url } = await startSetupServer({ dev, open, port: portArg ? Number(portArg.split("=")[1]) : undefined });
  console.log("\n  Tour Core setup is running.");
  console.log(`\n  Open this link in your browser:  ${url}\n`);
  console.log(open ? "  (It should open by itself in a moment.)" : "");
  console.log("  Keep this window open while you work. Press Ctrl+C to stop.\n");
  const sb = sendblueRuntime.env();
  if (sb.apiKey || sb.publicBaseUrl) {
    console.log(`  Real-phone messaging: Sendblue number ${sb.fromNumber ?? "(not set)"}`);
    console.log(`  Incoming messages:    ${sb.publicBaseUrl ? `${sb.publicBaseUrl}${SENDBLUE_WEBHOOK_PATH}` : "(set PUBLIC_BASE_URL to receive replies)"}`);
    const model = intentModelFromEnv();
    console.log(`  Reading texts:        built-in rules${model ? ` + language model ${model.name}` : " only"}\n`);
  }
  if (dev) console.log(`  Developer mode is on. Records folder: ${new PropertyWorkspace().root}\n  Static files: ${fileURLToPath(PUBLIC_DIR)}\n`);
  const stop = () => {
    console.log("\n  Tour Core setup stopped. Your work is saved.");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
