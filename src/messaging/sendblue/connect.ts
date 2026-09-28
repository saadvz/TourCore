import { randomBytes } from "node:crypto";
import { mapSendblueError } from "./adapter";
import { checkSendblue, type MessagingCheck } from "./readiness";
import { SENDBLUE_WEBHOOK_PATH, sendblueRuntime, webhookUrlFor, type SendblueEnv } from "./runtime";

/**
 * Connects this Tour Core to a Sendblue account end to end: checks the
 * account and line, makes sure incoming messages are protected by a webhook
 * secret, registers (or repairs) Tour Core's own receive webhook for the
 * current public address, removes Tour Core's webhook for a previous address,
 * then runs the same read-only checks readiness uses. Other webhooks on the
 * account are never touched. Nothing here returns or logs a credential.
 */

export interface SendblueConnectResult {
  ok: boolean;
  checks: MessagingCheck[];
  webhook: "already-registered" | "registered" | "re-registered" | "not-attempted";
  removedPreviousWebhook: boolean;
  webhookUrl?: string;
  /** Plain-language problem when a step failed before the checks. */
  problem?: string;
}

const hookUrl = (h: string | { url: string }) => (typeof h === "string" ? h : h.url);

export async function connectSendblue(
  env: SendblueEnv,
  options: {
    /** Stores a newly created webhook secret (the SecretStore); called only when none exists. */
    saveWebhookSecret: (secret: string) => void;
    /** Tour Core's webhook for an earlier public address, to remove. */
    previousWebhookUrl?: string;
  },
): Promise<SendblueConnectResult> {
  const notAttempted = async (problem?: string): Promise<SendblueConnectResult> => ({
    ok: false,
    checks: await checkSendblue(env),
    webhook: "not-attempted",
    removedPreviousWebhook: false,
    ...(problem ? { problem } : {}),
  });
  if (!env.apiKey || !env.apiSecret || !env.fromNumber) return notAttempted();
  const url = webhookUrlFor(env);
  if (!url) return notAttempted("Tour Core doesn't have a public https address yet, so Sendblue can't deliver visitor replies.");

  const client = sendblueRuntime.client(env);
  let hooks: Array<string | { url: string; secret?: string }>;
  try {
    hooks = (await client.webhooks.list()).webhooks?.receive ?? [];
  } catch (err) {
    const e = mapSendblueError(err);
    return notAttempted(e.code === "SENDBLUE_AUTH_FAILED" ? "Sendblue didn't accept those account details." : "Couldn't reach Sendblue right now.");
  }

  let secret = env.webhookSecret;
  const newSecret = !secret;
  if (!secret) {
    secret = randomBytes(24).toString("base64url");
    options.saveWebhookSecret(secret);
  }
  const withSecret: SendblueEnv = { ...env, webhookSecret: secret };

  let webhook: SendblueConnectResult["webhook"];
  const mine = hooks.find((h) => hookUrl(h) === url);
  // A registration made before this secret existed can't be carrying it.
  const mismatched = !!mine && (newSecret || (typeof mine === "object" && !!mine.secret && mine.secret !== secret));
  try {
    if (mine && !mismatched) webhook = "already-registered";
    else {
      if (mine) await client.webhooks.delete({ webhooks: [url], type: "receive" });
      await client.webhooks.create({ webhooks: [{ url, secret, sendblue_numbers: [env.fromNumber] }], type: "receive" });
      webhook = mine ? "re-registered" : "registered";
    }
  } catch {
    return { ...(await notAttempted("Sendblue didn't accept Tour Core's incoming-message address.")), checks: await checkSendblue(withSecret) };
  }

  let removedPreviousWebhook = false;
  const previous = options.previousWebhookUrl;
  if (previous && previous !== url && previous.endsWith(SENDBLUE_WEBHOOK_PATH) && hooks.some((h) => hookUrl(h) === previous)) {
    try {
      await client.webhooks.delete({ webhooks: [previous], type: "receive" });
      removedPreviousWebhook = true;
    } catch {
      // The old address no longer reaches Tour Core anyway; leaving it only costs Sendblue a failed delivery.
    }
  }

  const checks = await checkSendblue(withSecret);
  return { ok: checks.every((c) => c.ok), checks, webhook, removedPreviousWebhook, webhookUrl: url };
}
