import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDelegationTestService } from "../src/delegation/testService";
import { DelegationStartupError, resolveTestStartupConfig, validateTestCredentials } from "../src/delegation/startupConfig";

let config: ReturnType<typeof resolveTestStartupConfig>;
try { config = resolveTestStartupConfig(process.env); }
catch (error) {
  console.error(`Cleaner Core test startup blocked: ${error instanceof DelegationStartupError ? error.message : "Startup configuration could not be read."}`);
  process.exit(1);
}
const { root, port, host, publicBaseUrl } = config;
try { mkdirSync(root, { recursive: true, mode: 0o700 }); }
catch { console.error("Cleaner Core test startup blocked: CLEANER_TEST_HOME is not writable. Check the mounted volume's permissions."); process.exit(1); }
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
let stage: "credentials" | "storage" = "credentials";
try {
  let credentials = config.credentials;
  if (!credentials) {
    const credentialsPath = join(root, "credentials.json");
    if (!existsSync(credentialsPath)) writeFileSync(credentialsPath, JSON.stringify({ agentToken: randomBytes(32).toString("hex"), adminToken: randomBytes(32).toString("hex") }) + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(credentialsPath, 0o600);
    const saved = JSON.parse(readFileSync(credentialsPath, "utf8"));
    credentials = validateTestCredentials(saved.agentToken, saved.adminToken);
  }
  stage = "storage";
  service = createDelegationTestService({ root, ...credentials, publicBaseUrl, railwayHealthcheck: Boolean(process.env.RAILWAY_ENVIRONMENT_ID) });
} catch {
  release();
  console.error(stage === "credentials"
    ? "Cleaner Core test startup blocked: saved local credentials.json is unreadable or invalid. Check that file and its permissions."
    : "Cleaner Core test startup blocked: durable test storage could not be initialized. Check delegation.json, replies.json, and volume permissions.");
  process.exit(1);
}
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
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(error.code === "EADDRINUSE" ? "Cleaner Core test startup blocked: the selected port is already in use." : "Cleaner Core test listener could not start. Check PORT and listener permissions.");
  void stop(1);
});
process.on("SIGTERM", () => { void stop(0); });
process.on("SIGINT", () => { void stop(0); });
