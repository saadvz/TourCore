import type { DeliveryChannel } from "./Messenger";

/** A message a visitor sent, in provider-neutral terms. Webhook layers produce this. */
export interface InboundMessage {
  provider: string;
  /** Provider's id for this message; the durable de-duplication key. */
  providerMessageId: string;
  /** Visitor's number, E.164. */
  from: string;
  /** The line it was sent to, E.164, when known. */
  to?: string;
  text: string;
  channel: DeliveryChannel;
  receivedAt: string;
}
