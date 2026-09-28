/**
 * Tour Core's one messaging contract. Tour Core decides what to say and
 * records every message; an adapter only delivers it and reports back.
 * Nothing outside src/messaging knows which provider is behind this.
 */

/** How replies should be phrased: buttons on a web page, or typed replies in a messages app. */
export type MessageChannel = "WEB" | "MESSAGING";

/** Where a message actually went, when the provider tells us. */
export type DeliveryChannel = "IMESSAGE" | "SMS" | "RCS" | "WEB" | "DEMO" | "UNKNOWN";

export type DeliveryStatus = "QUEUED" | "SENT" | "DELIVERED" | "FAILED" | "SUPPRESSED" | "SKIPPED";

export interface OutgoingMessage {
  /** Phone number (E.164) for visitors; a contact label for operators. */
  to: string;
  /** Display name for logs and demos. */
  toName?: string;
  audience: "PROSPECT" | "OPERATOR";
  body: string;
  /** Same key => same send. Tour Core uses the message id. */
  idempotencyKey?: string;
  /** Ties a send to a conversation/session, for records. */
  correlationId?: string;
}

export interface DeliveryReceipt {
  provider: string;
  providerMessageId?: string;
  channel: DeliveryChannel;
  status: DeliveryStatus;
  sentAt: string;
  error?: { code: string; message: string };
}

/** A provider problem in provider-neutral terms. `message` is safe to show; it never contains secrets. */
export class MessagingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: { retryable?: boolean; status?: number } = {},
  ) {
    super(message);
  }
}

export interface MessagingAdapter {
  /** Provider name for records, e.g. "demo", "sendblue". */
  readonly provider: string;
  /** How messages sent through this adapter should be phrased. */
  readonly presentation: MessageChannel;
  send(message: OutgoingMessage): Promise<DeliveryReceipt>;
}

/** Earlier name for the same contract. */
export type Messenger = MessagingAdapter;

/** Prints texts instead of sending them. Used by the demo, practice tours and tests. */
export class DemoMessagingAdapter implements MessagingAdapter {
  readonly provider = "demo";
  constructor(
    private readonly log: (line: string) => void = (line) => console.log(line),
    readonly presentation: MessageChannel = "MESSAGING",
  ) {}

  async send(message: OutgoingMessage): Promise<DeliveryReceipt> {
    const label = message.audience === "OPERATOR" ? "TEXT -> operator" : "TEXT -> prospect";
    this.log(`    [${label} ${message.toName ?? message.to}]`);
    for (const line of message.body.split("\n")) this.log(`      ${line}`);
    return { provider: this.provider, channel: "DEMO", status: "SENT", sentAt: new Date().toISOString() };
  }
}

/** Kept so existing callers keep working. */
export const ConsoleMessenger = DemoMessagingAdapter;

/** "(555) 010-2000" -> "+15550102000". Undefined when it can't be a real number. */
export function toE164(raw: string): string | undefined {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  const e164 = trimmed.startsWith("+") ? `+${digits}` : digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : undefined;
  return e164 && /^\+[1-9]\d{9,14}$/.test(e164) ? e164 : undefined;
}
