import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { CleanerStore } from '../src/delegation/phase05/store';
import { GuestyFixtureProjection, fixtureCleaningWindow, calendarObservation, verifyGuestyWebhook } from '../src/integrations/phase06/guesty';
import { probeGuesty, probeTwilio, type ProbeFetch } from '../src/integrations/phase06/probes';
import { TwilioIntegrationLab, twilioLabApp, LAB_PHRASE, type LabBinding } from '../src/integrations/phase06/twilioLab';
import { twilioSignature } from '../src/messaging/twilio/signature';

const account = `AC${'1'.repeat(32)}`, token = 'test-only-token-'.repeat(3), owner = 'test-only-owner-'.repeat(3);
const message = (n: number) => `SM${n.toString(16).padStart(32, '0')}`;
const phone = (n: number) => `+1555010${String(n).padStart(4, '0')}`;
const reservation = (extra = {}) => ({ _id: 'stay', accountId: 'account_A', listingId: 'unit_A', status: 'confirmed',
  checkIn: '2026-10-20T19:00:00Z', checkOut: '2026-10-23T15:00:00Z', lastUpdatedAt: '2026-10-12T12:00:00Z', ...extra });
const roots: string[] = [], stores: CleanerStore[] = [], servers: Server[] = [], labs: TwilioIntegrationLab[] = [];
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.close();
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function storage(path?: string) {
  const root = path ?? mkdtempSync(join(tmpdir(), 'p06-')); if (!path) roots.push(root);
  const store = new CleanerStore(join(root, 'test.sqlite')); stores.push(store); return { root, store };
}
function binding(extra: Partial<LabBinding> = {}): LabBinding {
  return { id: 'A', tenant: 'tenant_A', accountSid: account, authToken: token, fromNumber: phone(1000), testNumber: phone(2000), publicBaseUrl: 'https://lab.example',
    consent: { at: '2026-10-12T10:00:00Z', reference: 'synthetic consent, controlled lab only' }, send: async () => ({ sid: message(999), status: 'queued' }), ...extra };
}
async function harness(bindings = [binding()], timeout = 8000) {
  const { store, root } = storage();
  const lab = new TwilioIntegrationLab(store, bindings, () => Date.parse('2026-10-13T00:00:00Z'), timeout); labs.push(lab);
  const app = twilioLabApp(lab, owner), server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (b: LabBinding, path: string, params: Record<string, string>, signature?: string) => fetch(url + path, { method: 'POST', headers: {
    'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature ?? twilioSignature(b.authToken, b.publicBaseUrl + path, params),
  }, body: new URLSearchParams(params).toString() });
  const inbound = async (b = bindings[0]!, n = 1, text = LAB_PHRASE, extra: Record<string, string> = {}) => post(b, `/phase06/twilio/${b.id}/inbound`, {
    AccountSid: b.accountSid, MessageSid: message(n), From: b.testNumber, To: b.fromNumber, Body: text, NumMedia: '0', ...extra,
  });
  const callback = async (b = bindings[0]!, status = 'delivered', sid = message(999), n = 1) => post(b, `/phase06/twilio/${b.id}/status/test_${message(n)}`, { AccountSid: b.accountSid, MessageSid: sid, MessageStatus: status });
  return { lab, store, root, url, post, inbound, callback };
}

