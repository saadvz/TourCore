export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Lets the demo and tests move through a tour day without waiting. */
export class SimulatedClock implements Clock {
  private current: Date;
  constructor(start: Date) {
    this.current = new Date(start);
  }
  now(): Date {
    return new Date(this.current);
  }
  set(at: Date): void {
    this.current = new Date(at);
  }
  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
}
