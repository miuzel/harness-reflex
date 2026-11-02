/**
 * The shared orchestration of the failure-correction decision.
 *
 * The third of the three lifts: {@link ./orchestrate} owns when a result is
 * reduced, {@link ./orchestrate-stagnation} owns when a call is refused and when
 * a step is corrected, and this one owns what happens to a result that *failed* —
 * the run is retrying an operation that keeps failing, and what the model is
 * about to read is the failure again rather than the reason it keeps failing.
 *
 * ```
 * agent/turn-stopping / tools/pre-execute          (not this module)
 *
 * tools/post-execute
 *   downstream first, always
 *   → off / own tool / the result of a call this layer refused → hand it back
 *   → [the host records the step and reports the result failed]
 *   → not a failure → this decision does not apply
 *   → downstream blocked the result → hand it back
 *   → the cheap trigger (the trailing failing run) → not suspicious → hand it back
 *   → already corrected this episode → duplicate-intervention
 *   → the turn's action allowance is spent → intervention-cap
 *   → buy a judgment (memo first, budgets inside)
 *   → not useful → charge it, record why, hand it back
 *   → latch the episode, book the action, conclude
 *   → rewrite the result *only* in active mode
 * ```
 *
 * ## What is shared and what is not
 *
 * Shared here: the order above, every skip reason, the budget rules
 * (`actionWithinBudget`, `bookAction`, the judgment memo), the latch, the shape
 * of the audit detail, and the *decision* that an active mode rewrites the result.
 *
 * *Not* shared here: whether a result counts as a failure (the host's own reading
 * of `isError`, a structured exit status, or an exit marker in the text), the
 * window it is measured on and what a legitimate wait removes from it (the host
 * records steps and hands over the value — {@link progressSteps} is applied by
 * the caller, and the DSH host deliberately does *not* apply it here, because a
 * failing poll is still a failure), the wording the model reads, and the concrete
 * shape of a rewritten result.
 *
 * ## The strength of the action is the host's, the decision is not
 *
 * A correction has no single strength. The DSH engine answers with
 * `kind: 'block'` and a feedback list, which replaces the result outright; a
 * command hook answers with `additionalContext` next to the result it did not
 * touch. The shared layer therefore decides *whether* the correction applies and
 * *what it says*, and leaves *how strongly* to be expressed to {@link
 * CorrectionPort#apply}: an observation of the same decision is exactly the plan
 * that reaches the log in both modes, and installing it is the only thing the
 * mode gates.
 *
 * For the same reason this module states no permission-monotonicity rule. A
 * refusal is a permission and may not be added to anything stricter than an
 * allow — that rule lives in one place, {@link mayAddDecision}. A correction is
 * text shown to the model about a result that already happened; it grants and
 * denies nothing, so there is no decision it could weaken. The one decision it
 * must not overwrite is a result the rest of the waterfall *blocked*, and that is
 * an early return rather than a rule about kinds.
 *
 * ## Why the host supplies the window, not a store
 *
 * The same reason as the other two modules: the DSH engine keeps its window in
 * the agent's own bookkeeping and hands the shared layer a value, while a host
 * that derives it from a persisted log hands over a different value. Neither has
 * to teach the shared layer how it stores anything; the only thing the shared
 * layer mutates is the counters it is given, through {@link BudgetState}.
 *
 * @module core/orchestrate-correction
 */
import type { StagnationCheckResponse } from '../backend/types.js';
import type { ClockPort } from '../ports/clock.js';
import type { StagnationBackendPort } from '../ports/decision.js';
import {
  judgmentCharge,
  runJudgment,
  type JudgmentOutcome,
  type JudgmentState,
  type ObservedStep,
  type StagnationSuspicion
} from './judge.js';
import type { HostBillingPort, HostDecisionPort } from './orchestrate-host.js';
import { actionWithinBudget, bookAction, modeOf, type BudgetState, type PolicySnapshot } from './policy.js';
import { clip } from './text.js';

/** The capability every decision in this module belongs to. */
export const CORRECTION_CAPABILITY = 'gate' as const;

/** The audit action a correction is recorded under. */
export const CORRECTION_ACTION = 'corrective-feedback' as const;

/** What one orchestrated decision turned out to be. */
export type CorrectionAction = 'corrected' | 'pass-through';

/** The judgment cost of one decision, as the host bills it. */
export interface JudgedCharge {
  readonly judgments: number;
  readonly memoHits: number;
  readonly localLatencyMs: number;
  readonly remoteLatencyMs: number;
  readonly judgeTokens: number;
}

/** One planned correction, as the host records it. */
export interface CorrectionPlanRecord {
  readonly capability: typeof CORRECTION_CAPABILITY;
  readonly action: typeof CORRECTION_ACTION;
  readonly reason: string;
  feedback: string;
  readonly detail: Record<string, unknown>;
}

