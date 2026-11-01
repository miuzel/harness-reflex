/**
 * The host-independent hook decision.
 *
 * Everything a command-hook run needs in order to *decide* lives here: the
 * per-event handlers, the budget accounting, the idempotency commit, and the
 * audit line. It knows nothing about stdin, stdout, exit codes, timeouts, or
 * signals — those are properties of one delivery mechanism (a child process per
 * event) and stay in `run.ts`.
 *
 * The separation exists because the same decisions must run in hosts that do not
 * fork: the DSH plugin, a pi extension, and an opencode plugin all intercept in
 * process and call this class directly with their own {@link HookStorePort}.
 *
 * @module hook/decision
 */
import type {
  ClaimClassificationResponse,
  DecisionBackend,
  GateResponse,
  StagnationCheckResponse
} from '../backend/types.js';
import { claimCandidates, claimsOf, closingSkipReason, contradictedOf } from '../core/closing.js';
import { assembleEvidence, evidenceOf, type EvidenceEntry } from '../core/evidence.js';
import { countTrailingFailures, suspicionOf, type ObservedStep } from '../core/judge.js';
import { applyPruneFloor } from '../core/prune-plan.js';
import { clip, digestOf, estimateTokens } from '../core/text.js';
import type { HookClock } from '../state/clock.js';
import type { HookLedgerRecord, SessionEvent } from '../state/file-store.js';
import type { HookStorePort } from './store-port.js';
import {
  emptyHookOutput,
  preToolUseDeny,
  postToolUseFailureContext,
  postToolUseReplace,
  sessionStartContext,
  stopBlock,
  type EventBudget,
  type HookEvent,
  type HookMode,
  type HookOutput
} from './contract.js';
import { EVENT_BUDGETS } from './contract.js';


export const MAX_STDIN_BYTES = 8 * 1024 * 1024;

/** Resolved hook configuration; every number has a documented default. */
export interface HookConfig {
  maxInterventionsPerTurn: number;
  maxJudgmentsPerTurn: number;
  maxJudgmentsPerSession: number;
  repeatThreshold: number;
  failureThreshold: number;
  windowSize: number;
  minConfidence: number;
  pruneThreshold: number;
  pruneMinLines: number;
  maxRetainedChars: number;
  pruneFloorRatio: number;
  pruneHeadChars: number;
  pruneTailChars: number;
  claimMinConfidence: number;
  closingEvidenceChars: number;
  closingIntent: string;
  maxClosingBlocksPerTurn: number;
  eventBudgets: Record<HookEvent, EventBudget>;
}

/** Defaults mirrored from the DSH intervention policy (config.ts). */
export const DEFAULT_HOOK_CONFIG: HookConfig = {
  maxInterventionsPerTurn: 3,
  maxJudgmentsPerTurn: 3,
  maxJudgmentsPerSession: 20,
  repeatThreshold: 3,
  failureThreshold: 3,
  windowSize: 6,
  minConfidence: 0.6,
  pruneThreshold: 500,
  pruneMinLines: 4,
  maxRetainedChars: 100_000,
  pruneFloorRatio: 0.5,
  pruneHeadChars: 400,
  pruneTailChars: 400,
  claimMinConfidence: 0.6,
  closingEvidenceChars: 2000,
  closingIntent: 'verify a completion claim against this turn\'s tool evidence',
  maxClosingBlocksPerTurn: 2,
  eventBudgets: EVENT_BUDGETS
};

/** A stable label for `meta.mode`, the only place a single mode string is stored. */

export type HookCapability = 'stagnation' | 'prune' | 'gate' | 'closing';

/** One resolved mode per capability. */
export type HookModeMap = Record<HookCapability, HookMode>;

/** A stable label for `meta.mode`, the only place a single mode string is stored. */
export function modeLabel(modes: HookModeMap): string {
  const values = [modes.stagnation, modes.prune, modes.gate, modes.closing];
  if (values.every((value) => value === 'active')) return 'active';
  if (values.every((value) => value === 'off')) return 'off';
  if (values.every((value) => value === 'observe')) return 'observe';
  return 'mixed';
}

/**
 * The S3 default: the three tool-call interventions act, the closing check only
 * observes. A closing block is the most destructive action available (it keeps
 * the user's turn open), so it ships opt-in (design §4.2).
 */
export const DEFAULT_CAPABILITY_MODES: HookModeMap = {
  stagnation: 'active',
  prune: 'active',
  gate: 'active',
  closing: 'observe'
};

/** One explicit three-state value, or `undefined` when unset/unknown. */
function explicitMode(raw: string | undefined): HookMode | undefined {
  const value = raw?.trim().toLowerCase();
  return value === 'off' || value === 'observe' || value === 'active' ? value : undefined;
}

