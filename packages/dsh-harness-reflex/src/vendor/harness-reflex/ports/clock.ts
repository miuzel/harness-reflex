/**
 * Clock port.
 *
 * The decision core never reads the wall clock itself: latency accounting is a
 * pure function of two readings, so a test (or a replay) supplies its own
 * readings and the reported costs stay reproducible.
 *
 * @module ports/clock
 */

/** A monotonic-enough source of milliseconds for latency accounting. */
export interface ClockPort {
  /** Current time in milliseconds. */
  now(): number;
}
