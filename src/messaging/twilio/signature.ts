import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookVerification } from "../provider";

/**
 * Twilio's request signature: HMAC-SHA1 of the exact URL plus the POST
 * fields in sorted order, base64, compared with X-Twilio-Signature.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function verifyTwilioSignature(authToken: string | undefined, url: string | undefined, params: Record<string, string>, signature: string | undefined): WebhookVerification {
  if (!authToken || !url || !signature) return { ok: false, code: "WEBHOOK_UNSIGNED" };
  const expected = twilioSignature(authToken, url, params);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: "WEBHOOK_SIGNATURE_INVALID" };
  return { ok: true, signed: true };
}

export function formParams(raw: Buffer): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw.toString("utf8"))) params[key] = value;
  return params;
}
