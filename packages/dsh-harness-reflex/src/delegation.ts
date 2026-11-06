import type { ChoiceRequest } from './vendor/harness-reflex/backend/types.js';
import type { DecisionLedger } from './vendor/harness-reflex/core/ledger.js';
import {
  EFFORT_AUDIT_TASK_CHARS,
  EFFORT_CHOICE_OPTIONS,
  levelOfChoiceOption,
  type AdaptiveEffortLevel
} from './effort.js';

/**
 * One System One judgement spent on "how deep should this delegated task be
 * thought through", before the task is handed to the DSH `subagent` tool.
 *
 * Only the reasoning level is decided here. The caller's `provider`/`model` are
 * passed straight through to the Host tool and are *not* validated in this
 * module: the Host's `assertAllowedModelSelection` owns that policy, and
 * duplicating it would be the second decision layer the goal forbids.
 *
 * @module dsh-reflex/delegation
 */

/** The model-facing arguments of `reflex_delegate`, in declaration order. */
export interface ReflexDelegateArgs {
  /** The task handed to the child agent. */
  prompt: string;
  /** Short display label for the delegated task. */
  description: string;
  /** Child LLM provider id; passed straight through to the DSH tool. */
  provider?: string;
  /** Exact model id within that provider; passed straight through. */
  model?: string;
  /** Initial child working directory; passed straight through. */
  cwd?: string;
}

/** The `reasoning_effort` vocabulary the DSH `subagent` tool declares. */
export type DelegationEffort = 'low' | 'medium' | 'high';

/**
 * The levels a delegation may carry.
 *
 * `off`, `minimal`, and `max` are intentionally absent: the DSH tool's own
 * `reasoning_effort` accepts a `low`/`medium`/`high` vocabulary, and accepting a
 * level the transport cannot express would force this layer to silently invent
 * a replacement — the second decision layer the goal forbids.
 */
export const DELEGATION_EFFORT_LEVELS: readonly DelegationEffort[] = ['low', 'medium', 'high'];

/**
 * Levels offered to System One, narrowest first.
 *
 * Three candidates is what makes the confidence floor meaningful: with two, a
 * uniform backend would answer `0.5`, which no simple "above one half" rule
 * separates from a real lean. The vendor descriptions (see
 * {@link EFFORT_CHOICE_OPTIONS}) are kept verbatim so the delegated decision
 * speaks the same scenario vocabulary as the per-turn one.
 */
export const DELEGATION_CHOICE_OPTIONS: readonly string[] = EFFORT_CHOICE_OPTIONS.filter((option) => {
  const level = levelOfChoiceOption(option);
  return level !== undefined && (DELEGATION_EFFORT_LEVELS as readonly string[]).includes(level);
});

/** How one delegation's level was reached, for the audit record. */
export type DelegationSource = 'system-one' | 'inherited';

/** Facts about the parent session that the fallback inherits from. */
export interface DelegationParentFacts {
  /** Parent's negotiated reasoning effort, when it has one. */
  readonly reasoningEffort?: string;
  /** Parent's model id, when it has one. */
  readonly model?: string;
}

/** The resolved delegation level plus everything needed to audit it. */
export interface DelegationDecision {
  /** The `low`/`medium`/`high` value handed to the DSH tool. */
  level: DelegationEffort;
  /** Whether System One decided it, or the parent's own effort was inherited. */
  source: DelegationSource;
  /** Confidence of the winning option; `0` for an inherited level. */
  confidence: number;
  /** Wall-clock milliseconds spent deciding. */
  latencyMs: number;
  /** Verbatim evidence the decision rested on. */
  basis: string[];
  /** Set when System One was unavailable, untrusted, or disagreed with itself. */
  degradedReason?: string;
}

/** Options of {@link decideDelegationEffort}. */
export interface DelegationDecisionOptions {
  /** Model-facing task text; the judgement's question. */
  readonly description: string;
  /** Model-facing task body; appended to the question. */
  readonly prompt: string;
  /** System One choice execution. */
  readonly decide: (request: ChoiceRequest) => Promise<{ bestOption?: unknown; confidence?: unknown }>;
  /** Minimum confidence for a System One answer to be trusted. */
  readonly minConfidence: number;
  /** Parent facts the fallback inherits from. */
  readonly parent: DelegationParentFacts;
  /** Monotonic clock, injectable for tests. */
  readonly now?: () => number;
}

/**
 * Build the System One question for one delegation.
 *
 * The description leads because it is the caller's own summary of the task, and
 * the prompt body follows, truncated. Neither is rewritten: unlike a turn input,
 * a delegated task is work to be done, not an instruction that might be quoted
 * back, so the P9 restatement cleanup does not apply here.
 * @param description - short task label.
 * @param prompt - task body.
 * @returns the question text.
 */
export function buildDelegationQuestion(description: string, prompt: string): string {
  const head = description.trim();
  const body = prompt.trim();
  const parts = [head, body].filter((part) => part.length > 0);
  return parts.join('\n\n').slice(0, EFFORT_AUDIT_TASK_CHARS * 4);
}

/**
 * Map any effort id onto the delegation vocabulary by rank.
 * @param effort - an effort id the parent may carry (`low`, `minimal`, `xhigh`, …).
 * @returns the nearest delegation level, or `undefined` when it names none.
 */
export function toDelegationEffort(effort: string | undefined): DelegationEffort | undefined {
  if (effort === undefined) return undefined;
  const normalized = effort.trim().toLowerCase();
  if (normalized === 'off') return undefined;
  if (normalized === 'minimal' || normalized === 'low' || normalized === 'medium') {
    return normalized === 'minimal' ? 'low' : (normalized as DelegationEffort);
  }
  // `high`, `xhigh`, `max`, and anything else the host may add all land on the
  // deepest level the transport can express.
  return 'high';
}

