// Reconcile uploaded live fault evidence; no hosted or Railway calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = 'docs/evidence/cleaner-phase05-live-exports-2026-10-12/';
const load = name => JSON.parse(readFileSync(root + name, 'utf8'));
const report = load('Fault_packet_report.json'), packet = load('Fault_packet.json');
const prior = load('Security_packet.json'), ordinary = load('Ordinary20.json');
const r = packet.responses;
const hash = value => createHash('sha256').update(value).digest('hex');
const time = value => { const n = Date.parse(value); assert(Number.isFinite(n)); return n; };
const source = name => {
  const bytes = readFileSync(root + name);
  return { repositoryPath: root + name, bytes: bytes.length, sha256: hash(bytes) };
};
assert.equal(report.session, packet.session);
const counts = {};
for (const row of report.matrix) counts[row.result] = (counts[row.result] ?? 0) + 1;
assert.equal(report.matrix.length, 57);
assert.deepEqual(counts, report.counts);
assert.deepEqual(counts, { PASS: 46, MISSING: 2, NOT_RUN: 9 });
for (const key of ['s2_http_init_revokedA7.json', 's3_http_init_revokedA8.json']) {
  assert.equal(r[key].http, 401);
  assert.equal(JSON.parse(r[key].body).error, 'UNAUTHORIZED');
}
const verify = packet.http_log.find(x => x.name === 's2_verify_old_A');
assert.equal(verify.http, 409);
assert.equal(r['s2_verify_old_A.json'].error, 'WORKFLOW_NOT_VERIFIED');
for (const key of ['s2_profile_A_after_revoke.json', 's2_profile_A_after_verify.json', 's7_profile_A.json']) {
  const p = r[key];
  assert.equal(p.tenantId, 'A');
  assert.equal(p.agentId, 'grok_test_agent');
  assert.equal(p.readiness.executionMode, 'unavailable');
  assert(p.capabilities.every(c => c.status === 'unknown' && !c.evidence));
}
for (const key of ['s5_profile_B.json', 's7_profile_B.json']) assert.deepEqual(r[key], r['s2_profile_B.json']);
// Earlier exporter replaced native grants with a string: compare only visible fields.
const visible = p => { const { grants: _redacted, ...fields } = p; return fields; };
assert.deepEqual(visible(r['s2_profile_B.json']), visible(prior.profiles.B.final));
for (const tenant of ['A', 'B']) {
  assert.deepEqual(r[`s1_ev${tenant}_after_foreign.json`], ordinary.tenants[tenant].trials[0].rawEngineEvidence);
}
assert.deepEqual(r['s5_evB_trial01.json'], ordinary.tenants.B.trials[0].rawEngineEvidence);
const fixtures = {};
for (const [kind, eventKey, finalKey, version] of [
  ['revoke', 's3_event_revoke.json', 's5_ev_revoke_final.json', 1],
  ['expiry', 's4_event_expiry.json', 's5_ev_expiry_final.json', 2],
  ['action', 's6_event_action.json', 's6_ev_action_after_replays.json', 2],
]) {
  const original = r[eventKey].work, e = r[finalKey], w = e.work;
  const eventId = `p05_${packet.session}_${kind}`;
  assert.equal(w.id, 'work_' + hash(JSON.stringify(['A', 'provider_A', `test_${eventId}`])).slice(0, 32));
  assert.equal(w.id, report.createdWorks[kind]);
  assert.equal(w.id, original.id);
  assert.equal(w.receivedAt, original.receivedAt);
  assert.equal(w.deadlineAt, original.deadlineAt);
  assert.equal(time(w.deadlineAt) - time(w.receivedAt), 120000);
  assert.equal(w.status, 'completed');
  assert.equal(w.turn.version, version);
  assert.equal(e.mode, 'synthetic');
  assert.equal(e.operatesDoors, false);
  assert.equal(e.carrierEvents.length, 0);
  assert.equal(e.replies.length, 1);
  assert.equal(e.replies[0].recipient, 'synthetic_cleaner_A');
  const reply = JSON.parse(e.reply);
  assert.equal(reply.key, `reply_${w.id}`);
  assert.equal(reply.receipt, e.replies[0].receipt);
  assert.equal(reply.attempts, 1);
  const events = type => e.audit.filter(a => a.type === type);
  assert.equal(events('send_attempt').length, 1);
  assert.equal(events('provider_accepted_and_completed').length, 1);
  assert.equal(e.notification.status, 'not_queued');
  const done = time(events('provider_accepted_and_completed')[0].at);
  if (kind !== 'action') {
    assert.equal(w.decisionSource, 'fallback');
    assert(!w.turn.confirmedStart);
    assert.equal(events('validated_action_and_reply_saved').length, 0);
    assert.equal(events('deadline_fallback_selected').length, 1);
    assert(time(events('deadline_fallback_selected')[0].at) >= time(w.deadlineAt));
  } else {
    assert.equal(w.decisionSource, 'agent');
    assert.equal(w.turn.confirmedStart, w.requestedStart);
    assert.equal(events('validated_action_and_reply_saved').length, 1);
    assert(done < time(w.deadlineAt));
    assert.deepEqual(e, r['s6_ev_action_after1.json']);
  }
  fixtures[kind] = { eventId, workId: w.id, receivedAt: w.receivedAt, deadlineAt: w.deadlineAt,
    finalSource: w.decisionSource, turnVersion: w.turn.version, simulatedReceipts: 1,
    completionMinusDeadlineMs: done - time(w.deadlineAt) };
}
const revoked = r['s3_ev_revoke_after.json'], expired = r['s4_ev_expiry_at_lease_expiry.json'];
const release = revoked.audit.find(x => x.type === 'grant_revoked_lease_released');
const revokeClaim = packet.native.find(x => x.step === '3.2' && x.tool === 'claim_delegated_work').response;
assert(time(release.at) < time(revokeClaim.leaseExpiresAt));
assert.deepEqual(revoked, r['s3_ev_revoke_after_leaseinvalid.json']);
assert.equal(expired.work.status, 'pending');
assert.equal(expired.replies.length, 0);
const expiry = expired.audit.find(x => x.type === 'lease_expired_or_grant_revoked');
const margin = time(expired.work.deadlineAt) - time(expiry.at);
assert(margin > 0);
const nativeCodes = packet.native.filter(x => x.response?.code).map(x => x.response.code);
for (const code of ['NOT_FOUND', 'LEASE_INVALID', 'VERSION_CONFLICT', 'ACTION_CONFLICT']) assert(nativeCodes.includes(code));
assert.equal(packet.native.filter(x => x.response_text?.includes('Unrecognized key: "tenantId"')).length, 3);
const accessRows = packet.http_log.filter(x => x.name.startsWith('s7pa_'));
assert.equal(accessRows.length, 12);
for (const row of accessRows) {
  const value = r[row.name + '.json'];
  if (row.http === 404) assert.equal(value.error, 'NOT_FOUND');
  else { assert.equal(row.http, 200); if (value.propertyId) {
    assert.equal(value.hostClearance, false); assert.equal(value.clearanceCurrent, false); assert.equal(value.operatesDoors, false);
  } }
}
console.log(JSON.stringify({
  schemaVersion: 1, session: packet.session, status: 'FAULT_RECORDS_RECONCILED_RESTART_AND_RESTORATION_PENDING',
  provenance: 'User-exported engine records, structured native observations and HTTP logs; no direct authenticated hosted reads',
  sources: ['Fault_packet_report.json', 'Fault_packet.json'].map(source),
  suppliedMatrixRows: 57, reportedCounts: { ...counts, FAIL: 0 }, fixtures,
  leaseExpiryBeforeDeadlineMs: margin,
  directlyObservedHttpDenials: ['Revoked A7 MCP initialize: 401', 'Revoked A8 MCP initialize: 401', 'Old-epoch workflow verification: 409 WORKFLOW_NOT_VERIFIED'],
  checks: { mainRevocation: 'PASS_RECONCILED_ENGINE_PROFILE_AND_EXPORTED_DENIALS',
    activeLeaseRevocation: 'PASS_RECONCILED_RELEASE_BEFORE_EXPIRY; stale lease rejection recorded natively',
    leaseExpiry: 'PASS_RECONCILED_PENDING_BEFORE_DEADLINE_WITHOUT_REPLY',
    staleVersionAndAction: 'PASS_STRUCTURED_NATIVE_ERRORS_AND_ENGINE_OUTCOMES',
    exactActionReplay: 'PASS_EXPORTED_VALUES_EQUAL; one action audit/send/receipt',
    BPreservation: 'PASS_EXPORTED_VISIBLE_PROFILE_AND_TRIAL_EVIDENCE_EQUAL',
    propertyAccess: 'PASS_LABELLED_HTTP_STATUS_AND_RESPONSE_VALUES',
    nativeBridgeStatus: 'Native failure /register HTTP 404 is not the MCP endpoint status; only separate HTTP calls directly expose 401',
    queuedScheduleAbsence: 'MISSING_GLOBAL_LIST_API; no new schedules in this packet' },
  remaining: ['Restart of the dedicated test service with the same revision/volume/variables',
    'Post-restart runtime, replay/dedup, property/access, revoked/current grants and B controls',
    'One new restoration onboarding, genuine closed-window confirmation and fresh A workflow evidence'],
  limitations: ['Structured native entries mix full/summarized bodies, response text and redacted saved arguments; no per-call trace IDs',
    'Different lease-token bytes are redacted; reclaim audit and old-lease rejection corroborate the reported result',
    'Owner turn bump succeeds and appears as v2, but saveTurn emits no audit entry',
    'A tenantId-added calls and separate revoke-fixture pre-claim read are NOT_RUN',
    'B is listed natively before, not after faults; no global pending-schedule listing exists',
    'Prior-packet original native/refresh/revoke files remain missing',
    'No hosting restart performed by this reconciler; no real SMS, phone delivery or doors',
    'Fault fallbacks and controlled action remain separate from the twenty ordinary latency observations']
}, null, 2));
