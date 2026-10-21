import type { CandidateItem, DecisionLedger, RouteRequestState, RouteResponse } from './vendor/harness-reflex/index.js';

/**
 * System 1 virtual→physical model router.
 *
 * A *virtual provider* (default `reflex`) is a normal DSH provider route whose
 * models (`reflex-auto`, `reflex-fast`, …) are not physical endpoints at all:
 * each one owns a **candidate pool** of real `provider:model` targets. When a
 * request names the virtual route, {@link VirtualModelRouter} asks the System
 * One backend to rank the pool against the current task and returns the
 * winning physical target — a single-digit-millisecond decision with no
 * generative tokens.
 *
 * The router is deliberately free of any DSH/Cordis dependency: the System One
 * decision arrives as an injected `route` function and the audit as an
 * injected ledger, so the whole policy (pool resolution, degradation,
 * self-route refusal, confidence accounting) is unit-testable in isolation.
 *
 * @module dsh-reflex/router
 */

/** One physical `provider:model` pair. */
export interface PhysicalTarget {
  /** Registered DSH provider route. */
  provider: string;
  /** Provider-owned model id. */
  model: string;
}

/** One candidate inside a virtual model's pool. */
export interface ModelPoolEntry extends PhysicalTarget {
  /** Free-text capability note fed to the System One decision. */
  description?: string;
  /** Extra matching keywords fed to the System One decision. */
  tags?: readonly string[];
}

/** Virtual model id → ordered physical candidate pool. */
export type ModelPools = Readonly<Record<string, readonly ModelPoolEntry[]>>;

/** Why one routing decision was taken; also the degradation taxonomy. */
export type RoutingReason =
  | 'matched'
  | 'sticky-affinity'
  | 'fallback-empty-pool'
  | 'fallback-unknown-model'
  | 'fallback-no-candidate'
  | 'fallback-illegal-target'
  | 'fallback-invalid-name'
  | 'fallback-empty-model'
  | 'fallback-disabled';

/** Stable machine code for a routing refusal. */
export type RoutingFailureCode =
  | 'EMPTY_POOL'
  | 'UNKNOWN_MODEL'
  | 'NO_CANDIDATE'
  | 'ILLEGAL_TARGET'
  | 'INVALID_MODEL'
  | 'ROUTING_DISABLED';

/** Context the caller supplies about the request being routed. */
export interface RouteContext {
  /** Task text the System One decision reasons about (truncated by the caller). */
  task?: string;
  /** Session id of the requesting agent, recorded for audit. */
  agentId?: string;
  /** Whether the requesting agent is the main agent or a delegated subagent. */
  role?: 'main' | 'subagent';
  /** Delegation depth of the requesting agent when known (0 = top level). */
  delegationDepth?: number;
  /** Turn number of the request, recorded for audit. */
  turn?: number;
  /** Step number of the request, recorded for audit. */
  step?: number;
  /**
   * Physical target this session is already running on, when the caller knows
   * it. It is both the candidate the cache-affinity bias defends and the
   * baseline `switched` is computed against; absent on a session's first
   * routed request.
   */
  currentModel?: PhysicalTarget;
  /** Characters of session context accumulated so far (see {@link estimateContextTokens}). */
  contextChars?: number;
  /**
   * Tokens of session context accumulated so far. When omitted the router
   * derives one from {@link RouteContext.contextChars}.
   */
  contextTokens?: number;
}

/** One physical target chosen for a virtual model request. */
export interface RouteDecision {
  /** The virtual provider that was requested. */
  virtualProvider: string;
  /** The virtual model that was requested. */
  virtualModel: string;
  /** The physical route the request is rewritten to. */
  target: PhysicalTarget;
  /** Why this target was chosen (see {@link RoutingReason}). */
  reason: RoutingReason;
  /** Whether the pool could not answer and the configured fallback was used. */
  degraded: boolean;
  /** Number of candidates the decision ranked. */
  candidateCount: number;
  /** Ranked candidates with their raw System One scores. */
  candidates: Array<{ name: string; score: number; reason?: string }>;
  /** Raw System One score of the winner (0 when degraded). */
  score: number;
  /** Winner's share of the pool's total score, in 0–1 (0 when degraded). */
  confidence: number;
  /** End-to-end routing latency in whole milliseconds. */
  latencyMs: number;
  /** Task text the decision reasoned about, truncated for the ledger. */
  task?: string;
  /** `provider:model` the session used before this decision; absent on the first decision. */
  currentModel?: string;
  /** Whether this decision moves the session onto a different physical model. */
  switched: boolean;
  /** Tokens of session context this decision reasoned about (0 when unknown). */
  contextTokens: number;
  /** Characters the context token estimate was derived from (0 when unknown). */
  contextChars: number;
}

