import type { OutboxRecord } from "./outbox";

/**
 * One count of operator-alert delivery, shared by landlord status, installation
 * status, and runtime health. A miss counts until a passing test covers it.
 * An ordinary delivery does not clear one, including when they share a timestamp.
 * A passing test also covers the failed records that existed then, by each
 * record's own last attempt, so a clock that ran ahead still clears.
 */

export interface ClearedFailure {
  eventId: string;
  lastAttemptAt?: string;
}

export interface AlertDeliveryHealth {
  pending: number;
  retrying: number;
  failed: number;
  delivered: number;
  lastError?: string;
  lastDeliveredAt?: string;
}

const EMPTY: AlertDeliveryHealth = { pending: 0, retrying: 0, failed: 0, delivered: 0 };

function missed(record: OutboxRecord): boolean {
  return record.status === "failed" || (record.status === "pending" && record.attempts > 0);
}

function covered(record: OutboxRecord, successfulTestAt: string | undefined, cleared: Map<string, string | undefined>): boolean {
  if (successfulTestAt && record.lastAttemptAt && record.lastAttemptAt <= successfulTestAt) return true;
  if (!cleared.has(record.event.eventId)) return false;
  const mark = cleared.get(record.event.eventId);
  if (!record.lastAttemptAt || mark === undefined) return true;
  return record.lastAttemptAt <= mark;
}

/** The misses present now, so a passing test can cover each one by its own time. */
export function problemsToClear(records: OutboxRecord[]): ClearedFailure[] {
  return records.filter(missed).map((record) => ({
    eventId: record.event.eventId,
    ...(record.lastAttemptAt ? { lastAttemptAt: record.lastAttemptAt } : {}),
  }));
}

export function alertDeliveryHealth(records: OutboxRecord[], successfulTestAt?: string, cleared: ClearedFailure[] = []): AlertDeliveryHealth {
  const delivered = records.filter((record) => record.status === "delivered");
  const lastDeliveredAt = delivered
    .map((record) => record.deliveredAt)
    .filter((value): value is string => !!value)
    .sort()
    .at(-1);
  const marks = new Map<string, string | undefined>();
  for (const item of cleared) {
    const prev = marks.get(item.eventId);
    if (!marks.has(item.eventId) || (item.lastAttemptAt && (!prev || item.lastAttemptAt > prev))) marks.set(item.eventId, item.lastAttemptAt);
  }
  const problems = records.filter((record) => missed(record) && !covered(record, successfulTestAt, marks));
  const latestProblem = [...problems]
    .filter((record) => record.lastError)
    .sort((a, b) => (b.lastAttemptAt ?? "").localeCompare(a.lastAttemptAt ?? ""))[0];
  return {
    pending: records.filter((record) => record.status === "pending").length,
    retrying: problems.filter((record) => record.status === "pending").length,
    failed: problems.filter((record) => record.status === "failed").length,
    delivered: delivered.length,
    ...(latestProblem?.lastError ? { lastError: latestProblem.lastError } : {}),
    ...(lastDeliveredAt ? { lastDeliveredAt } : {}),
  };
}

export interface AlertHealthSource {
  files: { state(): { operatorAlerts?: { ok: boolean; at: string; clearedFailures?: ClearedFailure[] } } };
  outbox: { records(): OutboxRecord[] };
}

/** Failures a passing test has not covered. A read error is not a failure. */
export function installationAlertHealth(inst: AlertHealthSource): AlertDeliveryHealth {
  try {
    const check = inst.files.state().operatorAlerts;
    return alertDeliveryHealth(inst.outbox.records(), check?.ok ? check.at : undefined, check?.ok ? check.clearedFailures : undefined);
  } catch {
    return EMPTY;
  }
}
