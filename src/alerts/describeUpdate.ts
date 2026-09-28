import { addDays, formatDay, formatTime, localDateOf } from "../core/timezone";
import { UNNAMED_VISITOR } from "../domain/model";
import { inspectException } from "../operator/exceptions";
import type { OperatorServices } from "../operator/services";
import { currentReservation, findTour, tourSummary, unitNameOf, type TourSnapshot } from "../operator/tours";
import { SetupInputError } from "../setup/setupActions";
import { isIssueEvent, type OperatorEvent } from "./operatorEvents";

/**
 * What an operator update says, read from the canonical records when Grok
 * asks (the webhook itself carries no names). The sentence is Tour Core's,
 * so the landlord hears the same facts however the update reached them.
 */

function firstName(tour: TourSnapshot): string {
  const r = currentReservation(tour);
  const name = (tour.bundle.prospects.find((p) => p.id === r?.prospectId) ?? tour.bundle.prospects[0])?.name;
  return name && name !== UNNAMED_VISITOR ? name.trim().split(/\s+/)[0]! : "A visitor";
}

/** "today at 3:00 PM", "tomorrow at 10:00 AM", "on Wednesday, Sep 30 at 2:00 PM" */
function when(start: Date, now: Date, tz: string): string {
  const day = localDateOf(start, tz);
  const today = localDateOf(now, tz);
  const same = (a: typeof day, b: typeof day) => a.year === b.year && a.month === b.month && a.day === b.day;
  const label = same(day, today) ? "today" : same(day, addDays(today, 1)) ? "tomorrow" : `on ${formatDay(start, tz)}`;
  return `${label} at ${formatTime(start, tz)}`;
}

export async function describeOperatorUpdate(services: OperatorServices, event: OperatorEvent, now: Date) {
  if (event.eventType === "installation.test") {
    return { eventType: event.eventType, summary: "Tour updates are connected. I'll let you know about your tours here." };
  }
  if (isIssueEvent(event.eventType)) {
    if (!event.exceptionId) throw new SetupInputError("UPDATE_INCOMPLETE", "That update doesn't point at an issue.");
    const x = await inspectException(services, event.exceptionId);
    const who = x.visitorName.startsWith("A visitor") ? x.visitorName : x.visitorName.split(/\s+/)[0];
    return {
      eventType: event.eventType,
      stillOpen: x.status === "open",
      summary: `${who}${x.unitName ? `, ${x.unitName}` : ""}: ${x.summary} ${x.tourStatus}.`,
      issue: { exceptionId: x.exceptionId, what: x.title, question: x.question, tourStatus: x.tourStatus, nextSteps: x.nextSteps, tourRef: x.tourRef },
      instructions:
        x.kind === "unanswered-question"
          ? "Ask the operator for the answer itself (not a yes/no). When they give it, use answer_flagged_question; its question is the only confirmation."
          : "Tell the operator what happened. Change nothing unless they ask, through the Work Exception skill.",
    };
  }
  if (!event.tourId) throw new SetupInputError("UPDATE_INCOMPLETE", "That update doesn't point at a tour.");
  const tour = await findTour(services, event.tourId);
  const r = currentReservation(tour);
  const who = firstName(tour);
  const unit = unitNameOf(tour) ?? "their unit";
  const tz = tour.config.property.timezone;
  const slot = r?.slotStart ? when(new Date(r.slotStart), now, tz) : undefined;
  const summary = {
    "tour.booked": `New tour booked: ${who} is scheduled to tour ${unit}${slot ? ` ${slot}` : ""}.`,
    "tour.started": `${who}'s ${unit} tour has started.`,
    "tour.completed": `${who}'s ${unit} tour is complete.`,
    "tour.cancelled": `${who}'s ${unit} tour${slot ? ` ${slot}` : ""} was cancelled.`,
  }[event.eventType];
  return { eventType: event.eventType, summary, tour: tourSummary(tour), instructions: "Post summary as-is in your own short words. Don't act on the tour." };
}