/**
 * Resolve the per-capability modes.
 *
 * Precedence, highest first:
 * 1. `HARNESS_REFLEX_MODE` — one global override, kept for the S2 fixtures and
 *    for users who want to silence or shadow the whole layer;
 * 2. a capability's own `HARNESS_REFLEX_<CAP>_MODE`;
 * 3. the plugin's `userConfig` option, exported as `CLAUDE_PLUGIN_OPTION_<KEY>`
 *    (only `closing` has one: `closing_mode`, default `observe`);
 * 4. the S3 defaults in {@link DEFAULT_CAPABILITY_MODES}.
 *
 * @param env - environment to read.
 * @returns one mode per capability.
 */
export function resolveHookModes(env: NodeJS.ProcessEnv = process.env): HookModeMap {
  const global = explicitMode(env.HARNESS_REFLEX_MODE);
  if (global) return { stagnation: global, prune: global, gate: global, closing: global };
  return {
    stagnation: explicitMode(env.HARNESS_REFLEX_STAGNATION_MODE) ?? DEFAULT_CAPABILITY_MODES.stagnation,
    prune: explicitMode(env.HARNESS_REFLEX_PRUNE_MODE) ?? DEFAULT_CAPABILITY_MODES.prune,
    gate: explicitMode(env.HARNESS_REFLEX_GATE_MODE) ?? DEFAULT_CAPABILITY_MODES.gate,
    closing:
      explicitMode(env.HARNESS_REFLEX_CLOSING_MODE) ??
      explicitMode(env.CLAUDE_PLUGIN_OPTION_CLOSING_MODE) ??
      DEFAULT_CAPABILITY_MODES.closing
  };
}

/**
 * Read stdin up to a hard cap.
 *
 * Once the cap is crossed the buffered chunks are dropped and the rest of the
 * stream is drained without retention: the process must not OOM over a payload
 * it will refuse anyway, and it must not leave the writer with EPIPE.
 * @param stream - stdin.
 * @param limit - maximum retained bytes.
 * @returns the retained text, or `overflow: true` when the cap was crossed.
 */

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return 'null';
}

/** One string field, when it is a non-empty string. */
export function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The text a tool result shows the model, from any of the host's shapes. */
export function toolResponseText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (response === null || response === undefined) return '';
  if (Array.isArray(response)) {
    const parts: string[] = [];
    for (const item of response) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'text') {
        parts.push(String((item as { text?: unknown }).text ?? ''));
      }
    }
    return parts.join('\n');
  }
  if (typeof response === 'object') {
    const record = response as Record<string, unknown>;
    if (typeof record.stdout === 'string' || typeof record.stderr === 'string') {
      return [record.stdout, record.stderr].filter((part): part is string => typeof part === 'string').join('\n');
    }
    if (Array.isArray(record.content)) return toolResponseText(record.content);
    for (const key of ['output', 'text', 'message', 'error', 'result']) {
      if (typeof record[key] === 'string') return record[key] as string;
    }
    try {
      return JSON.stringify(response);
    } catch {
      return '';
    }
  }
  return String(response);
}

/** Whether a tool result is already known to be a failure. */
function toolResponseFailed(response: unknown): boolean {
  if (response === null || typeof response !== 'object') return false;
  const record = response as Record<string, unknown>;
  if (record.isError === true || record.interrupted === true) return true;
  if (typeof record.exitCode === 'number' && record.exitCode !== 0) return true;
  return false;
}

/** The dedupe key of design §2.5, extended for the events without a call id. */
export function dedupeKeyFor(event: HookEvent, payload: Record<string, unknown>): string {
  const session = stringField(payload.session_id) ?? '';
  const toolUseId = stringField(payload.tool_use_id) ?? '';
  const toolName = stringField(payload.tool_name) ?? '';
  let inputDigest = '';
  switch (event) {
    case 'pretooluse':
    case 'posttooluse':
    case 'postfailure':
      inputDigest = digestOf(canonicalJson(payload.tool_input ?? null));
      break;
    case 'stop':
    case 'substop':
      // `stop_hook_active` is part of the identity: the host's guarded retry
      // must reach the allow path instead of replaying the previous block.
      inputDigest = digestOf(
        [
          stringField(payload.last_assistant_message) ?? '',
          payload.stop_hook_active === true ? 'active' : 'inactive',
          stringField(payload.agent_id) ?? ''
        ].join('\u0000')
      );
      break;
    case 'sessionstart':
      inputDigest = digestOf(stringField(payload.source) ?? '');
      break;
    case 'sessionend':
      inputDigest = digestOf(stringField(payload.reason) ?? '');
      break;
  }
  return digestOf([session, event, toolUseId, toolName, inputDigest].join('\u0000')) + digestOf(`${event}:${session}`);
}

