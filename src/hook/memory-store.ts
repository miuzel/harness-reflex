/**
 * The in-process implementation of {@link HookStorePort}.
 *
 * A host that calls a decision *inside* its own loop (the DSH plugin, a pi
 * extension, an opencode plugin) must not pay a file round trip, a lock, and a
 * JSON re-read for every tool call. What it still needs is exactly the contract
 * `FileStateStore` already gives the command-hook: a turn counter, per-turn and
 * per-session budgets, an observation window, an idempotency marker per event,
 * and somewhere to put a retained original.
 *
 * This class provides all of that in memory with the same semantics. Where the
 * file store uses a directory lock to be safe across processes, this one counts
 * its update inside a single synchronous block, which is safe because the host
 * is single-threaded between awaits.
 *
 * @module hook/memory-store
 */
import type { HookStorePort } from './store-port.js';
import type {
  HookLedgerRecord,
  LockAttempt,
  RetentionResult,
  SessionEvent,
  SessionState
} from '../state/file-store.js';

/** Default retained-original allowance, matching the file store's 32 MiB. */
export const MEMORY_ORIGINAL_CAP = 32 * 1024 * 1024;

/** Everything one session keeps in memory. */
interface MemorySession {
  events: SessionEvent[];
  ledger: HookLedgerRecord[];
  decisions: Map<string, Record<string, unknown>>;
  claims: Set<string>;
  originals: Map<string, { text: string; at: number }>;
  state: SessionState;
}

/** A fresh state cache, identical in shape to the file store's `state.json`. */
function freshState(now: string): SessionState {
  return {
    version: 1,
    turnNo: 0,
    appliedSignatures: [],
    budgets: { interventions: 0, judgmentsTurn: 0, judgmentsSession: 0 },
    continues: {},
    updatedAt: now
  };
}

/** Options of {@link MemoryStateStore}. */
export interface MemoryStateStoreOptions {
  /** Ledger tag for this host (`dsh`, `pi`, `opencode`, …). */
  harness?: string;
  /** Clock seam; defaults to `Date.now`. */
  now?: () => number;
  /** Retained-original allowance in bytes. */
  maxOriginalBytes?: number;
  /** How many observations to keep per session; the window never needs more. */
  maxEvents?: number;
}

/** The in-memory {@link HookStorePort}. */
export class MemoryStateStore implements HookStorePort {
  readonly harness: string;
  readonly #now: () => number;
  readonly #maxOriginalBytes: number;
  readonly #maxEvents: number;
  readonly #sessions = new Map<string, MemorySession>();

  /**
   * @param options - harness tag, clock, and retention knobs.
   */
  constructor(options: MemoryStateStoreOptions = {}) {
    this.harness = options.harness ?? 'memory';
    this.#now = options.now ?? (() => Date.now());
    this.#maxOriginalBytes = options.maxOriginalBytes ?? MEMORY_ORIGINAL_CAP;
    this.#maxEvents = options.maxEvents ?? 512;
  }

