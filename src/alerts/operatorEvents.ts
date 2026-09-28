import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * What Tour Core tells an operator notification channel (Operator Updates).
 * Deliberately minimal: what kind of update, which property, which tour or
 * issue, when. No visitor names, numbers or message text, and no
 * credentials. The receiver (a Grok Routine today) wakes up and reads the
 * canonical details over MCP (`get_operator_update`), so Tour Core stays the
 * system of record.
 */

/** Tour lifecycle updates: what the landlord may want to hear about as it happens. */
export const TOUR_EVENT_TYPES = ["tour.booked", "tour.started", "tour.completed", "tour.cancelled"] as const;
/** Something that needs the landlord's judgment. Each points at one open issue. */
export const ISSUE_EVENT_TYPES = ["exception.created", "access.problem", "verification.problem"] as const;
export const OPERATOR_EVENT_TYPES = [...TOUR_EVENT_TYPES, ...ISSUE_EVENT_TYPES, "installation.test"] as const;
export type OperatorEventType = (typeof OPERATOR_EVENT_TYPES)[number];
export type TourEventType = (typeof TOUR_EVENT_TYPES)[number];
export type IssueEventType = (typeof ISSUE_EVENT_TYPES)[number];

export const OperatorEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: z.string().regex(/^evt_[A-Za-z0-9_-]{8,80}$/),
  eventType: z.enum(OPERATOR_EVENT_TYPES),
  propertyId: z.string().regex(/^[a-z0-9_]+$/).optional(),
  /** The tour's handle (inspect_tour's tourRef). A date-and-channel label; never a name or number. */
  tourId: z.string().regex(/^[a-z0-9_]+~[A-Za-z0-9_-]+$/).optional(),
  exceptionId: z.string().regex(/^exc_[a-f0-9]{12}$/).optional(),
  occurredAt: z.string(),
});
export type OperatorEvent = z.infer<typeof OperatorEventSchema>;

export const isTourEvent = (t: OperatorEventType): t is TourEventType => (TOUR_EVENT_TYPES as readonly string[]).includes(t);
export const isIssueEvent = (t: OperatorEventType): t is IssueEventType => (ISSUE_EVENT_TYPES as readonly string[]).includes(t);

/**
 * The same issue always gets the same eventId, across retries, restarts and
 * event types (an issue announced before issue types existed isn't announced again).
 */
export const exceptionEventId = (exceptionId: string) => `evt_${createHash("sha256").update(`exception.created|${exceptionId}`).digest("hex").slice(0, 24)}`;

/** One update per tour step per reservation: a repeated message or rescan never announces it twice. */
export const tourEventId = (eventType: TourEventType, tourRef: string, reservationId: string) =>
  `evt_${createHash("sha256").update(`${eventType}|${tourRef}|${reservationId}`).digest("hex").slice(0, 24)}`;

export function exceptionCreatedEvent(input: { propertyId: string; exceptionId: string; occurredAt: string; eventType?: IssueEventType }): OperatorEvent {
  return OperatorEventSchema.parse({
    schemaVersion: 1,
    eventId: exceptionEventId(input.exceptionId),
    eventType: input.eventType ?? "exception.created",
    propertyId: input.propertyId,
    exceptionId: input.exceptionId,
    occurredAt: input.occurredAt,
  });
}

export function tourEvent(input: { eventType: TourEventType; propertyId: string; tourRef: string; reservationId: string; occurredAt: string }): OperatorEvent {
  return OperatorEventSchema.parse({
    schemaVersion: 1,
    eventId: tourEventId(input.eventType, input.tourRef, input.reservationId),
    eventType: input.eventType,
    propertyId: input.propertyId,
    tourId: input.tourRef,
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
    throw new DeliveryError(`The Grok Routine didn't accept the update (status ${status}).`, status >= 500 || status === 429);
  }
}