/** Refusal raised when a virtual model cannot be routed and no fallback exists. */
export class ReflexRoutingError extends Error {
  /** Stable machine code the caller can branch on. */
  readonly code: RoutingFailureCode;

  /**
   * @param code - stable machine code.
   * @param message - human-readable diagnosis.
   */
  constructor(code: RoutingFailureCode, message: string) {
    super(message);
    this.name = 'ReflexRoutingError';
    this.code = code;
  }
}

/**
 * Everything beyond the candidate list one routing decision prompt carries.
 * A seam that ignores it sees exactly the pre-affinity request.
 */
export interface RouteDecisionInput {
  /** Session facts handed to the decision (current model, accumulated context). */
  state: RouteRequestState;
  /** Cache-affinity policy the backend must carry into its prompt. */
  instructions: string;
}

/** Dependencies of {@link VirtualModelRouter}. */
export interface VirtualModelRouterOptions {
  /** Virtual provider route this router owns (e.g. `reflex`). */
  virtualProvider: string;
  /** Virtual model id → ordered candidate pool. */
  models: ModelPools;
  /** Physical target used when the pool cannot answer; absent = fail closed. */
  fallback?: PhysicalTarget;
  /**
   * System One decision seam: ranks candidates for a goal. Backed by
   * `ReflexRouter.selectBest` with ledger recording disabled (the router
   * writes its own richer `model-route` record). The fourth argument carries
   * the session facts and the cache-affinity instruction; a seam that omits it
   * simply decides without affinity.
   */
  route: (
    goal: string,
    candidates: CandidateItem[],
    topK: number,
    input?: RouteDecisionInput
  ) => Promise<RouteResponse>;
  /**
   * Relative score advantage a challenger needs before it may displace the
   * session's current model. Defaults to {@link DEFAULT_STICKY_MARGIN}; `0`
   * switches on any strict improvement.
   */
  stickyMargin?: number;
  /** Audit sink for one `model-route` entry per decision. */
  ledger?: DecisionLedger;
  /** Decision-backend name recorded on the ledger entry. */
  backendName?: string;
  /** Injectable clock, for deterministic latency in tests. */
  now?: () => number;
  /**
   * Refresh this router's live policy before it is read or used.
   *
   * A Host that commits a config-only update into the running plugin (the
   * Cordis loader's volatile path) never remounts it, so the router must be able
   * to re-read its pools and fallback on its own. The callback is expected to be
   * cheap when nothing changed: it is consulted by every routing decision and by
   * the panel projection, and a throwing callback must never block a decision.
   */
  refresh?: () => void;
}

/** Longest task text carried into a ledger entry. */
const LEDGER_TASK_CHARS = 160;

/**
 * Normalise an observed count to a non-negative integer.
 * @param value - a character or token count, possibly absent or unusable.
 * @returns the count, or `0`.
 */
function toCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Read the cache-affinity facts out of one request.
 * @param request - the routing request.
 * @returns the session's current model and its context size, in both units.
 */
function affinityOf(request: RouteContext): {
  currentName?: string;
  contextChars: number;
  contextTokens: number;
} {
  const contextChars = toCount(request.contextChars);
  return {
    ...(request.currentModel ? { currentName: formatTargetName(request.currentModel) } : {}),
    contextChars,
    contextTokens:
      request.contextTokens === undefined ? estimateContextTokens(contextChars) : toCount(request.contextTokens)
  };
}

/**
 * Split a `provider:model` candidate name.
 * @param name - candidate name from the routing decision.
 * @returns the parsed target, or `undefined` when the name is malformed.
 */
