/**
 * The `harness-reflex hook <event>` entry point.
 *
 * Two rules shape every line below:
 *
 * 1. **stdout is protocol, never diagnostics.** The host may splice stdout into
 *    model-visible text, so only the JSON object named by `hook/contract` is
 *    returned; everything else goes to stderr.
 * 2. **A decision is the only thing that can block.** F1 events fail open with
 *    `{}` on a timeout, a crash, malformed input, or a backend error; F2 events
 *    are silent even then; F3 (`stop`/`substop`) blocks only when the normal
 *    closing decision produced `contradicted` evidence. An exception is never
 *    converted into a veto.
 *
 * This module owns only what a child process adds to a decision: reading stdin
 * under a cap, the per-event deadline, signal handling, and the exit code. The
 * decision itself lives in `decision.ts` and knows nothing about processes, so an
 * in-process host can call the same code without forking.
 *
 * The external state is the {@link FileStateStore}: one process per event, so
 * the only continuity between `PreToolUse` and `Stop` is what was appended.
 *
 * @module hook/run
 */
import { createDecisionBackend } from '../backend/factory.js';
import { clockFromEnv, type HookClock } from '../state/clock.js';
import { FileStateStore } from '../state/file-store.js';
import { assertSupportedPlatform, resolveStateRoot } from '../state/paths.js';
import { emptyHookOutput, parseHookEvent, type HookEvent, type HookMode, type HookOutput } from './contract.js';
import {
  DEFAULT_HOOK_CONFIG,
  HookDecision,
  dedupeKeyFor,
  modeLabel,
  resolveHookModes,
  stringField,
  type HookConfig,
  type HookModeMap
} from './decision.js';
import type { DecisionBackend } from '../backend/types.js';

export {
  DEFAULT_CAPABILITY_MODES,
  DEFAULT_HOOK_CONFIG,
  dedupeKeyFor,
  resolveHookModes,
  type HookCapability,
  type HookConfig,
  type HookModeMap
} from './decision.js';
export { MemoryStateStore } from './memory-store.js';
export type { HookStorePort } from './store-port.js';


export const MAX_STDIN_BYTES = 8 * 1024 * 1024;
export interface HookStdin {
  text: string;
  overflow: boolean;
}

/** The result of one invocation, before the CLI serializes it. */
export interface HookRunResult {
  /** The stdout object; `null` means "write nothing" (unsupported platform). */
  output: HookOutput | null;
  /** Process exit code; non-zero means "abandoned", which every host fails open. */
  code: number;
  /** Machine reason for stderr/audit; never part of stdout. */
  error?: string;
}

/** Injectable seams, used by the fixtures and by the CLI. */
export function readStdinCapped(stream: NodeJS.ReadableStream, limit = MAX_STDIN_BYTES): Promise<HookStdin> {
  return new Promise((resolve, reject) => {
    let total = 0;
    let overflow = false;
    let chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => {
      if (overflow) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buffer.length;
      if (total > limit) {
        overflow = true;
        chunks = [];
        return;
      }
      chunks.push(buffer);
    });
    stream.on('end', () => {
      resolve({ text: overflow ? '' : Buffer.concat(chunks).toString('utf8'), overflow });
    });
    stream.on('error', reject);
  });
}

/** A stable JSON rendering so equal objects produce equal input digests. */
export interface HookRunResult {
  /** The stdout object; `null` means "write nothing" (unsupported platform). */
  output: HookOutput | null;
  /** Process exit code; non-zero means "abandoned", which every host fails open. */
  code: number;
  /** Machine reason for stderr/audit; never part of stdout. */
  error?: string;
}

/** Injectable seams, used by the fixtures and by the CLI. */
export interface HookRunOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  backend?: DecisionBackend;
  store?: FileStateStore;
  clock?: HookClock;
  config?: Partial<HookConfig>;
  /** Explicit per-capability modes; when omitted, they are resolved from `env`. */
  modes?: Partial<HookModeMap>;
  readStdin?: () => Promise<HookStdin>;
  stderr?: (message: string) => void;
}

