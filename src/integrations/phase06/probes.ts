import { z } from 'zod';

export type ProbeResult = { check: string; outcome: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN'; http?: number; detail: string };
export type ProbeFetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'status' | 'json'>>;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const date = z.iso.date();

/** Read-only, bounded, no retries/token minting, no response bodies or credentials in evidence. */
async function probe(check: string, url: string, authorization: string, validate: (body: unknown) => boolean, fetchImpl: ProbeFetch): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'error', headers: { Authorization: authorization, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (res.status !== 200) return { check, outcome: 'FAIL', http: res.status, detail: 'Read was not authorized or available; no provider error body retained.' };
    const valid = validate(await res.json());
    return { check, outcome: valid ? 'PASS' : 'FAIL', http: res.status, detail: valid ? 'Expected read response observed; writes and business semantics remain unverified.' : 'Unexpected response shape or binding.' };
  } catch {
    return { check, outcome: 'BLOCKED', detail: 'Read could not be confirmed; no automatic retry or raw error retained.' };
  }
}
const object = (x: unknown): Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};

export async function probeGuesty(config?: { accessToken: string; listingId: string; reservationId: string; taskId: string; startDate: string; endDate: string }, fetchImpl: ProbeFetch = fetch) {
  const checks = ['guesty.listing_read', 'guesty.reservation_read', 'guesty.calendar_read', 'guesty.task_read'];
  if (!config) return checks.map(check => ({ check, outcome: 'BLOCKED', detail: 'No active Guesty account/token supplied.' } as ProbeResult));
  for (const value of [config.listingId, config.reservationId, config.taskId]) id.parse(value);
  date.parse(config.startDate); date.parse(config.endDate);
  if (!config.accessToken.trim() || /[\r\n]/.test(config.accessToken) || config.startDate > config.endDate) throw new Error('Invalid Guesty probe configuration');
  const base = 'https://open-api.guesty.com/v1', auth = `Bearer ${config.accessToken}`;
  const specs: Array<[string, (x: unknown) => boolean]> = [
    [`/listings/${config.listingId}`, x => object(x)._id === config.listingId],
    [`/reservations/${config.reservationId}?fields=_id%20listingId%20checkIn%20checkOut%20status%20lastUpdatedAt`, x => object(x)._id === config.reservationId && object(x).listingId === config.listingId],
    [`/availability-pricing/api/calendar/listings/${config.listingId}?${new URLSearchParams({ startDate: config.startDate, endDate: config.endDate, includeAllotment: 'true' })}`, x => Array.isArray(object(object(x).data).days)],
    [`/tasks-open-api/${config.taskId}`, x => (object(x)._id === config.taskId || object(x).id === config.taskId) && object(x).listingId === config.listingId],
  ];
  const results: ProbeResult[] = [];
  for (let i = 0; i < specs.length; i++) {
    const [path, validate] = specs[i]!;
    results.push(await probe(checks[i]!, base + path, auth, validate, fetchImpl));
  }
  results.push({ check: 'guesty.events_calendar_task_write', outcome: 'NOT_RUN', detail: 'Requires account-specific signed-event, calendar and controlled task update/readback tests. Reads do not establish this gate.' });
  return results;
}

export interface TwilioProbeConfig {
  accountSid: string; authToken: string; fromNumber: string; phoneSid: string;
  serviceSid: string; campaignSid: string;
}