export function parseTargetName(name: string): PhysicalTarget | undefined {
  const separator = name.indexOf(':');
  if (separator <= 0 || separator === name.length - 1) return undefined;
  const provider = name.slice(0, separator).trim();
  const model = name.slice(separator + 1).trim();
  if (provider.length === 0 || model.length === 0) return undefined;
  return { provider, model };
}

/**
 * Render a physical target as the canonical `provider:model` string.
 * @param target - the physical route.
 * @returns `provider:model`.
 */
export function formatTargetName(target: PhysicalTarget): string {
  return `${target.provider}:${target.model}`;
}

/**
 * Parse a configured `provider:model` fallback.
 * @param value - authored fallback string.
 * @returns the parsed target.
 * @throws Error when the value is not a `provider:model` pair.
 */
export function parseFallback(value: string): PhysicalTarget {
  const target = parseTargetName(value.trim());
  if (!target) throw new Error(`routing.fallback must be "provider:model", got "${value}"`);
  return target;
}

/**
 * Characters per token used to turn an observed context size into a token
 * estimate. It is the usual English/code ratio; the estimate only has to be
 * monotone and order-of-magnitude right, because it feeds a *preference*, not a
 * hard limit.
 */
export const CONTEXT_CHARS_PER_TOKEN = 4;

/**
 * Fractional score advantage a challenger must reach before it may displace the
 * model a session already runs on. `0.15` means "clearly better than the
 * incumbent, not merely ahead of it", which is what makes a switch worth the
 * prompt-cache miss it causes.
 */
export const DEFAULT_STICKY_MARGIN = 0.15;

/**
 * Note appended to the description of the candidate a session already uses, so
 * a text-prompt backend can see which option costs nothing to keep.
 */
export const CURRENT_MODEL_NOTE = 'current model — keeping it preserves the prompt cache';

/** Cache-affinity facts one routing decision is built from. */
export interface CacheAffinityFacts {
  /** `provider:model` the session already uses, when known. */
  currentModel?: string;
  /** Whether the incumbent is one of this pool's candidates. */
  incumbentInPool: boolean;
  /** Tokens of session context accumulated so far. */
  contextTokens: number;
  /** Characters the token estimate was derived from. */
  contextChars: number;
}

/**
 * Estimate tokens from an observed character count.
 * @param chars - characters of context observed.
 * @returns the estimate, rounded up; `0` for an empty or unusable count.
 */
export function estimateContextTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / CONTEXT_CHARS_PER_TOKEN);
}

/**
 * Build the cache-affinity instruction prepended to a routing decision.
 *
 * The wording is the policy itself: staying on the current physical model
 * preserves the upstream prompt prefix cache, so a switch is only worth it when
 * the task clearly outgrows it. A session with no model yet gets the matching
 * first-choice wording instead, which seeds the cache the same way.
 *
 * @param facts - session model and accumulated context size.
 * @returns one sentence pair, or an empty string when there is nothing to steer.
 */
export function buildCacheAffinityInstruction(facts: CacheAffinityFacts): string {
  const context =
    facts.contextTokens > 0
      ? ` about ${String(facts.contextTokens)} tokens (${String(facts.contextChars)} characters)`
      : ' some';
  const preamble = `Prompt-cache affinity: this session has accumulated${context} of context.`;

  if (!facts.currentModel) {
    return `${preamble} No physical model is in use yet, so pick the candidate that fits the task best; the first choice seeds the prompt prefix cache.`;
  }
  if (!facts.incumbentInPool) {
    return `${preamble} It currently runs on ${facts.currentModel}, which is not a candidate here, so this pool already implies a cache miss — pick the candidate that fits the task best.`;
  }
  return `${preamble} It currently runs on ${facts.currentModel}, and staying on it keeps that prefix cached — prefer ${facts.currentModel} and switch away only when another candidate is clearly better suited to the task.`;
}

/**
 * Route virtual model requests onto physical provider/model targets.
 *
 * One instance belongs to one plugin activation; it holds the activation's
 * pools, fallback, System One seam and ledger, and mutates nothing shared.
 */
export class VirtualModelRouter {
  #virtualProvider: string;

  #models: ModelPools;
  #fallback?: PhysicalTarget;
  #refresh?: () => void;
  #refreshing = false;

