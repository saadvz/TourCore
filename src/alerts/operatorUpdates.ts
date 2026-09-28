import type { AuditEvent } from "../domain/model";
import { listExceptions, type ExceptionKind } from "../operator/exceptions";
import type { OperatorServices } from "../operator/services";
import { tourRef, tourSnapshots } from "../operator/tours";
import { exceptionCreatedEvent, isIssueEvent, tourEvent, type IssueEventType, type OperatorEvent, type TourEventType } from "./operatorEvents";
import type { OperatorEventOutbox } from "./outbox";
import { wants, type NotificationPreferences } from "./preferences";

/**
 * Turns what happened on tours into operator updates. Everything is derived
 * from the canonical tour records (append-only audit), so after each saved
 * conversation step this looks for updates it hasn't queued yet and queues
 * one event each. Stable eventIds make a repeat scan (or a repeated inbound
 * message) a no-op. Only a tour's big moments and issues become updates;
 * normal texts and door requests never do.
 */

/** The team placed this hold themselves; telling them about it is noise. */
const NOT_ANNOUNCED: ExceptionKind[] = ["operator-hold"];

const ISSUE_TYPE: Partial<Record<ExceptionKind, IssueEventType>> = {
  "off-route-door": "access.problem",
  "door-system": "access.problem",
  "provider-failure": "access.problem",
  "access-problem": "access.problem",
  "verification-failed": "verification.problem",
};

const TOUR_STEP: Partial<Record<AuditEvent["type"], TourEventType>> = {
  // Booked means a valid booking: time chosen, consent given and identity checked.
  TOUR_READY: "tour.booked",
  TOUR_STARTED: "tour.started",
  TOUR_COMPLETED: "tour.completed",
  RESERVATION_CANCELLED: "tour.cancelled",
  RESERVATION_REVOKED: "tour.cancelled",
};

export class OperatorUpdates {
  constructor(
    private readonly deps: {
      services: OperatorServices;
      outbox: OperatorEventOutbox;
      /** The landlord's choices. Read on every scan so a change applies at once. */
      preferences?: () => NotificationPreferences | undefined;
      log?: (line: string) => void;
    },
  ) {}

  private prefs(): NotificationPreferences | undefined {
    try {
      return this.deps.preferences?.();
    } catch {
      return undefined;
    }
  }

  /** Queues events for new updates (one property or all). Returns how many were new. */
  async scan(propertyId?: string, options: { suppress?: boolean } = {}): Promise<number> {
    const prefs = this.prefs();
    let created = 0;
    const queue = (event: OperatorEvent) => {
      if (!options.suppress && !wants(prefs, event)) return;
      if (this.deps.outbox.enqueue(event, options).created) created++;
    };
    for (const x of await listExceptions(this.deps.services, { propertyId })) {
      if (NOT_ANNOUNCED.includes(x.kind)) continue;
      queue(exceptionCreatedEvent({ propertyId: x.propertyId, exceptionId: x.exceptionId, occurredAt: x.happenedAt, eventType: ISSUE_TYPE[x.kind] ?? "exception.created" }));
    }
    for (const event of await this.tourEvents(propertyId)) queue(event);
    return created;
  }

  /** Records every update that already exists as known, without announcing it. */
  baseline(): Promise<number> {
    return this.scan(undefined, { suppress: true });
  }

  /**
   * Tour lifecycle updates for tours with real visitors (text-message tours).
   * Practice tours and the browser visitor demo never wake the landlord.
   */
  private async tourEvents(propertyId?: string): Promise<OperatorEvent[]> {
    const out: OperatorEvent[] = [];
    for (const tour of await tourSnapshots(this.deps.services, { propertyId })) {
      if (tour.kind !== "messaging") continue;
      const ref = tourRef(tour.propertyId, tour.tourId);
      const booked = new Set<string>();
      for (const e of tour.bundle.auditEvents) {
        const type = TOUR_STEP[e.type];
        if (!type || !e.reservationId) continue;
        if (type === "tour.booked") booked.add(e.reservationId);
        // Only a tour that was actually booked can be cancelled; a declined consent is just a visitor saying no.
        if (type === "tour.cancelled" && !booked.has(e.reservationId)) continue;
        out.push(tourEvent({ eventType: type, propertyId: tour.propertyId, tourRef: ref, reservationId: e.reservationId, occurredAt: e.at }));
      }
    }
    return out;
  }

  /** Delivered only while it still matters: an issue while it's open, a tour update while the landlord still wants it. */
  async stillRelevant(event: OperatorEvent): Promise<boolean> {
    if (!wants(this.prefs(), event)) return false;
    if (!isIssueEvent(event.eventType) || !event.exceptionId) return true;
    const open = await listExceptions(this.deps.services, { propertyId: event.propertyId });
    return open.some((x) => x.exceptionId === event.exceptionId);
  }
}
