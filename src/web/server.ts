import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PropertyWorkspace } from "../setup";
import { VisitorDemoRegistry } from "../visitor";
import { handleApi } from "./api";

const PUBLIC_DIR = new URL("./public/", import.meta.url);
const JS = "text/javascript; charset=utf-8";
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/visitor": { file: "visitor.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: JS },
  "/ui.js": { file: "ui.js", type: JS },
  "/tours.js": { file: "tours.js", type: JS },
  "/visitor.js": { file: "visitor.js", type: JS },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};
const MAX_BODY_BYTES = 1_000_000;

export interface SetupServerOptions {
  workspace?: PropertyWorkspace;
  dev?: boolean;
}

/** Local-only setup app. Serves the page and the setup API; holds no setup logic itself. */
export function createSetupServer(options: SetupServerOptions = {}): Server {
  const workspace = options.workspace ?? new PropertyWorkspace();
  const visitors = new VisitorDemoRegistry();
  const dev = options.dev ?? false;

  return createServer(async (req, res) => {
    const send = (status: number, type: string, body: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
      res.end(body);
    };

    // Only answer requests addressed to this machine (blocks DNS-rebinding tricks).
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return send(403, "text/plain", "Forbidden");

    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        if (req.method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return send(415, "application/json", JSON.stringify({ error: { message: "Unsupported request." } }));
        }
        const body = req.method === "POST" ? await readJson(req) : undefined;
        const result = await handleApi({ workspace, visitors, dev }, req.method ?? "GET", url.pathname, body);
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

function readJson(req: IncomingMessage): Promise<unknown> {
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
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (err) {
        reject(err);
      }
    });
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
  const args = process.argv.slice(2);
  const dev = args.includes("--dev");
  const portArg = args.find((a) => a.startsWith("--port="));
  const open = !args.includes("--no-open") && !process.env.CI;
  const { server, url } = await startSetupServer({ dev, open, port: portArg ? Number(portArg.split("=")[1]) : undefined });
  console.log("\n  Tour Core setup is running.");
  console.log(`\n  Open this link in your browser:  ${url}\n`);
  console.log(open ? "  (It should open by itself in a moment.)" : "");
  console.log("  Keep this window open while you work. Press Ctrl+C to stop.\n");
  if (dev) console.log(`  Developer mode is on. Records folder: ${new PropertyWorkspace().root}\n  Static files: ${fileURLToPath(PUBLIC_DIR)}\n`);
  const stop = () => {
    console.log("\n  Tour Core setup stopped. Your work is saved.");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
