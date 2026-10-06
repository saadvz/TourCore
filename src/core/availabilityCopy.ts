import { formatPhone } from "./phone";

/**
 * Critiquito-approved visitor and operator copy for pausing or removing
 * tours. Placeholders are filled here; callers never rewrite the sentences.
 */

export function pausedPropertyVisitorText(address: string, team: string, visitorContact?: string): string {
  if (visitorContact) {
    return `Tours at ${address} are paused right now. The ${team} will text you when they're back, or call ${formatPhone(visitorContact)}.`;
  }
  return `Tours at ${address} are paused right now. The ${team} will text you when they're back.`;
}

export function pausedUnitVisitorText(unitName: string): string {
  return `${unitName} isn't open for tours right now.`;
}

/** Mid-tour cancel of a later booking. One place so wording is a one-line change. */
export function laterTourCalledOffWhileTouringLead(team: string, time: string, day: string): string {
  return `Sorry, the ${team} had to cancel your later tour at ${time} on ${day}. Your tour right now isn't affected.`;
}

export function bookedTourCalledOffText(input: {
  team: string;
  day: string;
  time: string;
  address: string;
  propertyWide: boolean;
  removed?: boolean;
  /** Visitor is on a tour right now; this cancel is a later / held booking. */
  touringNow?: boolean;
}): string {
  const lead = input.touringNow
    ? laterTourCalledOffWhileTouringLead(input.team, input.time, input.day)
    : `Sorry, the ${input.team} had to cancel your ${input.day} at ${input.time} tour at ${input.address}.`;
  if (input.removed) return `${lead} ${input.address} isn't offering tours anymore.`;
  return input.propertyWide ? `${lead} They'll text you when tours are back.` : `${lead} Text me anytime to book another.`;
}

/** Operator refuse when reschedule_tour targets a tour in progress and nothing later is held. */
export function tourInProgressCannotMove(who: string): string {
  return `${who} is touring right now, so I can't move this tour. Once it ends, you can book them another time.`;
}

/** Offer to move the later booking instead of the tour in progress. Time first; destination named. */
export function moveLaterBookingInstead(who: string, oldTime: string, oldDay: string, newTime: string, newDay: string): string {
  return `${who} is touring right now, so I can't move this tour. Want me to move their ${oldTime} on ${oldDay} booking to ${newTime} on ${newDay} instead?`;
}

/** Mid-tour later offer when the destination is outside tour hours. Fingerprint already includes outside; a plain yes is enough. */
export function moveLaterBookingOutsideHours(who: string, oldTime: string, oldDay: string, newTime: string, newDay: string): string {
  return `${who} is touring right now, so I can't move this tour. Their later booking is ${oldTime} on ${oldDay}, and ${newTime} on ${newDay} is outside your tour hours. Want me to move it there anyway?`;
}

/** Operator summary after a yes on that later-booking offer. */
export function movedLaterBookingSummary(who: string, time: string, day: string): string {
  return `Moved ${who}'s later booking to ${time} on ${day}.`;
}

/** Visitor text after an operator-directed move. Keep whatever follows this sentence unchanged. */
export function tourMovedToText(unit: string, time: string, day: string): string {
  return `Your tour of ${unit} has been moved to ${time} on ${day}.`;
}

/** Mid-tour visitor cancel of a later booking. Do not reuse the normal cancel lines. */
export function laterCancelConfirm(time: string, day: string): string {
  return `Cancel your later tour at ${time} on ${day}? Your tour right now isn't affected. Reply YES or NO.`;
}

export function laterCancelDone(time: string, day: string): string {
  return `Done, I've cancelled your later tour at ${time} on ${day}. Your tour right now isn't affected.`;
}

export function laterCancelKept(time: string, day: string): string {
  return `Okay, your later tour at ${time} on ${day} stays booked.`;
}

/** Extra sentence on hold / door-system problem. `{team}` is the pause-cancel team label. */
function runningProblemNote(team?: string): string {
  return team ? ` The ${team} is still working on the problem and will text you here.` : "";
}

