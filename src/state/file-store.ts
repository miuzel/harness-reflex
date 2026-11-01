/**
 * The file-backed session state of the command-hook process.
 *
 * The contract this module implements is design §3: append-only JSONL is the
 * authority, `state.json` is a discardable cache, the lock is an atomic `mkdir`
 * with a five-second staleness rule, and nothing here may block a tool call.
 * When a lock cannot be taken the caller is told so; when a cache file is
 * corrupt it is deleted and rebuilt; when one JSONL line is unreadable it is
 * isolated and the rest of the file is still read.
 *
 * Concurrency assumptions, stated explicitly because they are the whole point:
 * - `events.jsonl` / `ledger.jsonl` lines are each appended with a single write
 *   syscall to an `O_APPEND` file descriptor, so interleaving is impossible and
 *   a reader never triggers a second write per line.
 * - `state.json` and decision caches are written to a temporary file, fsynced,
 *   and renamed into place, so a reader sees the old file or the new one.
 * - A directory (not a file) is the lock: `mkdir` is atomic on every POSIX
 *   filesystem the design targets.
 *
 * @module state/file-store
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HookClock } from './clock.js';
import { SystemClock } from './clock.js';
import { DEFAULT_HARNESS, resolveStateRoot, sessionDirName, sessionHash } from './paths.js';

/** Longest JSONL line this store will append, in bytes (design §3.3). */
export const MAX_JSONL_LINE_BYTES = 4 * 1024;
/** Bad lines read from one file before the file is treated as unusable. */
export const MAX_BAD_LINES = 5;
/** Default lifetime of a session directory, seven days. */
export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Default cap on one session's retained originals: 32 MiB. */
export const MAX_ORIGINAL_BYTES = 32 * 1024 * 1024;
/** Default staleness of a `lock/` directory before it may be taken over. */
export const LOCK_STALE_MS = 5 * 1000;
/** Version recorded in `meta.json`; kept in step with package.json by hand. */
export const HARNESS_STATE_VERSION = '0.1.0-alpha.2';
/** Tail window for reads, so a large log is never loaded whole. */
export const READ_TAIL_BYTES = 256 * 1024;

/** One session's identity, as stored in `meta.json`. */
export interface SessionMeta {
  harness: string;
  /** Plaintext session id; the directory name only carries its hash. */
  sessionId: string;
  createdAt: string;
  harnessVersion: string;
  mode: string;
}

/** The per-turn counters a decision turn spends from. */
export interface SessionBudget {
  interventions: number;
  judgmentsTurn: number;
  judgmentsSession: number;
}

/** The derived cache in `state.json`; never authoritative. */
export interface SessionState {
  version: 1;
  turnNo: number;
  appliedSignatures: string[];
  budgets: SessionBudget;
  continues: Record<string, number>;
  updatedAt: string;
}

/** One line of `events.jsonl`: a tool observation, append-only. */
export interface SessionEvent {
  v: 1;
  kind: 'pre' | 'post' | 'failure' | 'stop' | 'session';
  at: number;
  atIso: string;
  turnNo: number;
  tool?: string;
  toolUseId?: string;
  signature?: string;
  failed?: boolean;
  /** Bounded model-facing text of the result, for later evidence assembly. */
  output?: string;
  source?: string;
  /** Present when the observation is also the idempotency commit of a decision. */
  dedupeKey?: string;
}

/** The ledger vocabulary of the hook surface. */
export type HookLedgerType = 'stagnation' | 'prune' | 'gate' | 'closing' | 'noop' | 'error';

/** One line of `ledger.jsonl`: an auditable decision or skip. */
export interface HookLedgerRecord {
  id: string;
  timestamp: string;
  type: HookLedgerType;
  harness: string;
  event: string;
  backend: string;
  latencyMs: number;
  dedupeKey: string;
  turnNo: number;
  shadow?: boolean;
  applied?: boolean;
  judged?: boolean;
  tokensSaved?: number;
  originalTokens?: number;
  prunedTokens?: number;
  passed?: boolean;
  isStuck?: boolean;
  skipReason?: string;
  retention?: 'retained' | 'evicted' | 'none';
  details?: Record<string, unknown>;
}

/** The paths of one ensured session. */
export interface SessionPaths {
  dir: string;
  meta: string;
  state: string;
  events: string;
  ledger: string;
  originals: string;
  decisions: string;
  lock: string;
}

