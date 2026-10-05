import type { Reservation, ReservationStatus } from "./model";

const HAPPY_PATH: Partial<Record<ReservationStatus, ReservationStatus[]>> = {
  INQUIRY: ["RESERVED", "CANCELLED", "EXPIRED"],
  RESERVED: ["AWAITING_CONSENT"],
  AWAITING_CONSENT: ["AWAITING_VERIFICATION", "READY"],
  AWAITING_VERIFICATION: ["READY", "VERIFICATION_FAILED"],
  READY: ["TOURING", "EXPIRED"],
  // TOURING -> READY only when a tour is rescheduled: its doors are switched off and it waits for the new time.
  TOURING: ["COMPLETED", "EXPIRED", "READY"],
};

/** Statuses where a booked tour is still live and can be interrupted. */
const ACTIVE: ReservationStatus[] = ["RESERVED", "AWAITING_CONSENT", "AWAITING_VERIFICATION", "READY", "TOURING"];
const INTERRUPTIONS: ReservationStatus[] = ["CANCELLED", "REVOKED", "OPERATOR_HOLD", "PROVIDER_FAILURE", "VERIFICATION_FAILED"];
const PAUSED: ReservationStatus[] = ["OPERATOR_HOLD", "PROVIDER_FAILURE"];

export const TERMINAL: ReservationStatus[] = ["COMPLETED", "CANCELLED", "VERIFICATION_FAILED", "EXPIRED", "REVOKED"];

export function canTransition(reservation: Reservation, to: ReservationStatus): boolean {
  const from = reservation.status;
  if (HAPPY_PATH[from]?.includes(to)) return true;
  if (ACTIVE.includes(from) && INTERRUPTIONS.includes(to)) return true;
  if (PAUSED.includes(from)) {
    if (to === reservation.heldFromStatus) return true;
    if (to === "CANCELLED" || to === "REVOKED" || to === "EXPIRED") return true;
  }
  return false;
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: ReservationStatus,
    readonly to: ReservationStatus,
  ) {
    super(`Reservation cannot move from ${from} to ${to}`);
  }
}

/** Returns a new reservation in the target status; never mutates the input. */
export function transition(reservation: Reservation, to: ReservationStatus, at: Date): Reservation {
  if (!canTransition(reservation, to)) throw new InvalidTransitionError(reservation.status, to);
  const next: Reservation = { ...reservation, status: to, updatedAt: at.toISOString() };
  if (PAUSED.includes(to)) next.heldFromStatus = PAUSED.includes(reservation.status) ? reservation.heldFromStatus : reservation.status;
  else delete next.heldFromStatus;
  return next;
}