/** Visitor named the running tour while a later booking is held. YES/NO still use laterCancelDone / laterCancelKept. */
export function cannotCancelRunningOfferLater(time: string, day: string, team?: string): string {
  return `You can't cancel the tour you're on, but you're free to wrap up whenever you like.${runningProblemNote(team)} Your later tour at ${time} on ${day} is still booked. Want me to cancel that one instead? Reply YES or NO.`;
}

/** Touring visitor with no later booking. Nothing is cancelled; doors keep working. */
export function cannotCancelRunningTour(team?: string): string {
  return `You can't cancel the tour you're on, but you're free to wrap up whenever you like.${runningProblemNote(team)} Text me anytime if you want to book another tour.`;
}

/** Call-off confirm. Optional when-clause is time first: "at {time} on {day}". */
export function revokeConfirmQuestion(who: string, unit: string, when?: { time: string; day: string }): string {
  const named = when ? ` at ${when.time} on ${when.day}` : "";
  return `Call off ${who}'s tour of ${unit}${named}? All their access will be switched off and they'll be told. This can't be undone.`;
}

/** Operator-facing refuse when approving or moving a time on a paused property. */
export function pausedPropertyOperatorRefuse(property: string): string {
  return `Tours at ${property} are paused. Resume them first.`;
}

/** Operator-facing refuse when approving or moving a time on a paused unit. */
export function pausedUnitOperatorRefuse(unit: string): string {
  return `Tours of ${unit} are paused. Resume them first.`;
}

export const PROPERTY_REMOVED_REFUSE = "That property has been removed.";

export function pauseConfirmQuestion(property: string, bookedCount: number): string {
  if (bookedCount === 0) {
    return `Pause tours at ${property}? New bookings stop now. Any tour in progress will finish. Pause it?`;
  }
  const tours = bookedCount === 1 ? "1 booked tour" : `${bookedCount} booked tours`;
  return `Pause tours at ${property}? New bookings stop now. ${tours}: keep them or cancel them with a text? Any tour in progress will finish.`;
}

export function toursAreBackText(address: string): string {
  return `Tours at ${address} are back. Text me anytime to book.`;
}

export function removedPropertyVisitorText(address: string, visitorContact?: string): string {
  const line = `${address} isn't offering tours anymore.`;
  return visitorContact ? `${line} Questions? Call ${formatPhone(visitorContact)}.` : line;
}

export function resumeConfirmQuestion(property: string, waitingCount = 0): string {
  if (waitingCount <= 0) {
    return `Resume tours at ${property}? New bookings can start again. Resume it?`;
  }
  const waiting =
    waitingCount === 1
      ? "1 person waiting gets a text that tours are back"
      : `${waitingCount} people waiting get a text that tours are back`;
  return `Resume tours at ${property}? New bookings can start again, and ${waiting}. Resume it?`;
}

export function removeConfirmQuestion(property: string, bookedCount: number): string {
  if (bookedCount === 0) {
    return `Remove ${property}? Tours stop. No one is booked, so no cancel texts go out. It leaves your list. Its records are kept. Remove it?`;
  }
  const visitors = bookedCount === 1 ? "1 booked visitor gets a cancel text" : `${bookedCount} booked visitors get a cancel text`;
  return `Remove ${property}? Tours stop, ${visitors}, and it leaves your list. Its records are kept. Remove it?`;
}

export function removeSetupConfirmQuestion(name: string): string {
  return `Remove the setup for ${name}? It isn't published yet, so no visitors are affected, but everything entered for it will be deleted for good.`;
}

export function removedSetupSummary(name: string): string {
  return `Removed the setup for ${name}.`;
}

export function removedPropertySummary(name: string): string {
  return `${name} has been removed. Its records are kept.`;
}

export const REMOVE_REFUSED_LIVE_TOUR = "Someone is on a tour right now. Try again after it ends.";
