import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { toE164 } from "../Messenger";
import type { InboundMessage } from "../inbound";
import type { MessagingLedger } from "../ledger";
import { channelFromService } from "./adapter";

/**
 * Sendblue receive webhooks. Authenticity is checked on the raw bytes before
 * anything is parsed:
 *  - `X-Sendblue-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`
 *    when present (with a 5-minute replay window), otherwise
 *  - the `sb-signing-secret` header, which Sendblue sets to the webhook's secret.
 * Comparisons are constant-time. Secrets and bodies are never logged.
 */

export type WebhookAuth = { ok: true; signed: boolean } | { ok: false; code: "WEBHOOK_UNSIGNED" | "WEBHOOK_SIGNATURE_INVALID" | "WEBHOOK_SIGNATURE_EXPIRED" };

type Headers = Record<string, string | string[] | undefined>;
const header = (h: Headers, name: string) => {
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

function sameSecret(a: string, b: string): boolean {
  // Hash both sides so length differences don't leak through an early exit.
  const ha = createHmac("sha256", "tourcore-compare").update(a).digest();
  const hb = createHmac("sha256", "tourcore-compare").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function verifySendblueWebhook(raw: Buffer, headers: Headers, secret: string | undefined, nowMs = Date.now(), toleranceSec = 300): WebhookAuth {
  if (!secret) return { ok: true, signed: false };

  const signature = header(headers, "x-sendblue-signature");
  if (signature) {
    const parts = Object.fromEntries(signature.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
    const t = Number(parts.t);
    const v1 = parts.v1 ?? "";
    if (!Number.isFinite(t) || !/^[0-9a-f]+$/i.test(v1)) return { ok: false, code: "WEBHOOK_SIGNATURE_INVALID" };
    if (Math.abs(nowMs / 1000 - t) > toleranceSec) return { ok: false, code: "WEBHOOK_SIGNATURE_EXPIRED" };
    const expected = createHmac("sha256", secret).update(`${parts.t}.`).update(raw).digest();
    const given = Buffer.from(v1, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected) ? { ok: true, signed: true } : { ok: false, code: "WEBHOOK_SIGNATURE_INVALID" };
  }

  const shared = header(headers, "sb-signing-secret");
  if (!shared) return { ok: false, code: "WEBHOOK_UNSIGNED" };
  return sameSecret(shared, secret) ? { ok: true, signed: true } : { ok: false, code: "WEBHOOK_SIGNATURE_INVALID" };
}

export const SendblueInboundSchema = z
  .object({
    message_handle: z.string().min(1),
    content: z.string().nullish(),
    from_number: z.string(),
    to_number: z.string().nullish(),
    sendblue_number: z.string().nullish(),
    is_outbound: z.boolean().nullish(),
    status: z.string().nullish(),
    service: z.string().nullish(),
    message_type: z.string().nullish(),
    group_id: z.string().nullish(),
    date_sent: z.string().nullish(),
  })
  .passthrough();

/** Turns a verified Sendblue payload into Tour Core's provider-neutral inbound message, or says why it's ignored. */
export function parseSendblueInbound(payload: unknown, now = new Date()): { message: InboundMessage } | { ignored: string } {
  const parsed = SendblueInboundSchema.safeParse(payload);
  if (!parsed.success) return { ignored: "not a message event" };
  const p = parsed.data;
  if (p.is_outbound) return { ignored: "outbound status update" };
  if (p.message_type === "group" || (p.group_id ?? "") !== "") return { ignored: "group message" };
  const from = toE164(p.from_number);
  if (!from) return { ignored: "unreadable sender" };
  const line = toE164(p.sendblue_number ?? p.to_number ?? "");
  return {
    message: {
      provider: "sendblue",
      providerMessageId: p.message_handle,
      from,
      ...(line ? { to: line } : {}),
      text: (p.content ?? "").trim(),
      channel: channelFromService(p.service),
      receivedAt: p.date_sent && !Number.isNaN(Date.parse(p.date_sent)) ? new Date(p.date_sent).toISOString() : now.toISOString(),
    },
  };
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The whole receive pipeline: verify, parse, de-duplicate, hand to Tour Core.
 * Always answers quickly; a repeat delivery is acknowledged but never re-run.
 */
export async function handleSendblueWebhook(
  request: { rawBody: Buffer; headers: Headers },
  deps: {
    secret: string | undefined;
    ledger: MessagingLedger;
    receive: (message: InboundMessage) => Promise<void>;
    now?: () => Date;
    log?: (line: string) => void;
  },
): Promise<WebhookResult> {
  const now = deps.now?.() ?? new Date();
  const auth = verifySendblueWebhook(request.rawBody, request.headers, deps.secret, now.getTime());
  if (!auth.ok) {
    deps.log?.(`Sendblue webhook rejected (${auth.code}).`);
    return { status: 401, body: { error: "unauthorized" } };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(request.rawBody.toString("utf8"));
  } catch {
    return { status: 400, body: { error: "invalid json" } };
  }
  const parsed = parseSendblueInbound(payload, now);
  if ("ignored" in parsed) return { status: 200, body: { ignored: parsed.ignored } };

  const key = `sendblue:in:${parsed.message.providerMessageId}`;
  if (!deps.ledger.claim(key, now)) return { status: 200, body: { duplicate: true } };
  try {
    await deps.receive(parsed.message);
    deps.ledger.complete(key);
    return { status: 200, body: { ok: true } };
  } catch (err) {
    // Retrying won't help and could repeat half-done work; acknowledge and keep the failure on record.
    deps.ledger.fail(key);
    deps.log?.(`Couldn't process a Sendblue message: ${err instanceof Error ? err.message : "unknown error"}`);
    return { status: 200, body: { ok: false } };
  }
}
