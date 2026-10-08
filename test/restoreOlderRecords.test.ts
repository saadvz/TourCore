import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PropertyWorkspace } from "../src/setup";
import { createSetupServer } from "../src/web/server";
import { installHarness, type InstallHarness } from "./installHarness";

/**
 * Keys a2e2663 `receiveUpload` writes. The backup text sits on `body`.
 * There is no `bodyFile` and no `bytes` field.
 */
const OLD_UPLOAD_KEYS = ["schemaVersion", "kind", "tokenHash", "expiresAt", "createdAt", "body"] as const;

const FIXTURE_URL = new URL("./fixtures/a2e2663-portable-backup.json", import.meta.url);
const fixtureText = readFileSync(FIXTURE_URL, "utf8");

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((run) => run()));

function hosted(): InstallHarness {
  const h = installHarness({
    env: { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app", PORT: "8080" },
  });
  cleanups.push(h.cleanup);
  h.inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
  h.inst.files.setPublicBaseUrl("https://demo.up.railway.app", "RAILWAY");
  return h;
}

function uploadIdOf(upload: { handoff: { path: string } }): string {
  return String(upload.handoff.path).split("/").pop()!;
}

function handoffPath(h: InstallHarness, uploadId: string): string {
  return join(h.root, "portable-handoff", `${uploadId}.json`);
}

async function listen(h: InstallHarness): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createSetupServer({ workspace: new PropertyWorkspace(h.root), installation: h.inst, log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function postUpload(port: number, path: string, capability: string, body: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
          "x-tourcore-capability": capability,
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("older restore records", () => {
  it("uploads a backup written by a2e2663, previews it, and imports it", async () => {
    const backup = JSON.parse(fixtureText) as { format: string; schemaVersion: number; tourCoreVersion: string };
    expect(backup).toMatchObject({ format: "tourcore-portable-backup", schemaVersion: 1, tourCoreVersion: "0.4.0" });

    const h = hosted();
    const upload = await h.ok("begin_restore_upload");
    const uploadId = uploadIdOf(upload);
    const app = await listen(h);
    cleanups.push(() => void app.close());
    const posted = await postUpload(app.port, String(upload.handoff.path), String(upload.handoff.capability), Buffer.from(fixtureText));
    expect(posted.status).toBe(200);
    expect(posted.body).toContain("Backup received");

    const preview = await h.ok("preview_portable_restore", { uploadId });
    expect(preview.summary).toMatch(/Backup contains:/);
    expect(preview.counts).toMatchObject({ properties: 1, units: 2 });

    const asked = await h.ok("import_portable_backup", { uploadId });
    expect(asked.requiresConfirmation).toBe(true);
    const restored = await h.ok("import_portable_backup", { uploadId, confirmationCode: asked.confirmationCode });
    expect(restored.lines).toContain("Property records: restored");
    expect(h.workspace.list().map((property) => property.config.property.name)).toContain("100 Alfred Way");
  });

  it("previews a handoff record stored with the body inline, the way a2e2663 wrote it", async () => {
    const h = hosted();
    const upload = await h.ok("begin_restore_upload");
    const uploadId = uploadIdOf(upload);
    const path = handoffPath(h, uploadId);
    const opened = JSON.parse(readFileSync(path, "utf8")) as {
      schemaVersion: number;
      kind: string;
      tokenHash: string;
      expiresAt: number;
      createdAt: number;
    };
    const planted = {
      schemaVersion: opened.schemaVersion,
      kind: opened.kind,
      tokenHash: opened.tokenHash,
      expiresAt: opened.expiresAt,
      createdAt: opened.createdAt,
      body: fixtureText,
    };
    expect(Object.keys(planted)).toEqual([...OLD_UPLOAD_KEYS]);
    expect(planted).not.toHaveProperty("bodyFile");
    writeFileSync(path, JSON.stringify(planted, null, 2) + "\n");
    expect(existsSync(join(h.root, "portable-handoff", `${uploadId}.body`))).toBe(false);

    const preview = await h.ok("preview_portable_restore", { uploadId });
    expect(preview.summary).toMatch(/Backup contains:/);
    expect(preview.counts).toMatchObject({ properties: 1, units: 2 });
  });

  it("asks for the file when a declared upload has no body", async () => {
    const h = hosted();
    const upload = await h.ok("begin_restore_upload");
    const uploadId = uploadIdOf(upload);
    const record = JSON.parse(readFileSync(handoffPath(h, uploadId), "utf8")) as { body?: string; bodyFile?: boolean };
    expect(record.body).toBeUndefined();
    expect(record.bodyFile).toBeUndefined();
    expect(await h.fails("preview_portable_restore", { uploadId })).toBe("Upload the backup file first, then I can show you what's in it.");
  });
});