  #route: VirtualModelRouterOptions['route'];
  #ledger?: DecisionLedger;
  #backendName: string;
  #now: () => number;
  #stickyMargin: number;

  /**
   * @param options - pools, fallback, decision seam, and audit sink.
   */
  constructor(options: VirtualModelRouterOptions) {
    this.#virtualProvider = options.virtualProvider;
    this.#models = options.models;
    this.#fallback = options.fallback;
    this.#refresh = options.refresh;
    this.#route = options.route;
    this.#ledger = options.ledger;
    this.#backendName = options.backendName ?? 'system-one';
    this.#now = options.now ?? (() => performance.now());
    this.#stickyMargin =
      options.stickyMargin === undefined || !Number.isFinite(options.stickyMargin)
        ? DEFAULT_STICKY_MARGIN
        : Math.max(0, options.stickyMargin);
  }

  /**
   * The virtual provider route currently in force.
   *
   * Live on purpose: a config-only save may rename the route without remounting
   * the activation, and every listener/panel read has to see the new name.
   * @returns the provider id this router currently owns.
   */
  get virtualProvider(): string {
    return this.#virtualProvider;
  }

  /**
   * Rename the virtual provider route.
   *
   * The router does not own the provider registration — the installer swaps the
   * registered adapter — so renaming is a policy change here: after it, only the
   * new name is recognised as this router's route.
   * @param provider - the new virtual provider route id.
   */
  setVirtualProvider(provider: string): void {
    this.#virtualProvider = provider;
  }

  /**
   * The virtual model pools currently in force.
   *
   * Deliberately a live read: the deployment's virtual-provider page edits a
   * config the Host commits *without* remounting the plugin, so a router that
   * kept the activation-time pools would route on a configuration the panel no
   * longer shows.
   * @returns the pools in authored order.
   */
  get models(): ModelPools {
    this.#ensureFresh();
    return this.#models;
  }

  /**
   * The physical fallback currently in force.
   * @returns the configured target, or `undefined` (fail closed).
   */
  get fallback(): PhysicalTarget | undefined {
    this.#ensureFresh();
    return this.#fallback;
  }

  /**
   * Replace the policy this router routes with.
   *
   * Used by the runtime when the Host commits a config-only update (pools and
   * fallback are the routing policy) and when a later activation takes the
   * process-wide route over. The decision seam, ledger and clock stay those of
   * the activation that owns this router.
   * @param policy - the new pools and fallback.
   */
  updatePolicy(policy: { models: ModelPools; fallback?: PhysicalTarget; backendName?: string }): void {
    this.#models = policy.models;
    this.#fallback = policy.fallback;
    if (policy.backendName !== undefined) this.#backendName = policy.backendName;
  }

  /**
   * Re-read the live policy, at most once per read when nothing changed.
   *
   * Re-entrancy is guarded: the refresh callback updates this router through
   * {@link updatePolicy}, which never reads the getters that call back here.
   */
  #ensureFresh(): void {
    const refresh = this.#refresh;
    if (refresh === undefined || this.#refreshing) return;
    this.#refreshing = true;
    try {
      refresh();
    } catch {
      // A config probe must never be able to veto a request or a panel read.
    } finally {
      this.#refreshing = false;
    }
  }

  /**
   * Relative score advantage this router demands before switching a session.
   * @returns the configured sticky margin.
   */
  get stickyMargin(): number {
    return this.#stickyMargin;
  }

  /** Whether this router owns the given provider route. */
  owns(provider: string): boolean {
    return provider === this.virtualProvider;
  }

