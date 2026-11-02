/**
 * The decisions every orchestrated capability asks its host for.
 *
 * ## Why this exists
 *
 * Four capabilities now share one orchestration layer (prune, stagnation,
 * correction, closing), and each of them asks its host the same handful of
 * questions: what policy is in force, which counters may move, how one abandoned
 * plan is recorded, how one plan is billed. Before this module, each `Host*Port`
 * re-declared that surface in its own words. The declarations agreed, but
 * nothing *made* them agree — a fourth capability would have been the fourth copy,
 * and a divergence between two ports meant to be the same would have had nowhere
 * to be caught.
 *
 * The shared surface is stated once, here. It is deliberately split into two
 * interfaces rather than one, because the corpus of four ports showed the two
 * halves have different reach:
 *
 * | Interface | Members | Who extends it |
 * |---|---|---|
 * | {@link HostDecisionPort} | `policy`, `budget`, `clock`/`now`, `serves` | **all four** |
 * | {@link HostBillingPort} | `skip`, `chargeJudgment`, `conclude` | the three that bill the same way |
 *
 * ## Why the billing channels are a second interface
 *
 * The judgment capabilities (stagnation, correction, closing) record an abandoned
 * plan as "reason + the judgment it cost" and bill an applied plan as "record +
 * applied + the judgment it rode on". All three are literally the same two calls,
 * so they share {@link HostBillingPort}.
 *
 * Pruning is **not** one of them, and this is the finding that stopped this batch
 * from collapsing everything into one interface. Its two billing channels are
 * genuinely wider:
 *
 * - `skip(reason, detail, judgment?)` — the `detail` is not a charge. It carries
 *   the payload diagnostics (`digest`, `floored`, `floorMissed`, the segment
 *   counts) that make *"why was nothing pruned"* answerable. Those fields are the
 *   reason the pruning audit trail exists at all.
 * - `conclude(plan, applied, costs, judgment?, locator?)` — `costs` carries the
 *   four size columns and the retained locator, i.e. every number that makes a
 *   claimed saving *verifiable*. Collapsing it into the judgment-capability shape
 *   would silently drop them.
 *
 * Fitting pruning to the common shape would therefore have required either
 * deleting audit fields or making the base `skip(reason, x?: unknown)`, which
 * buys nothing: every caller would cast, and the one place a wrong answer is a
 * model-visible regression would be the place the type stopped helping. Both were
 * rejected. Pruning extends only {@link HostDecisionPort}, states its two wider
 * channels in its own interface, and the divergence is documented there.
 *
 * ## The judgment is bought, not fetched
 *
 * A port never hands over a backend. It answers **one purchase at a time** —
 * {@link HostJudgmentPort#buy} for the stagnation verdict (bought by both the
 * stagnation and the correction capability, which ask the same question of the
 * same service), `classify`/`verify` for closing's two-request judgment, and
 * `judge(payload)` for pruning's reduction.
 *
 * The distinction matters because a port that exposes `backend()` forces every
 * caller to re-implement the purchase: the memo key, the budget check, the
 * local/remote latency split, and the billing. Those four are the shared layer's
 * — {@link ../judge.runJudgment} and each capability's own accounting — and they
 * are stated once. A host answers only "what did the service say, and how long
 * did it wait".
 *
 * ### One buy is one request; one charge may be several buys
 *
 * The unit of `buy` is the *request*, not the bill. The closing check buys twice
 * from one capability — a classification of the turn's sentences, then a
 * verification of the claims that classification accepted — but bills them as a
 * single {@link JudgmentCost} against the single slot the turn budget granted.
 * That fold is the shared layer's (`orchestrateClosing`), which is exactly why
 * the closing port must not be collapsing the two requests into one method: the
 * latency split and the token sum belong where the charge is built. For the
 * stagnation verdict one buy is one request and one charge.
 *
 * @module core/orchestrate-host
 */

import type { ActionStep, StagnationCheckResponse } from '../backend/types.js';
import type { ClockPort } from '../ports/clock.js';
import type { BudgetState, PolicySnapshot } from './policy.js';

/**
 * The charge of one judgment, as every capability bills it.
 *
 * Stated here rather than in one capability's module because all of them record
 * the same five columns, and the fifth (`judgeTokens`) is the one a host that
 * forgot it would quietly under-report.
 */
export interface JudgmentCost {
  readonly judgments: number;
  readonly memoHits: number;
  readonly localLatencyMs: number;
  readonly remoteLatencyMs: number;
  readonly judgeTokens: number;
}

/**
 * One judgment request: the window, plus the question it is put to.
 *
 * This is the whole of what a host is asked for when a judgment is bought. It is
 * a value rather than a port because the host's only job is "ask the service and
 * report what it said, latency included" — the memo key, the budget check, the
 * latency split and the charge stay with the caller that owns the counters.
 */