/** What one correction was built from. */
export interface CorrectionFeedbackFacts {
  /** Name of the call that failed. */
  readonly tool: string;
  /** The failure text the host reads off the result, for quoting. */
  readonly error: string;
  /** The cheap-path trigger. */
  readonly suspicion: StagnationSuspicion;
  /** What System 1 answered. */
  readonly verdict: StagnationCheckResponse;
}

/**
 * The counters one correction spends from and books against.
 *
 * The verdict cache is part of the budget state because a cached answer is what
 * makes a second question in the same turn free: this path shares that cache with
 * the stagnation capability, so it reads it through here rather than keeping a
 * second copy. `turn` and `step` are what the audit record quotes.
 */
export interface CorrectionState extends JudgmentState {
  step: number;
}

/**
 * Everything the shared layer cannot know by itself.
 *
 * {@link HostDecisionPort} answers the part every capability asks — policy,
 * counters, clock, switch, and the three billing channels — so this interface
 * states only what a *correction* additionally needs.
 */
export interface HostCorrectionPort<Result>
  extends HostDecisionPort<CorrectionState>,
    HostBillingPort<JudgedCharge, CorrectionPlanRecord> {
  /** The service that answers the judgment. */
  backend(): StagnationBackendPort;
  /** Name of the call whose result is being decided. */
  toolName(): string;
  /** The failure text, as the model would read it. */
  error(): string;
  /**
   * The window the trigger is measured on.
   *
   * The host's, deliberately: it is the one value the three capabilities can
   * disagree about, and the disagreement is real — a failing poll is a failure
   * even though a wait is not progress.
   */
  window(): readonly ObservedStep[];
  /** The identity this decision is about. */
  signature(): string;
  /**
   * The cheap trigger over one window.
   *
   * `PolicySnapshot` carries the repetition threshold, the confidence floor and
   * the judgment budgets — the numbers the *budget* rules are stated in — but the
   * failure threshold and the window size are trigger parameters, and the host
   * owns their values.
   */
  suspicion(steps: readonly ObservedStep[]): StagnationSuspicion;
  /** Whether this identity was already corrected on this turn. */
  alreadyCorrected(): boolean;
  /** Latch this identity as corrected. */
  latchCorrected(): void;
  /** The result to hand back when nothing is done. */
  passThrough(): Result;
  /**
   * The result to hand back when the correction applies.
   *
   * How strong this is — a replacement, an added context, or nothing at all
   * because the host is only observing — is the host's to decide, and it is why
   * this is a callback rather than a kind the shared layer picks.
   */
  apply(feedback: string): Result;
  /** Word the correction handed to the model. */
  describe(facts: CorrectionFeedbackFacts): string;
}

/** The outcome of one orchestrated decision. */
export interface CorrectionOutcome<Result> {
  /** What the host should return to its caller. */
  readonly result: Result;
  /** What the decision was. */
  readonly action: CorrectionAction;
  /** The skip reason, when the decision refused to correct. */
  readonly skip?: string;
}

/**
 * The charge of one judgment, through the core's own billing rule.
 * @param outcome - the judgment's outcome.
 * @param started - clock reading at hook entry.
 * @param now - clock reading now.
 * @returns the charge the host records.
 */
function chargeOf(outcome: JudgmentOutcome, started: number, now: number): JudgedCharge {
  return judgmentCharge(outcome, started, now);
}

/**
 * The detail every correction record carries.
 *
 * Kept identical to the correction this module replaced, so an audit trail
 * written before and after the lift reads the same: a reader comparing two
 * sessions must not be able to tell which engine produced which.
 * @param suspicion - the cheap-path trigger.
 * @param verdict - what System 1 answered.
 * @param turn - the deciding turn.
 * @param step - the deciding step.
 * @returns the audit fields.
 */
function detailOf(
  suspicion: StagnationSuspicion,
  verdict: StagnationCheckResponse,
  turn: number,
  step: number
): Record<string, unknown> {
  return {
    pattern: String(verdict.patternType ?? suspicion.pattern ?? 'unknown'),
    confidence: verdict.confidence,
    repeats: suspicion.repeats,
    turn,
    step
  };
}

/**
 * `tools/post-execute`: rewrite a result the run keeps failing to change.
 *
 * The host calls this **after** its own `next()`, and hands over what that
 * returned: a result the rest of the waterfall blocked is already unreadable, so
 * rewriting it would be inventing a surface nobody asked for.
 *
 * @param invocation - the downstream decision, the signal, and the failure facts.
 * @param port - everything that is the host's to answer.
 * @returns the result the host commits.
 */
