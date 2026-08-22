/** Monotonic deadline context shared by every reviewer lifecycle phase. */

/**
 * Supplies one total deadline and bounded child phase deadlines.
 * @param now - monotonic clock in milliseconds.
 * @param totalMs - total lifetime budget.
 */
export class DeadlineContext {
  /** Monotonic timestamp at which this context was created. */
  readonly startTime: number
  /** Absolute monotonic timestamp at which the total budget expires. */
  readonly totalDeadline: number

  constructor(
    private readonly now: () => number,
    totalMs: number,
  ) {
    this.startTime = now()
    this.totalDeadline = this.startTime + totalMs
  }

  /**
   * Return the milliseconds remaining in the total budget.
   * @returns a non-negative remaining duration.
   */
  remaining(): number {
    return Math.max(0, this.totalDeadline - this.now())
  }

  /**
   * Derive a phase budget without extending the total deadline.
   * @param phaseMs - requested phase budget.
   * @returns the bounded phase duration.
   */
  phaseBudget(phaseMs: number): number {
    return Math.min(phaseMs, this.remaining())
  }

  /** Return whether the total deadline has elapsed.
   * @returns whether the total deadline has elapsed.
   */
  expired(): boolean {
    return this.remaining() <= 0
  }
}
