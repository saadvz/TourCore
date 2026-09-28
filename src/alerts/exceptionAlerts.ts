import { listExceptions, type ExceptionKind } from "../operator/exceptions";
import type { OperatorServices } from "../operator/services";
import { exceptionCreatedEvent, type OperatorEvent } from "./operatorEvents";
import type { OperatorEventOutbox } from "./outbox";

/**
 * Turns new exceptions into operator events. Exceptions are derived from the
 * canonical tour records, so after each saved conversation step this looks
 * for open exceptions it hasn't queued yet and queues one event each. The
 * outbox's stable eventId makes a repeat scan a no-op.
 */

/** The team placed this hold themselves; telling them about it is noise. */
const NOT_ANNOUNCED: ExceptionKind[] = ["operator-hold"];

export class ExceptionAlerts {
  constructor(
    private readonly deps: {
      services: OperatorServices;
      outbox: OperatorEventOutbox;
      log?: (line: string) => void;
    },
  ) {}

  /** Queues events for new open exceptions (one property or all). Returns how many were new. */
  async scan(propertyId?: string, options: { suppress?: boolean } = {}): Promise<number> {
    const open = await listExceptions(this.deps.services, { propertyId });
    let created = 0;
    for (const x of open) {
      if (NOT_ANNOUNCED.includes(x.kind)) continue;
      const event = exceptionCreatedEvent({ propertyId: x.propertyId, exceptionId: x.exceptionId, occurredAt: x.happenedAt });
      if (this.deps.outbox.enqueue(event, options).created) created++;
    }
    return created;
  }

  /** Records every exception that already exists as known, without announcing it. */
  baseline(): Promise<number> {
    return this.scan(undefined, { suppress: true });
  }

  /** An event is still worth delivering only while its exception is open. */
  async stillOpen(event: OperatorEvent): Promise<boolean> {
    if (event.eventType !== "exception.created" || !event.exceptionId) return true;
    const open = await listExceptions(this.deps.services, { propertyId: event.propertyId });
    return open.some((x) => x.exceptionId === event.exceptionId);
  }
}
