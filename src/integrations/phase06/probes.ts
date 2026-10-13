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
