import { mapSendblueError } from "./adapter";
import { sendblueRuntime, webhookUrlFor, type SendblueEnv } from "./runtime";
import type { MessagingCheck } from "../provider";

export type { MessagingCheck };

/**
 * Can this computer text visitors through Sendblue and hear their replies?
 * Uses the real Sendblue API (read-only calls); nothing is sent.
 */
export async function checkSendblue(env: SendblueEnv = sendblueRuntime.env()): Promise<MessagingCheck[]> {
  const checks: MessagingCheck[] = [];
  const add = (c: MessagingCheck) => checks.push(c);

  if (!env.apiKey || !env.apiSecret) {
    add({ id: "account", label: "Sendblue account", ok: false, code: "SENDBLUE_KEYS_MISSING", message: "Visitor messaging isn't connected yet: the Sendblue account details aren't set up on this computer." });
  }
  const client = env.apiKey && env.apiSecret ? sendblueRuntime.client(env) : undefined;

  let receiveHooks: Array<string | { url: string; secret?: string }> | undefined;
  if (client) {
    try {
      receiveHooks = (await client.webhooks.list()).webhooks?.receive ?? [];
      add({ id: "account", label: "Sendblue account", ok: true, message: "Sendblue account connected" });
    } catch (err) {
      const e = mapSendblueError(err);
      add({
        id: "account",
        label: "Sendblue account",
        ok: false,
        code: e.code,
        message: e.code === "SENDBLUE_AUTH_FAILED" ? "Visitor messaging couldn't sign in to Sendblue. Check the Sendblue account details." : "Couldn't reach Sendblue right now. Check the internet connection and try again.",
      });
    }
  }

  if (!env.fromNumberRaw) {
    add({ id: "line", label: "Messaging number", ok: false, code: "SENDBLUE_FROM_NUMBER_MISSING", message: "The Sendblue messaging number isn't set up yet." });
  } else if (!env.fromNumber) {
    add({ id: "line", label: "Messaging number", ok: false, code: "SENDBLUE_FROM_NUMBER_INVALID", message: "The Sendblue messaging number doesn't look like a full phone number (for example +15551234567)." });
  } else if (client && receiveHooks) {
    try {
      const lines = (await client.lines.getState()).data;
      const line = lines.find((l) => l.sendblue_number === env.fromNumber);
      if (!line) add({ id: "line", label: "Messaging number", ok: false, code: "SENDBLUE_LINE_NOT_FOUND", message: `${env.fromNumber} isn't one of this Sendblue account's numbers.` });
      else if (line.status === "OFFLINE") add({ id: "line", label: "Messaging number", ok: false, code: "SENDBLUE_LINE_OFFLINE", message: `${env.fromNumber} is offline right now, so messages can't go out.` });
      else add({ id: "line", label: "Messaging number", ok: true, message: `Messaging number connected (${env.fromNumber})` });
    } catch (err) {
      const e = mapSendblueError(err);
      // Some plans don't report line status; the number is still usable if the account works.
      if (e.code === "SENDBLUE_NOT_FOUND" || e.code === "SENDBLUE_AUTH_FAILED") {
        add({ id: "line", label: "Messaging number", ok: true, code: "SENDBLUE_LINE_STATUS_UNAVAILABLE", message: `Messaging number set (${env.fromNumber})` });
      } else {
        add({ id: "line", label: "Messaging number", ok: false, code: e.code, message: "Couldn't check the messaging number with Sendblue right now." });
      }
    }
  } else {
    add({ id: "line", label: "Messaging number", ok: false, code: "SENDBLUE_LINE_UNCHECKED", message: `The messaging number (${env.fromNumber}) can be checked once the Sendblue account is connected.` });
  }

  const url = webhookUrlFor(env);
  if (!url) {
    add({
      id: "incoming",
      label: "Incoming messages",
      ok: false,
      code: env.publicBaseUrlRaw ? "PUBLIC_BASE_URL_NOT_HTTPS" : "PUBLIC_BASE_URL_MISSING",
      message: "Replies from visitors can't reach this computer yet: no public https web address is set.",
    });
  } else if (!env.webhookSecret) {
    add({ id: "incoming", label: "Incoming messages", ok: false, code: "SENDBLUE_WEBHOOK_SECRET_MISSING", message: "Incoming messages aren't protected with a secret yet. Run the Sendblue setup step." });
  } else if (receiveHooks) {
    const hook = receiveHooks.find((h) => (typeof h === "string" ? h : h.url) === url);
    if (!hook) add({ id: "incoming", label: "Incoming messages", ok: false, code: "SENDBLUE_WEBHOOK_NOT_REGISTERED", message: "Sendblue isn't sending visitor replies to Tour Core yet. Run the Sendblue setup step." });
    else if (typeof hook === "object" && hook.secret && hook.secret !== env.webhookSecret) {
      add({ id: "incoming", label: "Incoming messages", ok: false, code: "SENDBLUE_WEBHOOK_SECRET_MISMATCH", message: "Sendblue is using a different webhook secret than this computer. Run the Sendblue setup step." });
    } else add({ id: "incoming", label: "Incoming messages", ok: true, message: "Incoming messages connected" });
  } else {
    add({ id: "incoming", label: "Incoming messages", ok: false, code: "SENDBLUE_WEBHOOK_UNCHECKED", message: "Incoming messages can be checked once the Sendblue account is connected." });
  }

  add(
    env.publicBaseUrl
      ? { id: "verify-link", label: "Identity form link", ok: true, message: "Visitors can open the identity form from their phone" }
      : {
          id: "verify-link",
          label: "Identity form link",
          ok: false,
          code: "VERIFY_LINK_UNAVAILABLE",
          message: "Visitors can't open the identity form from their phone until a public https web address is set.",
        },
  );
  return checks;
}
