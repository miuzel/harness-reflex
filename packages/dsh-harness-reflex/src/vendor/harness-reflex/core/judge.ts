/**
 * The deterministic pre-trigger, the judgment call, and the cost accounting.
 *
 * The expensive path of every capability is one System 1 judgment. This module
 * owns the cheap path that decides whether a judgment is worth buying, the
 * once-per-turn call itself (memoized by the window it is about), and the
 * bookkeeping that bills exactly one judgment per call. The transport is a
 * {@link StagnationBackendPort}; the clock is a {@link ClockPort}; neither is
 * imported from a host.
 *
 * @module core/judge
 */
import type { ActionStep, StagnationCheckResponse } from '../backend/types.js';
import type { ClockPort } from '../ports/clock.js';
import type { StagnationBackendPort } from '../ports/decision.js';
import type { BudgetState, PolicySnapshot } from './policy.js';
import { spendJudgment, usefulVerdict } from './policy.js';
import { estimateTokens } from './text.js';

/** One step of one agent's detection window. */
export interface ObservedStep {
  /** `tool:argumentsDigest` — the identity a repetition is measured on. */
  signature: string;
  tool: string;
  input: string;
  output: string;
  error: string;
  failed: boolean;
  turn: number;
  at: number;
  /** Whether the step was a legitimate wait query rather than progress. */
  wait?: boolean;
}

/** Why a deterministic pre-trigger wants a judgment. */
export interface StagnationSuspicion {
  suspicious: boolean;
  /** The pattern the trigger suspects, before System 1 confirms it. */
  pattern?: 'repetition' | 'oscillation' | 'failing_retry';
  /** Human-readable trigger facts, for the audit record. */
  note: string;
  /** How many steps the pattern was measured on. */
  repeats: number;
}

/**
 * Count the identical trailing repeats of one signature.
 * @param steps - observed steps, oldest first.
 * @param signature - the identity to count.
 * @returns the length of the trailing run of that signature.
 */
export function countTrailingRepeats(steps: readonly ObservedStep[], signature: string): number {
  let count = 0;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]!.signature !== signature) break;
    count += 1;
  }
  return count;
}

/**
 * Count the trailing consecutive failures.
 * @param steps - observed steps, oldest first.
 * @returns the length of the trailing run of failing steps.
 */
export function countTrailingFailures(steps: readonly ObservedStep[]): number {
  let count = 0;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (!steps[index]!.failed) break;
    count += 1;
  }
  return count;
}

/**
 * Whether the window's tail alternates between exactly two call identities.
 *
 * `A B A B` is the cheapest loop to miss and among the most wasteful to run:
 * neither call repeats consecutively, so a consecutive-repeat trigger never
 * fires.
 * @param steps - observed steps, oldest first.
 * @param window - how many trailing steps to inspect.
 * @returns whether the tail oscillates.
 */
export function detectOscillation(steps: readonly ObservedStep[], window: number): boolean {
  const tail = steps.slice(Math.max(0, steps.length - window));
  if (tail.length < 4) return false;
  const signatures = new Set(tail.map((step) => step.signature));
  if (signatures.size !== 2) return false;
  for (let index = 2; index < tail.length; index += 1) {
    if (tail[index]!.signature !== tail[index - 2]!.signature) return false;
  }
  return true;
}

/**
 * Decide, locally and deterministically, whether a judgment is worth spending.
 *
 * This is the cost gate of the whole surface: the expensive path is a System 1
 * call, and it only opens when the *cheap* path already sees a pattern. A single
 * distinctive call is never judged, however large its output.
 *
 * @param steps - observed steps, oldest first.
 * @param options - thresholds, window, and the current call identity.
 * @returns the suspicion, with `suspicious: false` when nothing justifies a call.
 */
export function suspicionOf(
  steps: readonly ObservedStep[],
  options: { repeatThreshold: number; failureThreshold: number; window: number; signature: string }
): StagnationSuspicion {
  const window = steps.slice(Math.max(0, steps.length - options.window));
  const repeats = countTrailingRepeats(window, options.signature);
  if (repeats >= options.repeatThreshold) {
    return { suspicious: true, pattern: 'repetition', note: `identical call repeated ${repeats}x`, repeats };
  }
  const failures = countTrailingFailures(window);
  if (failures >= options.failureThreshold) {
    return { suspicious: true, pattern: 'failing_retry', note: `${failures} consecutive failing steps`, repeats: failures };
  }
  if (detectOscillation(window, options.window)) {
    return { suspicious: true, pattern: 'oscillation', note: `two calls alternating over ${window.length} steps`, repeats: window.length };
  }
  return { suspicious: false, note: 'no local pattern', repeats: 0 };
}

