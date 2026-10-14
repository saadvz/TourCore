import { parsePhone } from "../core/phone";
import { twilioHttpClient, type TwilioClient } from "../messaging/twilio/client";

/** Off unless CLEANER_CORE_LIVE_SMS is exactly "1" or "true". */
export function liveSmsOn(env: NodeJS.ProcessEnv): boolean {
  const raw = env.CLEANER_CORE_LIVE_SMS?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export function smsAllowlist(env: NodeJS.ProcessEnv): string[] {
  const raw = env.CLEANER_CORE_SMS_ALLOWLIST ?? "";
  const phones: string[] = [];
  for (const part of raw.split(",")) {
    const phone = parsePhone(part.trim());
    if (phone) phones.push(phone);
  }
  return phones;
}

export function isAllowlisted(env: NodeJS.ProcessEnv, phone: string): boolean {
  const parsed = parsePhone(phone);
  if (!parsed) return false;
  return smsAllowlist(env).includes(parsed);
}

let clientOverride: TwilioClient | undefined;

/** Tests replace the Cleaner Core Twilio client. Unset uses the account in the environment. */
export function setCleanerTwilioClient(client: TwilioClient | undefined): void {
  clientOverride = client;
}

export function cleanerTwilioClient(env: NodeJS.ProcessEnv): TwilioClient {
  if (clientOverride) return clientOverride;
  const accountSid = env.CLEANER_CORE_TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.CLEANER_CORE_TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken) throw new Error("not sent");
  return twilioHttpClient({ accountSid, authToken });
}

export const CLEANER_PIN_STATUS_PATH = "/webhooks/twilio/cleaner-core/status";

export function cleanerPinStatusUrl(env: NodeJS.ProcessEnv): string | undefined {
  const base = env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  if (!base) return undefined;
  return `${base}${CLEANER_PIN_STATUS_PATH}`;
}

/** Sends one text when live texts are on and the number is allowed. A failed Twilio status throws. */
export async function sendLiveSms(env: NodeJS.ProcessEnv, text: { to: string; body: string; statusCallback?: string }): Promise<string | undefined> {
  if (!liveSmsOn(env) || !isAllowlisted(env, text.to)) return undefined;
  const from = parsePhone(env.CLEANER_CORE_TWILIO_PHONE_NUMBER ?? "");
  if (!from) throw new Error("not sent");
  const result = await cleanerTwilioClient(env).sendSms({
    to: text.to,
    from,
    body: text.body,
    ...(text.statusCallback ? { statusCallback: text.statusCallback } : {}),
  });
  const status = (result.status ?? "").toLowerCase();
  if (status === "failed" || status === "undelivered" || status === "canceled") throw new Error("not sent");
  return result.sid;
}

let groupFetch: typeof fetch | undefined;

export function setCleanerGroupFetch(impl: typeof fetch | undefined): void {
  groupFetch = impl;
}

export async function sendLiveGroup(
  env: NodeJS.ProcessEnv,
  input: { audience: string[]; body: string; conversationSid?: string },
): Promise<{ sid?: string; conversationSid?: string } | undefined> {
  if (!liveSmsOn(env)) return undefined;
  const allow = smsAllowlist(env);
  if (allow.length === 0) return undefined;
  const audience = input.audience.map((phone) => parsePhone(phone)).filter((phone): phone is string => Boolean(phone));
  if (audience.length === 0 || audience.some((phone) => !allow.includes(phone))) return undefined;
  const accountSid = env.CLEANER_CORE_TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.CLEANER_CORE_TWILIO_AUTH_TOKEN?.trim();
  const from = parsePhone(env.CLEANER_CORE_TWILIO_PHONE_NUMBER ?? "");
  if (!accountSid || !authToken || !from) throw new Error("not sent");
  const fetchImpl = groupFetch ?? fetch;
  const root = "https://conversations.twilio.com/v1";
  const auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  const post = async (url: string, fields: Record<string, string>): Promise<{ sid?: string }> => {
    const body = new URLSearchParams(fields);
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error("not sent");
    return (await res.json()) as { sid?: string };
  };
  let conversationSid = input.conversationSid;
  if (!conversationSid) {
    const created = await post(`${root}/Conversations`, { FriendlyName: "Cleaning group" });
    if (!created.sid) throw new Error("not sent");
    conversationSid = created.sid;
    for (const phone of audience) {
      await post(`${root}/Conversations/${encodeURIComponent(conversationSid)}/Participants`, {
        "MessagingBinding.Address": phone,
        "MessagingBinding.ProxyAddress": from,
      });
    }
  }
  const message = await post(`${root}/Conversations/${encodeURIComponent(conversationSid)}/Messages`, { Body: input.body, Author: from });
  if (!message.sid) throw new Error("not sent");
  return { sid: message.sid, conversationSid };
}
