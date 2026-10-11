/** Phase 0 evidence collector. A webhook acceptance never proves agent execution. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const modes = args.filter((a) => a === "--local" || a === "--live-trigger");
if (modes.length !== 1 || args.some((a) => !["--local", "--live-trigger"].includes(a) && !/^--delay-seconds=\d+$/.test(a))) {
  console.error("Usage: node scripts/probe-agent-execution.mjs --local\n       node --import tsx scripts/probe-agent-execution.mjs --live-trigger --delay-seconds=300");
  process.exit(2);
}
const output = join(root, "logs", "agent-execution");
mkdirSync(output, { recursive: true });
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (revision.status !== 0) throw new Error("Cannot identify the checkout revision.");
const report = {
  schemaVersion: 1,
  mode: modes[0].slice(2),
  commit: revision.stdout.trim(),
  recordedAt: new Date().toISOString(),
  liveAgentExecution: "unverified",
};
function save() {
  const path = join(output, `${report.mode}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(`Evidence: ${path}`);
}

if (modes[0] === "--local") {
  const temp = mkdtempSync(join(tmpdir(), "tourcore-agent-proof-"));
  try {
    const resultFile = join(temp, "vitest.json");
    const run = spawnSync("npm", ["test", "--", "test/operatorAlerts.test.ts", "test/operatorUpdates.test.ts", "test/routineSetup.test.ts", "--maxWorkers=2", "--testTimeout=30000", "--reporter=json", `--outputFile=${resultFile}`], { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    report.runnerExitCode = run.status;
    if (existsSync(resultFile)) {
      const result = JSON.parse(readFileSync(resultFile, "utf8"));
      report.tests = {
        success: result.success,
        total: result.numTotalTests,
        passed: result.numPassedTests,
        failed: result.numFailedTests,
        pending: result.numPendingTests,
        assertions: result.testResults.flatMap((file) => file.assertionResults.map((test) => ({ name: test.fullName, status: test.status }))),
      };
    }
    report.providerBoundaries = "Messaging SDK and Grok Routine network are simulated; HTTP/MCP, storage, and application behavior are exercised locally.";
    save();
    if (run.status !== 0 || !report.tests?.success || report.tests.total < 1 || report.tests.passed !== report.tests.total) {
      console.error("Local proof did not pass completely. Inspect the selected tests; agent execution remains unverified.");
      process.exitCode = run.status || 1;
    } else {
      console.log(`${report.tests.passed} local tests passed. Live Grok execution remains unverified.`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
} else {
  const { LocalSecretStore } = await import("../src/install/secretStore.ts");
  const { loadLocalEnv } = await import("../src/web/env.ts");
  const { GrokRoutineWebhookSink, testEvent } = await import("../src/alerts/operatorEvents.ts");
  // Follow the application's existing precedence; never print or persist values.
  process.chdir(root);
  loadLocalEnv();
  const home = resolve(root, process.env.TOURCORE_HOME || "tourcore-data");
  const secrets = new LocalSecretStore(join(home, "install", "secrets.json"));
  const value = (name) => secrets.get(name) || process.env[name]?.trim();
  const sink = new GrokRoutineWebhookSink({ url: () => value("TOURCORE_GROK_ROUTINE_URL"), key: () => value("TOURCORE_GROK_ROUTINE_KEY") });
  if (!sink.configured()) {
    report.status = "blocked_missing_existing_routine_binding";
    save();
    console.error("Configure the existing routine securely on this installation, or run the probe on its already-configured server. Do not send credentials in chat.");
    process.exitCode = 2;
  } else {
    let secureUrl = false;
    try { secureUrl = new URL(value("TOURCORE_GROK_ROUTINE_URL")).protocol === "https:"; } catch {}
    if (!secureUrl) throw new Error("The configured routine must use HTTPS.");
    const delay = Number(args.find((a) => a.startsWith("--delay-seconds="))?.split("=")[1] ?? 300);
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 3600) throw new Error("Delay must be an integer between 0 and 3600 seconds.");
    report.scheduledSendAt = new Date(Date.now() + delay * 1000).toISOString();
    report.status = "scheduled";
    save();
    console.log(`One synthetic installation.test event is scheduled for ${report.scheduledSendAt}. Close the Grok conversation before delivery. This probe sends no SMS and changes no property.`);
    await new Promise((done) => setTimeout(done, delay * 1000));
    const event = testEvent(new Date());
    report.eventId = event.eventId;
    report.eventType = event.eventType;
    report.sentAt = new Date().toISOString();
    const before = performance.now();
    try {
      await sink.deliver(event);
      report.status = "webhook_accepted_agent_execution_unverified";
      report.acceptedAt = new Date().toISOString();
    } catch {
      report.status = "webhook_delivery_failed";
      process.exitCode = 1;
    }
    report.deliveryDurationMs = Math.round(performance.now() - before);
    save();
    console.log(report.status);
  }
}
