import type { DeliveryChannel } from "./Messenger";

/** A file attached to an inbound message. Only safe delivery fields, never a raw provider payload. */
export interface InboundMedia {
  url?: string;
  contentType?: string;
}

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
  media?: InboundMedia[];
  channel: DeliveryChannel;
  receivedAt: string;
  /** Non-secret delivery hints. Not the provider's original payload. */
  metadata?: { status?: string };
  /**
   * Listing deep link: the property this first text is for, when the listing
   * already chose it. A street, public name, or property id. Not a tracking number.
   */
  listingProperty?: string;
}

/** True when the inbound included a photo or other attachment. Presence only; Tour Core does not download or forward files. */
export function hasInboundMedia(message: { media?: InboundMedia[] } | undefined): boolean {
  return (message?.media?.length ?? 0) > 0;
}