  /** Virtual model ids in configured order. */
  get modelIds(): string[] {
    this.#ensureFresh();
    return Object.keys(this.#models);
  }

  /** Whether any virtual model has a usable candidate pool. */
  get hasPools(): boolean {
    return this.modelIds.some((model) => (this.#models[model] ?? []).length > 0);
  }

  /**
   * Candidate pool of one virtual model.
   * @param model - virtual model id.
   * @returns the pool, or `undefined` when the id is unknown.
   */
  poolFor(model: string): readonly ModelPoolEntry[] | undefined {
    this.#ensureFresh();
    return this.#models[model];
  }

  /**
   * Model-visible description of one virtual model, listing its targets.
   * @param model - virtual model id.
   * @returns a one-line description for catalog surfaces.
   */
  describe(model: string): string {
    this.#ensureFresh();
    const pool = this.#models[model] ?? [];
    if (pool.length === 0) return `System 1 virtual model (no physical candidates configured)`;
    const targets = pool.map((entry) => {
      const note = entry.description ? ` (${entry.description})` : '';
      return `${formatTargetName(entry)}${note}`;
    });
    return `System 1 routes each request to the best of ${pool.length} candidate(s): ${targets.join(', ')}`;
  }

  /**
   * Resolve one virtual request to a physical target and audit the decision.
   * @param request - requested virtual route plus the task context.
   * @returns the decision, including degradation facts when the pool failed.
   * @throws ReflexRoutingError when the pool cannot answer and no fallback is configured.
   */
  async routeModel(request: { provider: string; model: string } & RouteContext): Promise<RouteDecision> {
    this.#ensureFresh();
    const started = this.#now();
    const task = request.task?.trim();
    const { currentName, contextChars, contextTokens } = affinityOf(request);

    if (!this.owns(request.provider)) {
      throw new ReflexRoutingError(
        'ILLEGAL_TARGET',
        `router "${this.virtualProvider}" received provider "${request.provider}"`
      );
    }
    if (request.model.trim().length === 0) {
      return this.#degrade('INVALID_MODEL', `virtual model id must be non-empty`, request, started);
    }

    const pool = this.#models[request.model];
    if (pool === undefined) {
      return this.#degrade(
        'UNKNOWN_MODEL',
        `virtual model "${request.model}" is not declared in routing.models`,
        request,
        started
      );
    }
    if (pool.length === 0) {
      return this.#degrade(
        'EMPTY_POOL',
        `virtual model "${request.model}" has an empty candidate pool`,
        request,
        started
      );
    }

    // A current model that is not a candidate of this pool cannot be defended:
    // the pool already implies a switch, so the decision is a plain match.
    const incumbentName =
      currentName !== undefined && pool.some((entry) => formatTargetName(entry) === currentName)
        ? currentName
        : undefined;

    const candidates: CandidateItem[] = pool.map((entry) => {
      const name = formatTargetName(entry);
      const parts = [entry.description, ...(entry.tags ?? [])].filter(
        (part): part is string => !!part && part.length > 0
      );
      // The incumbent is marked on the candidate itself — both for a backend
      // that reads the flag and for one that only reads the description text.
      const isCurrent = name === incumbentName;
      if (isCurrent) parts.push(CURRENT_MODEL_NOTE);
      return { name, description: parts.join(' · '), ...(isCurrent ? { current: true } : {}) };
    });

    const affinity: CacheAffinityFacts = {
      ...(currentName ? { currentModel: currentName } : {}),
      incumbentInPool: incumbentName !== undefined,
      contextTokens,
      contextChars
    };
    const state: RouteRequestState = {
      ...(currentName ? { currentModel: currentName } : {}),
      contextTokens,
      contextChars
    };

    // The complete ranking is requested (not just the winner) so the winner's
    // share of the pool's total score is a real confidence, and so the ledger
    // carries the evidence the choice was made on.
    const ranked = await this.#route(task ?? `${request.provider}/${request.model}`, candidates, candidates.length, {
      state,
      instructions: buildCacheAffinityInstruction(affinity)
    });
    const best = ranked.bestCandidate;
    if (!best) {
      return this.#degrade('NO_CANDIDATE', `System 1 ranked no candidate for "${request.model}"`, request, started);
    }

