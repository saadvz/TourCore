import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { testEvent } from "../alerts/operatorEvents";
import { MockDurinAccessAdapter } from "../durin/MockDurinAccessAdapter";
import { connectSendblue } from "../messaging/sendblue/connect";
import type { OperatorServices } from "../operator/services";
import { writeFileAtomic } from "../storage/atomicWrite";
import { probeRuntimeStore } from "../storage/runtimeStore";
import { TOURCORE_VERSION, type Installation } from "./installation";

/**
 * The installation checks behind Tour Core's installation tools. Each one
 * does a real check, records the plain-language result in the install state
 * (never a credential), and returns what the operator should be told.
 */

export const HEALTH_PATH = "/healthz";

/** Identifies this installation on the public health page without revealing its id. */
export const installationFingerprint = (installationId: string | undefined) =>
  installationId ? createHash("sha256").update(`tour-core|${installationId}`).digest("hex").slice(0, 16) : undefined;

export interface PublicHealth {
  ok: true;
  service: "tour-core";
  installation?: string;
}

export function publicHealth(inst: Installation): PublicHealth {
  const id = safe(() => inst.files.manifest()?.installationId);
  const fingerprint = installationFingerprint(id);
  return { ok: true, service: "tour-core", ...(fingerprint ? { installation: fingerprint } : {}) };
}

export function runtimeHealth(inst: Installation) {
  const deployment = inst.deployment();
  let storageOk = true;
  try {
    probeRuntimeStore(inst.runtime, new Date(inst.now()));
  } catch {
    storageOk = false;
  }
  const alerts = safe(() => inst.outbox.health());
  return {
    running: true,
    version: TOURCORE_VERSION,
    pid: process.pid,
    uptimeSeconds: Math.round((inst.now() - inst.startedAt) / 1000),
    deploymentMode: deployment.mode,
    runtimeRecords: storageOk ? "ok" : "can't be saved",
    alertsWaiting: alerts ? alerts.pending : undefined,
  };
}

/** Fetches the public health page through the public address and checks it's this installation answering. */
export async function checkPublicEndpoint(inst: Installation, options: { attempts?: number; delayMs?: number } = {}): Promise<{ ok: boolean; url?: string; message: string }> {
  const url = inst.publicBaseUrl();
  if (!url) return { ok: false, message: "Tour Core doesn't have a public https address yet." };
  const expected = publicHealth(inst).installation;
  const attempts = options.attempts ?? 1;
  let message = "Tour Core's public address didn't answer.";
  let ok = false;
  for (let i = 0; i < attempts && !ok; i++) {
    if (i) await new Promise((r) => setTimeout(r, options.delayMs ?? 3000));
    try {
      const res = await inst.fetch()(`${url}${HEALTH_PATH}`, { signal: AbortSignal.timeout(10_000) });
      const body = res.status === 200 ? ((await res.json().catch(() => undefined)) as Partial<PublicHealth> | undefined) : undefined;
      if (body?.service !== "tour-core") message = `Tour Core's public address answered, but not with Tour Core (status ${res.status}).`;
      else if (expected && body.installation !== expected) message = "Tour Core's public address reaches a different Tour Core installation.";
      else {
        ok = true;
        message = "Tour Core is reachable at its public address.";
      }
    } catch {
      message = "Tour Core's public address didn't answer.";
    }
  }
  inst.files.recordCheck("publicEndpointCheck", { ok, at: new Date(inst.now()).toISOString(), message, url });
  return { ok, url, message };
}

/**
 * Checks visitor messaging end to end and repairs what Tour Core owns: its
 * own incoming-message webhook for the current public address (removing the
 * one for a previous address) and the webhook secret. Account details are
 * never changed here; they're entered on the secure setup page.
 */
