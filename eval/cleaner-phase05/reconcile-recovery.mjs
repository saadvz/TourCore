// Reconcile the final account exports; no network, provider or restart calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = 'docs/evidence/cleaner-phase05-live-exports-2026-10-12/';
const load = name => JSON.parse(readFileSync(root + name, 'utf8'));
const final = load('Fault_packet_recovery_final.json'), report = load('Fault_packet_recovery_final_report.json');
const before = load('Fault_packet.json'), ordinary = load('Ordinary20.json');
const provenancePath = 'docs/evidence/cleaner-phase05-recovery-provenance-2026-10-12.json';
const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
const r = final.responses;
const time = value => { const ms = Date.parse(value); assert(Number.isFinite(ms)); return ms; };
const hash = value => createHash('sha256').update(value).digest('hex');
const source = path => { const bytes = readFileSync(path); return { repositoryPath: path, bytes: bytes.length, sha256: hash(bytes) }; };
assert.equal(final.session, before.session);
assert.equal(final.session, report.session);
assert.deepEqual(final.matrix, report.matrix);
const counts = {};
for (const row of report.matrix) counts[row.result] = (counts[row.result] ?? 0) + 1;
assert.deepEqual(counts, report.counts);
assert.equal(report.matrix.length, 61);
assert.deepEqual(counts, { PASS: 56, MISSING: 2, NOT_RUN: 2, FAIL: 1 });
const runtime = r['r8_runtime.json'];
assert.equal(runtime.mode, 'synthetic');
assert.equal(runtime.realSmsEnabled, false);
assert.equal(runtime.tenants, 2);
assert.equal(runtime.fixtureSchedulerVersion, 'server-clock-v1');
assert.equal(runtime.fixtureSchedulerHealthy, true);
const replays = [];
for (const [label, baseline] of [
  ['A_shared01', ordinary.tenants.A.trials[0].rawEngineEvidence],
  ['B_shared01', ordinary.tenants.B.trials[0].rawEngineEvidence],
  ['revoke', before.responses['s5_ev_revoke_final.json']],
  ['expiry', before.responses['s5_ev_expiry_final.json']],
  ['action', before.responses['s6_ev_action_after1.json']],
]) {
  const first = r[`r8_${label}_ev_before.json`], after = r[`r8_${label}_ev_after.json`];
  assert.deepEqual(first, baseline);
  assert.deepEqual(after, baseline);
  assert.deepEqual(r[`r8_${label}_replay.json`].work, baseline.work);
  assert.equal(after.replies.length, 1);
  replays.push({ label, workId: after.work.id, originalDeadlineAt: after.work.deadlineAt,
    replyKey: after.replies[0].key, receipt: after.replies[0].receipt,
    result: 'PASS_EXPORTED_VALUES_EQUAL_TO_PRE_RESTART_BASELINE' });
}
for (const [name, value] of Object.entries(before.responses)) {
  if (name.startsWith('s7pa_')) assert.deepEqual(r[name.replace('s7pa_', 'r8_')], value);
}
for (const key of ['r8_profile_B.json', 'r8_profile_B_postfail.json', 'r9_profile_B.json']) {
  assert.deepEqual(r[key], before.responses['s7_profile_B.json']);
}
for (const key of ['r8_profile_A.json', 'r8_profile_A_now.json', 'r8_profile_A_postfail.json']) {
  assert.equal(r[key].readiness.executionMode, 'unavailable');
  assert(r[key].capabilities.every(c => c.status === 'unknown' && !c.evidence));
}
for (const key of ['r8_http_init_A7.json', 'r8_http_init_A8.json']) assert.equal(r[key].error, 'UNAUTHORIZED');
for (const key of ['r8_http_init_A9.json', 'r8_http_init_A11.json', 'r8_http_init_B6.json']) assert.equal(r[key].http, 200);
assert.equal(r['r8_native_A7.json'].result, 'FAIL');
assert(r['r8_native_A7.json'].literal.includes('Connection closed'));
assert(r['r8_native_A7.json'].literal.includes('/register'));
const failed = r['r8_sched_fired.json'].schedule, original = r['r8_sched_restore_onboard.json'].schedule;
assert.equal(failed.id, original.id);
assert.equal(failed.runAt, original.runAt);
assert.equal(failed.status, 'failed');
assert.equal(failed.error, 'UNAUTHORIZED');
assert.equal(failed.workId, null);
assert.equal(failed.firedAt, null);
const scheduled = r['r9_sched_retry.json'].schedule, fired = r['r9_sched_fired.json'].schedule;
assert.equal(scheduled.status, 'scheduled');
assert.equal(fired.id, scheduled.id);
assert.equal(fired.runAt, scheduled.runAt);
assert.equal(fired.status, 'fired');
assert.equal(fired.error, null);
const e = r['r9_ev_completed.json'], w = e.work;
assert.equal(w.id, fired.workId);
assert.equal(w.id, 'work_' + hash(JSON.stringify(['A', 'provider_A', `test_${fired.eventId}`])).slice(0, 32));
assert.equal(w.status, 'completed');
assert.equal(w.decisionSource, 'agent');
assert.equal(w.deliveryStatus, 'sent');
assert.equal(w.turn.version, 2);
assert.equal(w.turn.confirmedStart, w.requestedStart);
assert.equal(e.replies.length, 1);
assert.equal(e.replies[0].recipient, 'synthetic_cleaner_A');
assert.equal(e.carrierEvents.length, 0);
assert.equal(e.operatesDoors, false);
const reply = JSON.parse(e.reply);
assert.equal(reply.key, `reply_${w.id}`);
assert.equal(reply.receipt, e.replies[0].receipt);
assert.equal(reply.attempts, 1);
const event = type => { const found = e.audit.filter(a => a.type === type); assert.equal(found.length, 1); return found[0]; };
const received = time(w.receivedAt), claimed = time(event('claimed').at);
const validated = time(event('validated_action_and_reply_saved').at), done = time(event('provider_accepted_and_completed').at);
assert(received < claimed && claimed <= validated && validated < done && done < time(w.deadlineAt));
assert.equal(event('send_attempt').actor, 'engine');
assert.equal(e.notification.tenant, 'A');
assert.equal(e.notification.epoch, 4);
assert.equal(e.notification.status, 'accepted');
assert.equal(e.notification.attempts, 1);
assert(e.notification.attempted_at <= e.notification.accepted_at && e.notification.accepted_at < claimed);
assert.deepEqual(r['r9_verify.json'], r['r9_profile_A.json']);
const profile = r['r9_profile_A.json'], bg = profile.capabilities.find(c => c.capability === 'background_runs');
assert.equal(profile.tenantId, 'A');
assert.equal(profile.agentId, 'grok_test_agent');
assert.equal(profile.readiness.executionMode, 'autonomous');
assert.deepEqual(profile.readiness.missingForAutonomous, []);
assert.equal(profile.readiness.productionReady, false);
assert.equal(bg.evidence.evidenceId, w.id);
assert.equal(bg.evidence.observedAt, event('provider_accepted_and_completed').at);
assert.equal(bg.evidence.latencyMs, done - received);
assert.equal(bg.evidence.ownerConfirmedConversationClosed, true);
assert.equal(final.http_log.find(x => x.name === 'r9_verify').http, 200);
const confirmation = provenance.ownerClosedWindowConfirmation;
assert.equal(confirmation.confirmed, true);
assert(time(confirmation.windowStart) < received && done < time(confirmation.windowEnd));
console.log(JSON.stringify({
  schemaVersion: 1, status: 'RECOVERY_AND_RESTORATION_RECONCILED_WITH_RETAINED_FAILURE', session: final.session,
  provenance: 'User-exported hosted engine/account records and retrospective closed-window confirmation; no direct authenticated hosted reads by this verifier',
  sources: [root + 'Fault_packet_recovery_final.json', root + 'Fault_packet_recovery_final_report.json', provenancePath].map(source),
  suppliedMatrixRows: 61, reportedCounts: counts,
  restart: 'USER_CONFIRMED_ONCE; post-restart baseline values persist in supplied records',
  replays, propertyAccess: 'PASS_EXPORTED_VALUES_EQUAL_FOR_BOTH_TENANTS',
  grantRecovery: { nativeRevokedAccess: 'Recorded connection failure and /register 404; underlying MCP HTTP status not surfaced by bridge',
    postRestartA7A8HttpStatus: '401 reported at 19:23 EDT inside original validity; exported bodies contain UNAUTHORIZED but no numeric status/time wrapper',
    validControls: 'A9/A11/B6 HTTP initialize 200 and structured native identity/own reads; A remains cleared until new workflow evidence',
    olderBTokenRejection: 'Bcur initialize 401; reason for invalidity not established from redacted credential provenance. Fresh B6 works without clearing B profile.' },
  firstRestoration: { status: 'FAIL_UNAUTHORIZED_NO_WORK_CREATED', schedule: failed,
    sourceCause: 'Account-reported accidental extra A grant revocation; consistent with agent-wide retirement and retry notification epoch 4. Actual extra revoke request not exported.',
    invalidInputCalls: 2, failureRetained: true },
  retryRestoration: { status: 'PASS_RECONCILED_ENGINE_AND_OWNER_CONFIRMATION', schedule: fired,
    workId: w.id, source: 'agent', engineLatencyMs: done - received, validatedDecisionLatencyMs: validated - received,
    storedDeadlineMarginMs: time(w.deadlineAt) - done, scheduleFireLagMs: time(fired.firedAt) - time(fired.runAt),
    receipt: e.replies[0].receipt, notificationEpoch: e.notification.epoch, closedWindow: confirmation,
    verification: 'HTTP 200; fresh work-linked background evidence; A autonomous; productionReady false' },
  restorationAccounting: { acceptedSchedules: 2, failedBeforeWorkCreation: 1, createdWorks: 1, agentCompletions: 1 },
  BPreservation: 'PASS_EXPORTED_FULL_PUBLIC_PROFILE_EQUAL_TO_PRE_RESTART_BASELINE',
  exporterContradictions: ['Report aStillCleared=true and connector label (cleared) are stale; r9 final A profile is autonomous with fresh evidence',
    'Report onboardingSchedule refers to initial failed schedule; r9 fired schedule identifies the successful explicit retry'],
  limits: ['Missing earlier original native/refresh/revoke logs, native trace IDs and global schedule listing remain missing',
    'A tenantId-added checks and separate revoke-fixture pre-claim read remain NOT_RUN; local transport suite covers schema rejection',
    'Backend verify-workflow ran before the closed window ended using an advance promise; genuine retrospective confirmation was obtained in this thread afterward',
    'Original wire bytes, restart hosting controls and reported extra revoke call are not independently inspected',
    'Profile grants lists describe native resource grants, not OAuth bearer validity',
    'Reply is simulated provider acceptance, not a phone delivery; no carrier events or door operation',
    'Restoration/fault/manual-action observations remain outside the twenty ordinary trials']
}, null, 2));
