/**
 * The three-state policy and the shared action/judgment budgets.
 *
 * This is the harness-agnostic half of the intervention policy: given what the
 * deployment resolved (a mode per capability, a master switch, and the ceilings)
 * and the current turn's counters, it answers *may this capability act*, *may
 * this judgment be spent*, and *may one more action be planned*. It knows
 * nothing about hooks, payload shapes, or which host is calling.
 *
 * @module core/policy
 */

/** The three-state vocabulary every automatic capability shares. */
export const DECISION_MODES = ['off', 'observe', 'active'] as const;

/** One resolved three-state mode. */
export type DecisionMode = (typeof DECISION_MODES)[number];

/** The capability names the decision surface speaks in. */
export const DECISION_CAPABILITIES = ['stagnation', 'prune', 'gate', 'closing'] as const;

/** One automatic capability name. */
export type DecisionCapability = (typeof DECISION_CAPABILITIES)[number];

/**
 * The resolved policy the core reads.
 *
 * Structural on purpose: a host's own resolved config object satisfies it
 * without importing this module's types, and the core never sees the host's
 * configuration schema.
 */
export interface PolicySnapshot<Capability extends string = DecisionCapability> {
  /** Master switch: when false, no capability acts whatever its own mode says. */
  readonly enabled: boolean;
  /** The master three-state mode. */
  readonly mode: DecisionMode;
  /** Effective mode of every capability. */
  readonly capabilities: Readonly<Record<Capability, DecisionMode>>;
  /** Ceiling on planned/applied interventions per turn. */
  readonly maxInterventionsPerTurn: number;
  /** Ceiling on System 1 judgments per turn. */
  readonly maxJudgmentsPerTurn: number;
  /** Ceiling on System 1 judgments per session. */
  readonly maxJudgmentsPerSession: number;
  /** Identical consecutive calls required before a judgment is bought. */
  readonly repeatThreshold: number;
  /** Minimum verdict confidence for an action to be justified. */
  readonly minConfidence: number;
}

/** The counters one turn and one session spend from. */
export interface BudgetState {
  /** Interventions planned or applied in the current turn. */
  interventions: number;
  /** Judgments spent in the current turn. */
  judgmentsCount: number;
  /** Judgments spent in the current session. */
  judgmentsSession: number;
}

/** The minimal verdict shape the action gate reads. */
export interface VerdictLike {
  readonly isStuck?: boolean;
  readonly confidence: number;
  readonly patternType?: string;
  readonly latencyMs?: number;
}

/**
 * Effective mode of one capability.
 * @param policy - the resolved policy.
 * @param capability - the capability to ask about.
 * @returns its resolved three-state mode.
 */
export function modeOf<Capability extends string>(
  policy: PolicySnapshot<Capability>,
  capability: Capability
): DecisionMode {
  return policy.capabilities[capability];
}

/**
 * Whether a capability may run at all: the master switch is on and the capability
 * is not `off`.
 * @param policy - the resolved policy.
 * @param capability - the capability to ask about.
 * @returns whether it is observable or active.
 */
export function enabledCapability<Capability extends string>(
  policy: PolicySnapshot<Capability>,
  capability: Capability
): boolean {
  return policy.enabled && modeOf(policy, capability) !== 'off';
}

/**
 * Whether a hook serving one capability set must be registered at all.
 * @param policy - the resolved policy.
 * @param capabilities - capabilities the hook serves.
 * @returns whether at least one of them is not `off`.
 */
export function serves<Capability extends string>(
  policy: PolicySnapshot<Capability>,
  ...capabilities: Capability[]
): boolean {
  if (!policy.enabled) return false;
  return capabilities.some((capability) => modeOf(policy, capability) !== 'off');
}

/**
 * Whether this turn still has room for one more planned action.
 *
 * This is the *action* ceiling, and it is deliberately not the judgment budget:
 * a judgment is the question System 1 was asked, this is the number of things
 * the run is allowed to do about the answer. Every capability draws on the same
 * allowance, and both observe and active draw on it the same way.
 *
 * @param state - the deciding state's counters.
 * @param policy - the resolved policy.
 * @returns whether one more planned action fits this turn.
 */
export function actionWithinBudget(state: BudgetState, policy: PolicySnapshot): boolean {
  return state.interventions < policy.maxInterventionsPerTurn;
}

/**
 * Book one planned action against the turn's shared allowance.
 * @param state - the deciding state's counters.
 */
export function bookAction(state: BudgetState): void {
  state.interventions += 1;
}

/**
 * Spend one System 1 judgment against the turn's and the session's budget.
 *
 * Both budgets are spent at the one place a judgment is actually made, so a
 * capability cannot buy its way around them by calling a service directly. The
 * caller decides whether a refusal means "plan nothing" or "do not act"; what
 * matters here is that the count is never overrun and that a shadowed
 * application is charged like a real one.
 *
 * @param state - the deciding state's counters.
 * @param policy - the resolved policy.
 * @returns `undefined` when the judgment was spent, else the skip reason.
 */
export function spendJudgment(state: BudgetState, policy: PolicySnapshot): string | undefined {
  if (state.judgmentsCount >= policy.maxJudgmentsPerTurn) return 'judgment-turn-cap';
  if (state.judgmentsSession >= policy.maxJudgmentsPerSession) return 'judgment-session-cap';
  state.judgmentsCount += 1;
  state.judgmentsSession += 1;
  return undefined;
}

/**
 * Whether a verdict justifies acting: stuck, confident enough, and about a
 * pattern other than `none`.
 * @param response - the verdict.
 * @param policy - the resolved policy (for the confidence floor).
 * @returns whether the plan may be made.
 */
export function usefulVerdict(response: VerdictLike, policy: PolicySnapshot): boolean {
  return (
    response.isStuck === true &&
    response.confidence >= policy.minConfidence &&
    (response.patternType ?? 'none') !== 'none'
  );
}
