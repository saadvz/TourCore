import type { TourCoreConfig } from "../config/tourCoreConfig";
import { formatTime } from "../core/timezone";
import type { AccessGrant, AuditEvent } from "../domain/model";
import type { ExportBundle } from "../export/exportBundle";

/**
 * Operator-facing access-window times, derived from saved AccessGrant
 * records and ACCESS_* audit events. No new store: grants and the audit
 * already know when a door was allowed, until when, and when it ended.
 */

export type AccessWindowSource = {
  config: TourCoreConfig;
  bundle: Pick<ExportBundle, "accessGrants" | "auditEvents" | "reservations">;
};

export interface AccessGrantTimes {
  doorName: string;
  /** ACCESS_ALLOWED time, or the grant's createdAt / validFrom. */
  allowedAt: string;
  validUntil: string;
  /** Revoked or otherwise ended, when that happened. */
  endedAt?: string;
}

export interface AccessDenialTimes {
  doorName: string;
  time: string;
  code: string;
}

export class AccessWindows {
  static doorName(config: TourCoreConfig, doorId: string | undefined): string {
    if (!doorId) return "a door";
    return config.doors.find((d) => d.id === doorId)?.name ?? "a door that isn't on file";
  }

  static grants(tour: AccessWindowSource): AccessGrantTimes[] {
    const tz = tour.config.property.timezone;
    const reservationId = tour.bundle.reservations.at(-1)?.id;
    const grants = tour.bundle.accessGrants.filter((g) => !reservationId || g.reservationId === reservationId);
    const allowed = tour.bundle.auditEvents.filter((e) => e.type === "ACCESS_ALLOWED" && !e.detail.startsWith("duplicate"));
    const revoked = tour.bundle.auditEvents.filter((e) => e.type === "ACCESS_REVOKED");
    return grants.map((grant) => AccessWindows.fromGrant(grant, allowed, revoked, tour.config, tz));
  }

  static denials(tour: AccessWindowSource): AccessDenialTimes[] {
    const tz = tour.config.property.timezone;
    return tour.bundle.auditEvents
      .filter((e) => e.type === "ACCESS_DENIED")
      .map((e) => ({
        doorName: AccessWindows.doorName(tour.config, e.doorId),
        time: formatTime(new Date(e.at), tz),
        code: e.code ?? "DENY_UNKNOWN",
      }));
  }

  static fromTours(tours: AccessWindowSource[]): { accessGrants: AccessGrantTimes[]; accessDenials: AccessDenialTimes[] } {
    return {
      accessGrants: tours.flatMap((t) => AccessWindows.grants(t)),
      accessDenials: tours.flatMap((t) => AccessWindows.denials(t)),
    };
  }

  private static fromGrant(grant: AccessGrant, allowed: AuditEvent[], revoked: AuditEvent[], config: TourCoreConfig, tz: string): AccessGrantTimes {
    const allowedEvent = allowed.find((e) => e.doorId === grant.doorId && e.reservationId === grant.reservationId);
    const revokedEvent = revoked.find((e) => e.doorId === grant.doorId && e.reservationId === grant.reservationId);
    const allowedAt = allowedEvent?.at ?? grant.createdAt ?? grant.validFrom;
    const endedAt = grant.revokedAt ?? revokedEvent?.at;
    return {
      doorName: AccessWindows.doorName(config, grant.doorId),
      allowedAt: formatTime(new Date(allowedAt), tz),
      validUntil: formatTime(new Date(grant.validUntil), tz),
      ...(endedAt ? { endedAt: formatTime(new Date(endedAt), tz) } : {}),
    };
  }
}
