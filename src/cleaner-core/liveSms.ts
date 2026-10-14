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

/** Sends one text when live texts are on and the number is allowed. A failed Twilio status throws. */
export async function sendLiveSms(env: NodeJS.ProcessEnv, text: { to: string; body: string }): Promise<void> {
  if (!liveSmsOn(env) || !isAllowlisted(env, text.to)) return;
  const from = parsePhone(env.CLEANER_CORE_TWILIO_PHONE_NUMBER ?? "");
  if (!from) throw new Error("not sent");
  const result = await cleanerTwilioClient(env).sendSms({ to: text.to, from, body: text.body });
  const status = (result.status ?? "").toLowerCase();
  if (status === "failed" || status === "undelivered" || status === "canceled") throw new Error("not sent");
}
