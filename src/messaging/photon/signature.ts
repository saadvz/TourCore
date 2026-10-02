import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookVerification } from "../provider";

const FIVE_MINUTES = 300;

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Legacy Spectrum header: `X-Spectrum-Signature: v0=<hex>` over
 * `v0:{timestamp}:{rawBody}` with the webhook signing secret.
 * https://photon.codes/docs/webhooks/verifying-signatures (Stable)
 */
export function verifyLegacySpectrumSignature(rawBody: Buffer, signingSecret: string, signature: string, timestamp: string, nowMs = Date.now()): WebhookVerification {
  const t = Number(timestamp);
  if (!Number.isFinite(t)) return { ok: false, code: "WEBHOOK_SIGNATURE_INVALID" };
  if (Math.abs(nowMs / 1000 - t) > FIVE_MINUTES) return { ok: false, code: "WEBHOOK_SIGNATURE_EXPIRED" };
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:`).update(rawBody).digest("hex")}`;
  return safeEqual(Buffer.from(expected), Buffer.from(signature)) ? { ok: true, signed: true } : { ok: false, code: "WEBHOOK_SIGNATURE_INVALID" };
}

function standardKey(secret: string): Buffer | undefined {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`)
 * using the `whsec_` secret returned when the webhook is registered.
 * Signed content is `id.timestamp.rawBody`.
 */
export function verifyStandardWebhook(rawBody: Buffer, secret: string, id: string, timestamp: string, signatureHeader: string, nowMs = Date.now()): WebhookVerification {
  const t = Number(timestamp);
  if (!Number.isFinite(t) || !id) return { ok: false, code: "WEBHOOK_SIGNATURE_INVALID" };
  if (Math.abs(nowMs / 1000 - t) > FIVE_MINUTES) return { ok: false, code: "WEBHOOK_SIGNATURE_EXPIRED" };
  const key = standardKey(secret);
  if (!key) return { ok: false, code: "WEBHOOK_SIGNATURE_INVALID" };
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(rawBody).digest();
  const parts = signatureHeader.split(" ").filter(Boolean);
  for (const part of parts) {
    const [version, encoded] = part.split(",", 2);
    if (version !== "v1" || !encoded) continue;
    const given = Buffer.from(encoded, "base64");
    if (safeEqual(expected, given)) return { ok: true, signed: true };
  }
  return { ok: false, code: "WEBHOOK_SIGNATURE_INVALID" };
}

export function verifyPhotonWebhook(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secrets: { signingSecret?: string; standardSigningSecret?: string },
  nowMs = Date.now(),
): WebhookVerification {
  if (!secrets.signingSecret && !secrets.standardSigningSecret) return { ok: false, code: "WEBHOOK_UNSIGNED" };

  const standardId = header(headers, "webhook-id");
  const standardTimestamp = header(headers, "webhook-timestamp");
  const standardSignature = header(headers, "webhook-signature");
  if (secrets.standardSigningSecret && standardId && standardTimestamp && standardSignature) {
    const standard = verifyStandardWebhook(rawBody, secrets.standardSigningSecret, standardId, standardTimestamp, standardSignature, nowMs);
    if (standard.ok) return standard;
  }

  const legacySignature = header(headers, "x-spectrum-signature");
  const legacyTimestamp = header(headers, "x-spectrum-timestamp");
  if (secrets.signingSecret && legacySignature && legacyTimestamp) {
    return verifyLegacySpectrumSignature(rawBody, secrets.signingSecret, legacySignature, legacyTimestamp, nowMs);
  }

  if ((standardSignature && secrets.standardSigningSecret) || (legacySignature && secrets.signingSecret)) {
    return { ok: false, code: "WEBHOOK_SIGNATURE_INVALID" };
  }
  return { ok: false, code: "WEBHOOK_UNSIGNED" };
}
