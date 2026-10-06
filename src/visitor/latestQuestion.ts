import type { StepAwaiting, TourIntent } from "../intent";

/** A bare YES/NO answers this question, not an older consent or cancel confirm. */
export function awaitingLatestYesNo(awaiting?: StepAwaiting): boolean {
  return (
    !!awaiting &&
    (awaiting.kind === "confirm-stop" ||
      awaiting.kind === "confirm-arrival" ||
      awaiting.kind === "confirm-finish" ||
      awaiting.kind === "choose-stop" ||
      awaiting.kind === "confirm-cancel-tour")
  );
}

/** A door or finish ask while a cancel confirm is open becomes the latest question. */
export function doorAskSupersedesCancel(intent: TourIntent): boolean {
  return intent.type === "AT_UNIT" || intent.type === "AT_ROUTE_STOP" || intent.type === "ARRIVAL" || intent.type === "FINISH_TOUR";
}
