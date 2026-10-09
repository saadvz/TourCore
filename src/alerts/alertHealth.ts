import type { OutboxRecord } from "./outbox";

/**
 * One count of operator-alert delivery, shared by landlord status, installation
 * status, and runtime health. A miss counts only after the later of the last
 * successful delivery and a successful test. An equal timestamp does not count.
 */

export interface AlertDeliveryHealth {
  pending: number;
  retrying: number;
  failed: number;
  delivered: number;
  lastError?: string;
  lastDeliveredAt?: string;
}

const EMPTY: AlertDeliveryHealth = { pending: 0, retrying: 0, failed: 0, delivered: 0 };

function later(a?: string, b?: string): string | undefined {
  return [a, b].filter((value): value is string => !!value).sort().at(-1);
}

function isProblem(record: OutboxRecord, since: string | undefined): boolean {
  const missed = record.status === "failed" || (record.status === "pending" && record.attempts > 0);
  if (!missed) return false;
  if (!since) return true;
  if (!record.lastAttemptAt) return true;
  return record.lastAttemptAt > since;
}

export function alertDeliveryHealth(records: OutboxRecord[], successfulTestAt?: string): AlertDeliveryHealth {
  const delivered = records.filter((record) => record.status === "delivered");
  const lastDeliveredAt = delivered
    .map((record) => record.deliveredAt)
    .filter((value): value is string => !!value)
    .sort()
    .at(-1);
  const since = later(lastDeliveredAt, successfulTestAt);
  const problems = records.filter((record) => isProblem(record, since));
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
  files: { state(): { operatorAlerts?: { ok: boolean; at: string } } };
  outbox: { records(): OutboxRecord[] };
}

/** Failures since the last successful test, when that test passed. A read error is not a failure. */
export function installationAlertHealth(inst: AlertHealthSource): AlertDeliveryHealth {
  try {
    const check = inst.files.state().operatorAlerts;
    return alertDeliveryHealth(inst.outbox.records(), check?.ok ? check.at : undefined);
  } catch {
    return EMPTY;
  }
}