/** Discover metadata using the already-bound sender; never log credential/phone or change routing. */
export async function discoverTwilioProbe(config: Pick<TwilioProbeConfig, 'accountSid' | 'authToken' | 'fromNumber'> & { expectedInboundUrl?: string }, fetchImpl: ProbeFetch = fetch): Promise<ProbeResult[]> {
  z.string().regex(/^AC[a-fA-F0-9]{32}$/).parse(config.accountSid);
  z.string().regex(/^\+[1-9]\d{7,14}$/).parse(config.fromNumber);
  if (!config.authToken || /[\r\n]/.test(config.authToken)) throw new Error('Invalid Twilio probe configuration');
  const auth = `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`;
  const account = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}`;
  const messaging = 'https://messaging.twilio.com/v1/Services';
  const results: ProbeResult[] = [];
  const read = async (url: string): Promise<{ http: number; body: Record<string, unknown> }> => {
    try {
      const r = await fetchImpl(url, { method: 'GET', redirect: 'error', headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      return { http: r.status, body: r.status === 200 ? object(await r.json()) : {} };
    } catch { return { http: 0, body: {} }; }
  };
  const result = (check: string, http: number, valid: boolean, detail: string) => results.push({ check, outcome: http === 0 ? 'BLOCKED' : valid ? 'PASS' : 'FAIL', ...(http ? { http } : {}), detail });
  const a = await read(`${account}.json`);
  result('twilio.account_read', a.http, a.body.sid === config.accountSid && a.body.status === 'active', 'Account identity/activity check; no account details retained.');
  if (results[0]!.outcome !== 'PASS') return results;
  const n = await read(`${account}/IncomingPhoneNumbers.json?${new URLSearchParams({ PhoneNumber: config.fromNumber, PageSize: '1' })}`);
  const numbers = Array.isArray(n.body.incoming_phone_numbers) ? n.body.incoming_phone_numbers.map(object) : [];
  const number = numbers.find(x => x.account_sid === config.accountSid && x.phone_number === config.fromNumber && object(x.capabilities).sms === true && /^PN[a-fA-F0-9]{32}$/.test(String(x.sid)));
  result('twilio.number_read', n.http, Boolean(number), 'Bound sender ownership and SMS capability check; no phone retained.');
  if (!number) return results;
  const services = await read(`${messaging}?PageSize=10`);
  const owned = Array.isArray(services.body.services) ? services.body.services.map(object).filter(x => x.account_sid === config.accountSid && /^MG[a-fA-F0-9]{32}$/.test(String(x.sid))).slice(0, 10) : [];
  let serviceSid: string | undefined;
  for (const candidate of owned) {
    const membership = await read(`${messaging}/${candidate.sid}/PhoneNumbers/${number.sid}`);
    if (membership.http === 200 && membership.body.account_sid === config.accountSid && membership.body.service_sid === candidate.sid && membership.body.phone_number === config.fromNumber) { serviceSid = String(candidate.sid); break; }
  }
  results.push({ check: 'twilio.service_number', outcome: serviceSid ? 'PASS' : 'BLOCKED', detail: serviceSid ? 'Exact sender membership in an owned Messaging Service observed.' : 'Could not locate the sender within the bounded ten-service lookup; use explicit SIDs or inspect sender authorization.' });
  if (!serviceSid) return results;
  const campaigns = await read(`${messaging}/${serviceSid}/Compliance/Usa2p?PageSize=10`);
  const rows = Array.isArray(campaigns.body.compliance) ? campaigns.body.compliance.map(object) : [];
  result('twilio.campaign', campaigns.http, rows.some(x => x.account_sid === config.accountSid && x.messaging_service_sid === serviceSid && x.campaign_status === 'VERIFIED'), 'Verified 10DLC campaign association check; cleaner use-case wording still needs owner review.');
  if (config.expectedInboundUrl) {
    const service = await read(`${messaging}/${serviceSid}`);
    const valid = service.body.account_sid === config.accountSid && service.body.sid === serviceSid;
    const onNumber = service.body.use_inbound_webhook_on_number;
    const url = onNumber === true ? number.sms_url : service.body.inbound_request_url;
    const method = onNumber === true ? number.sms_method : service.body.inbound_method;
    results.push({ check: 'twilio.inbound_routing', outcome: !valid || typeof onNumber !== 'boolean' ? 'BLOCKED' : url === config.expectedInboundUrl && method === 'POST' ? 'PASS' : 'NOT_RUN',
      detail: onNumber === true ? 'Effective routing uses the phone number webhook; it must match the lab POST endpoint.' : 'Effective routing uses the Messaging Service webhook; it must match the lab POST endpoint.' });
  }
  results.push({ check: 'twilio.cleaner_use_case_and_consent', outcome: 'NOT_RUN', detail: 'Account readiness does not establish cleaner use-case coverage or real cleaner consent.' });
  return results;
}

export async function probeTwilio(config?: TwilioProbeConfig, fetchImpl: ProbeFetch = fetch) {
  const checks = ['twilio.account_read', 'twilio.number_read', 'twilio.service_number', 'twilio.campaign'];
  if (!config) return checks.map(check => ({ check, outcome: 'BLOCKED', detail: 'Twilio is owner-reported ready; credentials are not configured in this workspace.' } as ProbeResult));
  for (const [value, prefix] of [[config.accountSid, 'AC'], [config.phoneSid, 'PN'], [config.serviceSid, 'MG'], [config.campaignSid, 'QE']] as const)
    z.string().regex(new RegExp(`^${prefix}[a-fA-F0-9]{32}$`)).parse(value);
  z.string().regex(/^\+[1-9]\d{7,14}$/).parse(config.fromNumber);
  if (!config.authToken || /[\r\n]/.test(config.authToken)) throw new Error('Invalid Twilio probe configuration');
  const auth = `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`;
  const account = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}`;
  const service = `https://messaging.twilio.com/v1/Services/${config.serviceSid}`;
  const specs: Array<[string, (x: unknown) => boolean]> = [
    [`${account}.json`, x => object(x).sid === config.accountSid && object(x).status === 'active'],
    [`${account}/IncomingPhoneNumbers/${config.phoneSid}.json`, x => object(x).account_sid === config.accountSid && object(x).phone_number === config.fromNumber && object(object(x).capabilities).sms === true],
    [`${service}/PhoneNumbers/${config.phoneSid}`, x => object(x).account_sid === config.accountSid && object(x).service_sid === config.serviceSid && object(x).phone_number === config.fromNumber],
    [`${service}/Compliance/Usa2p/${config.campaignSid}`, x => object(x).account_sid === config.accountSid && object(x).messaging_service_sid === config.serviceSid && object(x).campaign_status === 'VERIFIED'],
  ];
  const results: ProbeResult[] = [];
  for (let i = 0; i < specs.length; i++) {
    const [url, validate] = specs[i]!;
    results.push(await probe(checks[i]!, url, auth, validate, fetchImpl));
  }
  results.push({ check: 'twilio.cleaner_use_case_and_consent', outcome: 'NOT_RUN', detail: 'Review approved description, sample messages and opt-in flow for cleaner coordination; account/campaign readiness alone does not establish consent or use-case coverage.' });
  return results;
}
