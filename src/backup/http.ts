import type { IncomingMessage } from "node:http";
import { HandoffError } from "./handoff";
import { PortableBackupError } from "./portable";
import type { PortableBackups } from "./service";

const ARTIFACT = /^\/portable\/artifacts\/(art_[A-Za-z0-9_-]{20,80})$/;
const UPLOAD = /^\/portable\/uploads\/(art_[A-Za-z0-9_-]{20,80})$/;

function capability(req: IncomingMessage): string {
  const value = req.headers["x-tourcore-capability"];
  return typeof value === "string" ? value : "";
}

function readRaw(req: IncomingMessage, max = 1_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Capability-bound backup download and restore upload. Undefined when the path is unrelated. */
export async function handlePortableRequest(
  backups: PortableBackups,
  method: string,
  pathname: string,
  req: IncomingMessage,
): Promise<{ status: number; type: string; body: string } | undefined> {
  const artifact = ARTIFACT.exec(pathname);
  const upload = UPLOAD.exec(pathname);
  if (!artifact && !upload) return undefined;
  const missing = { status: 404, type: "text/plain", body: "Not found" };
  const cap = capability(req);
  if (!cap) return missing;
  try {
    if (artifact && method === "GET") {
      const file = backups.handoff.takeDownload(artifact[1]!, cap);
      return {
        status: 200,
        type: "application/json; charset=utf-8",
        body: file.body,
      };
    }
    if (upload && method === "POST") {
      const raw = await readRaw(req);
      backups.receive(upload[1]!, cap, raw.toString("utf8"));
      return { status: 200, type: "application/json; charset=utf-8", body: JSON.stringify({ ok: true, summary: "Backup received. I'll check it before anything changes." }) };
    }
  } catch (err) {
    if (err instanceof HandoffError || err instanceof PortableBackupError || (err instanceof Error && err.message === "too large")) return missing;
    return missing;
  }
  return missing;
}
