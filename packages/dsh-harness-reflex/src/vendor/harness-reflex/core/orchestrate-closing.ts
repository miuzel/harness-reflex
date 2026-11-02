/**
 * The shared orchestration of the closing check.
 *
 * The fourth and last lift: {@link ./orchestrate} owns when a result is reduced,
 * {@link ./orchestrate-stagnation} owns when a call is refused and when a step is
 * corrected, {@link ./orchestrate-correction} owns what happens to a result that
 * failed — and this one owns what happens when a turn is about to *close* while
 * its own words claim success the evidence does not support.
 *
 * ```
 * agent/turn-stopping
 *   → off, or the host is not serving this capability → nothing at all
 *   → the turn said nothing, or no evidence is a failure → not suspicious, nothing at all
 *   → no candidate sentence → nothing at all
 *   → already latched for this turn → duplicate-intervention
 *   → the turn's action allowance is spent → intervention-cap
 *   → the caller's signal is aborted → nothing at all
 *   → assemble the evidence; truncation is NOTED and the decision continues
 *   → buy the classification (turn/session budgets inside)
 *   → the classifier could not answer → closing-claim-unavailable (fail open, locally)
 *   → nothing really claims completion → closing-no-claim (and the charge is kept)
 *   → buy the verification (same judgment, second request)
 *   → nothing contradicted → closing-undecided / closing-unconfirmed / closing-evidence-consistent
 *   → latch the turn, book the action, conclude
 *   → [the host steers the objection into the turn, in active mode only]
 *   → a failure anywhere after that → planning-error (fail open)
 * ```
 *
 * ## What is shared and what is not
 *
 * Shared here: the order above, every skip reason, the budget rules, the two
 * per-turn latches, the shape of the audit detail, and the decision that active
 * mode asks its host to steer.
 *
 * *Not* shared here: the act of steering (that is `HostClosingPort#steer`), the
 * wording the model reads (`#describe`), the storage of the evidence counters
 * (`#noteEvidence`), and the accumulation of the turn's own words — a host that
 * reads them from a stream and a host that reads them from a transcript both hand
 * over the same string.
 *
 * ## The two judgments are one decision
 *
 * The closing check buys **two** requests from one capability: a classification
 * of the turn's candidate sentences, and a verification of the claims that
 * classification accepted. They are one logical judgment — the classification
 * decides *whether* anything is worth verifying — so both are charged against the
 * single slot the turn budget allowed, and both are billed as one
 * {@link ClosingJudgment}. That fold is why this port states its two *purchases*
 * ({@link HostClosingPort#classify} and {@link HostClosingPort#verify}) and never
 * the transport behind them: a caller holding the service would have to
 * re-implement the purchase, the memo, the latency split and the billing, and the
 * one-charge rule is only stateable where the charge is built. It stays here.
 *
 * ## The skip that does not return
 *
 * Every skip in the other three modules ends the decision. `evidence-truncated`
 * does not: the evidence was assembled with some of it dropped, the amount is
 * reported, and the judgment proceeds on what survived. This module therefore
 * distinguishes a *note* (`#note`, which records) from a *refusal* (`#refuse`,
 * which records and returns). Collapsing the two would either stop the closing
 * check whenever evidence is large, or lose the fact that it was truncated.
 *
 * ## A verdict that could not decide is not a contradiction
 *
 * `escalate` means the backend could not answer — an unavailable service degrades
 * exactly this way. Steering a turn on an undecided verdict would turn a backend
 * failure into a model-visible objection, so only `contradicted` results steer;
 * `escalate` gets its own reason (`closing-undecided`) precisely so a run can tell
 * "the evidence was fine" from "nobody looked".
 *
 * @module core/orchestrate-closing
 */

import { claimCandidates } from './closing.js';
import { assembleEvidence, type EvidenceEntry } from './evidence.js';
import type { HostBillingPort, HostDecisionPort, JudgmentCost, JudgmentPosition } from './orchestrate-host.js';
import { actionWithinBudget, bookAction, spendJudgment } from './policy.js';
import { clip, estimateTokens } from './text.js';

