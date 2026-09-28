import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * What Tour Core tells an operator notification channel. Deliberately
 * minimal: which exception, at which property, when. No visitor names,
 * numbers or message text, and no credentials. The receiver (a Grok Routine
 * today) wakes up and reads the canonical exception over MCP
 * (`inspect_exception`), so Tour Core stays the system of record.
 */

export const OperatorEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: z.string().regex(/^evt_[A-Za-z0-9_-]{8,80}$/),
  eventType: z.enum(["exception.created", "installation.test"]),
  propertyId: z.string().regex(/^[a-z0-9_]+$/).optional(),
  exceptionId: z.string().regex(/^exc_[a-f0-9]{12}$/).optional(),
  occurredAt: z.string(),
});
export type OperatorEvent = z.infer<typeof OperatorEventSchema>;

/** The same exception always gets the same eventId, across retries and restarts. */
export const exceptionEventId = (exceptionId: string) => `evt_${createHash("sha256").update(`exception.created|${exceptionId}`).digest("hex").slice(0, 24)}`;

export function exceptionCreatedEvent(input: { propertyId: string; exceptionId: string; occurredAt: string }): OperatorEvent {
  return OperatorEventSchema.parse({
    schemaVersion: 1,
    eventId: exceptionEventId(input.exceptionId),
    eventType: "exception.created",
    propertyId: input.propertyId,
    exceptionId: input.exceptionId,
    occurredAt: input.occurredAt,
  });
}

export function testEvent(now: Date): OperatorEvent {
  return OperatorEventSchema.parse({
    schemaVersion: 1,
    eventId: `evt_test_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    eventType: "installation.test",
    occurredAt: now.toISOString(),
  });
}

/** A delivery that didn't go through. The message is plain and never contains the address or key. */
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface OperatorNotificationSink {
  readonly kind: "NONE" | "GROK_ROUTINE";
  /** Whether this sink has what it needs to deliver. */
  configured(): boolean;
  /** Resolves once the receiver accepted the event; throws DeliveryError otherwise. */
  deliver(event: OperatorEvent): Promise<void>;
}

/** No channel set up: events wait in the outbox until one is. */
export class NoopOperatorNotificationSink implements OperatorNotificationSink {
  readonly kind = "NONE" as const;
  configured(): boolean {
    return false;
  }
  async deliver(): Promise<void> {
    throw new DeliveryError("Operator alerts aren't connected yet.", true);
  }
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;

/**
 * Wakes a Grok Routine through its authenticated webhook: one JSON POST with
 * the routine's key as a bearer token. The address and key come from the
 * SecretStore on every delivery, so rotating them on the secure setup page
 * takes effect immediately.
 */
export class GrokRoutineWebhookSink implements OperatorNotificationSink {
  readonly kind = "GROK_ROUTINE" as const;

  constructor(
    private readonly settings: { url: () => string | undefined; key: () => string | undefined },
    private readonly options: { fetch?: Fetch; timeoutMs?: number } = {},
  ) {}

  configured(): boolean {
    return !!this.settings.url() && !!this.settings.key();
  }

  async deliver(event: OperatorEvent): Promise<void> {
    const url = this.settings.url();
    const key = this.settings.key();
    if (!url || !key) throw new DeliveryError("Operator alerts aren't connected yet.", true);
    const body = JSON.stringify(OperatorEventSchema.parse(event));
    const doFetch: Fetch = this.options.fetch ?? ((u, init) => fetch(u, init));
    let status: number;
    try {
      ({ status } = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "User-Agent": "tour-core" },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      }));
    } catch {
      throw new DeliveryError("Couldn't reach the Grok Routine right now.", true);
    }
    if (status >= 200 && status < 300) return;
    if (status === 401 || status === 403) throw new DeliveryError("The Grok Routine refused the connection details. Re-enter them on the secure setup page.", true);
    if (status === 404) throw new DeliveryError("The Grok Routine address wasn't found. Check it on the secure setup page.", true);
    throw new DeliveryError(`The Grok Routine didn't accept the alert (status ${status}).`, status >= 500 || status === 429);
  }
}
