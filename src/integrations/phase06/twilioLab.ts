import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { CleanerStore } from '../../delegation/phase05/store';
import { formParams, verifyTwilioSignature } from '../../messaging/twilio/signature';

export const LAB_PHRASE = 'CLEANER CORE TEST';
export const LAB_REPLY = 'Cleaner Core TEST: Received your test reply. This test does not change bookings or permit entry. Reply STOP to opt out.';
const sid = z.string().regex(/^SM[a-fA-F0-9]{32}$/);
const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/);
const providerStatuses = ['accepted', 'queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered', 'canceled'] as const;
type Outbox = { binding: string; key: string; status: string; receipt: string | null };
export interface LabBinding {
  id: string; tenant: string; accountSid: string; authToken: string; fromNumber: string; testNumber: string;
  publicBaseUrl: string; consent?: { at: string; reference: string };
  send(input: { from: string; to: string; body: string; statusCallback: string; signal: AbortSignal }): Promise<{ sid: string; status?: string; errorCode?: number | null }>;
}
class LabError extends Error { constructor(readonly status: number) { super('Lab request rejected'); } }

/** Isolated one-reply test lab; never mounted on the touring or Phase 0.5 hosted service. */
export class TwilioIntegrationLab {
  private active = new Map<string, Promise<void>>();
  private closing = false;
  constructor(readonly store: CleanerStore, readonly bindings: LabBinding[], readonly now: () => number = Date.now, readonly timeoutMs = 8000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || new Set(bindings.map(b => b.id)).size !== bindings.length
      || new Set(bindings.map(b => `${b.accountSid}:${b.fromNumber}`)).size !== bindings.length) throw new Error('Invalid lab bindings');
    store.db.exec(`CREATE TABLE IF NOT EXISTS p06_lab_bindings(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS p06_lab_consent(binding TEXT PRIMARY KEY, at TEXT, reference TEXT, opted_out INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS p06_lab_inbound(binding TEXT NOT NULL, sid TEXT NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, received INTEGER NOT NULL, PRIMARY KEY(binding,sid));
      CREATE TABLE IF NOT EXISTS p06_lab_outbox(binding TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL, receipt TEXT, PRIMARY KEY(binding,key));
      CREATE TABLE IF NOT EXISTS p06_lab_delivery(binding TEXT NOT NULL, key TEXT NOT NULL, sid TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL, received INTEGER NOT NULL, PRIMARY KEY(binding,key,sid,status,error));`);
    store.tx(() => {
      for (const b of bindings) {
        z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(b.id); z.string().min(1).parse(b.tenant);
        z.string().regex(/^AC[a-fA-F0-9]{32}$/).parse(b.accountSid);
        e164.parse(b.fromNumber); e164.parse(b.testNumber);
        if (b.authToken.length < 32 || b.fromNumber === b.testNumber) throw new Error('Invalid lab settings');
        const origin = new URL(b.publicBaseUrl);
        if (origin.protocol !== 'https:' || origin.origin !== b.publicBaseUrl) throw new Error('Trusted HTTPS origin required');
        if (b.consent) { z.iso.datetime().parse(b.consent.at); z.string().min(1).max(300).parse(b.consent.reference); if (Date.parse(b.consent.at) > now()) throw new Error('Consent cannot be in the future'); }
        const fingerprint = createHash('sha256').update(JSON.stringify([b.tenant, b.accountSid, b.fromNumber, b.testNumber, b.publicBaseUrl])).digest('hex');
        const old = store.one<{ fingerprint: string }>('SELECT fingerprint FROM p06_lab_bindings WHERE id=?', b.id);
        if (old && old.fingerprint !== fingerprint) throw new Error('Lab routing changed; use separate lab storage');
        store.run('INSERT OR IGNORE INTO p06_lab_bindings VALUES(?,?)', b.id, fingerprint);
        store.run('INSERT OR IGNORE INTO p06_lab_consent(binding,at,reference) VALUES(?,?,?)', b.id, b.consent?.at ?? null, b.consent?.reference ?? null);
      }
      // A crashed non-idempotent send never becomes eligible for automatic resend.
      store.run("UPDATE p06_lab_outbox SET status='review_required' WHERE status='sending'");
    });
  }
  private binding(id: string) { const b = this.bindings.find(b => b.id === id); if (!b) throw new LabError(404); return b; }
  private verify(b: LabBinding, path: string, raw: Buffer, signature?: string) {
    const form = new URLSearchParams(raw.toString('utf8'));
    if ([...form.keys()].length !== new Set(form.keys()).size) throw new LabError(400);
    const p = formParams(raw);
    if (!verifyTwilioSignature(b.authToken, b.publicBaseUrl + path, p, signature).ok || p.AccountSid !== b.accountSid) throw new LabError(403);
    return p;
  }
  private consent(id: string) { return this.store.one<{ at: string | null; reference: string | null; opted_out: number }>('SELECT * FROM p06_lab_consent WHERE binding=?', id)!; }
  inbound(id: string, raw: Buffer, signature?: string) {
    const b = this.binding(id), p = this.verify(b, `/phase06/twilio/${id}/inbound`, raw, signature);
    if (p.From !== b.testNumber || p.To !== b.fromNumber || p.NumMedia && p.NumMedia !== '0' || !sid.safeParse(p.MessageSid).success) throw new LabError(403);
    if (p.MessagingServiceSid !== undefined && !/^MG[a-fA-F0-9]{32}$/.test(p.MessagingServiceSid)) throw new LabError(400);
    const text = p.Body?.trim().toUpperCase() ?? '';
    const opt = p.OptOutType;
    if (opt !== undefined && !['STOP', 'START', 'HELP'].includes(opt)) throw new LabError(400);
    const kind = opt ?? (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT'].includes(text) ? 'STOP' : ['START', 'UNSTOP'].includes(text) ? 'START' : text === 'HELP' ? 'HELP' : text === LAB_PHRASE ? 'test' : text === 'DONE' ? 'reported_done' : 'other');
    // START is opt-in/report input only. It cannot establish cleaner consent or physical entry.
    const fingerprint = createHash('sha256').update(JSON.stringify([p.From, p.To, p.Body, p.NumMedia ?? '0', opt ?? null])).digest('hex');
    return this.store.tx(() => {
      const old = this.store.one<{ fingerprint: string }>('SELECT fingerprint FROM p06_lab_inbound WHERE binding=? AND sid=?', id, p.MessageSid!);
      if (old) { if (old.fingerprint !== fingerprint) throw new LabError(409); return { duplicate: true }; }
      this.store.run('INSERT INTO p06_lab_inbound VALUES(?,?,?,?,?)', id, p.MessageSid!, fingerprint, kind, this.now());
      if (kind === 'STOP') {
        this.store.run('UPDATE p06_lab_consent SET opted_out=1 WHERE binding=?', id);
        this.store.run("UPDATE p06_lab_outbox SET status='suppressed' WHERE binding=? AND status='pending'", id);
      } else if (kind === 'START' && this.consent(id).at) this.store.run('UPDATE p06_lab_consent SET opted_out=0 WHERE binding=?', id);
      const consent = this.consent(id);
      if (kind === 'test' && consent.at && consent.reference && !consent.opted_out)
        this.store.run('INSERT INTO p06_lab_outbox VALUES(?,?,?,NULL)', id, `test_${p.MessageSid}`, 'pending');
      return { duplicate: false };
    });
  }
  callback(id: string, key: string, raw: Buffer, signature?: string) {
    const b = this.binding(id);
    if (!/^test_SM[a-fA-F0-9]{32}$/.test(key)) throw new LabError(400);
    const p = this.verify(b, `/phase06/twilio/${id}/status/${key}`, raw, signature);
    if (!sid.safeParse(p.MessageSid).success || !(providerStatuses as readonly string[]).includes(p.MessageStatus ?? '')
      || p.From !== undefined && p.From !== b.fromNumber || p.To !== undefined && p.To !== b.testNumber
      || p.ErrorCode !== undefined && p.ErrorCode !== '' && !/^\d{1,10}$/.test(p.ErrorCode)) throw new LabError(400);
    this.store.tx(() => {
      const out = this.store.one<Outbox>('SELECT * FROM p06_lab_outbox WHERE binding=? AND key=?', id, key);
      if (!out || !['sending', 'accepted', 'review_required'].includes(out.status) || out.receipt && out.receipt !== p.MessageSid) throw new LabError(409);
      // Early callbacks are retained, but establish delivery only if the REST receipt later matches.
      this.store.run('INSERT OR IGNORE INTO p06_lab_delivery VALUES(?,?,?,?,?,?)', id, key, p.MessageSid!, p.MessageStatus!, p.ErrorCode ?? '', this.now());
    });
  }
  async tick() {
    if (this.closing) return;
    const jobs: Promise<void>[] = [];
    for (const b of this.bindings) {
      if (this.active.has(b.id)) continue;
      const out = this.store.tx(() => {
        const consent = this.consent(b.id);
        if (!consent.at || !consent.reference || consent.opted_out) {
          this.store.run("UPDATE p06_lab_outbox SET status='suppressed' WHERE binding=? AND status='pending'", b.id); return;
        }
        const row = this.store.one<Outbox>("SELECT * FROM p06_lab_outbox WHERE binding=? AND status='pending' ORDER BY rowid LIMIT 1", b.id);
        if (row) this.store.run("UPDATE p06_lab_outbox SET status='sending' WHERE binding=? AND key=?", b.id, row.key);
        return row;
      });
      if (!out) continue;
      const job = this.send(b, out).finally(() => this.active.delete(b.id)); this.active.set(b.id, job); jobs.push(job);
    }
    await Promise.all(jobs);
  }
  private async send(b: LabBinding, out: Outbox) {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const sent = await Promise.race([
        Promise.resolve().then(() => b.send({ from: b.fromNumber, to: b.testNumber, body: LAB_REPLY, statusCallback: `${b.publicBaseUrl}/phase06/twilio/${b.id}/status/${out.key}`, signal: controller.signal })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Send timeout')); }, this.timeoutMs); }),
      ]);
      sid.parse(sent.sid);
      const failed = sent.errorCode != null && sent.errorCode !== 0 || ['failed', 'undelivered', 'canceled'].includes(sent.status ?? '');
      this.store.tx(() => {
        this.store.run('UPDATE p06_lab_outbox SET status=?,receipt=? WHERE binding=? AND key=? AND status=?', failed ? 'review_required' : 'accepted', sent.sid, b.id, out.key, 'sending');
        if ((providerStatuses as readonly string[]).includes(sent.status ?? '')) this.store.run('INSERT OR IGNORE INTO p06_lab_delivery VALUES(?,?,?,?,?,?)', b.id, out.key, sent.sid, sent.status!, String(sent.errorCode ?? ''), this.now());
      });
    } catch {
      this.store.run("UPDATE p06_lab_outbox SET status='review_required' WHERE binding=? AND key=? AND status='sending'", b.id, out.key);
    } finally { if (timer) clearTimeout(timer); }
  }
  evidence(id: string) {
    this.binding(id);
    const consent = this.consent(id);
    const replies = this.store.all<Outbox>('SELECT * FROM p06_lab_outbox WHERE binding=? ORDER BY rowid', id).map(out => {
      const events = this.store.all<{ status: string; error: string }>('SELECT status,error FROM p06_lab_delivery WHERE binding=? AND key=? AND sid=?', id, out.key, out.receipt);
      const terminal = new Set(events.filter(e => ['delivered', 'failed', 'undelivered', 'canceled'].includes(e.status)).map(e => e.status));
      return { key: out.key, status: out.status, providerReceipt: out.receipt,
        delivery: terminal.size > 1 ? 'conflict_requires_review' : terminal.size === 1 ? [...terminal][0] : 'unconfirmed',
        errorObserved: events.some(e => e.error !== '' && e.error !== '0') };
    });
    return { mode: 'isolated_test', consentRecorded: Boolean(consent.at && consent.reference), optedOut: Boolean(consent.opted_out),
      inbound: this.store.all<{ kind: string; count: number }>('SELECT kind,COUNT(*) AS count FROM p06_lab_inbound WHERE binding=? GROUP BY kind', id),
      replies, receiptMeaning: 'provider_acceptance', operatesDoors: false, changesBookings: false };
  }
  async close() { this.closing = true; await Promise.allSettled(this.active.values()); }
}

