// Reconcile account-exported observations; this does not contact Grok or a host.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = 'docs/evidence/cleaner-phase05-live-exports-2026-10-12/';
const load = name => JSON.parse(readFileSync(root + name, 'utf8'));
const ordinary = load('Ordinary20.json'), security = load('Security_packet.json');
const time = value => { const ms = Date.parse(value); assert(Number.isFinite(ms)); return ms; };
const hash = value => createHash('sha256').update(value).digest('hex');
const source = name => {
  const bytes = readFileSync(root + name);
  return { repositoryPath: root + name, bytes: bytes.length, sha256: hash(bytes) };
};
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  assert(n > 0);
  return { n, min: sorted[0], median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    max: sorted[n - 1], p95NearestRank: sorted[Math.ceil(.95 * n) - 1] };
};
assert.equal(ordinary.manifest.length, 10);
assert.equal(new Set(ordinary.manifest.map(x => x.eventId)).size, 10);
const rows = [], tenants = {};
for (const tenant of ['A', 'B']) {
  const trials = ordinary.tenants[tenant].trials;
  assert.equal(trials.length, 10);
  for (const [index, trial] of trials.entries()) {
    const manifest = ordinary.manifest[index], ack = trial.rawAcknowledgment.schedule;
    const schedule = trial.rawScheduleRecord.schedule, e = trial.rawEngineEvidence, w = e.work;
    assert.equal(manifest.delaySeconds, 300 + 60 * index);
    assert.equal(manifest.kind, 'ordinary');
    assert.equal(trial.eventId, manifest.eventId);
    assert.equal(trial.delaySeconds, manifest.delaySeconds);
    assert.equal(trial.requestLog.http, 202);
    assert.equal(ack.eventId, manifest.eventId);
    assert.equal(ack.kind, manifest.kind);
    assert.equal(ack.delaySeconds, manifest.delaySeconds);
    assert.equal(ack.status, 'scheduled');
    assert.equal(ack.workId, null);
    assert.equal(schedule.id, ack.id);
    assert.equal(schedule.runAt, ack.runAt);
    assert.equal(schedule.status, 'fired');
    assert.equal(schedule.error, null);
    assert.equal(schedule.workId, w.id);
    assert.equal(w.id, 'work_' + hash(JSON.stringify([tenant, `provider_${tenant}`, `test_${manifest.eventId}`])).slice(0, 32));
    assert.equal(w.turn.id, 'turn_' + hash(JSON.stringify([manifest.eventId])).slice(0, 32));
    const at = type => {
      const events = e.audit.filter(x => x.type === type);
      assert.equal(events.length, 1, `${tenant}/${index + 1}: ${type}`);
      return time(events[0].at);
    };
    const received = time(w.receivedAt), deadline = time(w.deadlineAt);
    const claimed = at('claimed'), validated = at('validated_action_and_reply_saved');
    const attempted = at('send_attempt'), completed = at('provider_accepted_and_completed');
    // The deployed engine samples its clock independently for these fields.
    const receivedAuditDeltaMs = at('received') - received;
    assert(receivedAuditDeltaMs >= 0 && receivedAuditDeltaMs <= 1);
    assert(deadline - received >= 120000 && deadline - received <= 120001);
    assert(received <= claimed && claimed <= validated && validated <= attempted && attempted <= completed);
    assert(validated < deadline && completed < deadline);
    assert(time(schedule.runAt) <= received && received - time(schedule.runAt) <= 5000);
    assert(time(schedule.firedAt) >= received);
    assert.equal(w.status, 'completed');
    assert.equal(w.decisionSource, 'agent');
    assert.equal(w.deliveryStatus, 'sent');
    assert.equal(w.turn.version, 2);
    assert.equal(w.turn.confirmedStart, w.requestedStart);
    assert.equal(e.mode, 'synthetic');
    assert.equal(e.operatesDoors, false);
    assert.equal(e.carrierEvents.length, 0);
    assert.equal(e.replies.length, 1);
    const reply = JSON.parse(e.reply), receipt = e.replies[0];
    assert.equal(reply.key, `reply_${w.id}`);
    assert.equal(reply.source, 'agent');
    assert.equal(reply.status, 'sent');
    assert.equal(reply.attempts, 1);
    assert.equal(reply.recipient, `synthetic_cleaner_${tenant}`);
    assert.equal(reply.turnVersion, w.turn.version);
    for (const key of ['key', 'text', 'recipient', 'receipt']) assert.equal(receipt[key], reply[key]);
    assert(receipt.receipt.startsWith('simulated_'));
    assert.equal(e.notification.tenant, tenant);
    assert.equal(e.notification.work_id, w.id);
    assert.equal(e.notification.agent, 'grok_test_agent');
    assert.equal(e.notification.status, 'accepted');
    assert.equal(e.notification.http, 200);
    assert(e.notification.attempted_at <= e.notification.accepted_at && e.notification.accepted_at <= claimed);
    rows.push({ tenant, trial: index + 1, eventId: manifest.eventId, workId: w.id,
      receivedAt: w.receivedAt, deadlineAt: w.deadlineAt,
      engineLatencyMs: completed - received, validatedDecisionLatencyMs: validated - received,
      deadlineMarginMs: deadline - completed, deadlineIntervalMs: deadline - received,
      receivedAuditDeltaMs, receipt: receipt.receipt });
  }
  const own = rows.filter(x => x.tenant === tenant);
  tenants[tenant] = { planned: 10, accepted: 10, fired: 10, created: 10, agentCompletedBeforeDeadline: 10,
    fallback: 0, review: 0, lateCompletion: 0, duplicateReceipts: 0,
    engineLatencyMs: stats(own.map(x => x.engineLatencyMs)),
    validatedDecisionLatencyMs: stats(own.map(x => x.validatedDecisionLatencyMs)),
    deadlineMarginMs: stats(own.map(x => x.deadlineMarginMs)) };
  for (const [reportedKey, computedKey] of [['engineLatency', 'engineLatencyMs'], ['validatedDecisionLatency', 'validatedDecisionLatencyMs']]) {
    const reported = ordinary.reconstructed_stats_NOT_RAW[tenant][reportedKey], computed = tenants[tenant][computedKey];
    assert.equal(reported.n, computed.n);
    for (const key of ['min', 'median', 'max', 'p95NearestRank']) {
      const reportedValue = reported[key === 'p95NearestRank' ? 'p95_nearestRank' : key];
      assert(Math.abs(reportedValue * 1000 - computed[key]) <= .500001, 'Exported reconstruction rounding exceeds half a millisecond');
    }
  }
  const profile = ordinary[`currentProfile_${tenant}`];
  assert.equal(profile.http, 200);
  assert.equal(profile.raw.tenantId, tenant);
  assert.equal(profile.raw.agentId, 'grok_test_agent');
  assert.equal(profile.raw.readiness.executionMode, 'autonomous');
  assert.equal(profile.raw.readiness.productionReady, false);
  assert(time(profile.readAtUTC) > Math.max(...own.map(x => time(x.receivedAt) + x.engineLatencyMs)));
}
assert.equal(new Set(rows.map(x => x.workId)).size, 20);
assert.equal(new Set(rows.map(x => x.receipt)).size, 20);
const replayChecks = {};
for (const tenant of ['A', 'B']) {
  const trial = ordinary.tenants[tenant].trials[0], r = security.raw_replay[tenant];
  assert.equal(security.selectedFixtures[tenant].workId, trial.rawEngineEvidence.work.id);
  assert.equal(security.selectedFixtures[tenant].eventId, trial.eventId);
  assert.deepEqual(r.evidenceBefore, trial.rawEngineEvidence);
  assert.deepEqual(r.evidenceBefore, r.evidenceAfter);
  for (const name of ['scheduleReplay1', 'scheduleReplay2']) assert.deepEqual(r[name], trial.rawScheduleRecord);
  for (const name of ['eventReplay1', 'eventReplay2']) assert.deepEqual(r[name].work, trial.rawEngineEvidence.work);
  assert.equal(r.conflict.error, 'SOURCE_CONFLICT');
  assert.deepEqual(security.profiles[tenant].baseline, ordinary[`currentProfile_${tenant}`].raw);
  assert.deepEqual(security.profiles[tenant].baseline, security.profiles[tenant].final);
  replayChecks[tenant] = 'PASS_EXPORTED_VALUES_EQUAL; original HTTP wire bytes and replay status lines not supplied';
}
assert.equal(security.runtime.mode, 'synthetic');
assert.equal(security.runtime.realSmsEnabled, false);
assert.equal(security.runtime.tenants, 2);
for (const [tenant, label, status, raw] of security.raw_ingress) {
  const body = JSON.parse(raw);
  if (label.startsWith('valid replay')) {
    assert.equal(status, 200); assert.equal(body.accepted, true);
    assert.equal(body.workId, security.selectedFixtures[tenant].workId);
  } else { assert.equal(status, 401); assert.equal(body.error, 'UNAUTHORIZED'); }
}
assert.equal(security.raw_ingress.length, 16);
const rawOAuthStatuses = {};
for (const [tenant, label, status, body] of security.raw_oauth_log) {
  rawOAuthStatuses[`${tenant}: ${label}`] = status === 0 ? 'LOCAL_COMPARISON_NOT_HTTP' : status;
  if (label.includes('by other owner')) { assert.equal(status, 404); assert.equal(body.error, 'NOT_FOUND'); }
  if (['token wrong verifier', 'token other tenant client', 'consumed code replay', 'agent token on owner route'].includes(label)) {
    assert.equal(status, 401); assert.equal(body.error, 'UNAUTHORIZED');
  }
  if (label.includes('correct exchange')) { assert.equal(status, 200); assert.equal(body.expires_in, 3600); }
  if (label === 'state matches') assert.equal(body.match, true);
}
const access = security.raw_property_access_log.filter(x => x.propertyId);
assert.equal(access.length, 4);
for (const x of access) { assert.equal(x.hostClearance, false); assert.equal(x.clearanceCurrent, false); assert.equal(x.operatesDoors, false); }
const properties = security.raw_property_access_log.filter(x => x.name);
assert.equal(properties.length, 2);
assert.equal(properties[0].id, properties[1].id);
assert.notEqual(properties[0].name, properties[1].name);
const counts = {};
for (const row of security.matrix_RECONSTRUCTED) counts[row.result] = (counts[row.result] ?? 0) + 1;
assert.equal(security.matrix_RECONSTRUCTED.length, 76);
assert.equal(counts.PASS, 71);
assert.equal(counts.NOT_RUN, 1);
assert.equal(counts.missing, 1);
const report = {
  schemaVersion: 1, status: 'ORDINARY_PASS_RECONCILED; SECURITY_PARTIAL_EVIDENCE',
  provenance: 'User-exported account records; no direct authenticated hosted queries by this reconciler',
  sources: ['Ordinary20.json', 'Security_packet.json', 'Security_narrative.txt'].map(source),
  ordinary: { status: 'PASS_RECONCILED_20_OF_20_EXPORTED_ENGINE_RECORDS', tenants, rows,
    combinedEngineLatencyMs: stats(rows.map(x => x.engineLatencyMs)),
    precision: 'Recomputed medians retain half-millisecond averages; exported reconstructed medians round to three decimal seconds. Eight received audits follow receivedAt by 1ms because clocks were sampled separately; original values retained.',
    freshPostStageProfiles: 'A/B post-stage reads present; profile grants redacted and not compared as original values' },
  security: { suppliedMatrixRows: 76, originalResultCounts: counts,
    correctedClassification: { reportedPassRows: 71, nativeFailureObservedHttpStatusInferred: 3,
      browserOAuthConsentNotRun: 1, nativeTraceIdsMissing: 1 },
    replayChecks, ingress: 'PASS_RECONCILED_16_EXPORTED_STATUS_BODY_PAIRS', rawOAuthStatuses,
    propertyAccess: 'Owned response values, errors and false clearance reconciled; raw log lacks route/tenant/status labels',
    nativeScope: 'PASS_REPORTED_WITH_POSITIVE_CONTROLS; reconstructed matrix contains errors, not original tool-result objects',
    mainProfilePreservation: 'PASS_RECONCILED_REDACTED_PUBLIC_VALUES_EQUAL; native grant values were not exported',
    nativeRevocation: 'Three actual connector failures reported; bridge exposes registration HTTP 404, underlying MCP 401 not directly observed',
    exportGaps: ['Raw native scope/identity/error result objects and per-call trace IDs missing',
      'Refresh rotation/reuse and cross-owner revoke HTTP statuses are in the reconstructed matrix, not raw_oauth_log',
      'Property/access raw log omits method/path/tenant/status; matrix supplies those interpretations',
      'Provider signing requests not exported, so intended mutation/re-signing relies on account labels',
      'Wire-byte equality cannot be established from parsed exported objects'] },
  remaining: ['Main-agent revocation with verified capability/profile evidence and active lease',
    'Live lease expiry, stale proposal/version/action and post-revocation capability freshness',
    'Controlled persistent restart and replay with revoked access still denied',
    'Retry/uncertain-send guarantees covered by local injected-provider tests; deployed simulated provider has no fault-injection controls'],
  limitations: ['No phone delivery or door operation; productionReady remains false',
    'Small ordinary latency sample does not establish a production SLA',
    'The earlier failed B onboarding remains in its separate 1-of-2 onboarding accounting',
    'Unknown temporary profile createdAt initially recomputed on every read; see separate local correction']
};
console.log(JSON.stringify(report, null, 2));
