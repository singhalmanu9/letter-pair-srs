/** Tracks elapsed and remaining time for a single review prompt (seconds). */
export class ReviewTimer {
  constructor(
    readonly startedAt: number,
    readonly timeoutSeconds: number,
  ) {}

  get deadline(): number {
    return this.startedAt + this.timeoutSeconds;
  }

  elapsed(now: number): number {
    return Math.max(0, now - this.startedAt);
  }

  remaining(now: number): number {
    return Math.max(0, this.deadline - now);
  }

  isTimedOut(now: number): boolean {
    return now >= this.deadline;
  }
}
