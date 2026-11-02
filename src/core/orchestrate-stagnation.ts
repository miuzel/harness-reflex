/**
 * The shared orchestration of the stagnation decision.
 *
 * Like {@link ./orchestrate}, this module owns *when and in what order* a
 * decision is made, and none of the host facts the decision is made of. It was
 * lifted in behaviour from the DSH engine's `toolCall` and `preStep` branches so
 * that a second host can reuse them, and each of the two hooks is a function over
 * a port:
 *
 * ```
 * tools/pre-execute
 *   downstream first, always
 *   → off / own tool / aborted → hand the downstream decision back
 *   → [the window: recorded steps + this call, waits removed]
 *   → a wait shape already classified this turn → wait-query, nothing asked
 *   → the cheap trigger (repetition / failing retry / oscillation)
 *   → a handle-shaped repetition promoted to a wait question
 *   → not suspicious, or already refused → hand it back
 *   → already intervened on this episode → duplicate-intervention
 *   → the turn's action allowance is spent → intervention-cap
 *   → buy a judgment (memo first, budgets inside)
 *   → not useful → charge it, record why, hand it back
 *   → latch the refusal, latch the episode, book the action, conclude
 *   → deny *only* when the downstream decision was an allow
 *
 * agent/pre-step
 *   downstream first, always
 *   → off / aborted / not `enter` → hand the downstream decision back
 *   → nothing observed → nothing to correct
 *   → the last observation was a wait → wait-query / wait-query-unjudged
 *   → already intervened / no allowance → duplicate-intervention / cap
 *   → the cheap trigger over the progress-only window
 *   → buy a judgment → not useful → charge it, record why, hand it back
 *   → latch the correction, book the action, conclude
 *   → append the correction to the admitted messages (active only)
 * ```
 *
 * ## What is shared and what is not
 *
 * Shared here: both orders, every skip reason, the budget rules
 * (`actionWithinBudget`, `bookAction`, the judgment memo), the latch semantics,
 * the shape of the audit detail, and the rule that decides whether a refusal may
 * be *added* at all.
 *
 * *Not* shared here: the window itself (the host records steps and hands over an
 * array), the call identity a repetition is measured on (the host's signature
 * algorithm), what counts as a legitimate wait (the host's tool list and argument
 * shape), how a correction is attached to a step or a refusal delivered (the
 * host's message and decision types), and the operator-facing wording of either.
 *
 * ## Why the host supplies the window, not a store
 *
 * The DSH engine keeps its window in the agent's own bookkeeping and hands the
 * shared layer a value; a host that derives the window from a persisted log would
 * hand over a different value. Both are legal, and neither has to teach the
 * shared layer how it stores anything. The only thing the shared layer mutates is
 * the counters it is given, through {@link BudgetState}.
 *
 * ## The safety property this module states
 *
 * A refusal may only ever be *added on top of an allow* — {@link mayAddDecision},
 * one place, one rule. A host that returned something stricter is never
 * overwritten, because the harness would otherwise be able to turn a host's
 * conservative decision into a weaker one.
 *
 * @module core/orchestrate-stagnation
 */
import type { StagnationCheckResponse } from '../backend/types.js';
import type { ClockPort } from '../ports/clock.js';
import type { StagnationBackendPort } from '../ports/decision.js';
import type { HostBillingPort, HostDecisionPort } from './orchestrate-host.js';
import {
  judgmentCharge,
  runJudgment,
  type JudgmentOutcome,
  type ObservedStep,
  type StagnationSuspicion
} from './judge.js';
import {
  actionWithinBudget,
  bookAction,
  modeOf,
  type BudgetState,
  type PolicySnapshot
} from './policy.js';

/** The capability every decision in this module belongs to. */
export const STAGNATION_CAPABILITY = 'stagnation' as const;

/** What one orchestrated decision turned out to be. */
export type StagnationAction = 'allow' | 'deny' | 'pass-through';

/**
 * The window a stagnation trigger and its judgment are measured on.
 *
 * A wait query is not progress the run can be repeating: an identically repeated
 * status/result query of the same background job is the sanctioned way to wait,
 * so those steps are dropped before the repetition, failure and oscillation
 * triggers read the window. Genuine calls on either side of a wait stay adjacent
 * instead of being separated by it, which keeps a real loop visible while a run
 * is waiting.
 * @param steps - observed steps, oldest first.
 * @returns the steps that count as progress.
 */
export function progressSteps(steps: readonly ObservedStep[]): readonly ObservedStep[] {
  return steps.some((step) => step.wait === true) ? steps.filter((step) => step.wait !== true) : steps;
}

