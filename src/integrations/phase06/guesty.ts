import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { CleanerStore } from '../../delegation/phase05/store';

/** Discovery contract, not a complete Guesty event adapter. Fixtures use a minimal REST projection. */
export const GuestyReservation = z.object({
  _id: z.string().min(1), accountId: z.string().min(1), listingId: z.string().min(1),
  checkIn: z.iso.datetime({ offset: true }), checkOut: z.iso.datetime({ offset: true }),
  lastUpdatedAt: z.iso.datetime({ offset: true }), status: z.string().min(1),
}).refine(r => Date.parse(r.checkOut) > Date.parse(r.checkIn), 'Invalid stay interval');
export type GuestyReservation = z.infer<typeof GuestyReservation>;

/** Svix v1 verification over untouched bytes; rotated signatures and a five-minute replay bound. */
export function verifyGuestyWebhook(secret: string, raw: Buffer, headers: Record<string, string | undefined>, now = Date.now()): boolean {
  const id = headers['svix-id'], timestamp = headers['svix-timestamp'], signatures = headers['svix-signature'];
  if (!id || id.length > 200 || !timestamp || !/^\d{1,12}$/.test(timestamp) || !signatures || signatures.length > 4096
    || Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return false;
  const key = Buffer.from(secret.slice(6), 'base64');
  if (key.length < 16) return false;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(raw).digest();
  return signatures.split(' ').some(s => {
    const [version, value] = s.split(',');
    if (version !== 'v1' || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    const candidate = Buffer.from(value, 'base64');
    return expected.length === candidate.length && timingSafeEqual(expected, candidate);
  });
}

/** Tenant/account/listing scope is trusted configuration, never selected by a webhook. */
export class GuestyFixtureProjection {
  constructor(readonly store: CleanerStore, readonly binding: { id: string; tenant: string; accountId: string; listingIds: string[] }) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS p06_guesty_bindings(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS p06_guesty_events(binding TEXT NOT NULL, source TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(binding,source));
      CREATE TABLE IF NOT EXISTS p06_guesty_reservations(binding TEXT NOT NULL, id TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(binding,id));`);
    const fingerprint = createHash('sha256').update(JSON.stringify([binding.tenant, binding.accountId, [...binding.listingIds].sort()])).digest('hex');
    const old = store.one<{ fingerprint: string }>('SELECT fingerprint FROM p06_guesty_bindings WHERE id=?', binding.id);
    if (old && old.fingerprint !== fingerprint) throw new Error('Guesty binding changed; use separate fixture storage');
    store.run('INSERT OR IGNORE INTO p06_guesty_bindings VALUES(?,?)', binding.id, fingerprint);
  }
  apply(source: string, snapshot: unknown) {
    const r = GuestyReservation.parse(snapshot);
    if (!source || source.length > 200 || r.accountId !== this.binding.accountId || !this.binding.listingIds.includes(r.listingId)) throw new Error('Unowned Guesty fixture');
    const fingerprint = createHash('sha256').update(JSON.stringify(r)).digest('hex');
    return this.store.tx(() => {
      const event = this.store.one<{ fingerprint: string }>('SELECT fingerprint FROM p06_guesty_events WHERE binding=? AND source=?', this.binding.id, source);
      if (event) {
        if (event.fingerprint !== fingerprint) throw new Error('Source conflict');
        return 'duplicate' as const;
      }
      const previous = this.store.one<{ updated: number; data: string }>('SELECT updated,data FROM p06_guesty_reservations WHERE binding=? AND id=?', this.binding.id, r._id);
      const updated = Date.parse(r.lastUpdatedAt);
      if (previous?.updated === updated && previous.data !== JSON.stringify(r)) throw new Error('Ambiguous reservation version');
      this.store.run('INSERT INTO p06_guesty_events VALUES(?,?,?)', this.binding.id, source, fingerprint);
      if (previous && updated < previous.updated) return 'stale' as const;
      this.store.run('INSERT INTO p06_guesty_reservations VALUES(?,?,?,?) ON CONFLICT(binding,id) DO UPDATE SET updated=excluded.updated,data=excluded.data', this.binding.id, r._id, updated, JSON.stringify(r));
      return 'applied' as const;
    });
  }
  read(id: string) {
    const row = this.store.one<{ data: string }>('SELECT data FROM p06_guesty_reservations WHERE binding=? AND id=?', this.binding.id, id);
    return row ? GuestyReservation.parse(JSON.parse(row.data)) : undefined;
  }
}

/** Hour-level scheduling uses explicit reservation instants, never nightly calendar availability. */
export function fixtureCleaningWindow(outgoing: GuestyReservation, upcoming: GuestyReservation[], minimumMinutes: number) {
  const r = GuestyReservation.parse(outgoing);
  if (r.status !== 'confirmed' || !Number.isSafeInteger(minimumMinutes) || minimumMinutes <= 0) return { status: 'review_required', entryCleared: false } as const;
  const start = Date.parse(r.checkOut);
  const candidates = upcoming.map(x => GuestyReservation.parse(x)).filter(x => x._id !== r._id && x.accountId === r.accountId && x.listingId === r.listingId && x.status !== 'canceled' && Date.parse(x.checkOut) > start);
  // Unknown/inquiry/owner-block semantics require account validation; do not silently exclude them.
  if (candidates.some(x => x.status !== 'confirmed')) return { status: 'review_required', entryCleared: false } as const;
  const end = Math.min(...candidates.map(x => Date.parse(x.checkIn)));
  if (!Number.isFinite(end) || end - start < minimumMinutes * 60000) return { status: 'review_required', entryCleared: false } as const;
  return { status: 'candidate', start: r.checkOut, end: new Date(end).toISOString(), entryCleared: false } as const;
}

/** A marketing/nightly availability flag is not physical vacancy or a cleaning permission. */
export function calendarObservation(day: { status: string; allotment?: number }) {
  return { bookable: typeof day.allotment === 'number' ? day.allotment > 0 : day.status === 'available', entryCleared: false, cleaningWindowEstablished: false } as const;
}
