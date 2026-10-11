import { resolve } from "node:path";
import type { SmsProofSettings } from "./smsProof";

/** Messages contain setting names and requirements only, never supplied values. */
export class DelegationStartupError extends Error {}

export function validateTestCredentials(agentToken: unknown, adminToken: unknown) {
  for (const [name, value] of [["CLEANER_TEST_AGENT_TOKEN", agentToken], ["CLEANER_TEST_ADMIN_TOKEN", adminToken]] as const) {
    if (typeof value !== "string" || value.length === 0) throw new DelegationStartupError(`${name} is missing. Add it to the service variables.`);
    if (value.length < 32) throw new DelegationStartupError(`${name} must contain at least 32 characters.`);
  }
  if (agentToken === adminToken) throw new DelegationStartupError("CLEANER_TEST_AGENT_TOKEN and CLEANER_TEST_ADMIN_TOKEN must have different values.");
  return { agentToken: agentToken as string, adminToken: adminToken as string };
}

export function resolveTestStartupConfig(env: NodeJS.ProcessEnv) {
  const root = resolve(env.CLEANER_TEST_HOME ?? "tourcore-data/cleaner-core-test");
  const port = Number(env.CLEANER_TEST_PORT ?? env.PORT ?? 4332);
  const host = env.CLEANER_TEST_HOST ?? "127.0.0.1";
  let publicBaseUrl = env.CLEANER_TEST_PUBLIC_URL ?? (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new DelegationStartupError("PORT (or CLEANER_TEST_PORT) must be an integer between 1 and 65535.");
  if (host !== "127.0.0.1" && host !== "0.0.0.0") throw new DelegationStartupError("CLEANER_TEST_HOST must be 127.0.0.1 or 0.0.0.0.");
  if (host === "0.0.0.0" && !publicBaseUrl) throw new DelegationStartupError("Set CLEANER_TEST_PUBLIC_URL to the HTTPS origin, or generate a Railway domain supplying RAILWAY_PUBLIC_DOMAIN.");
  if (publicBaseUrl !== undefined) {
    let url: URL;
    try { url = new URL(publicBaseUrl); }
    catch { throw new DelegationStartupError("CLEANER_TEST_PUBLIC_URL (or RAILWAY_PUBLIC_DOMAIN) does not form a valid HTTPS origin."); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new DelegationStartupError("CLEANER_TEST_PUBLIC_URL must be an HTTPS origin with no credentials, /mcp path, query, or fragment.");
    }
    publicBaseUrl = url.origin;
  }
  const supplied = env.CLEANER_TEST_AGENT_TOKEN !== undefined || env.CLEANER_TEST_ADMIN_TOKEN !== undefined;
  const credentials = supplied || host === "0.0.0.0" ? validateTestCredentials(env.CLEANER_TEST_AGENT_TOKEN, env.CLEANER_TEST_ADMIN_TOKEN) : undefined;
  let webhook: { url: string; authorization: string } | undefined;
  if (env.CLEANER_TEST_WEBHOOK_URL !== undefined || env.CLEANER_TEST_WEBHOOK_AUTH !== undefined) {
    if (!env.CLEANER_TEST_WEBHOOK_URL) throw new DelegationStartupError("CLEANER_TEST_WEBHOOK_URL is missing. Supply both webhook variables or remove both.");
    if (!env.CLEANER_TEST_WEBHOOK_AUTH || /[\r\n]/.test(env.CLEANER_TEST_WEBHOOK_AUTH)) throw new DelegationStartupError("CLEANER_TEST_WEBHOOK_AUTH must contain the complete Authorization header value without line breaks.");
    let url: URL;
    try { url = new URL(env.CLEANER_TEST_WEBHOOK_URL); }
    catch { throw new DelegationStartupError("CLEANER_TEST_WEBHOOK_URL must be a valid HTTPS address."); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new DelegationStartupError("CLEANER_TEST_WEBHOOK_URL must be HTTPS with no embedded credentials or fragment.");
    webhook = { url: env.CLEANER_TEST_WEBHOOK_URL, authorization: env.CLEANER_TEST_WEBHOOK_AUTH };
  }
  let sms: SmsProofSettings | undefined;
  if (env.CLEANER_TEST_SMS_ENABLED !== undefined && !["true", "false"].includes(env.CLEANER_TEST_SMS_ENABLED)) throw new DelegationStartupError("CLEANER_TEST_SMS_ENABLED must be true or false.");
  if (env.CLEANER_TEST_SMS_ENABLED === "true") {
    const accountSid = env.CLEANER_TEST_TWILIO_ACCOUNT_SID;
    const authToken = env.CLEANER_TEST_TWILIO_AUTH_TOKEN;
    const fromNumber = env.CLEANER_TEST_TWILIO_FROM_NUMBER;
    const testNumber = env.CLEANER_TEST_SMS_TEST_NUMBER;
    if (!accountSid || !/^AC[a-fA-F0-9]{32}$/.test(accountSid)) throw new DelegationStartupError("CLEANER_TEST_TWILIO_ACCOUNT_SID must be a valid Twilio Account SID.");
    if (!authToken || authToken.length < 32 || authToken !== authToken.trim()) throw new DelegationStartupError("CLEANER_TEST_TWILIO_AUTH_TOKEN must contain the complete account auth token with no surrounding whitespace.");
    for (const [name, value] of [["CLEANER_TEST_TWILIO_FROM_NUMBER", fromNumber], ["CLEANER_TEST_SMS_TEST_NUMBER", testNumber]]) {
      if (!value || !/^\+[1-9]\d{7,14}$/.test(value)) throw new DelegationStartupError(`${name} must be a complete E.164 phone number.`);
    }
    if (fromNumber === testNumber) throw new DelegationStartupError("The Twilio sender and controlled test phone must be different numbers.");
    if (!publicBaseUrl || !webhook) throw new DelegationStartupError("SMS proof requires an HTTPS public origin and the configured Cleaner Core test webhook.");
    sms = { accountSid, authToken, fromNumber: fromNumber!, testNumber: testNumber!, publicBaseUrl };
  }
  return { root, port, host, publicBaseUrl, credentials, webhook, sms };
}
