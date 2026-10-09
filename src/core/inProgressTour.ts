import type { Reservation } from "../domain/model";
import { isValidTimeZone } from "./timezone";

type Windowed = Pick<Reservation, "status" | "windowStart" | "windowEnd">;
type BookedZone = Pick<Reservation, "bookedTimeZone">;

/** Arrived, and still inside the absolute window booked while a zone was set. */
export function tourAlreadyUnderway(reservation: Windowed, now: Date): boolean {
  if (reservation.status !== "TOURING") return false;
  const start = Date.parse(reservation.windowStart ?? "");
  const end = Date.parse(reservation.windowEnd ?? "");
  const at = now.getTime();
  return Number.isFinite(start) && Number.isFinite(end) && at >= start && at < end;
}

/**
 * Zone for clock labels on a tour that already started.
 * The property zone wins. Otherwise the zone stored when the window was booked.
 * A blank result means there is no zone to format with; callers use zone-free copy.
 */
export function bookedClockZone(propertyZone: string, reservation: BookedZone | undefined): string | undefined {
  if (isValidTimeZone(propertyZone)) return propertyZone;
  const booked = reservation?.bookedTimeZone;
  return booked && isValidTimeZone(booked) ? booked : undefined;
}
