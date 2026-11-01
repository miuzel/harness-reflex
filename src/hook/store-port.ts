/**
 * The storage contract one hook decision needs.
 *
 * `FileStateStore` implements it today, because the command-hook contract gives
 * each event its own process and that process has no memory to carry. An
 * *in-process* host (the DSH plugin, a pi extension, an opencode plugin) does
 * carry memory and must not pay for a file round trip per tool call, so the
 * orchestration in `decision.ts` is written against this interface instead of
 * against the file implementation directly.
 *
 * The interface is deliberately the same shape the file store already has: an
 * adapter over memory is a few dozen lines and behavioural parity is checkable
 * by running the same decision fixtures over both.
 *
 * @module hook/store-port
 */
import type {
  HookLedgerRecord,
  LockAttempt,
  RetentionResult,
  SessionEvent,
  SessionState
} from '../state/file-store.js';

/** Where a decision may persist its state. */
export interface HookStorePort {
  /** Tag recorded on every ledger line (`cc`, `dsh`, `pi`, …). */
  readonly harness: string;

  /** Ensure the session exists before the first decision. */
  ensureSession(sessionId: string, mode: string): void;

  /** Read the discardable turn/budget cache. */
  readState(sessionId: string): SessionState;

  /**
   * One locked read-modify-write of the state cache.
   *
   * An in-process implementation may resolve without a real lock: only one
   * decision per session runs at a time inside one process, and the host is
   * single-threaded between awaits.
   */
  updateState<T>(sessionId: string, mutate: (state: SessionState) => T): LockAttempt<T>;

  /** Append one observation. */
  appendEvent(sessionId: string, record: SessionEvent): void;

  /** Append one auditable decision or skip. */
  appendLedger(sessionId: string, record: HookLedgerRecord): void;

  /**
   * Read the newest observations of one session.
   *
   * **Oldest first.** The tail is read in file order, which is append order,
   * and it stays that way: `core/judge` counts trailing runs from the *end* of
   * the array, so handing it a newest-first array would make it count the
   * newest replay rather than the run that just happened. The previous version
   * of this comment said "newest first", which contradicted both
   * implementations and every `oldest first` contract in `core/judge`.
   * @param sessionId - the session.
   * @param limit - maximum observations to return.
   * @returns the last `limit` observations, oldest first.
   */
  readEvents(sessionId: string, limit: number): SessionEvent[];

  /** Whether an observation with this dedupe key was already appended. */
  eventsHaveKey(sessionId: string, key: string): boolean;

  /** Whether a ledger line with this dedupe key was already written. */
  ledgerHasKey(sessionId: string, key: string): boolean;

  /** The committed output of a previous delivery, if any. */
  readDecision(sessionId: string, key: string): Record<string, unknown> | undefined;

  /** Commit one decision's output so a redelivery replays it. */
  writeDecision(sessionId: string, key: string, output: Record<string, unknown>): void;

  /** Take (or discover) the exclusive claim on one decision key. */
  claimDecision(sessionId: string, key: string): LockAttempt<unknown>;

  /** Release the claim, whether or not this process won it. */
  releaseDecisionClaim(sessionId: string, key: string): void;

  /** Retain a pruned payload's original under its digest. */
  retainOriginal(sessionId: string, digest: string, text: string): RetentionResult;

  /** Read back a retained original, or `undefined` when it is gone. */
  readOriginal(sessionId: string, digest: string): string | undefined;

  /** Drop expired session directories, never the one named by `keep`. */
  gcSessions(retentionMs: number | undefined, keep: string): void;

  /** Enforce one session's retained-original cap. */
  gcOriginals(sessionId: string): string[];
}