export function twilioLabApp(lab: TwilioIntegrationLab, ownerToken: string, healthy: () => boolean = () => true) {
  if (ownerToken.length < 32) throw new Error('Separate lab owner token required');
  const app = express(); app.disable('x-powered-by');
  const fail = (res: express.Response, e: unknown) => res.status(e instanceof LabError ? e.status : 503).json({ error: 'LAB_REQUEST_REJECTED' });
  app.post('/phase06/twilio/:id/inbound', express.raw({ type: 'application/x-www-form-urlencoded', limit: '16kb' }), (req, res) => {
    try { if (!Buffer.isBuffer(req.body) || req.originalUrl !== `/phase06/twilio/${req.params.id}/inbound`) throw new LabError(400); lab.inbound(req.params.id as string, req.body, req.get('X-Twilio-Signature')); res.type('text/xml').send('<Response/>'); }
    catch (e) { fail(res, e); }
  });
  app.post('/phase06/twilio/:id/status/:key', express.raw({ type: 'application/x-www-form-urlencoded', limit: '16kb' }), (req, res) => {
    try { if (!Buffer.isBuffer(req.body) || req.originalUrl !== `/phase06/twilio/${req.params.id}/status/${req.params.key}`) throw new LabError(400); lab.callback(req.params.id as string, req.params.key as string, req.body, req.get('X-Twilio-Signature')); res.sendStatus(204); }
    catch (e) { fail(res, e); }
  });
  app.get('/phase06/evidence/:id', (req, res) => {
    try {
      const actual = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${ownerToken}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new LabError(401);
      res.setHeader('Cache-Control', 'no-store'); res.json(lab.evidence(req.params.id as string));
    } catch (e) { fail(res, e); }
  });
  app.get('/healthz', (_req, res) => res.status(healthy() ? 200 : 503).json({ service: 'cleaner-phase06-lab', ready: healthy(), productionReady: false }));
  return app;
}
