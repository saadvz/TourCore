import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { tenantFolder } from "../cleaner-core/hosted/registry";
import type { HostedRequest } from "../cleaner-core/hosted/router";
import { formParams, twilioSignature } from "../messaging/twilio/signature";
import { TWILIO_WEBHOOK_PATH } from "../messaging/twilio/provider";
import { WORKER_KEY_HEADER } from "./ipc";

/**
 * How the shared service reaches one touring process on loopback: MCP calls after OAuth, the links
 * Tour Core handed out under /t/<id>/, and texts to the tenant's number. A text is saved before it is
 * forwarded and removed only once the process took it, so a crash in between replays it once; the
 * process's inbound ledger drops a repeat by its MessageSid.
 */

export interface WorkerTarget {
  port: number;
  key: string;
}

/** Never forwarded: hop-by-hop headers, the caller's own credentials, and any key a caller made up. */
const DROPPED = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "authorization", "cookie", "content-length", WORKER_KEY_HEADER]);

function forwardedHeaders(headers: IncomingHttpHeaders, key: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  out[WORKER_KEY_HEADER] = key;
  return out;
}

/** Sends one request to the process and streams its answer back. 503 when the process can't be reached. */
async function relay(target: WorkerTarget, r: HostedRequest, path: string, headers: Record<string, string | string[]>): Promise<void> {
  const body = r.method === "GET" || r.method === "HEAD" ? undefined : await r.readRaw();
  await new Promise<void>((resolve) => {
    const upstream = request(
      { host: "127.0.0.1", port: target.port, path, method: r.method, headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) } },
      (res) => {
        const out: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined && !["connection", "keep-alive", "transfer-encoding"].includes(name)) out[name] = value;
        }
        r.res.writeHead(res.statusCode ?? 502, out);
        res.pipe(r.res);
        res.on("end", resolve);
        res.on("error", () => resolve());
      },
    );
    upstream.on("error", () => {
      if (!r.res.headersSent) r.send(503, "application/json; charset=utf-8", JSON.stringify({ error: { message: "Touring isn't answering right now. Try again in a minute." } }));
      else r.res.end();
      resolve();
    });
    // A caller that goes away (an SSE stream closed) ends the upstream request too.
    r.res.on("close", () => upstream.destroy());
    if (body) upstream.write(body);
    upstream.end();
  });
}

/** An MCP call for a touring tenant. The process's own key is the bearer; the caller's token never leaves the service. */
export function forwardMcp(target: WorkerTarget, r: HostedRequest): Promise<void> {
  const headers = forwardedHeaders(r.req.headers, target.key);
  headers.authorization = `Bearer ${target.key}`;
  return relay(target, r, `/mcp${r.url.search}`, headers);
}

/** A link under /t/<id>/: `rest` is the path after the prefix, as the process knows it. */
export function forwardTenantPath(target: WorkerTarget, r: HostedRequest, rest: string): Promise<void> {
  return relay(target, r, `${rest}${r.url.search}`, forwardedHeaders(r.req.headers, target.key));
}

/** Texts for a touring tenant, saved until its process takes them. */
export class TouringInbox {
  constructor(
    private readonly dataRoot: string,
    private readonly now: () => Date,
  ) {}

  private folder(tenantId: string): string {
    return join(tenantFolder(this.dataRoot, tenantId), "tour-core-inbound");
  }

  /** Writes the raw Twilio form. Returns its path. */
  save(tenantId: string, raw: Buffer): string {
    const folder = this.folder(tenantId);
    mkdirSync(folder, { recursive: true });
    const sid = (formParams(raw).MessageSid ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 64) || "nosid";
    const stamp = String(this.now().getTime()).padStart(15, "0");
    const path = join(folder, `${stamp}-${sid}.form`);
    const temp = `${path}.tmp`;
    writeFileSync(temp, raw, { mode: 0o600 });
    renameSync(temp, path);
    return path;
  }

  done(path: string): void {
    rmSync(path, { force: true });
  }

  /** Saved texts, oldest first. */
  pending(tenantId: string): string[] {
    const folder = this.folder(tenantId);
    if (!existsSync(folder)) return [];
    return readdirSync(folder)
      .filter((name) => name.endsWith(".form"))
      .sort()
      .map((name) => join(folder, name));
  }
}

/**
 * Posts a text to the process's Twilio webhook, signed again with the shared token over the address
 * the process expects (its public base under /t/<id>), so its own signature check runs unchanged.
 */
export function deliverText(target: WorkerTarget, origin: string, tenantId: string, raw: Buffer, authToken: string): Promise<boolean> {
  const signedUrl = `${origin.replace(/\/+$/, "")}/t/${tenantId}${TWILIO_WEBHOOK_PATH}`;
  const signature = twilioSignature(authToken, signedUrl, formParams(raw));
  return new Promise((resolve) => {
    const upstream = request(
      {
        host: "127.0.0.1",
        port: target.port,
        path: TWILIO_WEBHOOK_PATH,
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(raw.length), "x-twilio-signature": signature, [WORKER_KEY_HEADER]: target.key },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300));
      },
    );
    upstream.on("error", () => resolve(false));
    upstream.write(raw);
    upstream.end();
  });
}

/** Hands saved texts to the process, oldest first, until one isn't taken. */
export async function replayInbox(inbox: TouringInbox, target: WorkerTarget, origin: string, tenantId: string, authToken: string): Promise<void> {
  for (const path of inbox.pending(tenantId)) {
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch {
      continue;
    }
    if (!(await deliverText(target, origin, tenantId, raw, authToken))) return;
    inbox.done(path);
  }
}
