import { SetupInputError } from "../setup/setupActions";
import type { RuntimeStore } from "../storage/runtimeStore";
import { toE164 } from "./Messenger";

/**
 * Which property answers on which messaging line. Provider-neutral: an
 * endpoint is an address (a phone number today) plus the provider that
 * carries it; the property's own setup knows nothing about providers. One
 * line answers for one property, and a line can't be claimed twice.
 */
export interface MessagingEndpoint {
  schemaVersion: 1;
  /** E.164 phone number. */
  address: string;
  /** e.g. "sendblue". */
  provider: string;
  propertyId: string;
  attachedAt: string;
}

const keyOf = (address: string) => `line_${address.replace(/\D/g, "")}`;

export class MessagingEndpoints {
  constructor(private readonly store: RuntimeStore) {}

  resolve(address: string | undefined): MessagingEndpoint | undefined {
    const e164 = address ? toE164(address) : undefined;
    if (!e164) return undefined;
    try {
      return this.store.get<MessagingEndpoint>("endpoints", keyOf(e164));
    } catch {
      // A damaged mapping answers for nobody.
      return undefined;
    }
  }

  forProperty(propertyId: string): MessagingEndpoint | undefined {
    return this.all().find((e) => e.propertyId === propertyId);
  }

  all(): MessagingEndpoint[] {
    return this.store.list<MessagingEndpoint>("endpoints").entries.map((e) => e.value);
  }

  /**
   * Points a line at a property. Refused if the line already answers for a
   * different property. A property moving to a new line lets go of its old
   * one. `previous` is the property's earlier line, when it had one.
   */
  attach(input: { address: string; provider: string; propertyId: string }, now = new Date(), options?: { replaceIf?: (propertyId: string) => boolean }): { changed: boolean; previous?: string } {
    const address = toE164(input.address);
    if (!address) throw new SetupInputError("LINE_INVALID", "That messaging number isn't a valid phone number.");
    const owner = this.resolve(address);
    if (owner && owner.propertyId !== input.propertyId) {
      if (options?.replaceIf?.(owner.propertyId)) this.store.delete("endpoints", keyOf(owner.address));
      else throw new SetupInputError("LINE_IN_USE", `This texting number is already used for another property (${owner.propertyId}). Each number can answer for one property.`);
    }
    const current = this.forProperty(input.propertyId);
    if (current?.address === address && current.provider === input.provider) return { changed: false };
    if (current) this.store.delete("endpoints", keyOf(current.address));
    const endpoint: MessagingEndpoint = { schemaVersion: 1, address, provider: input.provider, propertyId: input.propertyId, attachedAt: now.toISOString() };
    this.store.put("endpoints", keyOf(address), endpoint);
    return { changed: true, ...(current ? { previous: current.address } : {}) };
  }

  detach(propertyId: string): void {
    const current = this.forProperty(propertyId);
    if (current) this.store.delete("endpoints", keyOf(current.address));
  }
}
