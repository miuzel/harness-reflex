/**
 * The clock the state store and the hook read.
 *
 * Tests need a clock that can be pinned; the design exposes
 * `HARNESS_REFLEX_CLOCK` for exactly that (design §3.4). Production reads the
 * wall clock. Nothing in the decision core reads a clock directly.
 *
 * @module state/clock
 */
/** A clock with both a millisecond reading and an ISO rendering. */
export interface HookClock {
  /** Current time in epoch milliseconds. */
  now(): number;
  /** Current time as an ISO-8601 string. */
  iso(): string;
}

/** The wall clock. */
export class SystemClock implements HookClock {
  now(): number {
    return Date.now();
  }

  iso(): string {
    return new Date(this.now()).toISOString();
  }
}

/** A clock pinned to one instant, for repeatable fixtures. */
export class FixedClock implements HookClock {
  readonly #ms: number;

  /**
   * @param ms - the instant every reading reports.
   */
  constructor(ms: number) {
    this.#ms = ms;
  }

  now(): number {
    return this.#ms;
  }

  iso(): string {
    return new Date(this.#ms).toISOString();
  }
}

/**
 * Resolve the clock from the environment.
 *
 * `HARNESS_REFLEX_CLOCK` is an ISO timestamp; an unparseable value is ignored
 * rather than failing the hook (the wall clock is always a safe fallback).
 * @param env - environment to read.
 * @returns the pinned clock, or the wall clock.
 */
export function clockFromEnv(env: NodeJS.ProcessEnv = process.env): HookClock {
  const raw = env.HARNESS_REFLEX_CLOCK?.trim();
  if (raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return new FixedClock(ms);
  }
  return new SystemClock();
}