    const held = incumbentName !== undefined ? this.#preferIncumbent(incumbentName, best, ranked) : best;
    const winner = held;
    const target = parseTargetName(winner);
    if (!target) {
      return this.#degrade('ILLEGAL_TARGET', `System 1 returned an unparsable target "${best}"`, request, started, ranked);
    }
    if (this.owns(target.provider)) {
      return this.#degrade(
        'ILLEGAL_TARGET',
        `candidate "${winner}" routes back into the virtual provider "${this.virtualProvider}"`,
        request,
        started,
        ranked
      );
    }

    const scores = ranked.rankedCandidates.map((candidate) => Math.max(0, candidate.score));
    const total = scores.reduce((sum, score) => sum + score, 0);
    const score = Math.max(0, ranked.rankedCandidates.find((candidate) => candidate.name === winner)?.score ?? 0);

    return this.#record(
      {
        virtualProvider: request.provider,
        virtualModel: request.model,
        target,
        reason: winner === best ? 'matched' : 'sticky-affinity',
        degraded: false,
        candidateCount: pool.length,
        candidates: ranked.rankedCandidates.map((candidate) => ({
          name: candidate.name,
          score: candidate.score,
          ...(candidate.reason === undefined ? {} : { reason: candidate.reason })
        })),
        score,
        confidence: total > 0 ? Number((score / total).toFixed(4)) : 0,
        latencyMs: Math.max(0, Math.round(this.#now() - started)),
        ...(task ? { task: task.slice(0, LEDGER_TASK_CHARS) } : {}),
        ...(currentName ? { currentModel: currentName } : {}),
        switched: currentName !== undefined && winner !== currentName,
        contextTokens,
        contextChars
      },
      request
    );
  }

  /**
   * Apply the prompt-cache affinity bias to one ranking.
   *
   * System 1 still chooses; this only decides whether its winner is *clearly*
   * better than the model the session already runs on. A challenger that merely
   * edges ahead (or ties) loses to the incumbent, because switching costs a
   * prompt-cache miss that the small score difference does not pay for. The
   * comparison is relative, so it behaves the same for logit margins and for
   * the 0–1 probabilities a probability backend returns.
   *
   * @param incumbent - `provider:model` the session is already using.
   * @param best - System 1's winner.
   * @param ranked - the complete ranking.
   * @returns the target to use: the incumbent, or System 1's winner.
   */
  #preferIncumbent(incumbent: string, best: string, ranked: RouteResponse): string {
    if (incumbent === best) return best;

    const scoreOf = (name: string): number =>
      Math.max(0, ranked.rankedCandidates.find((candidate) => candidate.name === name)?.score ?? 0);
    const incumbentScore = scoreOf(incumbent);
    const winnerScore = scoreOf(best);

    // Strictly better *and* past the margin; a tie never displaces a cached
    // prefix, and neither does an unranked (scoreless) incumbent compare equal.
    const clearlyBetter = winnerScore > incumbentScore && winnerScore >= incumbentScore * (1 + this.#stickyMargin);
    return clearlyBetter ? best : incumbent;
  }

  /**
   * Build the degraded decision, or fail closed when no fallback is configured.
   * @param code - failure code.
   * @param diagnosis - human-readable cause.
   * @param request - the original request.
   * @param started - routing start timestamp.
   * @param ranked - whatever the decision produced before degrading.
   * @returns the degraded decision when a fallback exists.
   * @throws ReflexRoutingError when no fallback exists.
   */
  #degrade(
    code: RoutingFailureCode,
    diagnosis: string,
    request: { provider: string; model: string } & RouteContext,
    started: number,
    ranked?: RouteResponse
  ): RouteDecision {
    if (!this.#fallback) {
      throw new ReflexRoutingError(
        code,
        `${diagnosis}; configure routing.fallback or a candidate pool for "${request.model}"`
      );
    }
    if (this.owns(this.#fallback.provider)) {
      throw new ReflexRoutingError(
        'ILLEGAL_TARGET',
        `routing.fallback "${formatTargetName(this.#fallback)}" points back into the virtual provider "${this.virtualProvider}"`
      );
    }

    const reason: RoutingReason =
      code === 'EMPTY_POOL'
        ? 'fallback-empty-pool'
        : code === 'UNKNOWN_MODEL'
          ? 'fallback-unknown-model'
          : code === 'INVALID_MODEL'
            ? 'fallback-empty-model'
            : code === 'NO_CANDIDATE'
              ? 'fallback-no-candidate'
              : 'fallback-illegal-target';

    const affinity = affinityOf(request);
    const chosen = formatTargetName(this.#fallback);

    return this.#record(
      {
        virtualProvider: request.provider,
        virtualModel: request.model,
        target: this.#fallback,
        reason,
        degraded: true,
        candidateCount: ranked?.rankedCandidates.length ?? this.#models[request.model]?.length ?? 0,
        candidates: ranked?.rankedCandidates.map((candidate) => ({
          name: candidate.name,
          score: candidate.score,
          ...(candidate.reason === undefined ? {} : { reason: candidate.reason })
        })) ?? [],
        score: 0,
        confidence: 0,
        latencyMs: Math.max(0, Math.round(this.#now() - started)),
        ...(request.task?.trim() ? { task: request.task.trim().slice(0, LEDGER_TASK_CHARS) } : {}),
        ...(affinity.currentName ? { currentModel: affinity.currentName } : {}),
        switched: affinity.currentName !== undefined && affinity.currentName !== chosen,
        contextTokens: affinity.contextTokens,
        contextChars: affinity.contextChars
      },
      request,
      diagnosis
    );
  }

  /**
   * Append the `model-route` audit entry and return the decision.
   * @param decision - the completed decision.
   * @param request - the original request (for agent attribution).
   * @param diagnosis - degradation diagnosis, when this decision degraded.
   * @returns the same decision.
   */
  #record(
    decision: RouteDecision,
    request: { provider: string; model: string } & RouteContext,
    diagnosis?: string
  ): RouteDecision {
    this.#ledger?.record({
      type: 'model-route',
      backend: this.#backendName,
      latencyMs: decision.latencyMs,
      details: {
        goal: decision.task ?? `${decision.virtualProvider}/${decision.virtualModel}`,
        virtual: `${decision.virtualProvider}:${decision.virtualModel}`,
        chosen: formatTargetName(decision.target),
        candidateCount: decision.candidateCount,
        candidates: decision.candidates.map((candidate) => candidate.name),
        scores: decision.candidates.map((candidate) => candidate.score),
        confidence: decision.confidence,
        reason: diagnosis ? `${decision.reason}: ${diagnosis}` : decision.reason,
        degraded: decision.degraded,
        // The cache-affinity audit: which model held the session before this
        // decision, whether it moved, and how large the context it defends was.
        currentModel: decision.currentModel ?? null,
        switched: decision.switched,
        contextTokens: decision.contextTokens,
        contextChars: decision.contextChars,
        ...(decision.reason === 'sticky-affinity' ? { affinity: 'held-current-model' } : {}),
        ...(request.agentId ? { agentId: request.agentId } : {}),
        ...(request.role ? { role: request.role } : {}),
        ...(request.delegationDepth === undefined ? {} : { delegationDepth: request.delegationDepth }),
        ...(request.turn === undefined ? {} : { turn: request.turn }),
        ...(request.step === undefined ? {} : { step: request.step })
      }
    });
    return decision;
  }
}

