import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { parsePhone } from "../core/phone";
import { cleanerCoreEnabled } from "./flag";
import { liveDeskFor } from "./liveDesk";
import { CLEANER_PIN_STATUS_PATH } from "./liveSms";
import type { InboundMedia } from "./photos";
import { formParams, verifyTwilioSignature } from "../messaging/twilio/signature";

export const CLEANER_TWILIO_PATH = "/webhooks/twilio/cleaner-core";
export const CLEANER_TWILIO_STATUS_PATH = CLEANER_PIN_STATUS_PATH;
/** Twilio sends at most 10 attachments with one MMS. */
const MAX_MEDIA = 10;

/** An MMS's attachments: NumMedia (0 to 10), then MediaUrl{i} and MediaContentType{i}. Never logged. */
function mediaOf(params: Record<string, string>): InboundMedia[] {
  const count = Math.min(MAX_MEDIA, Math.max(0, Number.parseInt(params.NumMedia ?? "0", 10) || 0));
  return Array.from({ length: count }, (_, index) => ({ url: params[`MediaUrl${index}`]?.trim() ?? "", contentType: params[`MediaContentType${index}`]?.trim() ?? "" })).filter(
    (item) => item.url.length > 0,
  );
}

export function textAddressedTo(raw: Buffer, number: string | undefined): boolean {
  if (!number) return false;
  const to = formParams(raw).To;
  if (!to) return false;
  const left = parsePhone(to);
  const right = parsePhone(number);
  return Boolean(left && right && left === right);
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Inbound texts for the cleaning number. STOP and START are applied
 * before any job step. The HTTP body never includes a door code or a reply.
 */
export async function handleCleanerTwilioWebhook(input: {
  rawBody: Buffer;
  headers: IncomingHttpHeaders;
  url: string | undefined;
  /** Live: the desk keeps this getter. */
  env: () => NodeJS.ProcessEnv;
  root: string;
  now: () => Date;
}): Promise<{ status: number; body: string }> {
  const env = input.env();
  if (!cleanerCoreEnabled(env)) return { status: 404, body: "" };
  const params = formParams(input.rawBody);
  const signature = header(input.headers, "x-twilio-signature");
  const verified = verifyTwilioSignature(env.CLEANER_CORE_TWILIO_AUTH_TOKEN?.trim(), input.url, params, signature);
  if (!verified.ok) return { status: 403, body: JSON.stringify({ error: "unauthorized" }) };
  const from = params.From ?? "";
  const text = params.Body ?? "";
  const id = params.MessageSid?.trim() || createHash("sha256").update(`${from}\n${text}`).digest("hex");
  const media = mediaOf(params);
  const desk = liveDeskFor(input.root, input.env, input.now);
  await desk.inbound({ id, from, text, ...(media.length > 0 ? { media } : {}) });
  return { status: 200, body: "{}" };
}

/** Delivery status for a door-code text. Signature required. Never unseals or resends the code. */
export async function handleCleanerTwilioStatus(input: {
  rawBody: Buffer;
  headers: IncomingHttpHeaders;
  url: string | undefined;
  /** Live: the desk keeps this getter. */
  env: () => NodeJS.ProcessEnv;
  root: string;
  now: () => Date;
}): Promise<{ status: number; body: string }> {
  const env = input.env();
  if (!cleanerCoreEnabled(env)) return { status: 404, body: "" };
  const params = formParams(input.rawBody);
  const signature = header(input.headers, "x-twilio-signature");
  const verified = verifyTwilioSignature(env.CLEANER_CORE_TWILIO_AUTH_TOKEN?.trim(), input.url, params, signature);
  if (!verified.ok) return { status: 403, body: JSON.stringify({ error: "unauthorized" }) };
  const sid = params.MessageSid?.trim() || params.SmsSid?.trim() || "";
  const status = (params.MessageStatus || params.SmsStatus || "").toLowerCase();
  if (sid && status) {
    const desk = liveDeskFor(input.root, input.env, input.now);
    await desk.notePinDelivery({ sid, status });
  }
  return { status: 200, body: "{}" };
}
