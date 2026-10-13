import { MessagingError, toE164, type DeliveryChannel, type DeliveryReceipt, type DeliveryStatus, type MessagingAdapter, type OutgoingMessage } from "../Messenger";
import type { MessagingLedger } from "../ledger";
import type { SendblueClient } from "./runtime";

export function channelFromService(service: string | null | undefined): DeliveryChannel {
  switch ((service ?? "").toLowerCase()) {
    case "imessage":
      return "IMESSAGE";
    case "sms":
      return "SMS";
    case "rcs":
      return "RCS";
    default:
      return "UNKNOWN";
  }
}

/** Turns SDK/HTTP failures into provider-neutral errors. Messages are safe to show and never include secrets. */
export function mapSendblueError(err: unknown): MessagingError {
  const e = err as { status?: number; name?: string };
  const status = typeof e?.status === "number" ? e.status : undefined;
  const name = e?.name ?? "";
  if (status === 401 || status === 403) return new MessagingError("SENDBLUE_AUTH_FAILED", "Sendblue didn't accept the account details.", { status });
  if (status === 404) return new MessagingError("SENDBLUE_NOT_FOUND", "Sendblue couldn't find that number or resource.", { status });
  if (status === 429) return new MessagingError("SENDBLUE_RATE_LIMITED", "Sendblue is limiting messages right now. Try again shortly.", { status, retryable: true });
  if (status === 400 || status === 422) {
    return new MessagingError("SENDBLUE_REJECTED", "Sendblue didn't accept the message. The number may not be allowed to receive messages from this line yet.", { status });
  }
  if (status !== undefined && status >= 500) return new MessagingError("SENDBLUE_UNAVAILABLE", "Sendblue is having trouble right now.", { status, retryable: true });
  if (/Connection|Timeout/i.test(name)) return new MessagingError("SENDBLUE_UNREACHABLE", "Couldn't reach Sendblue.", { retryable: true });
  return new MessagingError("SENDBLUE_FAILED", "Sending through Sendblue failed.");
}

const STATUS: Record<string, DeliveryStatus> = {
  QUEUED: "QUEUED",
  PENDING: "QUEUED",
  REGISTERED: "QUEUED",
  ACCEPTED: "QUEUED",
  SENT: "SENT",
  DELIVERED: "DELIVERED",
  ERROR: "FAILED",
  DECLINED: "FAILED",
};

/**
 * Sends Tour Core's messages through Sendblue. The only messaging code that
 * knows Sendblue exists (besides the webhook and tooling).
 */
export class SendblueMessagingAdapter implements MessagingAdapter {
  readonly provider = "sendblue";
  readonly presentation = "MESSAGING" as const;
  /** Last channel each visitor actually used, learned from their inbound messages. */
  private readonly channels = new Map<string, DeliveryChannel>();

  constructor(
    private readonly options: {
      client: SendblueClient;
      fromNumber: string;
      statusCallbackUrl?: string;
      ledger?: MessagingLedger;
      now?: () => Date;
    },
  ) {}

  noteChannel(number: string, channel: DeliveryChannel): void {
    const e164 = toE164(number);
    if (e164 && channel !== "UNKNOWN") this.channels.set(e164, channel);
  }

  async send(message: OutgoingMessage): Promise<DeliveryReceipt> {
    const sentAt = (this.options.now?.() ?? new Date()).toISOString();
    // Operator alerts are shown in Tour Core's live view; they don't go out over the visitor line.
    if (message.audience === "OPERATOR") return { provider: this.provider, channel: "UNKNOWN", status: "SKIPPED", sentAt };

    const to = toE164(message.to);
    if (!to) throw new MessagingError("INVALID_NUMBER", "That phone number doesn't look right.");
    const from = toE164(this.options.fromNumber);
    if (!from) throw new MessagingError("SENDBLUE_FROM_NUMBER_INVALID", "The messaging number isn't set up correctly.");

    const key = message.idempotencyKey ? `sendblue:out:${message.idempotencyKey}` : undefined;
    const earlier = key ? this.options.ledger?.get<DeliveryReceipt>(key) : undefined;
    if (earlier) return earlier;

    let response: Awaited<ReturnType<SendblueClient["messages"]["send"]>>;
    try {
      // No automatic retries: a retried send after a timeout could text the visitor twice.
      response = await this.options.client.messages.send(
        { from_number: from, number: to, content: message.body, ...(this.options.statusCallbackUrl ? { status_callback: this.options.statusCallbackUrl } : {}) },
        { maxRetries: 0 },
      );
    } catch (err) {
      throw mapSendblueError(err);
    }

    const status = STATUS[response.status ?? ""] ?? "QUEUED";
    const receipt: DeliveryReceipt = {
      provider: this.provider,
      channel: channelFromService(response.service) !== "UNKNOWN" ? channelFromService(response.service) : (this.channels.get(to) ?? "UNKNOWN"),
      status,
      sentAt,
      ...(response.message_handle ? { providerMessageId: response.message_handle } : {}),
      ...(status === "FAILED" ? { error: { code: `SENDBLUE_SEND_ERROR${response.error_code ? `_${response.error_code}` : ""}`, message: "The message couldn't be delivered." } } : {}),
    };
    if (key) {
      this.options.ledger?.claim(key);
      this.options.ledger?.complete(key, receipt);
    }
    return receipt;
  }
}
