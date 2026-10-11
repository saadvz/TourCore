import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { createDelegationTestService } from "../src/delegation/testService";

const root = resolve(process.env.CLEANER_TEST_HOME ?? "tourcore-data/cleaner-core-test");
const port = Number(process.env.CLEANER_TEST_PORT ?? process.env.PORT ?? 4332);
const host = process.env.CLEANER_TEST_HOST ?? "127.0.0.1";
const publicBaseUrl = process.env.CLEANER_TEST_PUBLIC_URL ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid test service port.");
if (host !== "127.0.0.1" && host !== "0.0.0.0") throw new Error("Invalid test service listener host.");
if (host === "0.0.0.0" && !publicBaseUrl) throw new Error("A public HTTPS origin is required before exposing the test listener.");
mkdirSync(root, { recursive: true, mode: 0o700 });
const lockPath = join(root, "service.lock");
let lock: number | undefined;
// The container entrypoint holds an OS advisory lock for this process's whole
// lifetime. It is automatically released on crashes, including container restarts.
if (process.env.CLEANER_TEST_EXTERNAL_LOCK !== "1") {
  try { lock = openSync(lockPath, "wx", 0o600); }
  catch { throw new Error("Test storage is locked. Stop its existing service first. After a crash, verify that process has stopped before removing service.lock."); }
  writeFileSync(lock, String(process.pid));
}
const release = () => { if (lock !== undefined) { closeSync(lock); rmSync(lockPath); } };
let service: ReturnType<typeof createDelegationTestService>;
try {
  const schema = z.strictObject({ agentToken: z.string().min(32), adminToken: z.string().min(32) });
  let credentials: z.infer<typeof schema>;
  const supplied = process.env.CLEANER_TEST_AGENT_TOKEN !== undefined || process.env.CLEANER_TEST_ADMIN_TOKEN !== undefined;
  if (supplied || host === "0.0.0.0") {
    credentials = schema.parse({ agentToken: process.env.CLEANER_TEST_AGENT_TOKEN, adminToken: process.env.CLEANER_TEST_ADMIN_TOKEN });
  } else {
    const credentialsPath = join(root, "credentials.json");
    if (!existsSync(credentialsPath)) writeFileSync(credentialsPath, JSON.stringify({ agentToken: randomBytes(32).toString("hex"), adminToken: randomBytes(32).toString("hex") }) + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(credentialsPath, 0o600);
    credentials = schema.parse(JSON.parse(readFileSync(credentialsPath, "utf8")));
  }
  service = createDelegationTestService({ root, ...credentials, publicBaseUrl, railwayHealthcheck: Boolean(process.env.RAILWAY_ENVIRONMENT_ID) });
} catch { release(); throw new Error("Test service could not start. Check its address and local storage; credentials were not displayed."); }
const server = service.app.listen(port, host, () => {
  console.log(`Cleaner Core synthetic test service ready on ${host}:${port}`);
  console.log("MCP: /mcp; health: /healthz. Authentication values are saved privately and are never printed.");
  console.log("No Grok event dispatch, Guesty import, real SMS, or production configuration is enabled.");
});
let stopping = false;
const stop = async (exitCode: number) => {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await service.stop();
  release();
  process.exit(exitCode);
};
server.on("error", () => { console.error("Test listener could not start."); void stop(1); });
process.on("SIGTERM", () => { void stop(0); });
process.on("SIGINT", () => { void stop(0); });