describe('Phase 0.6 Guesty discovery contracts (synthetic, no account)', () => {
  it('verifies the independent Svix documentation test vector', () => {
    expect(verifyGuestyWebhook('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', Buffer.from('{"test": 2432232314}'), {
      'svix-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek', 'svix-timestamp': '1614265330',
      'svix-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    }, 1614265330000)).toBe(true);
  });
  it('rejects tampering, stale/future/unsigned envelopes and accepts rotated v1 signatures', () => {
    const secret = Buffer.alloc(32, 7), raw = Buffer.from('{"event":"reservation.updated.v2"}'), now = 2000000000000;
    const signature = createHmac('sha256', secret).update('event.2000000000.').update(raw).digest('base64');
    const headers = { 'svix-id': 'event', 'svix-timestamp': '2000000000', 'svix-signature': `v1,ignored v1,${signature}` };
    expect(verifyGuestyWebhook(`whsec_${secret.toString('base64')}`, raw, headers, now)).toBe(true);
    expect(verifyGuestyWebhook(`whsec_${secret.toString('base64')}`, Buffer.from('{}'), headers, now)).toBe(false);
    expect(verifyGuestyWebhook(`whsec_${secret.toString('base64')}`, raw, headers, now + 301000)).toBe(false);
    expect(verifyGuestyWebhook(`whsec_${secret.toString('base64')}`, raw, headers, now - 301000)).toBe(false);
    expect(verifyGuestyWebhook('whsec_bad', raw, {}, now)).toBe(false);
  });
  it('retains cancellation over old events, deduplicates and persists across reopen', () => {
    const { store, root } = storage(), scope = { id: 'guesty_A', tenant: 'A', accountId: 'account_A', listingIds: ['unit_A'] };
    const p = new GuestyFixtureProjection(store, scope);
    expect(p.apply('create', reservation())).toBe('applied'); expect(p.apply('create', reservation())).toBe('duplicate');
    expect(p.apply('cancel', reservation({ status: 'canceled', lastUpdatedAt: '2026-10-12T13:00:00Z' }))).toBe('applied');
    expect(p.apply('late_old_update', reservation())).toBe('stale');
    store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = new GuestyFixtureProjection(storage(root).store, scope);
    expect(reopened.read('stay')?.status).toBe('canceled'); expect(reopened.apply('create', reservation())).toBe('duplicate');
  });
  it('rejects ambiguous versions, changed sources and foreign accounts/listings without changes', () => {
    const { store } = storage(), p = new GuestyFixtureProjection(store, { id: 'A', tenant: 'A', accountId: 'account_A', listingIds: ['unit_A'] });
    p.apply('one', reservation());
    for (const [source, extra] of [['one', { status: 'canceled' }], ['two', { status: 'canceled' }], ['three', { accountId: 'account_B' }], ['four', { listingId: 'unit_B' }]] as const)
      expect(() => p.apply(source, reservation(extra))).toThrow();
    expect(p.read('stay')?.status).toBe('confirmed');
    expect(store.one<{ n: number }>('SELECT COUNT(*) AS n FROM p06_guesty_events')?.n).toBe(1);
  });
  it('isolates shared reservation/source IDs and refuses persistent rebinding', () => {
    const { store } = storage();
    const a = new GuestyFixtureProjection(store, { id: 'A', tenant: 'A', accountId: 'account_A', listingIds: ['unit_A'] });
    const b = new GuestyFixtureProjection(store, { id: 'B', tenant: 'B', accountId: 'account_B', listingIds: ['unit_B'] });
    a.apply('same', reservation()); b.apply('same', reservation({ accountId: 'account_B', listingId: 'unit_B', status: 'canceled' }));
    expect(a.read('stay')?.status).toBe('confirmed'); expect(b.read('stay')?.status).toBe('canceled');
    expect(() => new GuestyFixtureProjection(store, { id: 'A', tenant: 'B', accountId: 'account_B', listingIds: ['unit_B'] })).toThrow();
  });
  it('uses actual hourly instants across DST and never grants entry from a checkout', () => {
    const outgoing = reservation({ checkIn: '2026-10-30T15:00:00-04:00', checkOut: '2026-11-01T10:00:00-05:00' });
    const next = reservation({ _id: 'next', checkIn: '2026-11-01T15:00:00-05:00', checkOut: '2026-11-03T10:00:00-05:00' });
    expect(fixtureCleaningWindow(outgoing, [next], 90)).toEqual({ status: 'candidate', start: outgoing.checkOut, end: '2026-11-01T20:00:00.000Z', entryCleared: false });
  });
  it('holds cancellations, overlaps, unknown statuses and missing next arrivals for review', () => {
    const next = reservation({ _id: 'next', checkIn: '2026-10-23T16:00:00Z', checkOut: '2026-10-25T15:00:00Z' });
    for (const result of [fixtureCleaningWindow(reservation({ status: 'canceled' }), [next], 90), fixtureCleaningWindow(reservation(), [next], 90),
      fixtureCleaningWindow(reservation(), [reservation({ ...next, status: 'inquiry' })], 30), fixtureCleaningWindow(reservation(), [], 90)])
      expect(result).toEqual({ status: 'review_required', entryCleared: false });
  });
  it('interprets nightly multi-unit allotment without inferring a unit cleaning/access window', () => {
    expect(calendarObservation({ status: 'available', allotment: 0 })).toEqual({ bookable: false, entryCleared: false, cleaningWindowEstablished: false });
    expect(calendarObservation({ status: 'unavailable', allotment: 2 }).bookable).toBe(true);
    expect(calendarObservation({ status: 'available' }).bookable).toBe(true);
  });
});

describe('Phase 0.6 actual Twilio-shaped HTTP transport with injected provider', () => {
  it('durably acknowledges a signed controlled reply, sends once and preserves exact source conflicts', async () => {
    let sends = 0;
    const b = binding({ send: async input => { sends++; expect(input.to).toBe(phone(2000)); expect(input.statusCallback).toContain(`/test_${message(1)}`); return { sid: message(999), status: 'queued' }; } });
    const h = await harness([b]);
    expect((await h.inbound()).status).toBe(200); expect((await h.inbound()).status).toBe(200);
    expect(h.lab.evidence('A').replies[0]?.status).toBe('pending');
    await h.lab.tick(); await h.lab.tick();
    expect(sends).toBe(1); expect(h.lab.evidence('A').replies[0]).toMatchObject({ status: 'accepted', delivery: 'unconfirmed' });
    expect((await h.inbound(b, 1, 'different body')).status).toBe(409);
    expect((await h.inbound()).status).toBe(200); await h.lab.tick(); expect(sends).toBe(1);
  });
  it('rejects forged signatures, foreign phones/accounts, duplicate fields and query URL tampering', async () => {
    const h = await harness(), b = binding(), path = '/phase06/twilio/A/inbound';
    const params = { AccountSid: account, From: b.testNumber, To: b.fromNumber, MessageSid: message(1), Body: LAB_PHRASE };
    expect((await h.post(b, path, params, 'forged')).status).toBe(403);
    expect((await h.inbound(b, 1, LAB_PHRASE, { From: phone(3000) })).status).toBe(403);
    expect((await h.inbound(b, 1, LAB_PHRASE, { AccountSid: `AC${'2'.repeat(32)}` })).status).toBe(403);
    const repeated = await fetch(h.url + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() + '&Body=STOP' });
    expect(repeated.status).toBe(400); expect((await h.post(b, path + '?extra=1', params)).status).toBe(400);
    expect(h.lab.evidence('A').inbound).toHaveLength(0);
  });
  it('requires recorded cleaner-specific test consent; START alone creates none', async () => {
    const b = binding({ consent: undefined }); const h = await harness([b]);
    expect((await h.inbound(b, 1, 'START', { OptOutType: 'START' })).status).toBe(200);
    expect((await h.inbound(b, 2)).status).toBe(200); await h.lab.tick();
    expect(h.lab.evidence('A')).toMatchObject({ consentRecorded: false, replies: [], operatesDoors: false, changesBookings: false });
  });
  it('STOP suppresses queued replies and stays opted out after restart without an extra confirmation', async () => {
    let sends = 0; const b = binding({ send: async () => { sends++; return { sid: message(999) }; } }); const h = await harness([b]);
    await h.inbound(); await h.inbound(b, 2, 'arbitrary configured stop word', { OptOutType: 'STOP' });
    await h.lab.tick(); expect(sends).toBe(0); expect(h.lab.evidence('A').replies[0]?.status).toBe('suppressed');
    await h.lab.close(); h.store.close(); stores.splice(stores.indexOf(h.store), 1);
    const reopened = new TwilioIntegrationLab(storage(h.root).store, [b]); labs.push(reopened);
    expect(reopened.evidence('A').optedOut).toBe(true); await reopened.tick(); expect(sends).toBe(0);
  });
  it('accepts provider opt-in only for a previously consenting contact and records DONE without readiness/access effects', async () => {
    const h = await harness(), b = binding();
    await h.inbound(b, 1, 'STOP'); await h.inbound(b, 2, 'START', { OptOutType: 'START' }); await h.inbound(b, 3, 'DONE'); await h.inbound(b, 4);
    expect(h.lab.evidence('A')).toMatchObject({ optedOut: false, changesBookings: false, operatesDoors: false });
    expect(h.lab.evidence('A').inbound).toContainEqual({ kind: 'reported_done', count: 1 });
    expect(h.lab.evidence('A').replies).toHaveLength(1);
  });
  it('separates delivered receipts from provider acceptance and refuses status regression/conflicting terminals', async () => {
    const h = await harness(); await h.inbound(); await h.lab.tick();
    expect((await h.post(binding(), `/phase06/twilio/A/status/test_${message(1)}`, { AccountSid: account, MessageSid: message(999), MessageStatus: 'sent', ErrorCode: '' })).status).toBe(204);
    expect((await h.callback()).status).toBe(204); expect((await h.callback()).status).toBe(204);
    expect((await h.callback(binding(), 'queued')).status).toBe(204); expect(h.lab.evidence('A').replies[0]?.delivery).toBe('delivered');
    expect((await h.callback(binding(), 'failed')).status).toBe(204); expect(h.lab.evidence('A').replies[0]?.delivery).toBe('conflict_requires_review');
    expect((await h.callback(binding(), 'delivered', message(888))).status).toBe(409);
    await h.lab.tick(); expect(h.lab.evidence('A').replies).toHaveLength(1);
  });
  it('records callback-before-REST-response without treating an unmatched receipt as delivery', async () => {
    let finish!: (result: { sid: string; status: string }) => void;
    const h = await harness([binding({ send: () => new Promise(resolve => { finish = resolve; }) })]);
    await h.inbound(); const pending = h.lab.tick();
    await new Promise(resolve => setImmediate(resolve));
    expect((await h.callback(binding(), 'delivered', message(888))).status).toBe(204);
    expect(h.lab.evidence('A').replies[0]?.delivery).toBe('unconfirmed');
    finish({ sid: message(999), status: 'queued' }); await pending;
    expect(h.lab.evidence('A').replies[0]?.delivery).toBe('unconfirmed');
    expect((await h.callback()).status).toBe(204); expect(h.lab.evidence('A').replies[0]?.delivery).toBe('delivered');
  });
  it('never automatically resends uncertain non-idempotent sends or resolves them from unmatched callbacks', async () => {
    let sends = 0; const h = await harness([binding({ send: async () => { sends++; throw new Error('synthetic lost ack'); } })]);
    await h.inbound(); await h.lab.tick(); await h.lab.tick();
    expect(h.lab.evidence('A').replies[0]).toMatchObject({ status: 'review_required', delivery: 'unconfirmed' });
    await h.callback(); await h.lab.tick(); expect(sends).toBe(1);
    expect(h.lab.evidence('A').replies[0]?.status).toBe('review_required');
  });
  it('bounds an unresponsive transport and retains review state after restart', async () => {
    const b = binding({ send: () => new Promise(() => {}) }); const h = await harness([b], 10);
    await h.inbound(); await h.lab.tick(); expect(h.lab.evidence('A').replies[0]?.status).toBe('review_required');
    h.store.run("UPDATE p06_lab_outbox SET status='sending'"); // Persisted crash boundary before a non-idempotent POST.
    await h.lab.close(); h.store.close(); stores.splice(stores.indexOf(h.store), 1);
    const reopened = new TwilioIntegrationLab(storage(h.root).store, [b]); labs.push(reopened);
    await reopened.tick(); expect(reopened.evidence('A').replies[0]?.status).toBe('review_required');
  });
  it('isolates phone pairs and callbacks in both directions when two lab bindings share an account', async () => {
    const a = binding(), b = binding({ id: 'B', tenant: 'tenant_B', fromNumber: phone(3000), testNumber: phone(4000), send: async () => ({ sid: message(998), status: 'queued' }) });
    const h = await harness([a, b]);
    expect((await h.inbound(a, 1, LAB_PHRASE, { From: b.testNumber, To: b.fromNumber })).status).toBe(403);
    expect((await h.inbound(b, 1, LAB_PHRASE, { From: a.testNumber, To: a.fromNumber })).status).toBe(403);
    await h.inbound(a); await h.inbound(b); await h.lab.tick();
    expect((await h.callback(a, 'delivered', message(998))).status).toBe(409); expect((await h.callback(b, 'delivered', message(999))).status).toBe(409);
    expect(h.lab.evidence('A').replies[0]?.providerReceipt).toBe(message(999)); expect(h.lab.evidence('B').replies[0]?.providerReceipt).toBe(message(998));
  });
  it('guards evidence and refuses a persisted change of recipient/tenant/origin', async () => {
    const h = await harness();
    expect((await fetch(h.url + '/phase06/evidence/A')).status).toBe(401);
    const result = await fetch(h.url + '/phase06/evidence/A', { headers: { Authorization: `Bearer ${owner}` } });
    expect(result.status).toBe(200); const body = JSON.stringify(await result.json());
    expect(body).not.toContain(token); expect(body).not.toContain(phone(2000)); expect(body).not.toContain('synthetic consent');
    expect(() => new TwilioIntegrationLab(h.store, [binding({ tenant: 'B' })])).toThrow();
  });
});

describe('Phase 0.6 safe live read probes with injected HTTP', () => {
  it('does no network work and never claims account feasibility without settings', async () => {
    const never: ProbeFetch = async () => { throw new Error('must not call'); };
    expect((await probeGuesty(undefined, never)).every(r => r.outcome === 'BLOCKED')).toBe(true);
    expect((await probeTwilio(undefined, never)).every(r => r.outcome === 'BLOCKED')).toBe(true);
  });
  it('uses only bounded GETs to documented Guesty endpoints and leaves event/task-write proof open', async () => {
    const urls: string[] = [], replies = [{ _id: 'listing' }, { _id: 'stay', listingId: 'listing' }, { status: 200, data: { days: [] } }, { _id: 'task', listingId: 'listing' }];
    const fetcher: ProbeFetch = async (url, init) => { urls.push(url); expect(init.method).toBe('GET'); expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal); return { status: 200, json: async () => replies.shift() }; };
    const report = await probeGuesty({ accessToken: 'synthetic-token', listingId: 'listing', reservationId: 'stay', taskId: 'task', startDate: '2026-10-12', endDate: '2026-10-13' }, fetcher);
    expect(report.slice(0, 4).every(r => r.outcome === 'PASS')).toBe(true); expect(report[4]?.outcome).toBe('NOT_RUN');
    expect(urls[2]).toContain('includeAllotment=true'); expect(urls[3]).toBe('https://open-api.guesty.com/v1/tasks-open-api/task');
    expect(JSON.stringify(report)).not.toContain('synthetic-token');
  });
  it('does not convert HTTP authentication failure, unexpected bodies, quota or transport errors into PASS', async () => {
    let calls = 0;
    const fetcher: ProbeFetch = async () => { calls++; if (calls === 4) throw new Error('token=secret'); return { status: calls === 1 ? 403 : calls === 3 ? 429 : 200, json: async () => ({ error: 'secret' }) }; };
    const report = await probeGuesty({ accessToken: 'secret', listingId: 'listing', reservationId: 'stay', taskId: 'task', startDate: '2026-10-12', endDate: '2026-10-13' }, fetcher);
    expect(report.map(r => r.outcome)).toEqual(['FAIL', 'FAIL', 'FAIL', 'BLOCKED', 'NOT_RUN']); expect(JSON.stringify(report)).not.toContain('secret');
    expect(calls).toBe(4);
  });
  it('binds a verified Twilio campaign to the account/service/number but leaves cleaner use-case consent for review', async () => {
    const phoneSid = `PN${'1'.repeat(32)}`, serviceSid = `MG${'2'.repeat(32)}`, campaignSid = `QE${'3'.repeat(32)}`;
    const responses = [{ sid: account, status: 'active' }, { account_sid: account, phone_number: phone(1000), capabilities: { sms: true } },
      { account_sid: account, service_sid: serviceSid, phone_number: phone(1000) }, { account_sid: account, messaging_service_sid: serviceSid, campaign_status: 'VERIFIED' }];
    const fetcher: ProbeFetch = async (_url, init) => { expect(init.method).toBe('GET'); return { status: 200, json: async () => responses.shift() }; };
    const report = await probeTwilio({ accountSid: account, authToken: token, fromNumber: phone(1000), phoneSid, serviceSid, campaignSid }, fetcher);
    expect(report.slice(0, 4).every(r => r.outcome === 'PASS')).toBe(true); expect(report[4]?.outcome).toBe('NOT_RUN');
    expect(JSON.stringify(report)).not.toContain(token);
  });
  it('rejects pending/failed campaigns and mismatched accounts even on HTTP 200', async () => {
    const report = await probeTwilio({ accountSid: account, authToken: token, fromNumber: phone(1000), phoneSid: `PN${'1'.repeat(32)}`, serviceSid: `MG${'2'.repeat(32)}`, campaignSid: `QE${'3'.repeat(32)}` }, async () => ({ status: 200, json: async () => ({ campaign_status: 'PENDING' }) }));
    expect(report.slice(0, 4).every(r => r.outcome === 'FAIL')).toBe(true);
  });
});