  /** The session's in-memory record, created on first use. */
  #session(sessionId: string): MemorySession {
    let session = this.#sessions.get(sessionId);
    if (session === undefined) {
      session = {
        events: [],
        ledger: [],
        decisions: new Map(),
        claims: new Set(),
        originals: new Map(),
        state: freshState(new Date(this.#now()).toISOString())
      };
      this.#sessions.set(sessionId, session);
    }
    return session;
  }

  /** Ensure the session exists; the memory store has nothing else to prepare. */
  ensureSession(sessionId: string, _mode: string): void {
    this.#session(sessionId);
  }

  /** Read the volatile state cache. */
  readState(sessionId: string): SessionState {
    return { ...this.#session(sessionId).state };
  }

  /**
   * One read-modify-write of the state cache.
   *
   * The mutate callback runs inside this synchronous block, so two awaits
   * cannot interleave a check with an increment the way they could across two
   * processes.
   */
  updateState<T>(sessionId: string, mutate: (state: SessionState) => T): LockAttempt<T> {
    const session = this.#session(sessionId);
    const draft: SessionState = {
      ...session.state,
      budgets: { ...session.state.budgets },
      continues: { ...session.state.continues },
      appliedSignatures: [...session.state.appliedSignatures]
    };
    const value = mutate(draft);
    session.state = { ...draft, updatedAt: new Date(this.#now()).toISOString() };
    return { acquired: true, value };
  }

  /** Append one observation, trimmed to the retained window. */
  appendEvent(sessionId: string, record: SessionEvent): void {
    const session = this.#session(sessionId);
    session.events.push(record);
    if (session.events.length > this.#maxEvents) {
      session.events.splice(0, session.events.length - this.#maxEvents);
    }
  }

  /** Append one ledger line. */
  appendLedger(sessionId: string, record: HookLedgerRecord): void {
    this.#session(sessionId).ledger.push(record);
  }

  /** The newest `limit` observations, oldest first (see {@link HookStorePort}). */
  readEvents(sessionId: string, limit: number): SessionEvent[] {
    const events = this.#session(sessionId).events;
    return events.slice(Math.max(0, events.length - limit));
  }

  /** Whether this dedupe key already produced an observation. */
  eventsHaveKey(sessionId: string, key: string): boolean {
    return this.#session(sessionId).events.some((event) => event.dedupeKey === key);
  }

  /** Whether this dedupe key already produced a ledger line. */
  ledgerHasKey(sessionId: string, key: string): boolean {
    return this.#session(sessionId).ledger.some((record) => record.dedupeKey === key);
  }

  /** The committed output of a previous delivery. */
  readDecision(sessionId: string, key: string): Record<string, unknown> | undefined {
    return this.#session(sessionId).decisions.get(key);
  }

  /** Commit one decision's output. */
  writeDecision(sessionId: string, key: string, output: Record<string, unknown>): void {
    this.#session(sessionId).decisions.set(key, output);
  }

  /** Claim one decision key; a second delivery sees the existing claim. */
  claimDecision(sessionId: string, key: string): LockAttempt<unknown> {
    const claims = this.#session(sessionId).claims;
    if (claims.has(key)) return { acquired: false, reason: 'claim-held' };
    claims.add(key);
    return { acquired: true };
  }

  /** Release a claim, whether or not this caller took it. */
  releaseDecisionClaim(sessionId: string, key: string): void {
    this.#session(sessionId).claims.delete(key);
  }

  /** Retain a payload verbatim, evicting the oldest copy when the cap is hit. */
  retainOriginal(sessionId: string, digest: string, text: string): RetentionResult {
    const originals = this.#session(sessionId).originals;
    if (originals.has(digest)) return { retained: true, evicted: [] };
    const size = Buffer.byteLength(text, 'utf8');
    if (size > this.#maxOriginalBytes) return { retained: false, evicted: [], reason: 'retention-cap' };
    const total = (): number => [...originals.values()].reduce((sum, entry) => sum + Buffer.byteLength(entry.text, 'utf8'), 0);
    const evicted: string[] = [];
    while (originals.size > 0 && total() + size > this.#maxOriginalBytes) {
      const oldest = [...originals.entries()].sort((left, right) => left[1].at - right[1].at)[0];
      if (oldest === undefined) break;
      originals.delete(oldest[0]);
      evicted.push(oldest[0]);
    }
    if (total() + size > this.#maxOriginalBytes) return { retained: false, evicted, reason: 'retention-cap' };
    originals.set(digest, { text, at: this.#now() });
    return { retained: true, evicted };
  }

  /** Read a retained payload back. */
  readOriginal(sessionId: string, digest: string): string | undefined {
    return this.#session(sessionId).originals.get(digest)?.text;
  }

  /** Nothing expires in memory; the host owns its own lifetime. */
  gcSessions(_retentionMs: number | undefined, _keep: string): void {
    // The whole store lives and dies with the host process.
  }

  /** Nothing to trim: the cap is enforced when a payload is retained. */
  gcOriginals(_sessionId: string): string[] {
    return [];
  }

  /** Forget one session, used when the host reports it disposed. */
  forget(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }
}
