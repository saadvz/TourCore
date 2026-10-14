export interface TurnoverWindow {
  checkout: string;
  nextArrival: string;
}

/**
 * Same-day gap between one stay's checkout and the next stay's check-in.
 * Guesty Lite publishes that gap as an iCal feed. This reads the feed text.
 * It does not call the Guesty API.
 */
export function turnoverFromIcal(_ical: string, _timeZone: string, _now: Date): TurnoverWindow | undefined {
  throw new Error("not implemented");
}
