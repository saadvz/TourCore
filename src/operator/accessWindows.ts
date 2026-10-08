import type { TourCoreConfig } from "../config/tourCoreConfig";
import { formatDateTime, formatIsoOffset } from "../core/timezone";
import type { AccessGrant, AuditEvent, Reservation } from "../domain/model";
import { isRunningReservation, TERMINAL } from "../domain/stateMachine";
import type { ExportBundle } from "../export/exportBundle";
import { visitorSubject } from "../visitor/identity";

/**
 * Operator-facing access-window times, derived from saved AccessGrant
 * records and ACCESS_* audit events. No new store: grants and the audit
 * already know when a door was allowed, until when, and when it ended.
 */

export type AccessWindowSource = {
  config: TourCoreConfig;
  bundle: Pick<ExportBundle, "accessGrants" | "auditEvents" | "reservations">;
  propertyId?: string;
  tourId?: string;
};

export interface AccessGrantTimes {
  doorName: string;
  /** ACCESS_ALLOWED time, or the grant's createdAt / validFrom. */
  allowedAt: string;
  allowedAtIso: string;
  /** Grant window start (`validFrom`). */
  validFrom: string;
  validFromIso: string;
  validUntil: string;
  validUntilIso: string;
  /** Revoked or otherwise ended, when that happened. */
  endedAt?: string;
  endedAtIso?: string;
  tourRef?: string;
  unitName?: string;
}

export interface AccessDenialTimes {
  doorName: string;
  time: string;
  timeIso: string;
  code: string;
  tourRef?: string;
  unitName?: string;
}

/** Inclusive start, exclusive end, both ISO instants in any offset. */
export interface AccessDayWindow {
  from: string;
  to: string;
}

export class AccessWindows {
  static doorName(config: TourCoreConfig, doorId: string | undefined): string {
    if (!doorId) return "a door";
    return config.doors.find((d) => d.id === doorId)?.name ?? "a door that isn't on file";
  }

  static currentReservation(tour: AccessWindowSource): Reservation | undefined {
    const reservations = tour.bundle.reservations;
    if (!reservations.length) return undefined;
    const running = reservations.find((r) => isRunningReservation(r.status));
    if (running) return running;
    const open = reservations.filter((r) => !TERMINAL.includes(r.status));
    return open.at(-1) ?? reservations.at(-1);
  }

  static grants(tour: AccessWindowSource, reservationId = AccessWindows.currentReservation(tour)?.id, window?: AccessDayWindow): AccessGrantTimes[] {
    if (!reservationId) return [];
    const tz = tour.config.property.timezone;
    const grants = tour.bundle.accessGrants.filter((g) => g.reservationId === reservationId);
    const allowed = tour.bundle.auditEvents.filter((e) => e.type === "ACCESS_ALLOWED" && e.reservationId === reservationId && !e.detail.startsWith("duplicate"));
    const revoked = tour.bundle.auditEvents.filter((e) => e.type === "ACCESS_REVOKED" && e.reservationId === reservationId);
    return grants.flatMap((grant) => {
      if (!AccessWindows.grantOnDay(grant, allowed, window)) return [];
      return [AccessWindows.fromGrant(grant, allowed, revoked, tour, tz)];
    });
  }

  static denials(tour: AccessWindowSource, reservationId = AccessWindows.currentReservation(tour)?.id, window?: AccessDayWindow): AccessDenialTimes[] {
    if (!reservationId) return [];
    const tz = tour.config.property.timezone;
    return tour.bundle.auditEvents
      .filter((e) => e.type === "ACCESS_DENIED" && e.reservationId === reservationId && AccessWindows.onDay(e.at, window))
      .map((e) => ({
        doorName: AccessWindows.doorName(tour.config, e.doorId),
        ...AccessWindows.when(e.at, tz, "time"),
        code: e.code ?? "DENY_UNKNOWN",
        ...AccessWindows.attribution(tour, reservationId),
      }));
  }

  static fromTours(tours: AccessWindowSource[], window?: AccessDayWindow): { accessGrants: AccessGrantTimes[]; accessDenials: AccessDenialTimes[] } {
    const accessGrants: AccessGrantTimes[] = [];
    const accessDenials: AccessDenialTimes[] = [];
    for (const tour of tours) {
      for (const reservation of tour.bundle.reservations) {
        accessGrants.push(...AccessWindows.grants(tour, reservation.id, window));
        accessDenials.push(...AccessWindows.denials(tour, reservation.id, window));
      }
    }
    return { accessGrants, accessDenials };
  }

  /**
   * A grant belongs to the day it was issued (createdAt, or validFrom when
   * createdAt is missing). A use that day (ACCESS_ALLOWED) also counts.
   * A window that merely stays open past midnight does not.
   */
  private static grantOnDay(grant: AccessGrant, allowed: AuditEvent[], window?: AccessDayWindow): boolean {
    if (!window) return true;
    const issued = grant.createdAt || grant.validFrom;
    if (AccessWindows.onDay(issued, window)) return true;
    return allowed.some((event) => event.doorId === grant.doorId && AccessWindows.onDay(event.at, window));
  }

  private static onDay(at: string, window?: AccessDayWindow): boolean {
    if (!window) return true;
    const time = new Date(at).getTime();
    return time >= new Date(window.from).getTime() && time < new Date(window.to).getTime();
  }

  private static fromGrant(grant: AccessGrant, allowed: AuditEvent[], revoked: AuditEvent[], tour: AccessWindowSource, tz: string): AccessGrantTimes {
    const allowedEvent = allowed.find((e) => e.doorId === grant.doorId);
    const revokedEvent = revoked.find((e) => e.doorId === grant.doorId);
    const allowedAt = allowedEvent?.at ?? grant.createdAt ?? grant.validFrom;
    const endedAt = grant.revokedAt ?? revokedEvent?.at;
    return {
      doorName: AccessWindows.doorName(tour.config, grant.doorId),
      ...AccessWindows.when(allowedAt, tz, "allowedAt"),
      ...AccessWindows.when(grant.validFrom, tz, "validFrom"),
      ...AccessWindows.when(grant.validUntil, tz, "validUntil"),
      ...(endedAt ? AccessWindows.when(endedAt, tz, "endedAt") : {}),
      ...AccessWindows.attribution(tour, grant.reservationId),
    };
  }

  private static when<K extends string>(at: string, tz: string, key: K): Record<K, string> & Record<`${K}Iso`, string> {
    const date = new Date(at);
    return { [key]: formatDateTime(date, tz), [`${key}Iso`]: formatIsoOffset(date, tz) } as Record<K, string> & Record<`${K}Iso`, string>;
  }

  private static attribution(tour: AccessWindowSource, reservationId: string): { tourRef?: string; unitName?: string } {
    const reservation = tour.bundle.reservations.find((r) => r.id === reservationId);
    const unit = reservation ? tour.config.units.find((u) => u.id === reservation.unitId) : undefined;
    const unitName = unit ? visitorSubject(tour.config.property, unit.name) : undefined;
    const tourRef = tour.propertyId && tour.tourId ? `${tour.propertyId}~${tour.tourId}` : undefined;
    return { ...(tourRef ? { tourRef } : {}), ...(unitName ? { unitName } : {}) };
  }
}