/** What one retention attempt produced. */
export interface RetentionResult {
  retained: boolean;
  /** Digest names of older originals evicted to make room. */
  evicted: string[];
  /** Why the new payload was not retained, when it was not. */
  reason?: string;
}

/** Options of {@link FileStateStore}. */
export interface FileStateStoreOptions {
  /** State root; defaults to {@link resolveStateRoot}. */
  root?: string;
  /** Harness tag; defaults to `cc`. */
  harness?: string;
  /** Clock used for timestamps and staleness. */
  clock?: HookClock;
  /** Lock takeover age, default five seconds. */
  lockStaleMs?: number;
  /** Session directory lifetime, default seven days. */
  sessionRetentionMs?: number;
  /** Retained-original cap, default 32 MiB. */
  maxOriginalBytes?: number;
}

/** The value returned by a lock attempt. */
export interface LockAttempt<T> {
  acquired: boolean;
  value?: T;
  reason?: string;
}

/** A record with the fields the store validates before appending. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a pid still exists (EPERM means it exists but is not ours). */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Random suffix for temporary and tombstone names. */
function randomSuffix(): string {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The file-backed implementation of the hook's external state.
 *
 * Every mutating operation is either an append (safe for concurrent writers) or
 * guarded by the directory lock. Readers never throw on corrupt data: they
 * isolate, rebuild, or return an empty view, because a hook that throws is a
 * hook that might be misread as a decision.
 */
export class FileStateStore {
  readonly root: string;
  readonly harness: string;
  readonly clock: HookClock;
  readonly lockStaleMs: number;
  readonly sessionRetentionMs: number;
  readonly maxOriginalBytes: number;

  /**
   * @param options - root, harness, clock, and the retention/lock knobs.
   */
  constructor(options: FileStateStoreOptions = {}) {
    this.root = options.root ?? resolveStateRoot();
    this.harness = options.harness ?? DEFAULT_HARNESS;
    this.clock = options.clock ?? new SystemClock();
    this.lockStaleMs = options.lockStaleMs ?? LOCK_STALE_MS;
    this.sessionRetentionMs = options.sessionRetentionMs ?? SESSION_RETENTION_MS;
    this.maxOriginalBytes = options.maxOriginalBytes ?? MAX_ORIGINAL_BYTES;
  }

  /** The directory all session directories live in. */
  sessionsRoot(): string {
    return path.join(this.root, 'sessions');
  }

  /** The directory quarantined sessions are moved into. */
  orphansRoot(): string {
    return path.join(this.root, 'orphans');
  }

  /** The directory of one session (`<root>/sessions/cc-<sha16>`). */
  sessionDir(sessionId: string): string {
    return path.join(this.sessionsRoot(), sessionDirName(this.harness, sessionId));
  }

  /** The paths of one session without creating anything. */
  sessionPaths(sessionId: string): SessionPaths {
    const dir = this.sessionDir(sessionId);
    return {
      dir,
      meta: path.join(dir, 'meta.json'),
      state: path.join(dir, 'state.json'),
      events: path.join(dir, 'events.jsonl'),
      ledger: path.join(dir, 'ledger.jsonl'),
      originals: path.join(dir, 'originals'),
      decisions: path.join(dir, 'decisions'),
      lock: path.join(dir, 'lock')
    };
  }

  /**
   * Create the session directory and its metadata if they are missing.
   *
   * A directory whose `meta.json` does not hash back to its own name is
   * quarantined under `orphans/` rather than trusted (design §3.2/§3.4).
   * @param sessionId - the host's session id.
   * @param mode - the effective three-state mode, for `meta.json`.
   * @returns the ensured session paths.
   */
  ensureSession(sessionId: string, mode: string): SessionPaths {
    const paths = this.sessionPaths(sessionId);
    this.ensureDir(this.root);
    this.ensureDir(this.sessionsRoot());
    const expectedHash = sessionHash(this.harness, sessionId);
    let exists = false;
    try {
      exists = fs.statSync(paths.dir).isDirectory();
    } catch {
      exists = false;
    }
    if (exists) {
      const meta = this.readMeta(paths.meta);
      if (meta !== undefined && sessionHash(this.harness, meta.sessionId) !== expectedHash) {
        // A directory that hashes somewhere else is genuinely not this session.
        this.quarantine(paths.dir);
        exists = false;
      }
      // A missing or unreadable meta is the ordinary creation race: several
      // processes can see a new directory before the first one has renamed its
      // meta into place, and an interrupted writer can leave a bad one. The
      // directory's name already carries the session hash, so the safe repair is
      // to adopt it and rewrite the meta atomically — never to quarantine a
      // directory another process is actively appending to.
    }
    if (!exists) this.ensureDir(paths.dir);
    const meta: SessionMeta = {
      harness: this.harness,
      sessionId,
      createdAt: this.clock.iso(),
      harnessVersion: HARNESS_STATE_VERSION,
      mode
    };
    if (this.readMeta(paths.meta) === undefined) {
      // Temp + rename, never a half-written meta for another process to read.
      this.writeAtomic(paths.meta, `${JSON.stringify(meta)}\n`);
    }
    this.ensureDir(paths.originals);
    this.ensureDir(paths.decisions);
    for (const file of [paths.events, paths.ledger]) this.ensureFile(file);
    return paths;
  }

  /**
   * Append one observation to `events.jsonl`.
   * @param sessionId - the session.
   * @param record - the event line.
   */
  appendEvent(sessionId: string, record: SessionEvent): void {
    this.appendLine(this.sessionPaths(sessionId).events, record);
  }

  /**
   * Append one decision or skip to `ledger.jsonl`.
   *
   * A record is bounded before it is written: an oversized details object is
   * dropped rather than split, so a line is always one atomic write.
   * @param sessionId - the session.
   * @param record - the ledger line.
   */
  appendLedger(sessionId: string, record: HookLedgerRecord): void {
    this.appendLine(this.sessionPaths(sessionId).ledger, this.bounded(record));
  }

  /**
   * Read the newest events of one session, oldest first.
   * @param sessionId - the session.
   * @param limit - maximum events to return.
   * @returns parseable events, newest tail only.
   */
  readEvents(sessionId: string, limit = 60): SessionEvent[] {
    const paths = this.sessionPaths(sessionId);
    const records = this.readTail(paths, paths.events, limit);
    return records.filter((record): record is SessionEvent => isObject(record) && typeof record.kind === 'string');
  }

  /**
   * Read the newest ledger lines of one session, oldest first.
   * @param sessionId - the session.
   * @param limit - maximum lines to return.
   * @returns parseable ledger records.
   */
  readLedger(sessionId: string, limit = 60): HookLedgerRecord[] {
    const paths = this.sessionPaths(sessionId);
    const records = this.readTail(paths, paths.ledger, limit);
    return records.filter((record): record is HookLedgerRecord => isObject(record) && typeof record.type === 'string');
  }

  /**
   * Read the cached state, rebuilding it from the logs when it is missing or
   * corrupt. Never throws.
   * @param sessionId - the session.
   * @returns the derived state (a fresh one when nothing could be read).
   */
  readState(sessionId: string): SessionState {
    const paths = this.sessionPaths(sessionId);
    try {
      const parsed = JSON.parse(fs.readFileSync(paths.state, 'utf8')) as unknown;
      const state = this.normalizeState(parsed);
      if (state) return state;
    } catch {
      // missing or truncated: fall through to a rebuild
    }
    this.safeUnlink(paths.state);
    const rebuilt = this.rebuildState(sessionId);
    this.writeState(paths, rebuilt);
    return rebuilt;
  }

  /**
   * Run one read-modify-write of `state.json` under the directory lock.
   *
   * A caller that does not get the lock must skip its turn, not queue: a tool
   * call is never worth blocking (design §3.3).
   * @param sessionId - the session.
   * @param mutate - pure update of the state in place.
   * @returns whether the lock was acquired, plus the callback's value.
   */
  updateState<T>(sessionId: string, mutate: (state: SessionState) => T): LockAttempt<T> {
    const paths = this.sessionPaths(sessionId);
    const lock = this.acquireLock(paths);
    if (!lock.acquired) return { acquired: false, reason: lock.reason };
    try {
      const state = this.readState(sessionId);
      const value = mutate(state);
      state.updatedAt = this.clock.iso();
      this.writeState(paths, state);
      return { acquired: true, value };
    } finally {
      lock.release?.();
    }
  }

  /**
   * Whether a dedupe key was already accounted for in the ledger.
   *
   * Only the tail is scanned: a hook is never asked about an ancient call, and
   * an unbounded scan would turn a fast command into a slow one. Error records
   * do not count — a duplicate delivery after a transient failure is allowed to
   * decide again.
   * @param sessionId - the session.
   * @param key - the dedupe key.
   * @param limit - how many trailing ledger lines to inspect.
   * @returns whether a non-error record already carries this key.
   */
  ledgerHasKey(sessionId: string, key: string, limit = 512): boolean {
    return this.readLedger(sessionId, limit).some((record) => record.dedupeKey === key && record.type !== 'error');
  }

  /**
   * Whether a dedupe key was already written to the event log.
   *
   * This is the crash window after the observation was appended and before the
   * ledger line was: the retry must not append the observation twice.
   * @param sessionId - the session.
   * @param key - the dedupe key.
   * @param limit - how many trailing events to inspect.
   * @returns whether the event log already carries this key.
   */
  eventsHaveKey(sessionId: string, key: string, limit = 512): boolean {
    return this.readEvents(sessionId, limit).some((record) => record.dedupeKey === key);
  }

  /**
   * Read one cached decision output.
   * @param sessionId - the session.
   * @param key - the dedupe key.
   * @returns the cached output, or `undefined` when absent/corrupt.
   */
  readDecision(sessionId: string, key: string): Record<string, unknown> | undefined {
    const file = path.join(this.sessionPaths(sessionId).decisions, `${key}.json`);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      return isObject(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Commit one decision output atomically.
   *
   * The decision cache doubles as the idempotency marker: a duplicate delivery
   * of the same dedupe key replays this object instead of deciding again.
   * @param sessionId - the session.
   * @param key - the dedupe key.
   * @param output - the exact stdout object of the command.
   */
  writeDecision(sessionId: string, key: string, output: Record<string, unknown>): void {
    const paths = this.sessionPaths(sessionId);
    this.ensureDir(paths.decisions);
    this.writeAtomic(path.join(paths.decisions, `${key}.json`), JSON.stringify(output));
  }

  /**
   * Claim the right to decide one dedupe key before the expensive path runs.
   *
   * The decision cache is the commit, but it can only be written after the
   * judgment. Two processes delivering the same `tool_use_id` concurrently would
   * both decide in that window; this exclusive-create claim makes the loser an
   * explicit no-op (or a replay, when the winner has already committed). A claim
   * older than `staleMs` is taken over, so a crashed process cannot wedge a key
   * forever.
   * @param sessionId - the session.
   * @param key - the dedupe key.
   * @param staleMs - age after which a claim is considered abandoned.
   * @returns whether this process may decide the key.
   */
  claimDecision(sessionId: string, key: string, staleMs = 10_000): { acquired: boolean } {
    const paths = this.sessionPaths(sessionId);
    this.ensureDir(paths.decisions);
    const file = path.join(paths.decisions, `${key}.claim`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedMs: this.clock.now() }), {
          flag: 'wx',
          mode: 0o600
        });
        return { acquired: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { acquired: false };
        let startedMs = this.clock.now();
        let ownerAlive = true;
        try {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
          if (isObject(parsed)) {
            if (typeof parsed.startedMs === 'number') startedMs = parsed.startedMs;
            if (typeof parsed.pid === 'number') ownerAlive = isProcessAlive(parsed.pid);
          }
        } catch {
          // unreadable claim: its mtime is the best age estimate
          try {
            startedMs = fs.statSync(file).mtimeMs;
          } catch {
            continue;
          }
        }
        // A dead owner's claim is recoverable at once: that is what makes a
        // `kill -9` followed by an immediate replay decide rather than no-op.
        if (ownerAlive && this.clock.now() - startedMs <= staleMs) return { acquired: false };
        const tombstone = `${file}.stale-${randomSuffix()}`;
        try {
          fs.renameSync(file, tombstone);
          fs.rmSync(tombstone, { force: true });
        } catch {
          return { acquired: false };
        }
      }
    }
    return { acquired: false };
  }

  /** Release a claim; never throws. */
  releaseDecisionClaim(sessionId: string, key: string): void {
    this.safeUnlink(path.join(this.sessionPaths(sessionId).decisions, `${key}.claim`));
  }

  /**
   * Retain one pre-prune payload, evicting the oldest copies when the cap is
   * exceeded.
   *
   * The cap applies to the whole `originals/` directory of one session. Evicted
   * names are returned so the caller can record the downgrade; when the new
   * payload itself cannot fit the result is `retained: false` and the caller must
   * install the reduction without a locator and without counting a saving.
   * @param sessionId - the session.
   * @param digest - content digest (the file stem).
   * @param text - the payload, verbatim.
   * @returns what happened.
   */
  retainOriginal(sessionId: string, digest: string, text: string): RetentionResult {
    const paths = this.sessionPaths(sessionId);
    this.ensureDir(paths.originals);
    const target = path.join(paths.originals, `${digest}.txt`);
    if (fs.existsSync(target)) return { retained: true, evicted: [] };
    const size = Buffer.byteLength(text, 'utf8');
    // A payload larger than the whole allowance can never fit; evicting older
    // copies for it would only destroy data, so it is refused before any eviction.
    if (size > this.maxOriginalBytes) return { retained: false, evicted: [], reason: 'retention-cap' };
    const entries = this.originalEntries(paths.originals);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const evicted: string[] = [];
    if (total + size > this.maxOriginalBytes) {
      for (const entry of entries) {
        if (total + size <= this.maxOriginalBytes) break;
        try {
          fs.unlinkSync(path.join(paths.originals, entry.name));
          total -= entry.size;
          evicted.push(entry.name.replace(/\.txt$/, ''));
        } catch {
          // A concurrent eviction took it first; the accounting stays honest.
        }
      }
    }
    if (total + size > this.maxOriginalBytes) {
      return { retained: false, evicted, reason: 'retention-cap' };
    }
    try {
      fs.writeFileSync(target, text, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { retained: false, evicted, reason: 'retention-failed' };
      }
    }
    return { retained: true, evicted };
  }

  /**
   * Read one retained payload back.
   *
   * The locator a pruned result carries names this record; reading it is what
   * makes the reduction reversible, so a missing or unreadable file answers
   * `undefined` instead of throwing into a decision path.
   * @param sessionId - the session.
   * @param digest - content digest (the file stem).
   * @returns the verbatim payload, or `undefined`.
   */
  readOriginal(sessionId: string, digest: string): string | undefined {
    try {
      const paths = this.sessionPaths(sessionId);
      if (!/^[0-9a-f]{8,64}$/.test(digest)) return undefined;
      return fs.readFileSync(path.join(paths.originals, `${digest}.txt`), 'utf8');
    } catch {
      return undefined;
    }
  }

  /** Enforce one session's original cap without retaining anything new. */
  gcOriginals(sessionId: string): string[] {
    const paths = this.sessionPaths(sessionId);
    let entries: Array<{ name: string; size: number; mtimeMs: number }>;
    try {
      entries = this.originalEntries(paths.originals);
    } catch {
      return [];
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const evicted: string[] = [];
    for (const entry of entries) {
      if (total <= this.maxOriginalBytes) break;
      try {
        fs.unlinkSync(path.join(paths.originals, entry.name));
        total -= entry.size;
        evicted.push(entry.name.replace(/\.txt$/, ''));
      } catch {
        // best effort
      }
    }
    return evicted;
  }

  /**
   * Remove session directories older than the retention window.
   * @param nowMs - clock reading to compare against (defaults to the store clock).
   * @param keepSessionId - a session that must survive even if its mtime looks
   *   old (a pinned test clock must never garbage-collect the turn being served).
   * @returns the removed directory names.
   */
  gcSessions(nowMs?: number, keepSessionId?: string): string[] {
    const now = nowMs ?? this.clock.now();
    const keep = keepSessionId === undefined ? undefined : path.basename(this.sessionDir(keepSessionId));
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.sessionsRoot(), { withFileTypes: true });
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === keep) continue;
      const dir = path.join(this.sessionsRoot(), entry.name);
      const mtime = this.latestMtime(dir);
      if (now - mtime <= this.sessionRetentionMs) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(entry.name);
      } catch {
        // best effort: a concurrently opened session is left for the next gc
      }
    }
    return removed;
  }

  /** The quarantine log path for a session, created on demand. */
  corruptLog(sessionId: string): string {
    return path.join(this.sessionPaths(sessionId).dir, `corrupt-${this.clock.now()}.log`);
  }

  // ---------------------------------------------------------------- internals

  /** Create one directory with user-only permissions, best effort. */
  private ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Existing ownership/permissions outside our control; keep going.
    }
  }

  /** Create an empty file with 0600 if it does not exist yet. */
  private ensureFile(file: string): void {
    if (fs.existsSync(file)) return;
    try {
      fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  /** Single-write append of one JSON line. */
  private appendLine(file: string, record: unknown): void {
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_JSONL_LINE_BYTES) {
      throw new Error(`refusing to append a ${Buffer.byteLength(line, 'utf8')}-byte JSONL line (max ${MAX_JSONL_LINE_BYTES})`);
    }
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Read only the tail of a JSONL file, isolating unreadable lines. */
  private readTail(paths: SessionPaths, file: string, limit: number): unknown[] {
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return [];
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size === 0) return [];
      const start = Math.max(0, size - READ_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.toString('utf8');
      if (start > 0) {
        const newline = text.indexOf('\n');
        text = newline >= 0 ? text.slice(newline + 1) : '';
      }
      const lines = text.split('\n').filter((line) => line.trim().length > 0);
      const window = limit > 0 ? lines.slice(Math.max(0, lines.length - limit)) : lines;
      const good: unknown[] = [];
      const bad: string[] = [];
      for (const line of window) {
        try {
          good.push(JSON.parse(line));
        } catch {
          bad.push(line);
        }
      }
      if (bad.length > 0) this.isolateBadLines(paths, bad);
      if (bad.length > MAX_BAD_LINES) return [];
      return good;
    } catch {
      return [];
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Append unreadable lines to `corrupt-<ts>.log`; never grow it unbounded. */
  private isolateBadLines(paths: SessionPaths, bad: readonly string[]): void {
    try {
      const payload = bad.map((line) => line.slice(0, 1000)).join('\n');
      fs.appendFileSync(this.corruptLogFor(paths.dir), `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // diagnostics are best effort
    }
  }

  /** `corrupt-<ts>.log` in a session directory. */
  private corruptLogFor(dir: string): string {
    return path.join(dir, `corrupt-${this.clock.now()}.log`);
  }

  /** Validate and normalize a parsed `state.json`. */
  private normalizeState(value: unknown): SessionState | undefined {
    if (!isObject(value)) return undefined;
    if (value.version !== 1) return undefined;
    if (typeof value.turnNo !== 'number' || !Number.isFinite(value.turnNo) || value.turnNo < 0) return undefined;
    if (!isObject(value.budgets)) return undefined;
    const budgets = value.budgets as Record<string, unknown>;
    if (
      typeof budgets.interventions !== 'number' ||
      typeof budgets.judgmentsTurn !== 'number' ||
      typeof budgets.judgmentsSession !== 'number'
    ) {
      return undefined;
    }
    return {
      version: 1,
      turnNo: value.turnNo,
      appliedSignatures: Array.isArray(value.appliedSignatures)
        ? value.appliedSignatures.filter((item): item is string => typeof item === 'string').slice(-50)
        : [],
      budgets: {
        interventions: budgets.interventions,
        judgmentsTurn: budgets.judgmentsTurn,
        judgmentsSession: budgets.judgmentsSession
      },
      continues: isObject(value.continues)
        ? Object.fromEntries(
            Object.entries(value.continues).filter(([, count]) => typeof count === 'number') as Array<[string, number]>
          )
        : {},
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : this.clock.iso()
    };
  }

  /** Rebuild the discardable state from the two authoritative logs. */
  private rebuildState(sessionId: string): SessionState {
    const events = this.readEvents(sessionId, 5000);
    const ledger = this.readLedger(sessionId, 5000);
    let turnNo = 0;
    for (const event of events) {
      if (event.kind === 'stop' && typeof event.turnNo === 'number') turnNo = Math.max(turnNo, event.turnNo);
    }
    const judgmentsSession = ledger.filter((record) => record.judged === true).length;
    return {
      version: 1,
      turnNo,
      appliedSignatures: [],
      budgets: { interventions: 0, judgmentsTurn: 0, judgmentsSession },
      continues: {},
      updatedAt: this.clock.iso()
    };
  }

  /** Write `state.json` via temp + fsync + rename. */
  private writeState(paths: SessionPaths, state: SessionState): void {
    this.writeAtomic(paths.state, JSON.stringify(state));
  }

  /** Atomic replacement of a small file. */
  private writeAtomic(file: string, content: string): void {
    const tmp = `${file}.${randomSuffix()}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows-style rename-over-existing; POSIX never takes this branch.
      this.safeUnlink(file);
      fs.renameSync(tmp, file);
    }
  }

  /** Unlink without throwing. */
  private safeUnlink(file: string): void {
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
  }

  /** Read and validate `meta.json`. */
  private readMeta(file: string): SessionMeta | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (!isObject(parsed)) return undefined;
      if (typeof parsed.sessionId !== 'string' || typeof parsed.harness !== 'string') return undefined;
      return parsed as unknown as SessionMeta;
    } catch {
      return undefined;
    }
  }

  /** Move a directory whose meta does not match its name into `orphans/`. */
  private quarantine(dir: string): void {
    try {
      this.ensureDir(this.orphansRoot());
      const target = path.join(this.orphansRoot(), `${path.basename(dir)}-${this.clock.now()}`);
      fs.renameSync(dir, target);
    } catch {
      // If it cannot be moved, leave it; ensureSession recreates the missing path.
    }
  }

  /** Newest mtime under one directory, for the seven-day rule. */
  private latestMtime(dir: string): number {
    let latest = 0;
    try {
      latest = fs.statSync(dir).mtimeMs;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        try {
          const stat = fs.statSync(path.join(dir, entry.name));
          if (stat.mtimeMs > latest) latest = stat.mtimeMs;
        } catch {
          // raced with a unlink
        }
      }
    } catch {
      latest = 0;
    }
    return latest;
  }

  /** The retained originals, oldest first. */
  private originalEntries(dir: string): Array<{ name: string; size: number; mtimeMs: number }> {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const entries: Array<{ name: string; size: number; mtimeMs: number }> = [];
    for (const name of names) {
      if (!name.endsWith('.txt')) continue;
      try {
        const stat = fs.statSync(path.join(dir, name));
        entries.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // raced with an eviction
      }
    }
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
    return entries;
  }

  /** Take the directory lock, taking over one that is older than the stale rule. */
  private acquireLock(paths: SessionPaths): { acquired: boolean; reason?: string; release?: () => void } {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.mkdirSync(paths.lock, { mode: 0o700 });
        try {
          fs.writeFileSync(
            path.join(paths.lock, 'owner.json'),
            JSON.stringify({ pid: process.pid, startedAt: this.clock.iso(), startedMs: this.clock.now() }),
            { mode: 0o600 }
          );
        } catch {
          // The lock is still held; owner metadata is diagnostics only.
        }
        return { acquired: true, release: () => this.releaseLock(paths.lock) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { acquired: false, reason: 'lock-error' };
        const startedMs = this.lockStartedMs(paths.lock);
        const age = this.clock.now() - startedMs;
        if (!Number.isFinite(age) || age <= this.lockStaleMs) return { acquired: false, reason: 'lock-contention' };
        const tombstone = `${paths.lock}.stale-${randomSuffix()}`;
        try {
          fs.renameSync(paths.lock, tombstone);
          fs.rmSync(tombstone, { recursive: true, force: true });
        } catch {
          return { acquired: false, reason: 'lock-contention' };
        }
      }
    }
    return { acquired: false, reason: 'lock-contention' };
  }

  /** Release the lock directory. */
  private releaseLock(lock: string): void {
    try {
      fs.rmSync(lock, { recursive: true, force: true });
    } catch {
      // already gone
    }
  }

  /** When the current lock owner started, from its metadata or its mtime. */
  private lockStartedMs(lock: string): number {
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')) as unknown;
      if (isObject(owner) && typeof owner.startedMs === 'number' && Number.isFinite(owner.startedMs)) {
        return owner.startedMs;
      }
    } catch {
      // fall through to mtime
    }
    try {
      return fs.statSync(lock).mtimeMs;
    } catch {
      return this.clock.now();
    }
  }

  /** Bound one ledger record to the line budget before it can be appended. */
  private bounded(record: HookLedgerRecord): HookLedgerRecord {
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line, 'utf8') <= MAX_JSONL_LINE_BYTES) return record;
    const minimal: HookLedgerRecord = {
      ...record,
      details: { truncated: true },
      skipReason: (record.skipReason ?? '').slice(0, 120)
    };
    if (Buffer.byteLength(`${JSON.stringify(minimal)}\n`, 'utf8') <= MAX_JSONL_LINE_BYTES) return minimal;
    return { ...minimal, details: undefined };
  }
}