/** A stable label for `meta.mode`, the only place a single mode string is stored. */
export async function runHook(eventArg: string | undefined, options: HookRunOptions = {}): Promise<HookRunResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const stderr = options.stderr ?? ((message: string) => process.stderr.write(`${message}\n`));
  try {
    assertSupportedPlatform(platform);
  } catch (error) {
    stderr((error as Error).message);
    return { output: null, code: 2, error: 'unsupported-platform' };
  }
  const event = parseHookEvent(eventArg);
  if (!event) {
    stderr(`harness-reflex hook: unknown event "${eventArg ?? ''}" (expected one of pretooluse, posttooluse, postfailure, stop, substop, sessionstart, sessionend)`);
    return { output: emptyHookOutput(), code: 0, error: 'unknown-event' };
  }
  const modes: HookModeMap = { ...resolveHookModes(env), ...(options.modes ?? {}) };
  const mode = modeLabel(modes);
  if (mode === 'off') return { output: emptyHookOutput(), code: 0 };
  const clock = options.clock ?? clockFromEnv(env);
  let stdin: HookStdin;
  try {
    stdin = await (options.readStdin ?? (() => readStdinCapped(process.stdin)))();
  } catch (error) {
    stderr(`harness-reflex hook: stdin read failed: ${(error as Error).message}`);
    return { output: emptyHookOutput(), code: 0, error: 'stdin-read' };
  }
  if (stdin.overflow) {
    stderr(`harness-reflex hook: stdin exceeds ${MAX_STDIN_BYTES} bytes; failing open`);
    return { output: emptyHookOutput(), code: 0, error: 'stdin-too-large' };
  }
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stdin.text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('payload is not an object');
    payload = parsed as Record<string, unknown>;
  } catch (error) {
    stderr(`harness-reflex hook: malformed stdin JSON: ${(error as Error).message}`);
    return { output: emptyHookOutput(), code: 0, error: 'bad-json' };
  }
  const sessionId = stringField(payload.session_id);
  if (!sessionId) {
    stderr('harness-reflex hook: stdin JSON has no session_id; failing open');
    return { output: emptyHookOutput(), code: 0, error: 'missing-session-id' };
  }
  const config: HookConfig = { ...DEFAULT_HOOK_CONFIG, ...options.config };
  // Session boundaries are counted by GC; they carry no decision and no ledger.
  if (event === 'sessionstart' || event === 'sessionend') {
    const store = options.store ?? new FileStateStore({ root: resolveStateRoot(env), clock });
    const backend = options.backend ?? createDecisionBackend();
    const runtime = new HookDecision({ store, backend, config, modes, sessionId, clock, stderr });
    const timeoutMs = config.eventBudgets[event].budgetMs;
    const output = await withTimeout(
      Promise.resolve().then(() => runtime.handle(event, payload, config.eventBudgets[event])),
      timeoutMs,
      () => stderr(`harness-reflex hook: ${event} exceeded ${timeoutMs} ms; failing open`)
    );
    return { output: output ?? emptyHookOutput(), code: 0 };
  }
  const store = options.store ?? new FileStateStore({ root: resolveStateRoot(env), clock });
  const backend = options.backend ?? createDecisionBackend();
  store.ensureSession(sessionId, mode);
  const key = dedupeKeyFor(event, payload);
  // Fast replay path: a committed decision is returned verbatim.
  const committed = store.readDecision(sessionId, key) as HookOutput | undefined;
  if (committed !== undefined) return { output: committed, code: 0 };
  if (store.ledgerHasKey(sessionId, key)) return { output: emptyHookOutput(), code: 0 };
  // Concurrent duplicates of one tool_use_id: exactly one process decides, the
  // others are an explicit no-op (or replay the decision if it just committed).
  if (!store.claimDecision(sessionId, key).acquired) {
    const raced = store.readDecision(sessionId, key) as HookOutput | undefined;
    return { output: raced ?? emptyHookOutput(), code: 0 };
  }
  // Re-check after winning the claim: the previous owner may have committed and
  // released between our first read and the exclusive create.
  const committedAfterClaim = store.readDecision(sessionId, key) as HookOutput | undefined;
  if (committedAfterClaim !== undefined) {
    store.releaseDecisionClaim(sessionId, key);
    return { output: committedAfterClaim, code: 0 };
  }
  if (store.ledgerHasKey(sessionId, key)) {
    store.releaseDecisionClaim(sessionId, key);
    return { output: emptyHookOutput(), code: 0 };
  }
  const runtime = new HookDecision({ store, backend, config, modes, sessionId, clock, stderr });
  const timeoutMs = config.eventBudgets[event].budgetMs;
  const output = await withTimeout(
    runtime.handle(event, payload, config.eventBudgets[event]),
    timeoutMs,
    () => {
      runtime.abort();
      runtime.auditError(event, 'hook-timeout', `decision exceeded ${timeoutMs} ms`, key);
      stderr(`harness-reflex hook: ${event} exceeded ${timeoutMs} ms; failing open`);
    },
    (error) => {
      runtime.auditError(event, 'handler-error', (error as Error)?.message ?? 'unknown error', key);
      store.releaseDecisionClaim(sessionId, key);
      stderr(`harness-reflex hook: ${event} failed: ${(error as Error)?.message ?? 'unknown error'}`);
    }
  );
  return { output: output ?? emptyHookOutput(), code: 0 };
}

/** Resolve a promise at a deadline, running one best-effort callback first. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
  onError?: (error: unknown) => void
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout();
      } catch {
        // the fail-open path must itself never throw
      }
      resolve(undefined);
    }, Math.max(1, ms));
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          onError?.(error);
        } catch {
          // the fail-open path must itself never throw
        }
        resolve(undefined);
      }
    );
  });
}