/** The capability every decision in this module belongs to. */
export const CLOSING_CAPABILITY = 'closing' as const;

/** The audit action an objection is recorded under. */
export const CLOSING_ACTION = 'steer-closing' as const;

/**
 * The two latches this decision keeps, both keyed by turn rather than by identity.
 *
 * The other capabilities latch by *signature* — one repeated call is one episode.
 * A closing check has no such identity: the episode is the turn itself, so the
 * key is `closing:turn:<n>` and it is the host's storage that has to keep it.
 */
export const CLOSING_LATCH = {
  /** The turn was already objected to (or observed) — never twice per turn. */
  applied: (turn: number): string => `closing:turn:${turn}`,
  /** The memo namespace of the verification request, so a replay is free. */
  verdictKey: (agent: string, turn: number): string => `reflex-closing:${agent}:${turn}`
} as const;

/** One planned objection, as the host records it. */
export interface ClosingPlanRecord {
  readonly capability: typeof CLOSING_CAPABILITY;
  readonly action: typeof CLOSING_ACTION;
  readonly reason: string;
  feedback: string;
  readonly detail: Record<string, unknown>;
}

/**
 * The judgment one closing check rode on.
 *
 * Both requests are folded into one charge on purpose: the turn budget bought one
 * slot, and a reader of the account must not see two slots spent for one decision.
 * `localLatencyMs` is the wait the two requests cost in this process; the two
 * remote times are summed because the model was asked two questions.
 */
export interface ClosingJudgment extends JudgmentCost {}

/** What one closing check turned out to be. */
export type ClosingAction = 'objected' | 'pass-through';

/** What one orchestrated closing check produced. */
export interface ClosingOutcome {
  /** What the capability was in force: a decision is only made when this is not `off`. */
  readonly action: ClosingAction;
  /** The reason the check did nothing, when it did nothing. */
  readonly skip?: string;
  /** Every skip reason this one check reported, in order (normally 0 or 1). */
  readonly skips: readonly string[];
  /** The objection, once the decision is to make one. */
  readonly plan?: ClosingPlanRecord;
  /** Whether the objection was really steered (active mode only). */
  readonly applied: boolean;
  /** The message to hand the model, when the host steers in active mode. */
  readonly message?: string;
}

/** What the classification half answered. */
export interface ClaimClassificationLike {
  readonly results: readonly { readonly statement: string; readonly isClaim: boolean; readonly confidence: number }[];
  readonly latencyMs: number;
}

/** What the verification half answered. */
export interface ClosingVerdictLike {
  readonly passed: boolean;
  readonly results: readonly { readonly statement: string; readonly outcome: string; readonly confidence: number }[];
  readonly latencyMs: number;
}

/** What the objection is built from, for the host's wording. */
export interface ClosingFeedbackFacts {
  /** The contradicted statements, already clipped for quoting. */
  readonly contradicted: readonly string[];
  /** The turn that is closing. */
  readonly turn: number;
}

/** Everything the shared layer cannot know by itself. */
export interface HostClosingPort extends HostDecisionPort, HostBillingPort<ClosingJudgment, ClosingPlanRecord> {
  /** The effective mode of the `closing` capability. */
  mode(): 'off' | 'observe' | 'active';
  /**
   * The turn's own words, as the stream carried them.
   *
   * The host accumulates them (`agent/assistant-stream` in DSH); the shared layer
   * only asks for the string. An empty string means the turn said nothing, which
   * is one of the four deterministic reasons nothing is bought.
   */
  claims(): string;
  /**
   * Whether at least one retained evidence entry looks like a failure.
   *
   * A host computes this from its own reading of its results; the shared layer
   * needs only the boolean, because *which* result failed is what the judgment
   * reads, not what the trigger reads.
   */
  evidenceSuspect(): boolean;
  /** The evidence entries retained for this turn. */
  evidence(): readonly EvidenceEntry[];
  /** The evidence-assembly budget in force. */
  evidenceBudget(): number;
  /** Whether the caller's signal is already aborted (a cancelling turn). */
  aborted(): boolean;
  /** Whether this turn was already objected to (or observed) — the per-turn latch. */
  alreadyObjected(): boolean;
  /** Latch this turn as objected to. */
  latchObjected(): void;
  /** The identity the verification memo is namespaced by. */
  agentId(): string;
  /** The classification half of the one judgment. */
  classify(request: { readonly statements: readonly string[]; readonly context: string }): Promise<ClaimClassificationLike>;
  /** The verification half of the same judgment. */
  verify(
    claims: readonly { readonly statement: string }[],
    evidence: string,
    options: { readonly latchCacheKey: string }
  ): Promise<ClosingVerdictLike>;
  /** The confidence floor a classified sentence must clear to be a claim. */
  claimMinConfidence(): number;
  /** Word the objection the model reads. */
  describe(facts: ClosingFeedbackFacts): string;
  /** Hand the objection to the model. Only called in active mode. */
  steer(message: string): void;
  /** Record the evidence counters, which are engine-level rather than per-agent. */
  noteEvidence(stats: { readonly retainedChars: number; readonly truncatedChars: number }): void;
}