/** The verdict that stands in when no judgment could be spent. */
export const EMPTY_VERDICT: StagnationCheckResponse = { isStuck: false, confidence: 0, latencyMs: 0 };

/** What one judgment cost, charged exactly once per judgment. */
export interface JudgmentCharge {
  judgments: number;
  memoHits: number;
  localLatencyMs: number;
  remoteLatencyMs: number;
  judgeTokens: number;
}

/** One token and latency account of a mode or a capability. */
export interface InterventionCostBucket {
  /** Decisions planned. */
  plans: number;
  /** Decisions whose plan was executed. */
  applied: number;
  /** System 1 judgments paid for. */
  judgments: number;
  /** Judgments served from the per-turn verdict memo instead of a new call. */
  memoHits: number;
  /** Milliseconds spent in local, deterministic work. */
  localLatencyMs: number;
  /** Milliseconds spent waiting for System 1. */
  remoteLatencyMs: number;
  /** Tokens the judgments reasoned about. */
  judgeTokens: number;
  /** Tokens of the payloads decisions were made about. */
  originalTokens: number;
  /** Tokens the candidates would carry. */
  candidateTokens: number;
  /** Tokens the candidates would have saved. */
  potentialSavedTokens: number;
  /** Tokens actually removed from the model-visible surface. */
  actualSavedTokens: number;
  /** Tokens actually added to the model-visible surface. */
  injectedTokens: number;
}

/** A fresh, zeroed cost bucket. */
export function emptyBucket(): InterventionCostBucket {
  return {
    plans: 0,
    applied: 0,
    judgments: 0,
    memoHits: 0,
    localLatencyMs: 0,
    remoteLatencyMs: 0,
    judgeTokens: 0,
    originalTokens: 0,
    candidateTokens: 0,
    potentialSavedTokens: 0,
    actualSavedTokens: 0,
    injectedTokens: 0
  };
}

/** One charge against a mode's and a capability's account. */
export interface CostCharge {
  judgments?: number;
  memoHits?: number;
  localLatencyMs?: number;
  remoteLatencyMs?: number;
  judgeTokens?: number;
  originalTokens?: number;
  candidateTokens?: number;
  potentialSavedTokens?: number;
  actualSavedTokens?: number;
  injectedTokens?: number;
}

/**
 * Add one charge to one bucket.
 *
 * Every counter has exactly one writer, so a reader can add the parts up without
 * meeting a number twice.
 * @param bucket - the bucket to bill.
 * @param plans - decisions planned by this charge.
 * @param applied - decisions applied by this charge.
 * @param charge - the token/latency/decision counts.
 */
export function applyCharge(
  bucket: InterventionCostBucket,
  plans: number,
  applied: number,
  charge: CostCharge
): void {
  bucket.plans += plans;
  bucket.applied += applied;
  bucket.judgments += charge.judgments ?? 0;
  bucket.memoHits += charge.memoHits ?? 0;
  bucket.localLatencyMs += charge.localLatencyMs ?? 0;
  bucket.remoteLatencyMs += charge.remoteLatencyMs ?? 0;
  bucket.judgeTokens += charge.judgeTokens ?? 0;
  bucket.originalTokens += charge.originalTokens ?? 0;
  bucket.candidateTokens += charge.candidateTokens ?? 0;
  bucket.potentialSavedTokens += charge.potentialSavedTokens ?? 0;
  bucket.actualSavedTokens += charge.actualSavedTokens ?? 0;
  bucket.injectedTokens += charge.injectedTokens ?? 0;
}

/** The state one judgment memo and the two budgets live in. */
export interface JudgmentState extends BudgetState {
  turn: number;
  verdictTurn: number;
  /** Identity of the window the cached verdict was about. */
  verdictKey: string;
  verdict?: StagnationCheckResponse;
}

/** The outcome of one judgment request. */
export interface JudgmentOutcome {
  useful: boolean;
  paid: boolean;
  reused: boolean;
  judgeTokens: number;
  localLatencyMs: number;
  remoteLatencyMs: number;
  skip?: string;
  response: StagnationCheckResponse;
}

