import { mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CleanerStore } from '../../delegation/phase05/store';
import { probeGuesty, probeTwilio, discoverTwilioProbe } from './probes';
import { TwilioIntegrationLab, twilioLabApp, type LabBinding } from './twilioLab';

const env = process.env;
function required(name: string) { const value = env[name]; if (!value?.trim()) throw new Error(`Configure ${name} in secure environment settings.`); return value; }
function optionalGroup(names: string[]) {
  if (names.every(name => env[name] === undefined)) return undefined;
  return names.map(required);
}
async function main() {
  const command = process.argv[2];
  if (command === 'evidence') {
    const origin = required('CLEANER_PHASE06_PUBLIC_URL'), url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('Trusted HTTPS origin required');
    const response = await fetch(`${origin}/phase06/evidence/test`, { redirect: 'error', headers: { Authorization: `Bearer ${required('CLEANER_PHASE06_OWNER_TOKEN')}` }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Evidence unavailable');
    console.log(JSON.stringify(await response.json(), null, 2)); return;
  }
  if (command === 'probe') {
    const g = optionalGroup(['CLEANER_PHASE06_GUESTY_ACCESS_TOKEN', 'CLEANER_PHASE06_GUESTY_LISTING_ID', 'CLEANER_PHASE06_GUESTY_RESERVATION_ID', 'CLEANER_PHASE06_GUESTY_TASK_ID', 'CLEANER_PHASE06_GUESTY_START_DATE', 'CLEANER_PHASE06_GUESTY_END_DATE']);
    const t = optionalGroup(['CLEANER_PHASE06_TWILIO_ACCOUNT_SID', 'CLEANER_PHASE06_TWILIO_AUTH_TOKEN', 'CLEANER_PHASE06_TWILIO_FROM_NUMBER']);
    const ids = optionalGroup(['CLEANER_PHASE06_TWILIO_PHONE_SID', 'CLEANER_PHASE06_TWILIO_SERVICE_SID', 'CLEANER_PHASE06_TWILIO_CAMPAIGN_SID']);
    const guesty = await probeGuesty(g ? { accessToken: g[0]!, listingId: g[1]!, reservationId: g[2]!, taskId: g[3]!, startDate: g[4]!, endDate: g[5]! } : undefined);
    const base = t ? { accountSid: t[0]!, authToken: t[1]!, fromNumber: t[2]! } : undefined;
    const twilio = base && !ids ? await discoverTwilioProbe(base) : await probeTwilio(base && ids ? { ...base, phoneSid: ids[0]!, serviceSid: ids[1]!, campaignSid: ids[2]! } : undefined);
    console.log(JSON.stringify({ schemaVersion: 1, measuredAt: new Date().toISOString(), mode: 'read_only_probe', guesty, twilio, phase06Complete: false, productionReady: false }, null, 2));
    if ([...guesty, ...twilio].some(r => r.outcome !== 'PASS')) process.exitCode = 2;
    return;
  }
  if (command === 'lab' && process.argv.includes('--live')) {
    // This command never discovers credentials or changes a Twilio number/service configuration.
    const sendsEnabled = env.CLEANER_PHASE06_USE_CASE_REVIEWED === 'true';
    const accountSid = required('CLEANER_PHASE06_TWILIO_ACCOUNT_SID'), authToken = required('CLEANER_PHASE06_TWILIO_AUTH_TOKEN');
    const ownerToken = required('CLEANER_PHASE06_OWNER_TOKEN');
    const binding: LabBinding = {
      id: 'test', tenant: 'controlled_test', accountSid, authToken,
      fromNumber: required('CLEANER_PHASE06_TWILIO_FROM_NUMBER'), testNumber: required('CLEANER_PHASE06_TEST_NUMBER'),
      publicBaseUrl: required('CLEANER_PHASE06_PUBLIC_URL'),
      ...(sendsEnabled ? { consent: { at: required('CLEANER_PHASE06_CONSENT_AT'), reference: required('CLEANER_PHASE06_CONSENT_REFERENCE') } } : {}),
      send: async input => {
        const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
          method: 'POST', redirect: 'error', signal: input.signal,
          headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ From: input.from, To: input.to, Body: input.body, StatusCallback: input.statusCallback }),
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error('Twilio send not confirmed'); }
        const result = await response.json() as { sid: string; status?: string; error_code?: number | null };
        return { sid: result.sid, status: result.status, errorCode: result.error_code };
      },
    };
    const root = resolve(env.CLEANER_PHASE06_HOME ?? 'tourcore-data/cleaner-phase06-lab');
    const port = Number(env.CLEANER_PHASE06_PORT ?? env.PORT ?? 4336), host = env.CLEANER_PHASE06_HOST ?? '127.0.0.1';
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('Invalid lab listen settings');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const lockPath = join(root, 'lab.lock'), lock = openSync(lockPath, 'wx', 0o600);
    let store: CleanerStore | undefined, lab: TwilioIntegrationLab | undefined;
    try {
      store = new CleanerStore(join(root, 'lab.sqlite'));
      lab = new TwilioIntegrationLab(store, [binding], Date.now, 8000, sendsEnabled);
      let workerFailed = false;
      const app = twilioLabApp(lab, ownerToken, () => !workerFailed), worker = lab;
      let lastEvidence = '';
      const timer = setInterval(() => { void worker.tick().then(() => {
        if (env.CLEANER_PHASE06_EVIDENCE_LOGGING === 'true') {
          const evidence = worker.evidence('test'), encoded = JSON.stringify(evidence);
          if (encoded !== lastEvidence) { lastEvidence = encoded; console.log(JSON.stringify({ event: 'phase06.lab_evidence', evidence })); }
        }
      }).catch(() => { workerFailed = true; }); }, 250); timer.unref();
      const probeController = new AbortController();
      const server = app.listen(port, host, () => {
        console.log(JSON.stringify({ event: 'phase06.listening', sendsEnabled, mode: sendsEnabled ? 'controlled_test' : 'preflight_only', commit: env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown' }));
        if (env.CLEANER_PHASE06_PREFLIGHT_ON_START === 'true') void discoverTwilioProbe({ accountSid, authToken, fromNumber: binding.fromNumber, expectedInboundUrl: binding.publicBaseUrl + '/phase06/twilio/test/inbound' }, (url, init) => fetch(url, { ...init, signal: AbortSignal.any([probeController.signal, init.signal!]) })).then(checks => console.log(JSON.stringify({ event: 'phase06.twilio_preflight', checks, sendsEnabled }))).catch(() => console.log(JSON.stringify({ event: 'phase06.twilio_preflight', error: 'Readiness could not be confirmed', sendsEnabled })));
      });
      const stop = async () => { clearInterval(timer); probeController.abort(); const stopped = new Promise<void>(resolve => server.close(() => resolve())); await worker.close(); await stopped; store!.close(); closeSync(lock); unlinkSync(lockPath); process.exitCode = workerFailed ? 1 : 0; };
      let stopping = false;
      for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { if (!stopping) { stopping = true; void stop(); } });
      server.on('error', () => { workerFailed = true; if (!stopping) { stopping = true; void stop(); } });
    } catch (error) { store?.close(); closeSync(lock); unlinkSync(lockPath); throw error; }
    return;
  }
  throw new Error('Use probe, or lab --live with dedicated secure test settings.');
}
void main().catch(error => {
  // Only our own configuration errors can be printed; provider/validation exceptions may echo input.
  const message = error instanceof Error && /^Configure CLEANER_PHASE06_[A-Z_]+ in secure environment settings\.$/.test(error.message) ? error.message : 'Phase 0.6 command could not run. Check complete secure test settings, lab lock and configuration; no automatic send retry was made.';
  console.error(message); process.exitCode = 1;
});