export interface JudgmentStep {
  /** Why the run is judged, when the caller knows (a wait question). */
  readonly goal: string | undefined;
  /** The observed steps to judge, oldest first. */
  readonly history: readonly ActionStep[];
}

/**
 * Where in the run one judgment is being made.
 *
 * This is the value the four capabilities used to each spell their own accessor
 * for (`position()`, `location()`, `turn()`, and two bare state reads). They
 * disagreed because a port should not answer it: every host has these two
 * numbers, every host means the same thing by them, and a judgment is *about*
 * one place. So the place travels with the judgment — never through the port.
 */
export interface JudgmentPosition {
  /** The turn this judgment belongs to. */
  turn: number;
  /** The step this judgment belongs to. */
  step: number;
}

/**
 * The counters every judgment capability keeps, positioned at where it decides.
 *
 * The place is part of the state for the three capabilities whose state *is* the
 * host's running record (the same object the trigger windows are kept in): the
 * audit detail, the retention request and the verdict memo all quote it, so one
 * source keeps them in step. The closing check is the exception, and the
 * exception is the finding: its turn is the boundary it was asked at, which can
 * be a turn no step has recorded yet, so it arrives as an input of that decision
 * instead (see `orchestrateClosing`).
 */
export interface JudgmentState extends BudgetState, JudgmentPosition {}

/**
 * What a capability that buys exactly one judgment asks its host for.
 *
 * The shape is one method over one value: the window and the question put to it
 * ({@link JudgmentStep}). The host answers what the service said, latency
 * included; the purchase around it — budget, memo, latency split, charge — is
 * the shared layer's.
 *
 * A capability that buys *differently* still states its buys in this form, one
 * member per request: closing answers `classify` and `verify`, pruning answers
 * `judge`. The rule is that a port states the purchases it makes and never the
 * transport behind them.
 *
 * @typeParam Answer - what this capability's service returns for one request.
 */
export interface HostJudgmentPort<Answer> {
  /**
   * Buy one judgment about one step.
   * @param step - the window to judge and the question it is asked in.
   * @returns the service's answer, carrying the latency the split is measured on.
   */
  buy(step: JudgmentStep): Promise<Answer>;
}

/**
 * What every orchestrated decision asks its host, whatever it decides.
 *
 * These four are the ones no capability can answer alone and no capability
 * answers differently: the policy is the host's resolved config, the counters are
 * the host's storage, the clock is the host's wall time, and the switch is the
 * host's.
 *
 * @typeParam State - the counters this decision spends from. Must extend
 *   {@link BudgetState}, because the shared budget rules mutate it through one.
 */
export interface HostDecisionPort<State extends BudgetState = BudgetState> {
  /** The resolved policy in force right now (re-read per decision). */
  policy(): PolicySnapshot;
  /**
   * The counters this decision spends from and books against.
   *
   * The shared layer mutates them in place through `core/policy`; a host that
   * stores its counters elsewhere hands over the object it wants mutated and
   * nothing else has to know where they live.
   */
  budget(): State;
  /** The clock, for the local-latency split. */
  clock(): ClockPort;
  /** Whether the decision applies at all (master switch on, capability not off). */
  serves(): boolean;
}

/**
 * The three accounting channels the judgment capabilities share.
 *
 * Extended by stagnation, correction and closing. See the module documentation
 * for why pruning is not one of them.
 *
 * @typeParam Charge - the judgment charge this capability bills.
 * @typeParam Record - the plan this capability records when it acts.
 */
export interface HostBillingPort<Charge = JudgmentCost, Record = unknown> {
  /**
   * Record one abandoned plan by reason.
   *
   * The charge is passed in because the record has to say what the refusal cost:
   * a paid "not this" and a free "budget spent" are different answers, and a skip
   * that reported both as free would understate the turn.
   */
  skip(reason: string, charge?: Charge): void;
  /**
   * Bill one judgment whose plan was abandoned after it was really made.
   *
   * A refusal before the judgment is bought costs nothing and is never billed
   * here. One that refused *after* it ran did spend, so hiding it would understate
   * what the turn cost.
   */
  chargeJudgment(charge: Charge): void;
  /**
   * Record one applied or observed plan.
   *
   * This is the one place a plan is billed: `plans` +1, `applied` +1 when it really
   * took effect, and every column of the charge.
   *
   * @param plan - what the capability decided.
   * @param applied - whether active mode executed it.
   * @param charge - the judgment this decision rode on.
   */
  conclude(plan: Record, applied: boolean, charge: Charge): void;
}
