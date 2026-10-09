import { describe, expect, it } from "vitest";
import { alertDeliveryHealth, installationAlertHealth } from "../src/alerts/alertHealth";
import type { OutboxRecord } from "../src/alerts/outbox";
import { OperatorEventOutbox } from "../src/alerts/outbox";
import { exceptionCreatedEvent } from "../src/alerts/operatorEvents";
import { MemoryRuntimeStore } from "../src/storage/runtimeStore";

const event = exceptionCreatedEvent({ propertyId: "prop_x", exceptionId: "exc_0123456789ab", occurredAt: "2026-09-28T13:00:00.000Z" });

function record(patch: Partial<OutboxRecord> & Pick<OutboxRecord, "status">): OutboxRecord {
  return {
    schemaVersion: 1,
    event,
    attempts: 0,
    createdAt: "2026-09-28T13:00:00.000Z",
    nextAttemptAt: "2026-09-28T13:00:00.000Z",
    ...patch,
  };
}

describe("alert delivery health", () => {
  it("counts a failure after the last successful test, and ignores one from before it", () => {
    const failed = record({ status: "failed", attempts: 1, lastAttemptAt: "2026-09-28T13:05:00.000Z", lastError: "The Grok Routine didn't accept the update (status 400)." });
    expect(alertDeliveryHealth([failed], "2026-09-28T13:00:00.000Z")).toMatchObject({ failed: 1, retrying: 0 });
    expect(alertDeliveryHealth([failed], "2026-09-28T13:05:00.000Z")).toMatchObject({ failed: 0, retrying: 0 });
    expect(alertDeliveryHealth([failed], "2026-09-28T13:06:00.000Z")).toMatchObject({ failed: 0, retrying: 0 });
  });

  it("a later delivery clears earlier misses, and a miss after that delivery counts", () => {
    const oldFailure = record({ status: "failed", attempts: 1, lastAttemptAt: "2026-09-28T13:01:00.000Z", lastError: "old" });
    const delivered = record({
      status: "delivered",
      attempts: 1,
      lastAttemptAt: "2026-09-28T13:02:00.000Z",
      deliveredAt: "2026-09-28T13:02:00.000Z",
      event: { ...event, eventId: "evt_delivered_1" },
    });
    const laterFailure = record({
      status: "failed",
      attempts: 1,
      lastAttemptAt: "2026-09-28T13:03:00.000Z",
      lastError: "new",
      event: { ...event, eventId: "evt_failed_2" },
    });
    expect(alertDeliveryHealth([oldFailure, delivered])).toMatchObject({ failed: 0, delivered: 1, lastDeliveredAt: "2026-09-28T13:02:00.000Z" });
    expect(alertDeliveryHealth([oldFailure, delivered, laterFailure])).toMatchObject({ failed: 1, lastError: "new" });
  });

  it("a retry from before a successful test does not count, and a pending first try does not count", () => {
    const retrying = record({ status: "pending", attempts: 2, lastAttemptAt: "2026-09-28T13:01:00.000Z", lastError: "down" });
    expect(alertDeliveryHealth([retrying], "2026-09-28T13:02:00.000Z")).toMatchObject({ retrying: 0, pending: 1, failed: 0 });
    expect(alertDeliveryHealth([retrying])).toMatchObject({ retrying: 1, pending: 1 });
    const waiting = record({ status: "pending", attempts: 0 });
    expect(alertDeliveryHealth([waiting])).toMatchObject({ pending: 1, retrying: 0, failed: 0 });
  });

  it("uses the same count as the outbox, and a passing check supplies the test time", () => {
    const store = new MemoryRuntimeStore();
    const outbox = new OperatorEventOutbox(store, () => ({ kind: "GROK_ROUTINE", configured: () => true, deliver: async () => {} }));
    outbox.enqueue(event);
    const saved = outbox.get(event.eventId)!;
    store.put("operator-events", event.eventId, { ...saved, status: "failed", attempts: 1, lastAttemptAt: "2026-09-28T13:05:00.000Z", lastError: "nope" });
    expect(outbox.health("2026-09-28T13:06:00.000Z")).toEqual(alertDeliveryHealth(outbox.records(), "2026-09-28T13:06:00.000Z"));
    const source = {
      files: { state: () => ({ operatorAlerts: { ok: true, at: "2026-09-28T13:06:00.000Z" } }) },
      outbox,
    };
    expect(installationAlertHealth(source)).toMatchObject({ failed: 0 });
    expect(installationAlertHealth({ files: { state: () => { throw new Error("unreadable"); } }, outbox })).toEqual({ pending: 0, retrying: 0, failed: 0, delivered: 0 });
  });
});