/** What an exact model route declares about reasoning effort. */
export type ReasoningSupport =
  | { kind: 'declared'; efforts: readonly string[]; defaultEffort?: string }
  | { kind: 'none' }
  | { kind: 'unknown' };

/** Look up one physical route's reasoning-effort declaration. */
export type ReasoningProbe = (target: PhysicalTarget) => Promise<ReasoningSupport>;

/**
 * Adapt a requested reasoning effort to the routed target.
 *
 * A virtual model is chosen without knowledge of the physical route's effort
 * vocabulary, so a preserved effort could reject the rewritten request with
 * `UNSUPPORTED_REASONING_EFFORT`. This projects it: keep a supported effort,
 * fall back to the target's declared default, drop it when the target declares
 * no reasoning at all, and leave it untouched when the capability is unknown
 * (the adapter then decides, as it would for any other route).
 *
 * @param requested - effort carried by the virtual request.
 * @param target - the routed physical target.
 * @param probe - capability lookup for the target.
 * @returns the effort the rewritten request should carry, or `undefined` to clear it.
 */
export async function alignReasoningEffort(
  requested: string | undefined,
  target: PhysicalTarget,
  probe: ReasoningProbe
): Promise<string | undefined> {
  if (requested === undefined) return undefined;

  let support: ReasoningSupport;
  try {
    support = await probe(target);
  } catch {
    return requested;
  }

  if (support.kind === 'unknown') return requested;
  if (support.kind === 'none') return undefined;
  if (support.efforts.includes(requested)) return requested;
  return support.defaultEffort;
}