/** Opinion of one contradicted statement, clipped for the wording and the record. */
const STATEMENT_CHARS = 160;

/** How much of the assembled evidence the classifier is shown as context. */
const CLASSIFY_CONTEXT_CHARS = 600;

/**
 * Decide whether the turn that is closing contradicts its own evidence, and tell
 * the host what to do about it.
 *
 * The position is an *input of this decision*, not a port accessor and not a
 * counter. The turn here is the boundary being closed, which can be a turn no
 * step has recorded yet — a turn that said something and admitted no step — so it
 * cannot be read off the running counters. `step` is the step the engine last
 * recorded, which is the same number the audit detail has always quoted.
 *
 * @param invocation - where in the run this check is being made.
 * @param port - everything the shared layer cannot know by itself.
 * @returns what the check decided, and the message to steer when it applied.
 */
export async function orchestrateClosing(
  invocation: { readonly position: JudgmentPosition },
  port: HostClosingPort
): Promise<ClosingOutcome> {
  const mode = port.mode();
  const policy = port.policy();
  // The three "nothing at all" exits are deliberately silent: a turn with nothing
  // to say, or nothing to say it about, is not a refused decision and would fill
  // the skip histogram with entries that describe every turn ever run.
  if (mode === 'off' || !port.serves()) return silent();
  if (!port.evidenceSuspect()) return silent();
  const claimsText = port.claims();
  if (claimsText.length === 0) return silent();
  const candidates = claimCandidates(claimsText);
  if (candidates.length === 0) return silent();

  const state = port.budget();
  // One place in the run, quoted by the latch key, the memo namespace, the audit
  // detail and the wording alike.
  const { turn, step } = invocation.position;
  const skips: string[] = [];
  const refuse = (reason: string, charge?: ClosingJudgment): ClosingOutcome => {
    if (charge !== undefined) port.chargeJudgment(charge);
    port.skip(reason, charge);
    skips.push(reason);
    return { action: 'pass-through', skip: reason, skips: [...skips], applied: false };
  };
  // A note records a reason without ending the decision: `evidence-truncated` is
  // the one branch that reports something and keeps going.
  const note = (reason: string): void => {
    port.skip(reason);
    skips.push(reason);
  };

  if (port.alreadyObjected()) return refuse('duplicate-intervention');
  if (!actionWithinBudget(state, policy)) return refuse('intervention-cap');
  if (port.aborted()) return silent();

  const assembled = assembleEvidence(port.evidence(), port.evidenceBudget());
  port.noteEvidence({ retainedChars: assembled.retainedChars, truncatedChars: assembled.truncatedChars });
  if (assembled.truncatedChars > 0) note('evidence-truncated');

  const classificationSkip = spendJudgment(state, policy);
  if (classificationSkip !== undefined) return refuse(classificationSkip);

  const started = port.clock().now();
  let classification: ClaimClassificationLike;
  try {
    classification = await port.classify({
      statements: candidates,
      context: assembled.text.slice(0, CLASSIFY_CONTEXT_CHARS)
    });
  } catch {
    // FAIL-OPEN, locally: an unavailable classifier must not become a model-visible
    // objection, and it must never fall back to a word list. The spent slot is not
    // refunded — the judgment really was bought — but nothing is billed, because
    // no answer was received.
    return refuse('closing-claim-unavailable');
  }
  const floor = port.claimMinConfidence();
  const claims = classification.results
    .filter((item) => item.isClaim && item.confidence >= floor)
    .map((item) => ({ statement: item.statement }));
  const classifyTokens = candidates.reduce((sum, statement) => sum + estimateTokens(statement), 0);
  const classificationCharge: ClosingJudgment = {
    judgments: 1,
    memoHits: 0,
    localLatencyMs: Math.max(0, port.clock().now() - started - classification.latencyMs),
    remoteLatencyMs: classification.latencyMs,
    judgeTokens: classifyTokens
  };
  if (claims.length === 0) {
    // Paying for the classification and then finding nothing to verify is a
    // complete answer, not a failure: the charge is recorded with the skip.
    return refuse('closing-no-claim', classificationCharge);
  }

  const verdict = await port.verify(claims, assembled.text, {
    latchCacheKey: CLOSING_LATCH.verdictKey(port.agentId(), turn)
  });
  const judgeTokens =
    classifyTokens + claims.reduce((sum, item) => sum + estimateTokens(item.statement), estimateTokens(assembled.text));
  const judgment: ClosingJudgment = {
    judgments: 1,
    memoHits: 0,
    localLatencyMs: Math.max(0, port.clock().now() - started - verdict.latencyMs - classification.latencyMs),
    remoteLatencyMs: classification.latencyMs + verdict.latencyMs,
    judgeTokens
  };
  const contradicted = verdict.results
    .filter((item) => item.outcome === 'contradicted')
    .map((item) => clip(item.statement, STATEMENT_CHARS));
  const undecided = verdict.results.filter((item) => item.outcome === 'escalate').length;
  if (contradicted.length === 0) {
    return refuse(undecided > 0 ? 'closing-undecided' : verdict.passed ? 'closing-evidence-consistent' : 'closing-unconfirmed', judgment);
  }

  const plan: ClosingPlanRecord = {
    capability: CLOSING_CAPABILITY,
    action: CLOSING_ACTION,
    reason: `closing evidence contradicts ${contradicted.length} completion claim(s)`,
    feedback: port.describe({ contradicted, turn }),
    detail: { confidence: verdict.results[0]?.confidence, turn, step }
  };
  const applies = mode === 'active';
  // Latched in both modes, for the same reason as the other capabilities: the
  // episode is consumed once, and only the *steering* is gated on the mode. An
  // observe run that did not latch would buy the same judgment again at the next
  // boundary and describe a run nobody could reproduce.
  port.latchObjected();
  bookAction(state);
  port.conclude(plan, applies, judgment);
  if (!applies) return { action: 'objected', skips: [...skips], plan, applied: false };
  port.steer(plan.feedback);
  return { action: 'objected', skips: [...skips], plan, applied: true, message: plan.feedback };
}

/** The outcome of a check that decided nothing and has nothing to report. */
function silent(): ClosingOutcome {
  return { action: 'pass-through', skips: [], applied: false };
}

/**
 * The objection's wording, in the default form.
 *
 * Exported because a host that shows the text to the same audience may keep it
 * verbatim; a host that words it differently supplies its own through the port.
 * The statement clipping is the shared part: a contradicted claim is quoted at
 * 160 characters with its whitespace collapsed, so a multi-line claim can never
 * make the objection unbounded.
 * @param facts - what the objection is built from.
 * @param limit - the total character budget.
 * @returns the text handed to the model.
 */
export function describeClosing(facts: ClosingFeedbackFacts, limit: number): string {
  return clip(
    `Reflex closing check: this turn is about to close while its own tool results carry failures that contradict what it claims ` +
      `(${facts.contradicted.map((item) => `"${item}"`).join('; ')}). Before concluding, either fix the failing evidence or state the failure ` +
      `plainly instead of the completion claim.`,
    limit
  );
}

