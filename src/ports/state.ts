/**
 * State-storage port.
 *
 * The core decisions are pure functions over an explicit state value; where that
 * value is persisted between calls is the host's business. A host that runs each
 * event in a fresh process writes through a file- or session-backed store; one
 * that keeps its decision runtime mounted can use an in-memory map. The
 * interface is the same so both see the same budget and dedupe semantics.
 *
 * @module ports/state
 */

/** The per-session counters a decision turn spends from. */
export interface BudgetSnapshot {
  /** Interventions planned or applied in the current turn. */
  interventions: number;
  /** System 1 judgments spent in the current turn. */
  judgmentsTurn: number;
  /** System 1 judgments spent in the current session. */
  judgmentsSession: number;
}

/** A keyed store of per-session state, including the turn/session budget. */
export interface StateStorePort<T> {
  /**
   * Read one key, without creating it.
   * @param key - session-scoped identity.
   * @returns the stored value, when one exists.
   */
  read(key: string): T | undefined;
  /**
   * Write one key.
   * @param key - session-scoped identity.
   * @param value - the value to retain.
   */
  write(key: string, value: T): void;
  /**
   * Drop one key.
   * @param key - session-scoped identity.
   * @returns whether a value was removed.
   */
  delete(key: string): boolean;
  /** Every key currently stored, for bounded-eviction housekeeping. */
  keys(): Iterable<string>;
}

/** The budget half of a session store, narrowed to what the policy spends. */
export interface BudgetStorePort extends StateStorePort<BudgetSnapshot> {}