/**
 * Decide the reasoning level for one delegation.
 *
 * The chain is: System One → trust check → fallback. It never throws, because a
 * delegation whose level could not be decided must still be delegatable.
 *
 * The trust check has two parts, and both are needed for the same reason: a
 * confidence number alone is not evidence. An answer that merely ties the
 * uniform baseline (`1 / candidates`) carries no information at all — the
 * winner is then whichever option came first — and an answer below the
 * deployment's floor is too weak to act on. Either way the parent's own level
 * is inherited instead of invented, so a weak signal can never silently change
 * how deeply a child thinks.
 * @param options - task text, System One seam, floor, and parent facts.
 * @returns the decision, with the reason recorded when it degraded.
 */
export async function decideDelegationEffort(options: DelegationDecisionOptions): Promise<DelegationDecision> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const inherited = inheritParentEffort(options.parent);

  let response: { bestOption?: unknown; confidence?: unknown };
  try {
    response = await options.decide({
      question: buildDelegationQuestion(options.description, options.prompt),
      options: [...DELEGATION_CHOICE_OPTIONS],
      context: 'the work this delegated subagent has to finish; choose the reasoning depth it needs'
    });
  } catch (error) {
    return degraded(inherited, `system-one call failed: ${errorMessage(error)}`, started, now);
  }

  const option = String(response?.bestOption ?? '');
  const level = levelOfChoiceOption(option);
  if (level === undefined || !(DELEGATION_EFFORT_LEVELS as readonly string[]).includes(level)) {
    return degraded(inherited, `system-one answered with an unknown option: ${option.slice(0, 40) || '(empty)'}`, started, now);
  }

  const confidence = Number(response?.confidence);
  if (!Number.isFinite(confidence)) {
    return degraded(inherited, `system-one answered without a confidence: ${option.slice(0, 40)}`, started, now);
  }

  const uniform = 1 / DELEGATION_CHOICE_OPTIONS.length;
  if (confidence <= uniform) {
    return degraded(
      inherited,
      `system-one confidence ${confidence.toFixed(2)} does not beat the ${DELEGATION_CHOICE_OPTIONS.length}-way baseline ${uniform.toFixed(2)}`,
      started,
      now
    );
  }
  if (confidence < options.minConfidence) {
    return degraded(
      inherited,
      `system-one confidence ${confidence.toFixed(2)} is below the floor ${options.minConfidence.toFixed(2)}`,
      started,
      now
    );
  }

  return {
    level: level as DelegationEffort,
    source: 'system-one',
    confidence,
    latencyMs: elapsed(now(), started),
    basis: [option.trim().split(/\s+/, 1)[0] ?? level]
  };
}

/**
 * The level a delegation inherits when System One cannot be trusted.
 *
 * The parent's own effort is honoured rather than reset: a parent already
 * thinking at `high` does not hand a `medium` child the work it was made for.
 * A parent with no reasoning at all (or one at `off`) falls to `medium`, the
 * vendor default for "no evidence either way".
 * @param parent - parent facts.
 * @returns the inherited level.
 */
export function inheritParentEffort(parent: DelegationParentFacts): DelegationEffort {
  return toDelegationEffort(parent.reasoningEffort) ?? 'medium';
}

/**
 * Record one delegation level in the audit ledger.
 *
 * It lands in the same ledger as the per-turn decisions, tagged `kind:
 * 'delegation'` and attributed to the `reflex-delegate` backend, so
 * `/reflex-ledger` and the ledger summary separate the two without a second
 * sink to configure.
 * @param ledger - the activation's ledger.
 * @param decision - the decided level.
 * @param args - the model-facing arguments, for attribution.
 * @param parent - parent facts, for attribution.
 */
export function recordDelegationDecision(
  ledger: DecisionLedger,
  decision: DelegationDecision,
  args: ReflexDelegateArgs,
  parent: DelegationParentFacts
): void {
  try {
    ledger.record({
      type: 'effort-decision',
      backend: 'reflex-delegate',
      latencyMs: decision.latencyMs,
      details: {
        goal: args.description.trim().slice(0, EFFORT_AUDIT_TASK_CHARS) || '(no description)',
        kind: 'delegation',
        level: decision.level,
        applied: decision.level,
        source: decision.source,
        confidence: decision.confidence,
        basis: decision.basis,
        ...(args.provider === undefined ? {} : { provider: args.provider }),
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(parent.reasoningEffort === undefined ? {} : { parentEffort: parent.reasoningEffort }),
        ...(parent.model === undefined ? {} : { parentModel: parent.model }),
        ...(decision.degradedReason ? { degraded: decision.degradedReason } : {})
      }
    });
  } catch {
    // The ledger is an audit sink; losing an entry must never fail a delegation.
  }
}

/** Compose a degraded decision on the inherited level. */
function degraded(
  level: DelegationEffort,
  reason: string,
  started: number,
  now: () => number
): DelegationDecision {
  return {
    level,
    source: 'inherited',
    confidence: 0,
    latencyMs: elapsed(now(), started),
    basis: [`inherited ${level}`],
    degradedReason: reason
  };
}

/** Short, single-line rendering of a caught value. */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n', 1)[0]?.slice(0, 120) || 'unknown error';
}

/** Milliseconds since a monotonic start, never negative. */
function elapsed(now: number, started: number): number {
  const delta = now - started;
  return Number.isFinite(delta) && delta > 0 ? Math.round(delta) : 0;
}
