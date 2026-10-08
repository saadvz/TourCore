import { once } from "node:events";
import { createWriteStream, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { HandoffError } from "./handoff";
import { RestoreUploadTooLargeError, restoreUploadMaxBytes, restoreUploadTooLargeMessage } from "./limits";
import { PortableBackupError } from "./portable";
import type { PortableBackups } from "./service";

const ARTIFACT = /^\/portable\/artifacts\/(art_[A-Za-z0-9_-]{20,80})$/;
const UPLOAD = /^\/portable\/uploads\/(art_[A-Za-z0-9_-]{20,80})$/;

function capability(req: IncomingMessage): string {
  const value = req.headers["x-tourcore-capability"];
  return typeof value === "string" ? value : "";
}

function declaredLength(req: IncomingMessage): number | undefined {
  const raw = req.headers["content-length"];
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (!text || !/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** A rejected body is read only this far, then the socket is destroyed. */
const REJECTED_BODY_MAX = 1024 * 1024;

/**
 * Reads a rejected body up to {@link REJECTED_BODY_MAX}, then cuts the
 * connection. A short body is finished so the refusal can still be sent.
 * Returns true when the socket was destroyed.
 */
function drainRejected(req: IncomingMessage): Promise<boolean> {
  return new Promise((resolve) => {
    let read = 0;
    let settled = false;
    const finish = (destroyed: boolean) => {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      resolve(destroyed);
    };
    const onData = (chunk: Buffer | string) => {
      read += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (read >= REJECTED_BODY_MAX) {
        req.socket?.destroy();
        req.destroy();
        finish(true);
      }
    };
    const onEnd = () => finish(false);
    const onError = () => finish(true);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/**
 * Writes the request to `dest` one chunk at a time. The chunk list is not kept,
 * and a body over the cap is discarded instead of buffered. The socket stays
 * open so the caller can answer 413; destroying it here is what turned a
 * too-large upload into a bare 502.
 */
async function spoolUpload(req: IncomingMessage, max: number, dest: string): Promise<"ok" | "too-large"> {
  const declared = declaredLength(req);
  if (declared !== undefined && declared > max) {
    void drainRejected(req);
    return "too-large";
  }
  const out = createWriteStream(dest);
  let size = 0;
  let tooLarge = false;
  let streamError: Error | undefined;
  out.on("error", (err) => {
    if (!tooLarge) streamError = err;
  });
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (tooLarge) continue;
      if (size + buf.length > max) {
        tooLarge = true;
        continue;
      }
      size += buf.length;
      if (!out.write(buf)) await once(out, "drain");
      if (streamError) throw streamError;
    }
  } catch (err) {
    out.destroy();
    throw err;
  }
  if (tooLarge) {
    out.destroy();
    rmSync(dest, { force: true });
    return "too-large";
  }
  if (streamError) throw streamError;
  await new Promise<void>((resolve, reject) => {
    out.on("error", reject);
    out.on("finish", resolve);
    out.end();
  });
  return "ok";
}

function tooLarge(max: number): { status: number; type: string; body: string } {
  return { status: 413, type: "text/plain; charset=utf-8", body: restoreUploadTooLargeMessage(max) };
}

/** Capability-bound backup download and restore upload. Undefined when the path is unrelated. */
export async function handlePortableRequest(
  backups: PortableBackups,
  method: string,
  pathname: string,
  req: IncomingMessage,
): Promise<{ status: number; type: string; body: string; close?: boolean } | undefined> {
  const artifact = ARTIFACT.exec(pathname);
  const upload = UPLOAD.exec(pathname);
  if (!artifact && !upload) return undefined;
  const missing = { status: 404, type: "text/plain", body: "Not found" };
  const cap = capability(req);
  if (!cap && !(upload && method === "POST")) return missing;
  const max = restoreUploadMaxBytes();
  let temp: string | undefined;
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
      try {
        backups.handoff.assertUploadAvailable(upload[1]!, cap);
      } catch {
        const closed = await drainRejected(req);
        return closed ? { ...missing, close: true } : missing;
      }
      const declared = declaredLength(req);
      if (declared !== undefined && declared > max) {
        // Same cap as a bad link: read at most 1 MB, then cut the connection.
        // Do not wait for that read before answering. A short body, or a declared
        // size with nothing behind it, still gets 413.
        void drainRejected(req);
        return { ...tooLarge(max), close: true };
      }
      temp = backups.handoff.incomingPath();
      const outcome = await spoolUpload(req, max, temp);
      if (outcome === "too-large") return tooLarge(max);
      backups.receiveFile(upload[1]!, cap, temp);
      temp = undefined;
      return { status: 200, type: "application/json; charset=utf-8", body: JSON.stringify({ ok: true, summary: "Backup received. I'll check it before anything changes." }) };
    }
  } catch (err) {
    if (temp) rmSync(temp, { force: true });
    if (err instanceof RestoreUploadTooLargeError) return tooLarge(err.maxBytes);
    if (err instanceof HandoffError || err instanceof PortableBackupError) return missing;
    return missing;
  }
  return missing;
}