/**
 * The memo key of one judgment: the question plus the trailing window it is
 * asked about.
 * @param goal - the wait/context question, when one was asked.
 * @param steps - the window.
 * @param repeatThreshold - how many trailing signatures identify the window.
 * @returns a stable key.
 */
export function judgmentKey(goal: string | undefined, steps: readonly ObservedStep[], repeatThreshold: number): string {
  return `${goal ?? ''}\u0000${steps
    .slice(-Math.max(1, repeatThreshold))
    .map((step) => step.signature)
    .join('|')}`;
}

/** The zero-cost verdict of a judgment that could not be spent. */
function noJudgment(skip: string): JudgmentOutcome {
  return {
    useful: false,
    paid: false,
    reused: false,
    judgeTokens: 0,
    localLatencyMs: 0,
    remoteLatencyMs: 0,
    skip,
    response: EMPTY_VERDICT
  };
}

/**
 * Ask for one stagnation verdict, reusing this turn's answer when the window is
 * the same one.
 *
 * The question is the trailing window plus the context it is asked in, so the
 * answer is cached against both: the same episode is never judged twice, while
 * a *different* episode or a different wait context in the same turn is a new
 * question — and therefore subject to the turn's budget.
 *
 * @param args - state, policy, backend, clock, window, question, and abort signal.
 * @returns the outcome, including why a judgment was refused.
 */
export async function runJudgment(args: {
  state: JudgmentState;
  policy: PolicySnapshot;
  backend: StagnationBackendPort;
  clock: ClockPort;
  steps: readonly ObservedStep[];
  goal?: string;
  signal?: AbortSignal;
}): Promise<JudgmentOutcome> {
  const { state, policy, backend, clock, steps, goal, signal } = args;
  const key = judgmentKey(goal, steps, policy.repeatThreshold);
  const cached = state.verdictTurn === state.turn && state.verdictKey === key ? state.verdict : undefined;
  if (cached) {
    return {
      useful: usefulVerdict(cached, policy),
      paid: false,
      reused: true,
      judgeTokens: 0,
      localLatencyMs: 0,
      remoteLatencyMs: 0,
      response: cached
    };
  }
  if (state.judgmentsCount >= policy.maxJudgmentsPerTurn) return noJudgment('judgment-turn-cap');
  if (state.judgmentsSession >= policy.maxJudgmentsPerSession) return noJudgment('judgment-session-cap');
  if (signal?.aborted) return noJudgment('aborted');
  spendJudgment(state, policy);

  const history: ActionStep[] = steps.map((step) => ({
    tool: step.tool,
    input: step.input,
    ...(step.output ? { output: step.output } : {}),
    ...(step.error ? { error: step.error } : {}),
    timestamp: step.at
  }));
  const judgeTokens = history.reduce(
    (sum, step) => sum + estimateTokens(`${step.tool}${step.input}${step.output ?? ''}${step.error ?? ''}`),
    0
  );
  const started = clock.now();
  const response = await backend.check(goal, history);
  const remoteLatencyMs = Number.isFinite(response.latencyMs) ? response.latencyMs : 0;
  state.verdict = response;
  state.verdictTurn = state.turn;
  state.verdictKey = key;
  return {
    useful: usefulVerdict(response, policy),
    paid: true,
    reused: false,
    judgeTokens,
    localLatencyMs: Math.max(0, clock.now() - started - remoteLatencyMs),
    remoteLatencyMs,
    response
  };
}

/**
 * The charge of one judgment, so every judgment is billed exactly once.
 * @param verdict - the outcome of the judgment call.
 * @param started - clock reading at hook entry.
 * @param finished - clock reading now.
 * @returns the charge.
 */
export function judgmentCharge(
  verdict: Pick<JudgmentOutcome, 'paid' | 'reused' | 'judgeTokens' | 'localLatencyMs' | 'remoteLatencyMs'>,
  started: number,
  finished: number
): JudgmentCharge {
  if (!verdict.paid) {
    return { judgments: 0, memoHits: verdict.reused ? 1 : 0, localLatencyMs: 0, remoteLatencyMs: 0, judgeTokens: 0 };
  }
  return {
    judgments: 1,
    memoHits: 0,
    localLatencyMs: Math.max(verdict.localLatencyMs, Math.max(0, finished - started - verdict.remoteLatencyMs)),
    remoteLatencyMs: verdict.remoteLatencyMs,
    judgeTokens: verdict.judgeTokens
  };
}
