import type { AccessGrant, AuditEvent, Consent, Message, Prospect, Reservation, Verification } from "../domain/model";

export interface Collections {
  prospects: Prospect;
  reservations: Reservation;
  consents: Consent;
  verifications: Verification;
  accessGrants: AccessGrant;
  messages: Message;
}
export type CollectionName = keyof Collections;

/**
 * Canonical record store. Async so a remote store (Google Drive next) can
 * drop in without touching core logic. Audit is append-only by construction:
 * there is no update or delete for it.
 */
export interface TourCoreStore {
  get<K extends CollectionName>(collection: K, id: string): Promise<Collections[K] | undefined>;
  put<K extends CollectionName>(collection: K, record: Collections[K]): Promise<void>;
  list<K extends CollectionName>(collection: K): Promise<Collections[K][]>;
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(): Promise<AuditEvent[]>;
}

export class InMemoryStore implements TourCoreStore {
  private data: { [K in CollectionName]: Map<string, Collections[K]> } = {
    prospects: new Map(),
    reservations: new Map(),
    consents: new Map(),
    verifications: new Map(),
    accessGrants: new Map(),
    messages: new Map(),
  };
  private audit: AuditEvent[] = [];

  async get<K extends CollectionName>(collection: K, id: string): Promise<Collections[K] | undefined> {
    const record = this.data[collection].get(id);
    return record ? structuredClone(record) : undefined;
  }

  async put<K extends CollectionName>(collection: K, record: Collections[K]): Promise<void> {
    this.data[collection].set(record.id, structuredClone(record));
  }

  async list<K extends CollectionName>(collection: K): Promise<Collections[K][]> {
    return [...this.data[collection].values()].map((r) => structuredClone(r));
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.audit.push(Object.freeze(structuredClone(event)));
  }

  async listAudit(): Promise<AuditEvent[]> {
    return this.audit.map((e) => structuredClone(e));
  }
}
