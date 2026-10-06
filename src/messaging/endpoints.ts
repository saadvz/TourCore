import { SetupInputError } from "../setup/setupActions";
import type { RuntimeStore } from "../storage/runtimeStore";
import { toE164 } from "./Messenger";

/**
 * Which properties answer on which messaging line. Provider-neutral: an
 * endpoint is an address (a phone number today) plus the provider that
 * carries it; the property's own setup knows nothing about providers. One
 * touring number covers every property on this Tour Core. A property that
 * moves to a new number lets go of the old one.
 */
export interface MessagingEndpoint {
  schemaVersion: 1 | 2;
  /** E.164 phone number. */
  address: string;
  /** e.g. "sendblue". */
  provider: string;
  /** First property on this line. Older readers still see one owner. */
  propertyId: string;
  /** Every property this line covers. */
  propertyIds: string[];
  attachedAt: string;
}

const keyOf = (address: string) => `line_${address.replace(/\D/g, "")}`;

function asEndpoint(raw: Partial<MessagingEndpoint> | undefined): MessagingEndpoint | undefined {
  if (!raw?.address || !raw.provider || !raw.attachedAt) return undefined;
  const propertyIds = (raw.propertyIds?.length ? raw.propertyIds : raw.propertyId ? [raw.propertyId] : []).filter((id) => !!id);
  const propertyId = propertyIds[0];
  if (!propertyId) return undefined;
  return {
    schemaVersion: raw.schemaVersion === 2 ? 2 : 1,
    address: raw.address,
    provider: raw.provider,
    propertyId,
    propertyIds,
    attachedAt: raw.attachedAt,
  };
}

export class MessagingEndpoints {
  constructor(private readonly store: RuntimeStore) {}

  resolve(address: string | undefined): MessagingEndpoint | undefined {
    const e164 = address ? toE164(address) : undefined;
    if (!e164) return undefined;
    try {
      return asEndpoint(this.store.get<MessagingEndpoint>("endpoints", keyOf(e164)));
    } catch {
      // A damaged mapping answers for nobody.
      return undefined;
    }
  }

  forProperty(propertyId: string): MessagingEndpoint | undefined {
    return this.all().find((e) => e.propertyIds.includes(propertyId));
  }

  all(): MessagingEndpoint[] {
    return this.store
      .list<MessagingEndpoint>("endpoints")
      .entries.map((e) => asEndpoint(e.value))
      .filter((e): e is MessagingEndpoint => !!e);
  }

  /**
   * Points a line at a property. The same line can cover every property on
   * this Tour Core. A property moving to a new line lets go of its old one.
   * `previous` is the property's earlier line, when it had one. `replaceIf`
   * drops another property from this line (a removed setup).
   */
  attach(
    input: { address: string; provider: string; propertyId: string },
    now = new Date(),
    options?: { replaceIf?: (propertyId: string) => boolean },
  ): { changed: boolean; previous?: string } {
    const address = toE164(input.address);
    if (!address) throw new SetupInputError("LINE_INVALID", "That messaging number isn't a valid phone number.");
    const current = this.forProperty(input.propertyId);
    let previous: string | undefined;
    if (current && current.address !== address) {
      previous = current.address;
      this.removeFrom(current, input.propertyId);
    }
    const owner = this.resolve(address);
    if (!owner) {
      this.put({ schemaVersion: 2, address, provider: input.provider, propertyId: input.propertyId, propertyIds: [input.propertyId], attachedAt: now.toISOString() });
      return { changed: true, ...(previous ? { previous } : {}) };
    }
    let propertyIds = owner.propertyIds.includes(input.propertyId) ? [...owner.propertyIds] : [...owner.propertyIds, input.propertyId];
    if (options?.replaceIf) propertyIds = propertyIds.filter((id) => id === input.propertyId || !options.replaceIf!(id));
    const sameMembers = propertyIds.length === owner.propertyIds.length && propertyIds.every((id) => owner.propertyIds.includes(id));
    const same = sameMembers && owner.provider === input.provider;
    if (same && !previous) return { changed: false };
    this.put({
      schemaVersion: 2,
      address,
      provider: input.provider,
      propertyId: propertyIds[0] ?? input.propertyId,
      propertyIds,
      attachedAt: owner.attachedAt,
    });
    return { changed: true, ...(previous ? { previous } : {}) };
  }

  detach(propertyId: string): void {
    const current = this.forProperty(propertyId);
    if (current) this.removeFrom(current, propertyId);
  }

  private removeFrom(endpoint: MessagingEndpoint, propertyId: string): void {
    const propertyIds = endpoint.propertyIds.filter((id) => id !== propertyId);
    if (!propertyIds.length) {
      this.store.delete("endpoints", keyOf(endpoint.address));
      return;
    }
    this.put({ ...endpoint, schemaVersion: 2, propertyIds, propertyId: propertyIds[0]! });
  }

  private put(endpoint: MessagingEndpoint): void {
    this.store.put("endpoints", keyOf(endpoint.address), endpoint);
  }
}
