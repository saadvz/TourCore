import { TERMINAL } from "../domain/stateMachine";
import type { Reservation } from "../domain/model";
import type { VisitorDemoSession } from "./session";

/** A leftover day/time (or other pre-booking) conversation was replaced. */
export const ONE_OFF_REPLACED_DETAIL = "replaced by the operator's one-off tour";

export const ONE_OFF_BOOKED_REFUSAL = "They already have a booked tour. I can move it or call it off.";

export const ONE_OFF_PENDING_REFUSAL =
  "They already have a tour waiting for them to reply YES or NO. I can call it off, or we can wait for them to answer.";

export const ONE_OFF_TOURING_REFUSAL = "They're on a tour right now. I can call it off.";

export const ONE_OFF_PAUSED_REFUSAL = "Their tour is on hold. I can resume it or call it off.";

/**
 * Why this phone cannot get a new operator-set tour, in plain operator words.
 * Undefined means the conversation is finished or only a leftover pre-booking
 * menu — the one-off may replace it.
 */
export async function oneOffBlockReason(session: VisitorDemoSession): Promise<string | undefined> {
  if (await session.isPaused()) return ONE_OFF_PAUSED_REFUSAL;
  const reservation = await session.reservation();
  if (!reservation || TERMINAL.includes(reservation.status)) return undefined;
  if (reservation.awaitingVisitorConfirm?.kind === "OPERATOR_SCHEDULED") return ONE_OFF_PENDING_REFUSAL;
  if (reservation.status === "TOURING") return ONE_OFF_TOURING_REFUSAL;
  if (isHeldOrBooked(reservation)) return ONE_OFF_BOOKED_REFUSAL;
  return undefined;
}

function isHeldOrBooked(reservation: Reservation): boolean {
  return reservation.status === "RESERVED" || reservation.status === "AWAITING_CONSENT" || reservation.status === "AWAITING_VERIFICATION" || reservation.status === "READY";
}