/**
 * Whether an action may be added on top of the decision the rest of the
 * waterfall already made.
 *
 * This is the permission-monotonicity rule, in one place: a `deny` may be added
 * only to an `allow`. An approval in flight, a denial carrying its own structured
 * error identity, or a cancellation is information the Host attached, and
 * overwriting any of it would drop that information or relax the decision.
 * @param downstreamKind - the kind of the downstream decision.
 * @returns whether the shared layer may add a refusal.
 */
export function mayAddDecision(downstreamKind: string): boolean {
  return downstreamKind === 'allow';
}

/**
 * The trigger for a repetition of a *wait-shaped* call.
 *
 * The host's tool list only decides that this repetition is worth asking about;
 * it does not pass or refuse anything by itself.
 * @param shape - the wait shape the host recognised.
 * @param repeats - how many times the identity already occurred.
 * @returns the promoted trigger.
 */
export function waitTrigger(shape: string, repeats: number): StagnationSuspicion {
  return {
    suspicious: true,
    pattern: 'repetition',
    note: `wait-suspect ${shape} repeated ${repeats}x`,
    repeats
  };
}

/** The judgment cost of one decision, as the host bills it. */
export interface JudgedCharge {
  readonly judgments: number;
  readonly memoHits: number;
  readonly localLatencyMs: number;
  readonly remoteLatencyMs: number;
  readonly judgeTokens: number;
}

/** One planned stagnation decision, as the host records it. */
export interface StagnationPlanRecord {
  readonly capability: typeof STAGNATION_CAPABILITY;
  readonly action: 'deny-call' | 'corrective-context';
  readonly reason: string;
  feedback: string;
  readonly detail: Record<string, unknown>;
}

/** What one refusal or correction was built from. */
export interface StagnationFeedbackFacts {
  readonly tool: string;
  readonly suspicion: StagnationSuspicion;
  readonly verdict: StagnationCheckResponse;
}

/**
 * The counters one decision spends from and books against.
 *
 * The verdict cache is part of the budget state because a cached answer is what
 * makes a second question in the same turn free: the shared layer reads it
 * through here rather than keeping a second copy.
 */
export interface StagnationState extends BudgetState {
  turn: number;
  step: number;
  verdictTurn: number;
  verdictKey: string;
  verdict?: StagnationCheckResponse;
}

/**
 * Everything the shared layer cannot know by itself.
 *
 * {@link HostDecisionPort} answers the part every capability asks — policy,
 * counters, clock, switch, and the three billing channels — so this interface
 * states only what a *refusal or correction* additionally needs.
 */
export interface HostStagnationPort<Decision, Corrected>
  extends HostDecisionPort<StagnationState>,
    HostBillingPort<JudgedCharge, StagnationPlanRecord> {
  /** The service that answers the judgment. */
  backend(): StagnationBackendPort;
  /** Name of the call being decided, for the record and the wording. */
  toolName(): string;
  /** The recorded window, oldest first, *without* the call about to run. */
  window(): readonly ObservedStep[];
  /** The step the call about to run would append, without committing it. */
  pendingStep(): ObservedStep;
  /** The identity this decision is about. */
  signature(): string;
  /**
   * The cheap trigger over one window.
   *
   * `PolicySnapshot` carries the repetition threshold and the confidence floor —
   * the two numbers the *budget* rules are stated in — but the failure threshold
   * and the window size are trigger parameters, and the host owns their values.
   * Keeping them here is what keeps one policy type for every capability.
   */
  suspicion(steps: readonly ObservedStep[]): StagnationSuspicion;
  /** The progress-only window a pre-step corrects against. */
  progressWindow(): readonly ObservedStep[];
  /** Whether this identity was already intervened on this turn. */
  alreadyIntervened(): boolean;
  /** Whether this identity was already refused this turn. */
  alreadyDenied(): boolean;
  /**
   * Whether the signature of a step was already classified as a wait.
   *
   * The pre-step hook needs it to tell "a poll the run already had answered" from
   * "a poll this turn never judged" — two different skip reasons, and the second
   * one is not a stagnation episode at all.
   */
  wasClassifiedAsWait(signature: string): boolean;
  /** Latch this identity as refused. */
  latchDenied(): void;
  /** Latch this identity as an episode already acted on. */
  latchIntervened(): void;
  /** The decision to hand back when nothing is done. */
  passThrough(): Decision;
  /** Build the refusal, once the decision is to apply one. */
  deny(feedback: string): Decision;
  /** Append the correction to the admitted messages, once the decision is to apply one. */
  correct(feedback: string): Corrected;
  /** Word the refusal handed to the model. */
  denyFeedback(facts: StagnationFeedbackFacts): string;
  /** Word the corrective context attached to a step. */
  contextFeedback(facts: StagnationFeedbackFacts): string;
}