export async function orchestrateCorrection<Result>(
  invocation: {
    /** Whether the result is one this layer reads as a failure. */
    readonly failed: boolean;
    /** Whether the rest of the waterfall blocked the result outright. */
    readonly blockedByDownstream: boolean;
    /** The result's abort signal, if it has one. */
    readonly signal?: AbortSignal;
  },
  port: HostCorrectionPort<Result>
): Promise<CorrectionOutcome<Result>> {
  const passThrough = (skip?: string): CorrectionOutcome<Result> => ({
    result: port.passThrough(),
    action: 'pass-through',
    ...(skip === undefined ? {} : { skip })
  });

  const mode = modeOf(port.policy(), CORRECTION_CAPABILITY);
  if (mode === 'off' || !port.serves()) return passThrough();
  if (!invocation.failed) return passThrough();
  // A result the rest of the waterfall blocked never reaches the model, so there
  // is nothing here to correct. Asked first: it is the cheapest refusal and it
  // must not be able to spend a judgment.
  if (invocation.blockedByDownstream) return passThrough();

  const signature = port.signature();
  const suspicion = port.suspicion(port.window());
  if (!suspicion.suspicious) return passThrough();
  // The latch is asked in the same breath as the trigger, and only reports when
  // the episode was real: a correction that never happened is not a duplicate of
  // anything, and a record claiming it was would misdescribe the turn.
  if (port.alreadyCorrected()) {
    port.skip('duplicate-intervention');
    return passThrough('duplicate-intervention');
  }
  if (!actionWithinBudget(port.budget(), port.policy())) {
    port.skip('intervention-cap');
    return passThrough('intervention-cap');
  }

  const policy = port.policy();
  const started = port.clock().now();
  const outcome = await runJudgment({
    state: port.budget(),
    policy,
    backend: port.backend(),
    clock: port.clock(),
    steps: port.window(),
    ...(invocation.signal === undefined ? {} : { signal: invocation.signal })
  });
  const charge = chargeOf(outcome, started, port.clock().now());
  if (!outcome.useful) {
    // A budget/abort skip keeps its own reason. The judgment really ran, so it is
    // charged rather than hidden — an abandoned paid plan is still a cost.
    port.chargeJudgment(charge);
    const skip = outcome.skip ?? 'unconfirmed';
    port.skip(skip, charge);
    return passThrough(skip);
  }

  const facts: CorrectionFeedbackFacts = {
    tool: port.toolName(),
    error: port.error(),
    suspicion,
    verdict: outcome.response
  };
  const plan: CorrectionPlanRecord = {
    capability: CORRECTION_CAPABILITY,
    action: CORRECTION_ACTION,
    reason: `${port.toolName()} failed ${suspicion.repeats} times; System 1 confirmed ${
      outcome.response.patternType ?? suspicion.pattern
    }`,
    feedback: port.describe(facts),
    detail: detailOf(suspicion, outcome.response, port.budget().turn, port.budget().step)
  };
  const applies = mode === 'active';
  // The latch is mode-independent on purpose. Observe has to consume the same
  // episode — one correction per failure episode, one charge against the turn's
  // cap — or its accounting would describe a run nobody could reproduce; the
  // model-visible rewrite is the only thing the mode gates.
  port.latchCorrected();
  bookAction(port.budget());
  port.conclude(plan, applies, charge);
  return applies ? { result: port.apply(plan.feedback), action: 'corrected' } : passThrough();
}

/**
 * The correction's wording, in the default form.
 *
 * Exported because a host that shows the text to the same audience may keep it
 * verbatim; a host that words it differently supplies its own through the port.
 * The two clippings are the shared part: an error is quoted at 160 characters and
 * the advice at 240, both with whitespace collapsed, so a multi-line stack can
 * never make the correction unbounded.
 * @param facts - what the correction is built from.
 * @param limits - the two budget lengths.
 * @returns the text handed to the model.
 */
export function describeCorrection(
  facts: CorrectionFeedbackFacts,
  limits: { readonly errorChars: number; readonly adviceChars: number; readonly totalChars: number }
): string {
  const advice = clip((facts.verdict.recommendedIntervention ?? '').replace(/\s+/g, ' ').trim(), limits.adviceChars);
  return clip(
    `Reflex intervention: ${facts.tool} failed ${facts.suspicion.repeats} consecutive times with ${clip(facts.error.replace(/\s+/g, ' ').trim(), limits.errorChars)}. ` +
      `System 1 confirms ${facts.verdict.patternType ?? facts.suspicion.pattern} (confidence ${facts.verdict.confidence.toFixed(2)}). ` +
      `This result is treated as a policy failure: change the command or the code before retrying. ${advice}`,
    limits.totalChars
  );
}