/** The ledger fields a handler must supply. */
type LedgerInput = Omit<HookLedgerRecord, 'id' | 'timestamp' | 'harness' | 'event' | 'dedupeKey' | 'turnNo'>;

/** The event fields a handler must supply. */
type EventInput = Omit<SessionEvent, 'v' | 'at' | 'atIso' | 'dedupeKey'>;

export class HookDecision {
  readonly #store: HookStorePort;
  readonly #backend: DecisionBackend;
  readonly #config: HookConfig;
  readonly #modes: HookModeMap;
  readonly #sessionId: string;
  readonly #clock: HookClock;
  readonly #stderr: (message: string) => void;
  #aborted = false;
  #currentEvent: HookEvent = 'pretooluse';

  constructor(args: {
    store: HookStorePort;
    backend: DecisionBackend;
    config: HookConfig;
    modes: HookModeMap;
    sessionId: string;
    clock: HookClock;
    stderr: (message: string) => void;
  }) {
    this.#store = args.store;
    this.#backend = args.backend;
    this.#config = args.config;
    this.#modes = args.modes;
    this.#sessionId = args.sessionId;
    this.#clock = args.clock;
    this.#stderr = args.stderr;
  }

  /** Mark the turn as timed out: later completion must not write anything. */
  abort(): void {
    this.#aborted = true;
  }

  /** The current turn number, from the discardable cache. */
  turnNo(): number {
    try {
      return this.#store.readState(this.#sessionId).turnNo;
    } catch {
      return 0;
    }
  }

