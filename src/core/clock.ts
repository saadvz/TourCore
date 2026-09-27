export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/**
 * Real time that can jump forward, for live visitor demos: minutes pass
 * normally, and "skip ahead to my tour" moves the clock without waiting.
 */
export class DemoClock implements Clock {
  private offsetMs = 0;
  constructor(private readonly realNow: () => number = () => Date.now()) {}
  now(): Date {
    return new Date(this.realNow() + this.offsetMs);
  }
  jumpTo(at: Date): void {
    this.offsetMs = Math.max(this.offsetMs, at.getTime() - this.realNow());
  }
}

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