/** The outcome of one orchestrated decision. */
export interface StagnationOutcome<Decision> {
  /** What the host should return to its caller. */
  readonly result: Decision;
  /** What the decision was. */
  readonly action: StagnationAction;
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
 * The detail every stagnation record carries.
 * @param suspicion - the cheap-path trigger.
 * @param verdict - what System 1 answered.
 * @param state - the deciding state, for turn and step.
 * @param step - the step the decision belongs to.
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
 * `tools/pre-execute`: refuse a call the run is repeating.
 *
 * The host calls this **after** its own `next()`, and hands over what that
 * returned: the downstream decision is the first fact the decision is about, and
 * a refusal may only ever be added to an allow.
 *
 * @param invocation - the downstream decision, the signal, and the window facts.
 * @param port - everything that is the host's to answer.
 * @returns the decision the Host dispatches on.
 */
export async function orchestrateStagnationPre<Decision, Corrected>(
  invocation: {
    /** Kind of the decision the rest of the waterfall made. */
    readonly downstreamKind: string;
    /** The call's abort signal, if it has one. */
    readonly signal?: AbortSignal;
    /**
     * The window the judgment is about, when a wait question needs one.
     *
     * Defaults to the progress-only window. A host that annotates its polls
     * supplies the annotated list here, because *how* a poll is labelled is the
     * host's business and the shared layer only asks the question.
     */
    judgeSteps?: () => readonly ObservedStep[];
    /** The question a promoted wait asks, or nothing for an ordinary repetition. */
    waitQuestion?: () => string | undefined;
    /** Whether this wait shape was already classified this turn. */
    waitClassified?: () => boolean;
    /** Latch the wait shape as classified. */
    latchWait?: () => void;
    /** The wait handle shape, so the trigger can name it. */
    waitShape?: () => { readonly shape: string; readonly repeats: number } | undefined;
    /** Record that this call was refused, so its result is not judged as evidence. */
    noteRefused?: () => void;
  },
  port: HostStagnationPort<Decision, Corrected>
): Promise<StagnationOutcome<Decision>> {
  const { signal } = invocation;
  const passThrough = (): StagnationOutcome<Decision> => ({ result: port.passThrough(), action: 'pass-through' });
  const mode = modeOf(port.policy(), STAGNATION_CAPABILITY);
  if (mode === 'off' || !port.serves()) return passThrough();
  if (signal?.aborted === true) return passThrough();

  const policy = port.policy();
  const pending = port.pendingStep();
  // The call about to run is part of its own window: three identical calls are a
  // repetition at the moment the third one is proposed, and the judgment has to
  // see all three.
  const allWindow = [...port.window(), pending];
  const window = progressSteps(allWindow);
  const signalValue = invocation.waitShape?.();

  // A wait-suspect call this turn already classified is answered by that verdict
  // rather than re-asked; anything else is only worth a question when it actually
  // repeats (the same threshold as any other repetition).
  if (signalValue !== undefined && invocation.waitClassified?.() === true) {
    port.skip('wait-query');
    return passThrough();
  }

  let suspicion = port.suspicion(window);
  let waitSuspected = false;
  if (signalValue !== undefined && signalValue.repeats >= policy.repeatThreshold) {
    suspicion = waitTrigger(signalValue.shape, signalValue.repeats);
    waitSuspected = true;
  }
  if (!suspicion.suspicious || port.alreadyDenied()) return passThrough();
  if (port.alreadyIntervened()) {
    port.skip('duplicate-intervention');
    return passThrough();
  }
  if (!actionWithinBudget(port.budget(), policy)) {
    port.skip('intervention-cap');
    return passThrough();
  }

  // A wait question is judged on the polls themselves (each labelled with its
  // place in the series, so the backend can read a wait rather than an exact
  // repeat); every other question keeps the progress-only window.
  const steps = waitSuspected ? (invocation.judgeSteps?.() ?? window) : window;
  const started = port.clock().now();
  const outcome = await runJudgment({
    state: port.budget(),
    policy,
    backend: port.backend(),
    clock: port.clock(),
    steps,
    ...(waitSuspected ? { goal: invocation.waitQuestion?.() } : {}),
    ...(signal === undefined ? {} : { signal })
  });
  const charge = chargeOf(outcome, started, port.clock().now());
  // Denial is latched per signature whether or not it was applied: in observe
  // mode the refusal is what would have happened, and the latch is what keeps the
  // next identical attempt from being judged again in the same turn.
  port.latchDenied();

  if (!outcome.useful) {
    if (waitSuspected) invocation.latchWait?.();
    // A budget/abort skip keeps its own reason; only a real "not stuck" answer to
    // a wait question is recorded as the wait outcome.
    port.chargeJudgment(charge);
    port.skip(outcome.skip ?? (waitSuspected ? 'wait-query' : 'unconfirmed'), charge);
    return passThrough();
  }

  const facts: StagnationFeedbackFacts = {
    tool: port.toolName(),
    suspicion,
    verdict: outcome.response
  };
  const plan: StagnationPlanRecord = {
    capability: STAGNATION_CAPABILITY,
    action: 'deny-call',
    reason: `System 1 confirmed ${outcome.response.patternType ?? suspicion.pattern} stagnation before ${port.toolName()}`,
    feedback: port.denyFeedback(facts),
    detail: detailOf(suspicion, outcome.response, port.budget().turn, port.budget().step)
  };
  const applies = mode === 'active' && mayAddDecision(invocation.downstreamKind);
  if (mode === 'active' && !applies) port.skip('downstream-decided');
  invocation.noteRefused?.();
  // The episode and the action are latched in both modes: observe has to plan
  // exactly what active would do — one refusal per episode, subject to the same
  // turn cap — or its column would over-count the very thing it is measuring.
  port.latchIntervened();
  bookAction(port.budget());
  port.conclude(plan, applies, charge);
  return applies
    ? { result: port.deny(plan.feedback), action: 'deny' }
    : passThrough();
}

/**
 * `agent/pre-step`: attach the correction to the step after a loop repeated
 * itself.
 *
 * The host calls this **after** its own `next()`. A step the rest of the
 * waterfall rejected, or a step whose turn is being cancelled, is not corrected.
 *
 * @param invocation - the downstream decision and the signal.
 * @param port - everything that is the host's to answer.
 * @returns the decision the loop enters with.
 */
export async function orchestrateStagnationStep<Decision, Corrected>(
  invocation: {
    /** Kind of the decision the rest of the waterfall made. */
    readonly downstreamKind: string;
    /** The step's abort signal, if it has one. */
    readonly signal?: AbortSignal;
  },
  port: HostStagnationPort<Decision, Corrected>
): Promise<StagnationOutcome<Decision | Corrected>> {
  const passThrough = (): StagnationOutcome<Decision | Corrected> => ({
    result: port.passThrough() as Decision | Corrected,
    action: 'pass-through'
  });
  const mode = modeOf(port.policy(), STAGNATION_CAPABILITY);
  if (mode === 'off' || !port.serves()) return passThrough();
  if (invocation.signal?.aborted === true || invocation.downstreamKind !== 'enter') return passThrough();

  // The last observation is read from the *raw* window, before waits are dropped:
  // a wait is exactly what this branch is about, so a window that had already
  // filtered it out could never recognize one. Everything after this reads the
  // progress-only window.
  const recorded = port.window();
  const last = recorded[recorded.length - 1];
  if (last === undefined) return passThrough();
  // A poll that already passed the semantic wait judgment has nothing to correct
  // here: the run asked about a background job again, it did not repeat its work.
  // A poll this turn never judged was not a repetition, so it is not an episode.
  if (last.wait === true) {
    port.skip(port.wasClassifiedAsWait(last.signature) ? 'wait-query' : 'wait-query-unjudged');
    return passThrough();
  }
  const window = port.progressWindow();
  if (port.alreadyIntervened()) {
    port.skip('duplicate-intervention');
    return passThrough();
  }
  const policy = port.policy();
  if (!actionWithinBudget(port.budget(), policy)) {
    port.skip('intervention-cap');
    return passThrough();
  }

  const suspicion = port.suspicion(window);
  if (!suspicion.suspicious) return passThrough();

  const started = port.clock().now();
  const outcome = await runJudgment({
    state: port.budget(),
    policy,
    backend: port.backend(),
    clock: port.clock(),
    steps: window,
    ...(invocation.signal === undefined ? {} : { signal: invocation.signal })
  });
  const charge = chargeOf(outcome, started, port.clock().now());
  if (!outcome.useful) {
    port.chargeJudgment(charge);
    port.skip(outcome.skip ?? 'unconfirmed', charge);
    return passThrough();
  }

  const facts: StagnationFeedbackFacts = {
    tool: port.toolName(),
    suspicion,
    verdict: outcome.response
  };
  const plan: StagnationPlanRecord = {
    capability: STAGNATION_CAPABILITY,
    action: 'corrective-context',
    reason: `System 1 confirmed ${outcome.response.patternType ?? suspicion.pattern} stagnation before step ${port.budget().step}`,
    feedback: port.contextFeedback(facts),
    detail: detailOf(suspicion, outcome.response, port.budget().turn, port.budget().step)
  };
  const applies = mode === 'active';
  // The latch is mode-independent on purpose. Observe has to consume the same
  // episode — one intervention per detected loop, one charge against the turn's
  // cap — or its accounting would describe a run nobody could reproduce;
  // installing the message is the only thing the mode gates.
  port.latchIntervened();
  bookAction(port.budget());
  port.conclude(plan, applies, charge);
  return applies
    ? { result: port.correct(plan.feedback), action: 'allow' }
    : passThrough();
}