export async function testVisitorMessaging(inst: Installation, options: { onConnected?: () => void } = {}) {
  const env = inst.sendblueEnv();
  const previous = inst.files.state().visitorMessaging?.webhookUrl;
  const result = await connectSendblue(env, {
    saveWebhookSecret: (secret) => inst.secrets.set({ SENDBLUE_WEBHOOK_SECRET: secret }, new Date(inst.now())),
    previousWebhookUrl: previous,
  });
  const problems = [...(result.problem ? [result.problem] : []), ...result.checks.filter((c) => !c.ok).map((c) => c.message)];
  const message = result.ok ? "Visitor texting is connected." : (problems[0] ?? "Visitor texting isn't connected yet.");
  inst.files.recordCheck("visitorMessaging", {
    ok: result.ok,
    at: new Date(inst.now()).toISOString(),
    message,
    problems,
    ...(env.publicBaseUrl ? { publicBaseUrl: env.publicBaseUrl } : {}),
    ...(result.webhookUrl ? { webhookUrl: result.webhookUrl } : previous ? { webhookUrl: previous } : {}),
  });
  if (result.ok) {
    inst.files.update({ messagingProvider: "SENDBLUE" }, new Date(inst.now()));
    options.onConnected?.();
  }
  return {
    ok: result.ok,
    message,
    checks: result.checks.map((c) => ({ check: c.label, ok: c.ok, message: c.message })),
    incomingMessages:
      result.webhook === "registered"
        ? "Registered Tour Core's incoming-message address with Sendblue."
        : result.webhook === "re-registered"
          ? "Updated Tour Core's incoming-message address with Sendblue."
          : result.webhook === "already-registered"
            ? "Sendblue already sends visitor replies to Tour Core."
            : "Not changed.",
    ...(result.removedPreviousWebhook ? { previousAddress: "Removed Tour Core's old incoming-message address from Sendblue." } : {}),
    ...(env.fromNumber ? { textingNumber: env.fromNumber } : {}),
  };
}

/** Sends one test event to the operator alert channel and records whether it was accepted. */
export async function testOperatorAlerts(inst: Installation) {
  const sink = inst.sink();
  const credentialsChangedAt = [inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_URL"), inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_KEY")]
    .filter((v): v is string => !!v)
    .sort()
    .at(-1);
  const at = new Date(inst.now());
  if (!sink.configured()) {
    return { ok: false, message: "Operator alerts aren't connected yet. The Grok Routine's details go in on the secure setup page." };
  }
  let ok = false;
  let message: string;
  try {
    await sink.deliver(testEvent(at));
    ok = true;
    message = "Sent a test update. The Tour Core Operator Updates routine should wake up and post a short confirmation.";
  } catch (err) {
    message = err instanceof Error ? err.message : "The test alert couldn't be delivered.";
  }
  inst.files.recordCheck("operatorAlerts", { ok, at: at.toISOString(), message, ...(credentialsChangedAt ? { credentialsChangedAt } : {}) });
  if (ok) {
    inst.files.update({ operatorNotificationProvider: "GROK_ROUTINE" }, at);
    void inst.outbox.drain().catch(() => undefined);
  }
  return { ok, message };
}

/** Saves, reads back and removes a test record in both the tour records folder and the runtime records. */
export async function testStorage(inst: Installation, services: OperatorServices) {
  const problems: string[] = [];
  try {
    probeRuntimeStore(inst.runtime, new Date(inst.now()));
  } catch {
    problems.push("Running tours couldn't be saved.");
  }
  const probe = join(services.workspace.root, `.probe-${randomBytes(6).toString("hex")}`);
  try {
    writeFileAtomic(probe, "tour-core");
    if (!existsSync(probe) || readFileSync(probe, "utf8") !== "tour-core") throw new Error("mismatch");
  } catch {
    problems.push("Tour records couldn't be saved.");
  } finally {
    rmSync(probe, { force: true });
  }
  if (!problems.length && inst.records.provider() === "GOOGLE_DRIVE_READY") {
    try {
      await inst.records.probe();
    } catch {
      problems.push("Google Drive didn't save a test record.");
    }
  }
  const provider = inst.records.provider();
  const where = provider === "GOOGLE_DRIVE_READY" ? "Tour records: Google Drive connected." : provider === "LOCAL_DEMO" ? "Tour records: Stored locally." : inst.records.summary();
  return {
    ok: problems.length === 0,
    provider,
    message: problems.length ? problems.join(" ") : `${where} A test record saved and read back correctly.`,
  };
}

export async function testAccess(inst: Installation) {
  const durin = new MockDurinAccessAdapter({ doorNames: {}, timeZone: "UTC", now: () => new Date(inst.now()) });
  const health = await durin.getHealth();
  return {
    ok: health.healthy,
    accessSystem: "Demo",
    message: health.healthy ? "Access system: Demo. It's answering, and no real doors open." : "Access system: Demo, but it isn't answering.",
  };
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