  /** The mode's resolved policy, shared by every capability. */
  #policy() {
    const modes = this.#modes;
    const mode = modes.stagnation !== 'off' || modes.prune !== 'off' || modes.gate !== 'off' || modes.closing !== 'off'
      ? 'active'
      : 'off';
    return {
      enabled: mode !== 'off',
      mode,
      capabilities: { ...modes },
      maxInterventionsPerTurn: this.#config.maxInterventionsPerTurn,
      maxJudgmentsPerTurn: this.#config.maxJudgmentsPerTurn,
      maxJudgmentsPerSession: this.#config.maxJudgmentsPerSession,
      repeatThreshold: this.#config.repeatThreshold,
      minConfidence: this.#config.minConfidence
    } as const;
  }

  /**
   * Reserve a budget slot (and optionally a judgment) under the lock.
   *
   * The checks and the increments happen in one locked read-modify-write, so two
   * processes cannot both believe the last slot is free. A lock that cannot be
   * taken skips this turn's decision, never blocks the tool call.
   */
  #reserve(needs: { action: boolean; judgment: boolean }): { ok: boolean; skipReason?: string } {
    const result = this.#store.updateState(this.#sessionId, (state) => {
      const policy = this.#policy();
      const budget = {
        interventions: state.budgets.interventions,
        judgmentsCount: state.budgets.judgmentsTurn,
        judgmentsSession: state.budgets.judgmentsSession
      };
      if (needs.action && budget.interventions >= policy.maxInterventionsPerTurn) {
        return { skip: 'intervention-cap' };
      }
      if (needs.judgment) {
        if (budget.judgmentsCount >= policy.maxJudgmentsPerTurn) return { skip: 'judgment-turn-cap' };
        if (budget.judgmentsSession >= policy.maxJudgmentsPerSession) return { skip: 'judgment-session-cap' };
        budget.judgmentsCount += 1;
        budget.judgmentsSession += 1;
      }
      if (needs.action) budget.interventions += 1;
      state.budgets = {
        interventions: budget.interventions,
        judgmentsTurn: budget.judgmentsCount,
        judgmentsSession: budget.judgmentsSession
      };
      return { skip: undefined };
    });
    if (!result.acquired) return { ok: false, skipReason: 'skippedLockContention' };
    if (result.value?.skip) return { ok: false, skipReason: result.value.skip };
    return { ok: true };
  }

  /** Reserve the closing action and its per-turn repeat ceiling together. */
  #reserveClosing(): { ok: boolean; skipReason?: string } {
    const result = this.#store.updateState(this.#sessionId, (state) => {
      const policy = this.#policy();
      if (state.budgets.interventions >= policy.maxInterventionsPerTurn) return { skip: 'intervention-cap' };
      const used = state.continues.closing ?? 0;
      if (used >= this.#config.maxClosingBlocksPerTurn) return { skip: 'closing-turn-cap' };
      state.budgets = { ...state.budgets, interventions: state.budgets.interventions + 1 };
      state.continues = { ...state.continues, closing: used + 1 };
      return { skip: undefined };
    });
    if (!result.acquired) return { ok: false, skipReason: 'skippedLockContention' };
    if (result.value?.skip) return { ok: false, skipReason: result.value.skip };
    return { ok: true };
  }

  /** Append an error record; never throws and never becomes a decision. */
  auditError(event: HookEvent, reason: string, message: string, key: string): void {
    try {
      this.#store.appendLedger(this.#sessionId, {
        id: `hr_${this.#clock.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: this.#clock.iso(),
        harness: this.#store.harness,
        event,
        dedupeKey: key,
        turnNo: this.turnNo(),
        type: 'error',
        backend: this.#backend.name,
        latencyMs: 0,
        skipReason: reason,
        details: { message: clip(message, 300) }
      });
    } catch (error) {
      this.#stderr(`harness-reflex hook: audit write failed: ${(error as Error).message}`);
    }
  }

  /**
   * Commit one decision and return the exact stdout object.
   *
   * The order is deliberate: observation, audit line, then the decision cache.
   * A retry that finds the cache always has the ledger line; one that finds only
   * the observation decides once more without appending it twice; one that finds
   * only the ledger line is an explicit no-op. No window can produce a second
   * intervention.
   */
  #finish(
    key: string,
    output: HookOutput,
    ledger: LedgerInput,
    event: EventInput | undefined,
    eventAlreadyRecorded: boolean
  ): HookOutput {
    if (this.#aborted) {
      // The caller timed out; the handler may still be running. The claim is
      // left to expire rather than opening a race with this still-live path.
      return emptyHookOutput();
    }
    // Observation, then the authoritative ledger line, then the idempotency
    // commit, then stdout. A crash in any window leaves the retry with one of:
    // nothing (decide), an existing observation (decide, do not append it
    // twice), an existing ledger line (explicit no-op), or an existing decision
    // cache (replay the exact same output) — never a second intervention.
    try {
      if (event && !eventAlreadyRecorded) {
        try {
          this.#store.appendEvent(this.#sessionId, {
            ...event,
            v: 1,
            at: this.#clock.now(),
            atIso: this.#clock.iso(),
            dedupeKey: key
          });
        } catch (error) {
          this.#stderr(`harness-reflex hook: event append failed: ${(error as Error).message}`);
        }
      }
      try {
        this.#store.appendLedger(this.#sessionId, {
          ...ledger,
          id: `hr_${this.#clock.now()}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp: this.#clock.iso(),
          harness: this.#store.harness,
          event: this.#currentEvent,
          dedupeKey: key,
          turnNo: this.turnNo()
        } as HookLedgerRecord);
      } catch (error) {
        this.#stderr(`harness-reflex hook: ledger append failed: ${(error as Error).message}`);
      }
      // The cache is the idempotency marker even when the audit line failed: a
      // duplicate must never repeat an intervention. A ledger gap is visible in
      // stderr and left for the next delivery to fill only if it can decide again.
      if (Object.keys(output).length > 0) {
        this.#store.writeDecision(this.#sessionId, key, output);
      }
      return output;
    } finally {
      this.#store.releaseDecisionClaim(this.#sessionId, key);
    }
  }

  /** Look up a previous delivery of this exact event. */
  #lookup(key: string): { cached?: HookOutput; ledgerSeen: boolean; eventSeen: boolean } {
    let cached: HookOutput | undefined;
    try {
      cached = this.#store.readDecision(this.#sessionId, key) as HookOutput | undefined;
    } catch {
      cached = undefined;
    }
    let ledgerSeen = false;
    let eventSeen = false;
    try {
      ledgerSeen = this.#store.ledgerHasKey(this.#sessionId, key);
      eventSeen = this.#store.eventsHaveKey(this.#sessionId, key);
    } catch {
      // A read failure means no dedupe evidence; deciding again is safe.
    }
    return { cached, ledgerSeen, eventSeen };
  }

  /** Dispatch one event. Callers have already ensured the session exists. */
  async handle(event: HookEvent, payload: Record<string, unknown>, budget: EventBudget): Promise<HookOutput> {
    this.#currentEvent = event;
    const key = dedupeKeyFor(event, payload);
    const lookup = this.#lookup(key);
    if (lookup.cached) return lookup.cached;
    if (lookup.ledgerSeen) return emptyHookOutput();
    const ctx: HandlerContext = { key, payload, budget, eventSeen: lookup.eventSeen };
    switch (event) {
      case 'pretooluse':
        return this.#preToolUse(ctx);
      case 'posttooluse':
        return this.#postToolUse(ctx);
      case 'postfailure':
        return this.#postToolUseFailure(ctx);
      case 'stop':
      case 'substop':
        return this.#stop(ctx, event);
      case 'sessionstart':
        return this.#sessionStart();
      case 'sessionend':
        return this.#sessionEnd();
    }
  }

  /** PreToolUse: deny a provably repeated call, otherwise allow silently. */
  async #preToolUse(ctx: HandlerContext): Promise<HookOutput> {
    if (this.#modes.stagnation === 'off') {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'stagnation',
        backend: this.#backend.name,
        latencyMs: 0,
        applied: false,
        skipReason: 'capability-off'
      }, undefined, ctx.eventSeen);
    }
    const toolName = stringField(ctx.payload.tool_name) ?? 'unknown';
    const inputDigest = digestOf(canonicalJson(ctx.payload.tool_input ?? null));
    const signature = `${toolName}:${inputDigest}`;
    const prior = this.#store
      .readEvents(this.#sessionId, this.#config.windowSize + 4)
      .filter((event) => event.kind === 'pre' || event.kind === 'post' || event.kind === 'failure');
    const steps: ObservedStep[] = prior.map((event) => ({
      signature: event.signature ?? `${event.tool ?? 'unknown'}:${''}`,
      tool: event.tool ?? 'unknown',
      input: '',
      output: event.output ?? '',
      error: event.failed ? (event.output ?? 'failed') : '',
      failed: event.failed === true,
      turn: event.turnNo,
      at: event.at
    }));
    const current: ObservedStep = {
      signature,
      tool: toolName,
      input: '',
      output: '',
      error: '',
      failed: false,
      turn: this.turnNo(),
      at: this.#clock.now()
    };
    const suspicion = suspicionOf([...steps, current], {
      repeatThreshold: this.#config.repeatThreshold,
      failureThreshold: this.#config.failureThreshold,
      window: this.#config.windowSize,
      signature
    });
    const event: EventInput = {
      kind: 'pre',
      turnNo: this.turnNo(),
      tool: toolName,
      toolUseId: stringField(ctx.payload.tool_use_id),
      signature
    };
    if (!suspicion.suspicious) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'stagnation',
        backend: this.#backend.name,
        latencyMs: 0,
        applied: false,
        isStuck: false,
        skipReason: 'no-local-pattern'
      }, event, ctx.eventSeen);
    }
    const reservation = this.#reserve({ action: true, judgment: true });
    if (!reservation.ok) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'stagnation',
        backend: this.#backend.name,
        latencyMs: 0,
        applied: false,
        skipReason: reservation.skipReason
      }, event, ctx.eventSeen);
    }
    const started = this.#clock.now();
    const history: Array<{ tool: string; input: string; output?: string; error?: string; timestamp: number }> = [
      ...steps,
      current
    ].map((step) => ({
      tool: step.tool,
      input: step.signature,
      ...(step.output ? { output: step.output } : {}),
      ...(step.error ? { error: step.error } : {}),
      timestamp: step.at
    }));
    let verdict: StagnationCheckResponse;
    try {
      verdict = await this.#backend.checkStagnation({ history, windowSize: this.#config.windowSize });
    } catch (error) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'error',
        backend: this.#backend.name,
        latencyMs: Math.max(0, this.#clock.now() - started),
        applied: false,
        skipReason: 'backend-error',
        details: { message: clip((error as Error).message, 300) }
      }, event, ctx.eventSeen);
    }
    const latencyMs = Math.max(0, this.#clock.now() - started);
    const useful =
      verdict.isStuck === true &&
      verdict.confidence >= this.#config.minConfidence &&
      (verdict.patternType ?? 'none') !== 'none';
    if (!useful) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'stagnation',
        backend: this.#backend.name,
        latencyMs,
        applied: false,
        isStuck: false,
        judged: true,
        skipReason: 'verdict-not-useful',
        details: { patternType: verdict.patternType ?? 'none', confidence: verdict.confidence }
      }, event, ctx.eventSeen);
    }
    const reason = clip(
      `harness-reflex: this call repeats a pattern this session already ran (${verdict.patternType ?? 'repetition'}). ` +
        `${verdict.diagnosis ?? 'Repeating it will not produce a different result.'} ` +
        `${verdict.recommendedIntervention ?? 'Change the approach or inspect the previous failure.'}`,
      600
    );
    const mode = this.#modes.stagnation;
    const output = mode === 'active' ? preToolUseDeny(reason) : emptyHookOutput();
    return this.#finish(ctx.key, output, {
      type: 'stagnation',
      backend: this.#backend.name,
      latencyMs,
      applied: mode === 'active',
      shadow: mode !== 'active',
      isStuck: true,
      judged: true,
      details: { patternType: verdict.patternType ?? 'repetition', confidence: verdict.confidence }
    }, event, ctx.eventSeen);
  }

  /** PostToolUse: replace an oversized result with its verified reduction. */
  async #postToolUse(ctx: HandlerContext): Promise<HookOutput> {
    if (this.#modes.prune === 'off') {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'prune',
        backend: this.#backend.name,
        latencyMs: 0,
        applied: false,
        tokensSaved: 0,
        skipReason: 'capability-off'
      }, undefined, ctx.eventSeen);
    }
    const toolName = stringField(ctx.payload.tool_name) ?? 'unknown';
    const text = toolResponseText(ctx.payload.tool_response);
    const failed = toolResponseFailed(ctx.payload.tool_response);
    const inputDigest = digestOf(canonicalJson(ctx.payload.tool_input ?? null));
    const signature = `${toolName}:${inputDigest}`;
    const event: EventInput = {
      kind: 'post',
      turnNo: this.turnNo(),
      tool: toolName,
      toolUseId: stringField(ctx.payload.tool_use_id),
      signature,
      failed,
      output: clip(text, 400)
    };
    const skip = (reason: string) => this.#finish(ctx.key, emptyHookOutput(), {
      type: 'prune',
      backend: this.#backend.name,
      latencyMs: 0,
      applied: false,
      tokensSaved: 0,
      skipReason: reason
    }, event, ctx.eventSeen);
    if (text.length < this.#config.pruneThreshold) return skip('below-threshold');
    if ((text.match(/\n/g)?.length ?? 0) < this.#config.pruneMinLines) return skip('unsupported-payload');
    if (text.length > this.#config.maxRetainedChars) return skip('retention-too-large');
    const reservation = this.#reserve({ action: true, judgment: true });
    if (!reservation.ok) return skip(reservation.skipReason ?? 'intervention-cap');

    const started = this.#clock.now();
    let response: { processedOutput: string; originalChars: number; latencyMs: number };
    try {
      response = await this.#backend.prune({ rawOutput: text, intent: 'extract errors and key results' });
    } catch (error) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'error',
        backend: this.#backend.name,
        latencyMs: Math.max(0, this.#clock.now() - started),
        applied: false,
        skipReason: 'backend-error',
        details: { message: clip((error as Error).message, 300) }
      }, event, ctx.eventSeen);
    }
    const latencyMs = Math.max(0, this.#clock.now() - started);
    const digest = digestOf(text);
    const locator = `originals/${digest}.txt`;
    const composed = applyPruneFloor(text, response.processedOutput, {
      floorRatio: this.#config.pruneFloorRatio,
      headChars: this.#config.pruneHeadChars,
      tailChars: this.#config.pruneTailChars,
      locator
    });
    const pruneMode = this.#modes.prune;
    const originalTokens = estimateTokens(text);
    let installed = composed.text;
    let retained = false;
    let evicted: string[] = [];
    if (pruneMode === 'active') {
      const retention = this.#store.retainOriginal(this.#sessionId, digest, text);
      retained = retention.retained;
      evicted = retention.evicted;
      if (!retained) {
        // Downgraded: shrink without a locator and without claiming a saving.
        installed = response.processedOutput.length > 0 ? response.processedOutput : text;
      }
    }
    const prunedTokens = estimateTokens(installed);
    const smaller = installed.length < text.length;
    if (!smaller) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'prune',
        backend: this.#backend.name,
        latencyMs,
        applied: false,
        judged: true,
        tokensSaved: 0,
        originalTokens,
        prunedTokens,
        skipReason: 'no-reduction',
        retention: 'none'
      }, event, ctx.eventSeen);
    }
    const shadow = pruneMode !== 'active';
    const saved = pruneMode === 'active' && retained ? Math.max(0, originalTokens - prunedTokens) : 0;
    const output = pruneMode === 'active' ? postToolUseReplace(installed) : emptyHookOutput();
    return this.#finish(ctx.key, output, {
      type: 'prune',
      backend: this.#backend.name,
      latencyMs,
      applied: pruneMode === 'active',
      shadow,
      judged: true,
      tokensSaved: saved,
      originalTokens,
      prunedTokens,
      retention: retained ? 'retained' : evicted.length > 0 || !retained ? 'evicted' : 'none',
      details: {
        digest,
        floored: composed.floored,
        potentialSavedTokens: Math.max(0, originalTokens - prunedTokens),
        ...(evicted.length > 0 ? { evictedOriginals: evicted.slice(0, 8) } : {})
      }
    }, event, ctx.eventSeen);
  }

  /** PostToolUseFailure: attach one correction after a failing run. */
  async #postToolUseFailure(ctx: HandlerContext): Promise<HookOutput> {
    if (this.#modes.gate === 'off') {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'gate',
        backend: this.#backend.name,
        latencyMs: 0,
        applied: false,
        skipReason: 'capability-off'
      }, undefined, ctx.eventSeen);
    }
    const toolName = stringField(ctx.payload.tool_name) ?? 'unknown';
    const errorText = toolResponseText(ctx.payload.error) || 'tool call failed';
    const inputDigest = digestOf(canonicalJson(ctx.payload.tool_input ?? null));
    const signature = `${toolName}:${inputDigest}`;
    const prior = this.#store
      .readEvents(this.#sessionId, 30)
      .filter((event) => event.kind === 'pre' || event.kind === 'post' || event.kind === 'failure');
    const steps: ObservedStep[] = prior.map((event) => ({
      signature: event.signature ?? `${event.tool ?? 'unknown'}:${''}`,
      tool: event.tool ?? 'unknown',
      input: '',
      output: event.output ?? '',
      error: event.failed ? (event.output ?? 'failed') : '',
      failed: event.failed === true,
      turn: event.turnNo,
      at: event.at
    }));
    steps.push({
      signature,
      tool: toolName,
      input: '',
      output: '',
      error: errorText,
      failed: true,
      turn: this.turnNo(),
      at: this.#clock.now()
    });
    const failures = countTrailingFailures(steps);
    const event: EventInput = {
      kind: 'failure',
      turnNo: this.turnNo(),
      tool: toolName,
      toolUseId: stringField(ctx.payload.tool_use_id),
      signature,
      failed: true,
      output: clip(errorText, 400)
    };
    if (failures < this.#config.failureThreshold) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'gate',
        backend: this.#backend.name,
        latencyMs: 0,
        applied: false,
        skipReason: 'below-failure-threshold'
      }, event, ctx.eventSeen);
    }
    const reservation = this.#reserve({ action: true, judgment: false });
    if (!reservation.ok) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'gate',
        backend: this.#backend.name,
        latencyMs: 0,
        applied: false,
        skipReason: reservation.skipReason
      }, event, ctx.eventSeen);
    }
    const context = clip(
      `harness-reflex: ${failures} consecutive tool calls failed (latest: ${toolName}). ` +
        'Stop retrying the same call. Read the error, change the input or the approach, and verify a smaller step before retrying.',
      600
    );
    const gateMode = this.#modes.gate;
    const output = gateMode === 'active' ? postToolUseFailureContext(context) : emptyHookOutput();
    return this.#finish(ctx.key, output, {
      type: 'gate',
      backend: this.#backend.name,
      latencyMs: 0,
      applied: gateMode === 'active',
      shadow: gateMode !== 'active',
      details: { failures, tool: toolName }
    }, event, ctx.eventSeen);
  }

  /** Stop/SubagentStop: the one place a normal decision may block. */
  async #stop(ctx: HandlerContext, hookEvent: HookEvent): Promise<HookOutput> {
    const increment = this.#store.updateState(this.#sessionId, (state) => {
      state.turnNo += 1;
      state.budgets = { interventions: 0, judgmentsTurn: 0, judgmentsSession: state.budgets.judgmentsSession };
      state.continues = {};
      return { turnNo: state.turnNo };
    });
    const turnNo = increment.acquired ? increment.value?.turnNo ?? this.turnNo() : this.turnNo();
    const stopHookActive = ctx.payload.stop_hook_active === true;
    const message = stringField(ctx.payload.last_assistant_message) ?? '';
    const event: EventInput = {
      kind: 'stop',
      turnNo,
      source: hookEvent,
      toolUseId: stringField(ctx.payload.agent_id)
    };
    if (!increment.acquired) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'closing',
        backend: this.#backend.name,
        latencyMs: 0,
        applied: false,
        skipReason: 'skippedLockContention'
      }, event, ctx.eventSeen);
    }
    // The turn counter and per-turn budgets were reset above; only the judgment
    // and the action are skipped when closing is off.
    if (this.#modes.closing === 'off') {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'closing',
        backend: this.#backend.name,
        latencyMs: 0,
        applied: false,
        skipReason: 'capability-off'
      }, event, ctx.eventSeen);
    }
    if (stopHookActive) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'closing',
        backend: this.#backend.name,
        latencyMs: 0,
        applied: false,
        passed: true,
        skipReason: 'stop-hook-active'
      }, event, ctx.eventSeen);
    }
    const candidates = claimCandidates(message);
    if (candidates.length === 0) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'closing',
        backend: this.#backend.name,
        latencyMs: 0,
        applied: false,
        skipReason: 'no-claim-candidates'
      }, event, ctx.eventSeen);
    }
    if (typeof this.#backend.classifyClaims !== 'function') {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'closing',
        backend: this.#backend.name,
        latencyMs: 0,
        applied: false,
        skipReason: 'classifier-unavailable'
      }, event, ctx.eventSeen);
    }
    const reservation = this.#reserve({ action: false, judgment: true });
    if (!reservation.ok) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'closing',
        backend: this.#backend.name,
        latencyMs: 0,
        applied: false,
        skipReason: reservation.skipReason
      }, event, ctx.eventSeen);
    }
    const started = this.#clock.now();
    let classification: ClaimClassificationResponse;
    try {
      classification = await this.#backend.classifyClaims({
        statements: candidates,
        intent: this.#config.closingIntent
      });
    } catch (error) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'error',
        backend: this.#backend.name,
        latencyMs: Math.max(0, this.#clock.now() - started),
        applied: false,
        skipReason: 'backend-error',
        details: { message: clip((error as Error).message, 300) }
      }, event, ctx.eventSeen);
    }
    const claims = claimsOf(classification, this.#config.claimMinConfidence);
    if (claims.length === 0) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'closing',
        backend: this.#backend.name,
        latencyMs: Math.max(0, this.#clock.now() - started),
        applied: false,
        passed: true,
        skipReason: 'no-completion-claim'
      }, event, ctx.eventSeen);
    }
    const evidence = this.#evidence();
    let verdict: GateResponse;
    try {
      verdict = await this.#backend.gate({ assertions: claims, evidence: evidence.text, strictness: 'normal' });
    } catch (error) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'error',
        backend: this.#backend.name,
        latencyMs: Math.max(0, this.#clock.now() - started),
        applied: false,
        skipReason: 'backend-error',
        details: { message: clip((error as Error).message, 300) }
      }, event, ctx.eventSeen);
    }
    const latencyMs = Math.max(0, this.#clock.now() - started);
    const contradicted = contradictedOf(verdict);
    if (contradicted.length === 0) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'closing',
        backend: this.#backend.name,
        latencyMs,
        applied: false,
        passed: verdict.passed,
        judged: true,
        skipReason: closingSkipReason(verdict, contradicted)
      }, event, ctx.eventSeen);
    }
    const closingReservation = this.#reserveClosing();
    if (!closingReservation.ok) {
      return this.#finish(ctx.key, emptyHookOutput(), {
        type: 'closing',
        backend: this.#backend.name,
        latencyMs,
        applied: false,
        passed: false,
        judged: true,
        skipReason: closingReservation.skipReason
      }, event, ctx.eventSeen);
    }
    const reason = clip(
      `harness-reflex: this turn claims completion but its own tool evidence contradicts it: ${contradicted.join('; ')}. ` +
        'Address the contradiction or restate the claim with the evidence that supports it.',
      900
    );
    const closingMode = this.#modes.closing;
    const output = closingMode === 'active' ? stopBlock(reason) : emptyHookOutput();
    return this.#finish(ctx.key, output, {
      type: 'closing',
      backend: this.#backend.name,
      latencyMs,
      applied: closingMode === 'active',
      shadow: closingMode !== 'active',
      passed: false,
      judged: true,
      details: { contradicted: contradicted.slice(0, 5), evidenceChars: evidence.retainedChars }
    }, event, ctx.eventSeen);
  }

  /** SessionStart: create the session, apply retention, announce the mode. */
  #sessionStart(): HookOutput {
    const modes = this.#modes;
    this.#store.ensureSession(this.#sessionId, modeLabel(modes));
    this.#store.gcSessions(undefined, this.#sessionId);
    this.#store.gcOriginals(this.#sessionId);
    const active = (['stagnation', 'prune', 'gate'] as const).filter((capability) => modes[capability] === 'active');
    if (active.length === 0 && modes.closing !== 'active') return emptyHookOutput();
    const closing = modes.closing === 'active' ? 'closing=active' : 'closing=observe';
    return sessionStartContext(
      `harness-reflex: mode=active (${active.length > 0 ? active.join('/') : 'none'}, ${closing}). ` +
        'Oversized tool results may be reduced; repeated calls, repeated failures, and contradicted completion claims are flagged.'
    );
  }

  /** SessionEnd: the same cleanup, with no output at all. */
  #sessionEnd(): HookOutput {
    try {
      this.#store.gcOriginals(this.#sessionId);
      this.#store.gcSessions(undefined, this.#sessionId);
    } catch {
      // F2: session teardown is silent even when it fails.
    }
    return emptyHookOutput();
  }

  /** Assemble this turn's evidence from the appended observations. */
  #evidence(): { text: string; retainedChars: number; truncatedChars: number } {
    const events = this.#store
      .readEvents(this.#sessionId, 40)
      .filter((event) => (event.kind === 'post' || event.kind === 'failure') && (event.output ?? '').length > 0);
    const entries: EvidenceEntry[] = [];
    for (const event of events) {
      entries.push(
        ...evidenceOf(event.tool ?? 'tool', { isError: event.failed === true }, event.output ?? '')
      );
    }
    return assembleEvidence(entries, this.#config.closingEvidenceChars);
  }
}

/** What a handler receives. */
interface HandlerContext {
  key: string;
  payload: Record<string, unknown>;
  budget: EventBudget;
  eventSeen: boolean;
}

/** Run one hook invocation. Never throws; failure is always `{}` + exit 0. */
interface HandlerContext {
  key: string;
  payload: Record<string, unknown>;
  budget: EventBudget;
  eventSeen: boolean;
}

/** Run one hook invocation. Never throws; failure is always `{}` + exit 0. */
