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

export function bookedTourCalledOffText(input: { team: string; day: string; time: string; address: string; propertyWide: boolean }): string {
  const lead = `Sorry, the ${input.team} had to cancel your ${input.day} at ${input.time} tour at ${input.address}.`;
  return input.propertyWide ? `${lead} They'll text you when tours are back.` : `${lead} Text me anytime to book another.`;
}

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
  const visitors = bookedCount === 1 ? "1 booked visitor" : `${bookedCount} booked visitors`;
  return `Remove ${property}? Tours stop, ${visitors} get a cancel text, and it leaves your list. Its records are kept. Remove it?`;
}

export const REMOVE_REFUSED_LIVE_TOUR = "Someone is on a tour right now. Try again after it ends.";
