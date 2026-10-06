import type { Reservation } from "../domain/model";
import { isCancelableReservation } from "../domain/stateMachine";

export type VisitorCancelTarget = {
  reservation: Reservation;
  laterWhileTouring: boolean;
};

const TOURING_NOW: Reservation["status"][] = ["TOURING", "OPERATOR_HOLD", "PROVIDER_FAILURE"];

/**
 * While they are touring and a later booking is held, cancel-by-text targets
 * that later booking. The running tour is never cancelled by visitor text.
 */
export function visitorCancelTarget(input: { current?: Reservation; later?: Reservation }): VisitorCancelTarget | undefined {
  const later = input.later && isCancelableReservation(input.later) ? input.later : undefined;
  if (input.current && TOURING_NOW.includes(input.current.status) && later) {
    return { reservation: later, laterWhileTouring: true };
  }
  if (input.current && isCancelableReservation(input.current)) {
    return { reservation: input.current, laterWhileTouring: false };
  }
  if (later) return { reservation: later, laterWhileTouring: false };
  return undefined;
}
