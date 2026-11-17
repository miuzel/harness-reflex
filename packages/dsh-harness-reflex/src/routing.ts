import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { isAgentLoopRequest, markAgentLoopRequest, type ContentBlock, type LlmCallConfig, type LlmRuntime, type UserMessage } from '@deepseek-ai/dsh-llm';

import type { EffortInterceptor, EffortResolution, ReflexEffortStatus } from './effort.js';
import { formatEffortStatusLine, EFFORT_CONTEXT_TURNS } from './effort.js';
import { appendEffortRecord } from './session-audit.js';
import { resolveAdaptiveIntent } from './adaptive-intent.js';
import type { PhysicalTarget, ReasoningProbe, RouteContext, VirtualModelRouter } from './router.js';
import { alignReasoningEffort, estimateContextTokens } from './router.js';
import { ReflexVirtualAdapter } from './virtual-adapter.js';

/**
 * Install the virtual provider route and the interception layers that route its
 * requests through System 1.
 *
 * Layer 1 — `agent/pre-step` (waterfall): the loop fixes the step's route and
 * reasoning effort from `this.model.current()` *before* it dispatches anything,
 * and `agent/request` may no longer propose a different one (DSH 0.2.2 rejects
 * it: "a replacement may adjust controls but must keep the provider, model, and
 * reasoning effort selection"). So the decision is taken here instead, and
 * written into `payload.modelSelection` — the same object `dsh-agent-loop`
 * keeps as its local `selection`, which is what `prepareRequest` compares the
 * request against. See {@link installModelRouting} for why that write is safe.
 *
 * Layer 2 — the same decision chooses the turn's reasoning effort. A selection
 * carrying the `reflex`/`auto` marker (or a deployment that configured the
 * marker) has no physical effort id yet; {@link EffortInterceptor} turns it into
 * one, projects it onto the routed model's vocabulary, audits it in the session
 * log, and publishes it to the status feed. A selection that named a concrete
 * effort is only re-worded to fit the routed model — never adapted.
 *
 * Layer 3 — the virtual adapter's `stream()`: anything that does not pass
 * through layer 1 (hand-built one-shot calls, `prepareCall()` consumers) is
 * routed at dispatch time and delegated to the physical adapter through
 * `ctx.llm.stream`.
 *
 * The task text each decision reasons about is the step's own user messages: a
 * subagent's first step carries its delegated task, so a delegated agent routes
 * on *its own* task rather than inheriting its parent's decision.
 *
 * The listener also accumulates each agent's *session size* (characters of step
 * input seen so far), and every routed step remembers the physical model it
 * landed on. Both ride into the next decision as cache-affinity facts, so a
 * session that already holds a warm prompt prefix is not moved onto another
 * physical model for a marginal score difference.
 *
 * `agent/request` is still listened to, but strictly read-only: it awaits the
 * rest of the waterfall and hands the configuration back untouched. It is kept
 * because the listener is the only place that can *observe* the configuration
 * the loop really uses, and a future audit may want it — it must never write a
 * field again.
 *
 * @module dsh-reflex/routing
 */

/** Dependencies of {@link installModelRouting}. */
export interface ModelRoutingOptions {
  /** LLM runtime to register the virtual route on and dispatch through. */
  llm: LlmRuntime;
  /** Pool policy and System 1 decision seam. */
  router: VirtualModelRouter;
  /** Per-turn adaptive reasoning-effort policy. */
  effort: EffortInterceptor;
  /**
   * Whether this activation should register the virtual provider route. `false`
   * (a deployment with routing disabled, or with no pool) still installs the
   * request listeners, so the adaptive-effort layer keeps working, but never
   * registers a route or rewrites one. Defaults to `true`.
   */
  route?: boolean;
  /**
   * Task-text budget captured from `agent/pre-step` (characters).
   *
   * A getter keeps the budget live: a config-only save may change
   * `routing.maxTaskChars` between steps, and the next step must capture with
   * the new value before the schema is re-resolved.
   */
  maxTaskChars: number | (() => number);
  /**
   * Read the live routing policy for the enable/disable and rename lifecycle.
   * Omitted means the initial {@link route} decision is final.
   */
  liveRouting?: () => LiveRoutingPolicy;
  /**
   * Pull the activation's live config, if the host commits config-only saves.
   *
   * Called once at the start of every `agent/pre-step`: the implementation
   * compares the volatile snapshot identities and re-resolves only when the
   * loader actually committed a change, so an unchanged step pays a handful of
   * identity comparisons and no schema run. This is what makes an effort-only
   * deployment (no route to refresh lazily) pick up a settings edit on its next
   * step even if the event were missed.
   */
  refreshConfig?: () => unknown;
  /** Diagnostic sink for non-fatal degradation (never throws). */
  warn?: (message: string) => void;
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One adaptive reasoning-effort decision was applied to a request. Fired for
     * every decided turn; carries the same payload that is committed to the
     * session log, so a status bar and the audit trail cannot disagree.
     * @param payload - the decided level, the effort dispatched, and the evidence.
     * @mode emit
     */
    'reflex/effort'(payload: ReflexEffortStatus): void;
  }
}

/** Routing policy facts the lifecycle reconciler reads. */
export interface LiveRoutingPolicy {
  /** Deployment `routing.enabled` switch. */
  enabled: boolean;
  /** Current virtual provider route id. */
  virtualProvider: string;
  /** Task capture budget in characters. */
  maxTaskChars: number;
  /** Pools that decide whether a route can be installed at all. */
  models: import('./router.js').ModelPools;
}

/** What {@link installModelRouting} installed. */
export interface ModelRoutingInstallation {
  /**
   * The router actually in force. With several activations on one runtime the
   * first activation owns the process-wide virtual route and later activations
   * route through the owner's policy, so every path agrees on the pools.
   */
  router: VirtualModelRouter;
  /** The adapter registered for the virtual route, when this activation owns it (live). */
  readonly adapter?: ReflexVirtualAdapter;
  /** Whether this call registered the virtual provider route itself. */
  readonly registered: boolean;
  /** How many `registerAdapter` calls this activation has made in total. */
  readonly registrationEvents: number;
  /**
   * Apply a freshly resolved routing policy: register/unregister the route and
   * rename the virtual provider to match. Idempotent; a same-value refresh
   * touches no registration.
   */
  refresh(policy: LiveRoutingPolicy): void;
  /** Detach the listeners and release the route when this call owned it. */
  dispose: () => void;
}

/** Nothing to undo. */
const NOOP = (): void => {};

/**
 * One process-wide virtual route this plugin has registered.
 *
 * `owners` counts the activations that still route through it. Two activations
 * exist at once when a reload is applied as "create the new activation, then
 * dispose the old one" (or with two entries of the same plugin). The provider
 * route must survive the first release in that ordering, and the newest
 * activation's policy must be the one in force — otherwise the new activation
 * routes on the old, about-to-be-released pools and then loses the route
 * entirely once the old activation disposes.
 *
 * There is deliberately one shared {@link ReflexVirtualAdapter} whose router all
 * owners route through: two `agent/pre-step` listeners each deciding a step's
 * route cannot hold two different policies, because the outer one runs after the
 * inner one already wrote its decision into the same selection object.
 */
interface OwnedRoute {
  /** Provider route this entry is registered under. */
  provider: string;
  /** The registered adapter, shared by every owner. */
  adapter: ReflexVirtualAdapter;
  /** Live activations routing through this adapter. */
  owners: number;
  /** Unregister the provider route, called when the last owner goes away. */
  handle: () => void;
}

/**
 * Stable process-wide identity of one LLM runtime.
 *
 * The service handle a context hands out (`ctx.llm`) is a fresh tracing wrapper
 * on every read, so it must never be a map key: two activations would each see
 * "no route yet" and the second would collide with `DUPLICATE_ADAPTER`. The
 * wrapper's owning root context is stable for every read of the same runtime.
 * @param llm - the runtime handle the activation was given.
 * @returns a key that is the same object for every activation on that runtime.
 */
function routeScope(llm: LlmRuntime): object {
  const root = (llm as unknown as { ctx?: { root?: object } }).ctx?.root;
  return root ?? (llm as unknown as object);
}

/**
 * Virtual routes already owned in this process, keyed by the root context of
 * the LLM runtime that holds them. A DSH deployment can activate this plugin
 * more than once (one activation per tool prefix); provider routes are
 * process-wide, so the first activation registers and the rest join its route
 * instead of colliding with `DUPLICATE_ADAPTER`.
 */
const OWNED_ROUTES = new WeakMap<object, Map<string, OwnedRoute>>();

/** Most agent-scoped tasks retained for routing; bounded so a long session cannot grow without limit. */
const MAX_TRACKED_AGENTS = 64;

/**
 * What one activation remembers about one agent between requests.
 *
 * `contextChars` is the running character count of the step input this
 * activation has observed for the agent — a monotone lower bound on the
 * session's real context (assistant and tool text are produced after the step
 * that caused them). It is deliberately an observation, not a session-log
 * read: routing must not depend on the session module's internal event shapes.
 */
interface AgentRoutingFacts {
  /** Task text captured on the agent's latest step. */
  task?: string;
  /** Physical model the agent's latest routed request landed on. */
  currentModel?: PhysicalTarget;
  /** Characters of step input observed for this agent so far. */
  contextChars: number;
  /** The decision this turn already made, reused by its later steps. */
  decided?: TurnDecision;
  /** Adaptive effort this layer dispatched most recently, used to recognise a header echo. */
  lastAdaptiveEffort?: string;
  /**
   * One entry per earlier turn that carried user text, oldest first — the
   * observed turn text the continuation path may grade a short reply against.
   *
   * This is an *observation* like every other fact here, not a session-log read:
   * routing must not depend on the session module's internal event shapes. Only
   * the turn number and the captured text are kept, and the list is bounded by
   * the effort layer's own window, so a long session cannot grow it without limit.
   */
  turns?: TrackedTurn[];
}

/** One earlier turn's captured task text. */
interface TrackedTurn {
  /** Turn the text was observed on. */
  turn: number;
  /** Joined user text of that turn, as captured by `agent/pre-step`. */
  text: string;
}

/** One decided turn, kept so a same-turn follow-up step costs nothing. */
interface TurnDecision {
  turn: number;
  provider: string;
  model: string;
  /**
   * Virtual model the decision was taken for.
   *
   * A later step of the same turn reuses the decision only when it names the
   * same virtual model: a caller that selects a different model mid-turn asked
   * for a different pool, and replaying the old target would ignore that.
   */
  virtualModel?: string;
  /** Effort the rewritten request carried; `undefined` when the key was cleared. */
  effort?: string;
  /** The published status of that decision. */
  status?: ReflexEffortStatus;
  /**
   * Effort policy generation the decision was taken under.
   *
   * A config-only save can land mid-turn; a follow-up step may reuse the cached
   * decision only when no policy change happened between them, otherwise the
   * new `fallback`/`minConfidence`/switch would be shadowed by a decision the
   * user already replaced.
   */
  generation?: number;
}

/**
 * Read the reasoning-effort vocabulary of one physical route.
 * @param llm - the runtime that owns the adapter for the target.
 * @param resolve - raw model-info lookup; defaults to the runtime's own.
 * @returns a probe that never throws.
 */
function createReasoningProbe(llm: LlmRuntime, resolve?: (provider: string, model: string) => Promise<LlmResolvedModelInfoLike>): ReasoningProbe {
  const lookup = resolve ?? ((provider: string, model: string) => llm.resolveModelInfo(provider, model) as unknown as Promise<LlmResolvedModelInfoLike>);
  return async (target) => {
    let info;
    try {
      info = await lookup(target.provider, target.model);
    } catch {
      return { kind: 'unknown' };
    }
    const reasoning = info?.reasoning;
    if (!reasoning || reasoning.efforts.length === 0) return { kind: 'none' };
    return {
      kind: 'declared',
      efforts: reasoning.efforts.map((effort) => effort.id as unknown as string),
      ...(reasoning.defaultEffort ? { defaultEffort: reasoning.defaultEffort as unknown as string } : {})
    };
  };
}

/** The slice of a resolved model the reasoning probe reads. */
interface LlmResolvedModelInfoLike {
  reasoning?: { efforts: readonly { id: unknown }[]; defaultEffort?: unknown };
}

/**
 * Agent identity facts the routing decision records.
 * @param agent - the requesting agent (possibly a synthetic test double).
 * @returns the audit attribution, never throwing.
 */
function describeAgent(agent: Agent): Pick<RouteContext, 'agentId' | 'role' | 'delegationDepth'> {
  const facts: Pick<RouteContext, 'agentId' | 'role' | 'delegationDepth'> = {};
  try {
    if (typeof agent?.id === 'string' && agent.id.length > 0) facts.agentId = agent.id;
    const header = (agent as { session?: { header?: { origin?: string; delegationDepth?: number } } })?.session?.header;
    facts.role = header?.origin === 'subagent' ? 'subagent' : 'main';
    if (typeof header?.delegationDepth === 'number') facts.delegationDepth = header.delegationDepth;
  } catch {
    // A synthetic or partially-built agent must never break the request path.
  }
  return facts;
}

/**
 * Report one effort decision to the two audit surfaces.
 *
 * Both are strictly best-effort: the decision has already been applied to the
 * request, and a full log, a hostile listener, or a detached agent must not turn
 * an audit problem into a failed turn.
 *
 * @param ctx - the plugin context (the emit reaches every subscriber of this host).
 * @param agent - the requesting agent, whose session receives the log record.
 * @param status - the decision payload.
 */
function reportEffort(ctx: Context, agent: Agent, status: ReflexEffortStatus): void {
  appendEffortRecord((agent as { session?: unknown } | undefined)?.session, status);
  try {
    ctx.emit('reflex/effort', status);
  } catch {
    // A status carrier must never be able to veto a turn.
  }
}

/** Effort id that means "let System 1 decide the level for this turn". */
const ADAPTIVE_EFFORT_MARKER = 'reflex';

/** Whether one effort value is the adaptive marker (or its accepted alias). */
function isAdaptiveMarker(value: string | undefined): boolean {
  return value === ADAPTIVE_EFFORT_MARKER || value === 'auto';
}

/** Whether a provider is a virtual route owned by this plugin on this runtime. */
function ownedVirtualProvider(llm: LlmRuntime, provider: string): boolean {
  return OWNED_ROUTES.get(routeScope(llm))?.has(provider) === true;
}

/**
 * The live policy facts the adaptive-effort surface reads.
 *
 * Kept structural rather than tied to {@link EffortInterceptor}: the surface
 * only needs the two values, and a caller that has them as getters gets the
 * live behaviour for free.
 */
export interface AdaptiveEffortPolicySource {
  /** Deployment `reasoningEffort` marker, or `undefined` when none is configured. */
  readonly setting: string | undefined;
  /** Deployment `effort.enabled` switch. */
  readonly enabled: boolean;
}

/** What {@link installAdaptiveEffortSurface} installed. */
export interface AdaptiveEffortSurface {
  /** Whether the deployment defaults virtual routes to the adaptive strategy. */
  readonly adaptive: boolean;
  /** Restore the original runtime methods. */
  dispose: () => void;
}

/**
 * Teach the LLM runtime that `reflex` is a selectable reasoning effort.
 *
 * This is the S4 fix, and it is deliberately a *runtime* change rather than a
 * plugin-local one: the model selector is built by the Host from
 * `llm.resolveModelInfo(...).reasoning.efforts`, and the selection round trip
 * goes through `llm.resolveCallConfig(...)`. A model therefore "offers Reflex
 * (Auto)" exactly when these two calls say so for that exact route.
 *
 * Three surfaces are wrapped:
 *
 * - `resolveModelInfo` gains the `reflex` entry (first, so it reads as the
 *   default) for every route that declares at least one real effort. A model
 *   that declares none is returned untouched, which is why a non-thinking model
 *   shows no effort at all instead of a dead "Reflex (Auto)" choice.
 * - `resolveCallConfig` accepts the marker for a thinking model, clears it for a
 *   model that cannot think, and injects it only for an owned virtual route
 *   when the deployment enables adaptive effort.
 * - `prepareCall` translates any marker that survived to this last gate into
 *   something the physical adapter accepts, so no code path can hand
 *   `reasoningEffort: "reflex"` to a provider that never heard of it.
 *
 * With `effort.enabled` off the surface installs nothing that can be *chosen*:
 * the marker is not appended to any model's effort list, so a selector stops
 * offering "Reflex (Auto)", and every path that still carries a marker — a
 * persisted selection, a deployment setting, a hand-built call — has it cleared
 * at the last gate instead of being translated to a level the adapter supports.
 * The runtime is still wrapped rather than left alone, because a marker that
 * survives to `prepareCall` must never reach a physical provider.
 *
 * The two policy facts are read through the live interceptor on every call
 * rather than captured here, so a config-only save (the loader commits new
 * volatile values without remounting the plugin) changes what the selector
 * offers and what an unpinned virtual request inherits on the very next call.
 *
 * @param ctx - plugin context (kept for API compatibility).
 * @param llm - the LLM runtime to extend.
 * @param policy - live effort policy (`setting` + `enabled`) of the activation.
 * @returns the installed surface, whose `dispose()` restores the runtime.
 */
export function installAdaptiveEffortSurface(
  _ctx: Context,
  llm: LlmRuntime,
  policy: AdaptiveEffortPolicySource
): AdaptiveEffortSurface {
  const runtime = llm as unknown as Record<string, unknown>;
  const originalResolveModelInfo = llm.resolveModelInfo.bind(llm);
  const originalResolveCallConfig = llm.resolveCallConfig.bind(llm);
  const originalPrepareCall = llm.prepareCall.bind(llm);

  /** Whether one exact route can think at all. */
  const supportsThinking = async (provider: string, model: string, signal?: AbortSignal): Promise<boolean> => {
    try {
      const info = await originalResolveModelInfo(provider, model, signal);
      const efforts = (info as unknown as LlmResolvedModelInfoLike)?.reasoning?.efforts;
      return Array.isArray(efforts) && efforts.length > 0;
    } catch {
      return false;
    }
  };

  runtime.resolveModelInfo = async (provider: string, model: string, signal?: AbortSignal) => {
    const info = await originalResolveModelInfo(provider, model, signal);
    // The switch is off: the plugin's own effort option is revoked, so no
    // selector can offer a mode this activation will not honour.
    if (!policy.enabled) return info;
    const reasoning = (info as unknown as LlmResolvedModelInfoLike)?.reasoning;
    if (!reasoning || reasoning.efforts.length === 0) return info;
    const efforts = reasoning.efforts as readonly { id: unknown }[];
    if (efforts.some((effort) => isAdaptiveMarker(String(effort.id)))) return info;
    return {
      ...info,
      reasoning: {
        ...reasoning,
        efforts: [{ id: ADAPTIVE_EFFORT_MARKER, name: 'Reflex (Auto)', description: 'System 1 adaptive reasoning effort, decided per turn' }, ...efforts]
      }
    };
  };

  runtime.resolveCallConfig = async (config: LlmCallConfig, signal?: AbortSignal) => {
    const requested = config.reasoningEffort as unknown as string | undefined;

    if (!policy.enabled) {
      // Nothing is injected for an owned virtual route, and a marker is stripped
      // instead of accepted: the call resolves with the provider's own default,
      // which is the only "adaptive effort" a disabled deployment can have.
      if (!isAdaptiveMarker(requested)) return originalResolveCallConfig(config, signal);
      const cleared = await originalResolveCallConfig(
        { ...config, reasoningEffort: undefined } as LlmCallConfig,
        signal
      );
      return { ...cleared, reasoningEffort: undefined };
    }

    if (isAdaptiveMarker(requested)) {
      const resolved = await originalResolveCallConfig(
        { ...config, reasoningEffort: undefined } as LlmCallConfig,
        signal
      );
      // A model that cannot think has no adaptive mode to be in: the marker is
      // dropped rather than forwarded, which is what keeps a non-thinking route
      // from failing with UNSUPPORTED_REASONING_EFFORT.
      if (!(await supportsThinking(resolved.provider, resolved.model, signal))) {
        return { ...resolved, reasoningEffort: undefined };
      }
      return { ...resolved, reasoningEffort: ADAPTIVE_EFFORT_MARKER as LlmCallConfig['reasoningEffort'] };
    }

    const resolved = await originalResolveCallConfig(config, signal);

    // No session identity is available at this runtime seam. Never infer a
    // physical request's intent from another session's model-selection event.
    // Virtual unpinned requests can inherit the deployment policy; physical
    // adaptive requests must carry their own explicit reflex/auto marker.
    if (requested === undefined && isAdaptiveMarker(policy.setting) &&
        ownedVirtualProvider(llm, resolved.provider)) {
      return { ...resolved, reasoningEffort: ADAPTIVE_EFFORT_MARKER as LlmCallConfig['reasoningEffort'] };
    }

    return resolved;
  };

  runtime.prepareCall = async (config: LlmCallConfig, signal?: AbortSignal, configure?: unknown) => {
    const requested = config.reasoningEffort as unknown as string | undefined;
    if (!isAdaptiveMarker(requested)) {
      return originalPrepareCall(config, signal, configure as never);
    }
    // Last gate before dispatch: the marker is an intent, never an effort any
    // physical adapter can accept, so it is resolved here for the paths that
    // never went through the `agent/pre-step` decision (hand-built one-shot
    // calls, `prepareCall` consumers). With the switch off there is no policy to
    // resolve it *to*, so it is deleted and the provider default applies.
    if (!policy.enabled) {
      const cleared = { ...config } as LlmCallConfig;
      delete (cleared as { reasoningEffort?: unknown }).reasoningEffort;
      return originalPrepareCall(cleared, signal, configure as never);
    }
    const info = await supportsThinking(config.provider, config.model, signal);
    const aligned = info
      ? await alignReasoningEffort(ADAPTIVE_EFFORT_MARKER, { provider: config.provider, model: config.model }, createReasoningProbe(llm, (provider, model) => originalResolveModelInfo(provider, model, signal)))
      : undefined;
    const next = { ...config } as LlmCallConfig;
    if (aligned === undefined) delete (next as { reasoningEffort?: unknown }).reasoningEffort;
    else next.reasoningEffort = aligned as LlmCallConfig['reasoningEffort'];
    return originalPrepareCall(next, signal, configure as never);
  };


  try {
    (llm as unknown as { emitAdaptersUpdated?: () => void }).emitAdaptersUpdated?.();
  } catch {
    // A catalog refresh is advisory.
  }

  let disposed = false;
  return {
    get adaptive() {
      return policy.enabled && isAdaptiveMarker(policy.setting);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      runtime.resolveModelInfo = originalResolveModelInfo;
      runtime.resolveCallConfig = originalResolveCallConfig;
      runtime.prepareCall = originalPrepareCall;
      try {
        (llm as unknown as { emitAdaptersUpdated?: () => void }).emitAdaptersUpdated?.();
      } catch {
        // Same.
      }
    }
  };
}

/** The `source` of a DSH message, as far as the notice filter reads it. */
interface MessageSourceLike {
  kind?: string;
  form?: string;
  summary?: string;
}

/** First text block of one message, or `''`. */
function textOfMessage(message: unknown): string {
  const blocks = (message as { content?: readonly ContentBlock[] } | undefined)?.content;
  if (!Array.isArray(blocks)) return '';
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}

/**
 * Whether one pre-step message is the model-switch notice for the *virtual* route.
 *
 * Routing a virtual model rewrites the request onto a physical target, so the
 * durable request header records the physical route while the user's selection
 * stays virtual. `installModelSelection` compares exactly those two and — seeing
 * a difference that is not a model change at all — appends "the session
 * continues with `reflex/…`" to every step. The notice states something false,
 * it costs context tokens on every single step, and it is not a user action, so
 * it is dropped here.
 *
 * The predicate is deliberately narrow: a genuine physical↔physical switch is
 * left alone, because its notice *is* true and the model needs it to interpret
 * the turns above it.
 *
 * @param message - one admitted pre-step message.
 * @param virtualProvider - the virtual provider route id.
 * @param virtualModels - the virtual model ids.
 * @returns whether the message is the pseudo-switch notice.
 */
export function isVirtualModelSwitchNotice(
  message: unknown,
  virtualProvider: string,
  virtualModels: readonly string[]
): boolean {
  const source = (message as { source?: MessageSourceLike } | undefined)?.source;
  if (source?.kind !== 'model-selection' || source.form !== 'notice') return false;

  const summary = typeof source.summary === 'string' ? source.summary : '';
  const text = textOfMessage(message);
  const arrow = summary.lastIndexOf('→');
  const named =
    (arrow >= 0 ? summary.slice(arrow + 1) : '').trim() ||
    (text.match(/continues with ([^\]]+)\]/)?.[1] ?? '').trim();
  if (named.length === 0) return false;

  if (named.startsWith(`${virtualProvider}/`)) return true;
  if (virtualModels.includes(named)) return true;
  return named.split('/')[0] === virtualProvider;
}

/**
 * Drop the pseudo-switch notices from one pre-step decision.
 * @param decision - the decision returned by the inner waterfall.
 * @param virtualProvider - the virtual provider route id.
 * @param virtualModels - the virtual model ids.
 * @returns the decision, with the false notices removed when there were any.
 */
export function filterVirtualSwitchNotices<T extends { messages?: readonly unknown[] }>(
  decision: T,
  virtualProvider: string,
  virtualModels: readonly string[]
): T {
  const messages = decision?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return decision;
  const kept = messages.filter((message) => !isVirtualModelSwitchNotice(message, virtualProvider, virtualModels));
  if (kept.length === messages.length) return decision;
  return { ...decision, messages: kept };
}

/**
 * How long one step's route/effort decision may take before the step is
 * admitted with its selection untouched.
 *
 * The decision costs a System 1 round trip (routing) plus, adaptively, a second
 * one (effort). Real backends answer in tens of milliseconds; this bound only
 * exists so a hung or unreachable backend cannot stall a turn before its first
 * token. Timing out is a *degradation*, not an error: the step runs on the
 * adapter's own defaults, exactly like a deployment that never configured the
 * layer, and the next step tries again.
 */
const STEP_DECISION_TIMEOUT_MS = 4000;

/**
 * The budget one step's decision actually gets.
 *
 * `REFLEX_STEP_DECISION_TIMEOUT_MS` overrides the default so a test can prove
 * the timeout path without waiting four seconds; an unset or unparseable value
 * keeps {@link STEP_DECISION_TIMEOUT_MS}.
 *
 * @returns the budget in milliseconds.
 */
function stepDecisionBudget(): number {
  const raw = Number(process.env.REFLEX_STEP_DECISION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : STEP_DECISION_TIMEOUT_MS;
}

/** What {@link planStep} decided for one step. */
interface StepPlan {
  /** Physical provider route to write into the step's selection. */
  provider?: string;
  /** Physical model id to write into the step's selection. */
  model?: string;
  /**
   * Effort to write into the step's selection.
   *
   * An own-property `undefined` is a deliberate *clear* (the decision removed an
   * effort the selection carried); an absent key means the decision had nothing
   * to say about the effort, so the selection keeps its own.
   */
  reasoningEffort?: string | undefined;
}

/**
 * Run a decision but let nothing it does escape an enclosing `try`.
 *
 * Everything the decision needs from its payload is read by {@link planStep}
 * before the first `await`, so the attempt can safely be abandoned: a decision
 * that loses the timeout race keeps running detached, and a rejection it meets
 * afterwards lands in a no-op handler instead of becoming an unhandled rejection
 * that would take the Host down.
 *
 * @param run - the decision to start.
 * @returns a promise that settles exactly once and never rejects.
 */
function startDecision(run: () => Promise<StepPlan | undefined>): Promise<StepPlan | undefined> {
  const attempt = Promise.resolve().then(run);
  attempt.catch(NOOP);
  return attempt;
}

/**
 * Race one decision against a deadline.
 *
 * The timer is unref'd and cleared on every path, so neither a settled decision
 * nor an abandoned one keeps the process alive or leaks a handle.
 *
 * @param attempt - the decision, already started.
 * @param ms - budget in milliseconds.
 * @returns the decision, or `undefined` when the budget ran out first.
 */
function withBudget<T>(attempt: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const finish = (value: T | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), ms);
    // Node keeps the process alive for a pending timer; a decision that never
    // answers must not turn into a hung host.
    (timer as unknown as { unref?: () => void }).unref?.();
    attempt.then(finish, () => finish(undefined));
  });
}

/**
 * Write one plan into the step's selection object.
 *
 * `payload.modelSelection` is `Readonly<ModelSelection>` in the contract, but
 * that is a compile-time marker only: DSH 0.2.2 does not freeze the object at
 * runtime, and mutating it here mutates `dsh-agent-loop`'s own local `selection`,
 * which is what its `prepareRequest` guards compare against. That is the whole
 * point of {@link installModelRouting}'s pre-step decision, and there is no
 * other seam — `agent.model.select()` records a selection that only the *next*
 * `current()` reads, and `current()` for this step has already been called.
 * The write therefore goes through a mutable view of the same object, and a
 * payload frozen by an embedder raises `TypeError`, which the caller catches.
 *
 * @param selection - the step's selection (the loop's `selection` object).
 * @param plan - the decided route and effort.
 */
function applyPlan(
  selection: Readonly<{ provider: string; model: string; reasoningEffort?: unknown }>,
  plan: StepPlan
): void {
  const target = selection as { provider: string; model: string; reasoningEffort?: unknown };
  if (plan.provider !== undefined) target.provider = plan.provider;
  if (plan.model !== undefined) target.model = plan.model;
  if (!('reasoningEffort' in plan)) return;
  if (plan.reasoningEffort === undefined) delete target.reasoningEffort;
  else target.reasoningEffort = plan.reasoningEffort;
}

/**
 * The provider route the caller composed this agent with.
 *
 * `agent.options` is the durable intent: it is what the model selector was set
 * to, and unlike the step's selection it is never overwritten by a physical
 * route this layer chose for one step.
 *
 * @param agent - the stepping agent.
 * @returns the composed provider id, or `undefined` when it carries none.
 */
function intendedProvider(agent: Agent): string | undefined {
  try {
    const provider = (agent as { options?: { provider?: unknown } })?.options?.provider;
    return typeof provider === 'string' && provider.length > 0 ? provider : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The virtual model the caller composed this agent with.
 * @param agent - the stepping agent.
 * @returns the composed model id, or `undefined` when it carries none.
 */
function intentModel(agent: Agent): string | undefined {
  try {
    const model = (agent as { options?: { model?: unknown } })?.options?.model;
    return typeof model === 'string' && model.length > 0 ? model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether one agent is a delegated subagent.
 *
 * `effort-delegation.ts` treats a positive `delegationDepth` as authoritative and
 * falls back to `origin: 'subagent'`; this check has to agree with it, or a
 * child whose depth was recorded but whose origin was not would have its effort
 * decided here *and* inherited there.
 *
 * @param agent - the stepping agent.
 * @returns whether the agent was delegated.
 */
function isDelegatedAgent(agent: Agent): boolean {
  try {
    const header = (agent as { session?: { header?: { origin?: string; delegationDepth?: number } } })?.session?.header;
    if (typeof header?.delegationDepth === 'number') return header.delegationDepth > 0;
    return header?.origin === 'subagent';
  } catch {
    return false;
  }
}

/** Everything {@link planStep} reads from the installation. */
interface StepPlanInput {
  /** Plugin context (the status emitter and the projection reader). */
  ctx: Context;
  /** The stepping agent. */
  agent: Agent;
  /** Turn the step belongs to. */
  turn: number | undefined;
  /** Step number in that turn. */
  step: number | undefined;
  /** The turn's cancellation signal. */
  signal?: AbortSignal;
  /** The selection the loop fixed for this step. */
  selection: Readonly<{ provider: string; model: string; reasoningEffort?: unknown }>;
  /** Router currently in force. */
  router: VirtualModelRouter;
  /** Live effort policy. */
  effort: EffortInterceptor;
  /** Whether these listeners may re-route at all. */
  routes: boolean;
  /** Per-installation memory. */
  facts: Map<string, AgentRoutingFacts>;
  /** Reasoning-vocabulary lookup of a physical route. */
  probe: ReasoningProbe;
}

/**
 * Decide one step's route and reasoning effort.
 *
 * This is the body the `agent/request` waterfall used to run (g-056). It
 * resolves the caller's durable intent, routes a virtual request through System
 * 1, then either adapts the effort (marker present) or aligns it onto the routed
 * model's vocabulary (concrete level). The order is preserved exactly —
 * intent → route → effort — because the effort is projected onto the model the
 * route actually chose.
 *
 * Reuse is part of the contract, not an optimisation: `agent/pre-step` runs once
 * per *step*, while a decision costs up to two System 1 round trips. A later step
 * of the same turn reuses the turn's plan, which is also why a turn can no longer
 * change its physical model mid-way.
 *
 * @param input - the step, its selection, and the installation's live seams.
 * @returns the plan to write, or `undefined` when the step needs no change.
 */
async function planStep(input: StepPlanInput): Promise<StepPlan | undefined> {
  const { ctx, agent, router, effort, routes, signal, selection, facts, probe } = input;

  // Everything below this line is read synchronously, before the first `await`,
  // so an abandoned (timed-out) attempt cannot observe a payload that moved on.
  if (signal?.aborted) return undefined;

  // The selection is the step's starting configuration; `resolveAdaptiveIntent`
  // may replace the virtual route and effort with the caller's durable intent.
  const base: LlmCallConfig = {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort as LlmCallConfig['reasoningEffort'] })
  };
  const config = resolveAdaptiveIntent(ctx, agent, base, (provider) => router.owns(provider));

  const remembered = recallFacts(facts, agent);
  const requested = config.reasoningEffort as unknown as string | undefined;
  const task = remembered?.task;

  // With `effort.enabled` off this layer manages no effort at all: it still
  // routes, but the only edit it is allowed to make to `reasoningEffort` is
  // removing its own marker. That keeps a concrete level byte-identical on its
  // way to the adapter, and it means no decision, no audit entry and no status
  // can be produced for a deployment that switched the layer off.
  const effortOff = effort.enabled === false;

  // Reflex only automatically adapts reasoning effort when the effort was
  // explicitly chosen as reflex/auto, or when an unpinned request names the
  // virtual provider (which defaults to adaptive effort). If the user selected
  // High, Low, Medium, Off, or Provider Default, reflex does not touch effort.
  // A delegated agent's effort was already settled by `effort-delegation.ts` on
  // its own selection, so this layer must not adapt it here either.
  const delegated = isDelegatedAgent(agent);

  const isAdaptive =
    !effortOff &&
    !delegated &&
    (isAdaptiveMarker(requested) ||
      (requested === undefined && router.owns(config.provider) && isAdaptiveMarker(effort.setting)));

  // Same-turn follow-up steps (step > 1) reuse the turn's decision: no second
  // System 1 call, no second effort event, 0ms latency. The turn is the unit of
  // decision — a later step carrying user text is still the same turn, so it
  // does not break the reuse (g-063).
  const isFollowupStep =
    (input.step ?? 1) > 1 &&
    remembered?.decided !== undefined &&
    remembered.decided.turn === input.turn &&
    // A config-only save may replace the policy mid-turn; a decision taken
    // under the previous policy is not this turn's answer any more.
    remembered.decided.generation === effort.generation;

  // Whether this step belongs on the virtual route. It cannot be read off the
  // step's *selection*: this layer writes the physical target into that object,
  // and the loop records it as the session's latest selection (the request header
  // retires the pending choice), so every later step starts from a physical
  // provider this router does not own. Asking the selection would make routing
  // stop after the first step, which is why the question is asked of the
  // caller's durable intent — the agent's composed options — and of the intent
  // `resolveAdaptiveIntent` just recovered from the selection projection.
  const intent = intendedProvider(agent);
  const stepOwnsRoute = router.owns(config.provider);
  const onVirtualRoute = routes && ((intent !== undefined && router.owns(intent)) || stepOwnsRoute);
  // The route name to hand `routeModel`: the step's own when it still names the
  // virtual provider, otherwise the router's current name (the intent path).
  const virtualProviderForStep = stepOwnsRoute ? config.provider : router.virtualProvider;

  const plan: StepPlan = {};

  // Reuse only applies while the step is still *on the virtual route*: a caller
  // that has switched the session onto a physical model (or pinned a concrete
  // effort on one) must never have that decision replayed over its own choice.
  const sameVirtualModel = remembered?.decided?.virtualModel === undefined || remembered.decided.virtualModel === config.model;
  if (remembered?.decided && isFollowupStep && sameVirtualModel && onVirtualRoute) {
    // The turn's route and effort, replayed exactly: re-routing a later step
    // would move a warm session between physical models mid-turn.
    const reuse = remembered.decided;
    if (onVirtualRoute) {
      plan.provider = reuse.provider;
      plan.model = reuse.model;
    }
    if (reuse.effort !== undefined) plan.reasoningEffort = reuse.effort;
    return plan;
  }

  let routed = config;
  let switched: boolean | undefined;
  let heldForCache: boolean | undefined;
  if (onVirtualRoute) {
    // The virtual *model* to route is the one the caller's durable intent names,
    // which `resolveAdaptiveIntent` has already folded into `config` (it
    // prefers the session's pending selection over the step's own). Using
    // `selection.model` here would instead route on whatever this layer wrote
    // into the previous step, i.e. on a physical id it cannot route at all.
    const virtualModel = config.model;
    const decision = await router.routeModel({
      provider: virtualProviderForStep,
      model: virtualModel,
      task,
      ...describeAgent(agent),
      turn: input.turn,
      step: input.step,
      // Cache-affinity facts: the model this session already holds and how
      // much context it is defending.
      ...(remembered?.currentModel ? { currentModel: remembered.currentModel } : {}),
      ...(remembered === undefined ? {} : { contextChars: remembered.contextChars }),
      contextTokens: estimateContextTokens(remembered?.contextChars ?? 0)
    });
    routed = { ...config, provider: decision.target.provider, model: decision.target.model };
    switched = decision.switched;
    heldForCache = decision.reason === 'sticky-affinity';
    plan.provider = decision.target.provider;
    plan.model = decision.target.model;
    rememberTarget(facts, agent, decision.target);
  }

  // A routed turn is recorded even when no effort was decided: its later steps
  // must reuse the physical target instead of asking System 1 again, or a turn
  // could migrate between models on every tool call.
  const settle = (effortToWrite: string | undefined, changed: boolean): StepPlan | undefined => {
    if (plan.provider !== undefined) {
      rememberDecision(
        facts,
        agent,
        input.turn,
        routed,
        { changed, ...(effortToWrite === undefined ? {} : { effort: effortToWrite }), outcome: 'passthrough' },
        effort.generation,
        config.model
      );
    }
    if (changed) plan.reasoningEffort = effortToWrite;
    return Object.keys(plan).length === 0 ? undefined : plan;
  };

  if (!isAdaptive) {
    if (effortOff) {
      // Transparent pass-through: the selection keeps the caller's own level
      // (never aligned, never snapped onto the routed model's vocabulary), and
      // the plugin's marker is dropped instead of being translated — the
      // adapter then applies the provider default, which is the only safe
      // reading of "reflex" once the adaptive layer is switched off.
      return settle(undefined, isAdaptiveMarker(requested));
    }
    // A delegated selection keeps exactly the effort it fixed: not aligned, not
    // snapped. The selection layer has already made sure this value is a
    // concrete level the adapter accepts.
    if (delegated || requested === undefined) return settle(requested, false);
    // Concrete effort (high, low, off...): align if needed, never adapt! This is
    // the *non-adaptive* branch, and it moves here for the same reason the
    // adaptive one does — alignment is still a rewrite of the fixed value, which
    // `agent/request` may no longer make.
    const aligned = await alignReasoningEffort(requested, { provider: routed.provider, model: routed.model }, probe);
    return settle(aligned, aligned !== requested);
  }

  const resolution = await effort.resolve({
    requested,
    target: { provider: routed.provider, model: routed.model },
    probe,
    task,
    // Earlier turns of this agent: since g-063 every decision sees them, inside
    // the effort layer's window, so a short prompt is graded against the work it
    // continues instead of on its own few characters.
    ...(remembered?.turns?.length ? { history: remembered.turns.map((entry) => ({ text: entry.text })) } : {}),
    // The level the last adaptive decision produced. It was recorded since g-056
    // to recognise a header echo and nothing ever read it; g-063 makes it the
    // decision input's prior, so "继续" after a hard turn cannot be graded cold.
    ...(remembered?.lastAdaptiveEffort ? { previousLevel: remembered.lastAdaptiveEffort } : {}),
    agent: describeAgent(agent),
    turn: input.turn,
    step: input.step,
    requestedProvider: config.provider,
    requestedModel: config.model,
    ...(switched === undefined ? {} : { switched }),
    ...(heldForCache === undefined ? {} : { heldForCache })
  });

  // The decision is recorded where it is *made* now (g-056): the ledger, the
  // session audit and the status feed all hear about it from here, not from the
  // read-only request waterfall.
  if (resolution.status) reportEffort(ctx, agent, resolution.status);
  rememberDecision(facts, agent, input.turn, routed, resolution, effort.generation, config.model);

  // Only an effort that was asked for — or one this layer just decided — is
  // written. A selection that never carried one keeps carrying none.
  const decidedEffort = resolution.changed ? resolution.effort : requested;
  if (decidedEffort !== requested) plan.reasoningEffort = decidedEffort;
  return Object.keys(plan).length === 0 ? undefined : plan;
}

/**
 * Install the virtual route and its interception layers.
 * @param ctx - the plugin's context (untagged listeners here observe every agent).
 * @param options - runtime, router, and capture budget.
 * @returns the installation handle; `dispose()` is idempotent.
 */
export function installModelRouting(ctx: Context, options: ModelRoutingOptions): ModelRoutingInstallation {
  const { llm } = options;
  const warn = options.warn ?? NOOP;
  const facts = new Map<string, AgentRoutingFacts>();

  // The raw lookups are captured before the adaptive-effort surface wraps them:
  // the routing probe must see what a model *declares*, never the `reflex`
  // entry the surface adds for the selector.
  const rawResolveModelInfo = llm.resolveModelInfo.bind(llm);
  const rawProbe = (provider: string, model: string) =>
    rawResolveModelInfo(provider, model) as unknown as Promise<LlmResolvedModelInfoLike>;

  const surface = installAdaptiveEffortSurface(ctx, llm, options.effort);

  let disposed = false;
  const scope = routeScope(llm);
  const owned = OWNED_ROUTES.get(scope) ?? new Map<string, OwnedRoute>();
  OWNED_ROUTES.set(scope, owned);

  /**
   * Whether these listeners may rewrite a request's route. Registering the
   * route and *using* one are different questions: an activation without pools
   * must not fall through to a fails-closed pool it never configured, and it
   * must not steal the policy of the activation that does own the route.
   */
  let routes = false;
  let adapter: ReflexVirtualAdapter | undefined;
  let router = options.router;
  /** The shared route entry this activation holds, when it holds one. */
  let held: OwnedRoute | undefined;
  /** Whether this activation created a provider registration (not merely joined). */
  let created = false;
  /** `registerAdapter` calls made by this activation (diagnostics/idempotence). */
  let registrationEvents = 0;

  const readTaskBudget = (): number => {
    const budget = typeof options.maxTaskChars === 'function' ? options.maxTaskChars() : options.maxTaskChars;
    return Number.isFinite(budget) ? Math.max(1, budget) : 400;
  };

  const republish = (): void => {
    try { (llm as any).emitAdaptersUpdated?.(); } catch {}
  };

  /** Build the adapter for one provider name; the router is shared. */
  const buildAdapter = (provider: string): ReflexVirtualAdapter =>
    new ReflexVirtualAdapter({
      provider,
      router,
      dispatch: (dispatchOptions) => llm.stream(dispatchOptions),
      probeReasoning: createReasoningProbe(llm, rawProbe),
      resolveContextWindow: async (prov, mod) => {
        try {
          const info = await rawResolveModelInfo(prov, mod);
          return (info as any)?.context?.contextWindow;
        } catch {
          return undefined;
        }
      }
    });

  /**
   * Register (or join) the route for the router's current provider name.
   *
   * Joining rather than colliding is what lets several activations share the
   * process-wide route: the first registers, the rest increment the owner count
   * and adopt the shared router, whose policy the newest activation replaces.
   */
  const registerRoute = (): void => {
    if (routes || held) return;
    const provider = router.virtualProvider;
    const existing = owned.get(provider);
    if (existing) {
      existing.owners += 1;
      router = existing.adapter.router;
      router.updatePolicy({
        models: options.router.models,
        ...(options.router.fallback ? { fallback: options.router.fallback } : {})
      });
      held = existing;
      routes = true;
      warn(
        `dsh-reflex: virtual route "${provider}" is already registered in this process; this activation joins it with its own pool policy`
      );
      republish();
      return;
    }
    if (llm.listProviders().some((entry) => entry.id === provider)) {
      warn(
        `dsh-reflex: provider "${provider}" is already registered by another adapter; System 1 model routing stays off for this activation`
      );
      return;
    }
    const nextAdapter = buildAdapter(provider);
    let handle: () => void;
    try {
      // Registered on the *root* context on purpose: the provider route is
      // process-wide, and provider registrations are disposed with the fiber
      // that created them. A registration on this activation's fiber would
      // disappear the moment this activation is released — even while another
      // activation is still routing through the same adapter. The release below
      // is what actually withdraws the route, once the last owner is gone.
      handle = ctx.root.llm.registerAdapter([provider], nextAdapter);
      registrationEvents += 1;
    } catch (error) {
      warn(
        `dsh-reflex: could not register the virtual provider "${provider}" (${(error as Error).message}); System 1 model routing stays off`
      );
      return;
    }
    const entry: OwnedRoute = { provider, adapter: nextAdapter, owners: 1, handle };
    owned.set(provider, entry);
    held = entry;
    adapter = nextAdapter;
    created = true;
    routes = true;
    republish();
  };

  /**
   * Release this activation's hold on the route.
   *
   * The provider registration is withdrawn only when the last owner goes away;
   * until then the shared adapter and its router stay registered for the other
   * activations.
   */
  const releaseRoute = (): void => {
    const entry = held;
    held = undefined;
    routes = false;
    adapter = undefined;
    if (!entry) return;
    entry.owners -= 1;
    if (entry.owners > 0) return;
    if (owned.get(entry.provider) === entry) owned.delete(entry.provider);
    created = false;
    entry.handle();
    republish();
  };

  /**
   * Rename the virtual provider route in place.
   *
   * A rename has to leave no orphan adapter: the new name is registered before
   * the old one is withdrawn (registry names differ, so no duplicate), then the
   * ownership entry moves to the new name. Every activation sharing this route
   * shares the same router object, so mutating its provider name renames the
   * route consistently for all of them; the owner count still decides when the
   * registration is actually withdrawn.
   */
  const renameRoute = (provider: string): void => {
    if (router.virtualProvider === provider) return;
    const entry = held;
    if (!entry) {
      router.setVirtualProvider(provider);
      return;
    }
    const oldProvider = entry.provider;
    const nextAdapter = buildAdapter(provider);
    let handle: () => void;
    try {
      handle = ctx.root.llm.registerAdapter([provider], nextAdapter);
      registrationEvents += 1;
    } catch (error) {
      // Keep routing on the old name rather than leaving the activation with no
      // route at all; the next commit retries.
      warn(
        `dsh-reflex: could not rename the virtual provider to "${provider}" (${(error as Error).message}); keeping "${oldProvider}"`
      );
      return;
    }
    router.setVirtualProvider(provider);
    entry.handle();
    if (owned.get(oldProvider) === entry) owned.delete(oldProvider);
    entry.provider = provider;
    entry.adapter = nextAdapter;
    entry.handle = handle;
    owned.set(provider, entry);
    adapter = nextAdapter;
    republish();
  };

  /**
   * Reconcile the provider lifecycle with one resolved routing policy.
   * @param policy - the policy currently in force.
   */
  const reconcile = (policy: LiveRoutingPolicy): void => {
    if (disposed) return;
    const canRoute = policy.enabled && Object.values(policy.models).some((pool) => pool.length > 0);
    if (!canRoute) {
      releaseRoute();
      router.setVirtualProvider(policy.virtualProvider);
      return;
    }
    if (!held) {
      router.setVirtualProvider(policy.virtualProvider);
      registerRoute();
      return;
    }
    if (router.virtualProvider !== policy.virtualProvider) renameRoute(policy.virtualProvider);
  };

  if (options.route === false || !router.hasPools) {
    // Deliberately silent: a deployment that configured no pool asked for the
    // tool surface only, and the effort layer may still be configured.
  } else {
    registerRoute();
  }

  const probe = createReasoningProbe(llm, rawProbe);
  const disposers: Array<() => void> = [];
  /** Detachers of the per-agent pseudo-switch filters installed lazily. */
  const agentFilterDisposers: Array<() => void> = [];
  /** Agents that already carry a filter, so a step never installs a second one. */
  const agentFilters = new WeakSet<object>();

  disposers.push(
    ctx.on('llm/stream', (options, next) => {
      if (isAgentLoopRequest(options) || (options as any).__reflexLoopOwned === true) {
        markAgentLoopRequest(options);
      }
      return next();
    })
  );

  // The pools a virtual model advertises are read from the live router, so a
  // committed routing edit changes what the model picker must show. The runtime
  // refreshes the router first (its listener is registered before this one);
  // this only republishes the catalog. A Host without the loader event simply
  // never calls it.
  disposers.push(
    ctx.on('loader/volatile-update', () => {
      try { (llm as any).emitAdaptersUpdated?.(); } catch {}
    })
  );

  /**
   * Decide one step's route and reasoning effort, then write it into the step's
   * selection.
   *
   * ## Why the write happens here (g-056)
   *
   * `dsh-agent-loop` reads `const selection = this.model.current()` before it
   * dispatches `agent/pre-step`, keeps that very object as the step's fixed
   * selection, and afterwards rejects a request that proposes anything else:
   *
   *   agent/request proposed reasoning effort "high" after step preparation
   *   fixed "reflex"; use agent.model.select() before step preparation
   *
   * `payload.modelSelection` *is* that object — `preStep` hands the local
   * `selection` straight into the waterfall payload, so mutating the payload
   * mutates what the guards compare against. `AgentModel.current()` already
   * returned a fresh mutable copy (`{ ...recorded }` / a new object from
   * `toSelection`), which is why the object is writable at all.
   *
   * The `Readonly<ModelSelection>` in the contract is a compile-time marker with
   * no runtime freeze attached, and DSH 0.2.2 offers no other write path before
   * step preparation: `agent.model.select()` appends a `model/selection` event
   * that only the *next* `current()` reads, and `current()` has already been
   * called. So this is the only seam, and the cast below is its documentation.
   *
   * Every failure mode degrades to "selection unchanged": a throwing planner, a
   * frozen payload (the write raises `TypeError`, caught here), or a decision
   * that outran {@link STEP_DECISION_TIMEOUT_MS}. An unchanged `reflex` marker
   * is then stripped by the virtual provider's own `resolveCallConfig`, so the
   * request lands on the adapter default instead of an unsupported effort.
   *
   * `next()` is called *outside* the `try` on purpose: the rest of the waterfall
   * decides whether the step is admitted (`enter`/`reject`) and with which
   * messages, and swallowing its rejection would turn a rejected step into a
   * silently admitted one.
   */
  disposers.push(
    ctx.on('agent/pre-step', async (payload, next) => {
      // Outside the try: a rejection here must reach the loop unchanged.
      const decision = await next();
      try {
        // Cheap liveness: the host that commits config-only saves leaves the
        // resolved config stale until someone asks. The check is a handful of
        // identity comparisons and parses nothing unless the loader committed.
        options.refreshConfig?.();
        ensureVirtualSwitchFilter(payload.agent, router, agentFilterDisposers, agentFilters);
        rememberStep(facts, payload.agent, captureTask(payload.messages, readTaskBudget()), measureMessages(payload.messages), payload.turn);

        // The loop has already read `model.current()` for this step; reading our
        // own attributes synchronously here (not through a composable) is what
        // makes the attempt safely able to outlive its budget.
        const selection = payload.modelSelection;
        const attempt = startDecision(() =>
          planStep({
            ctx,
            agent: payload.agent,
            turn: payload.turn,
            step: payload.step,
            signal: payload.signal,
            selection,
            router,
            effort: options.effort,
            routes,
            facts,
            probe
          })
        );
        const budget = stepDecisionBudget();
        const settled = await withBudget(attempt, budget);
        if (settled === undefined) {
          warn(
            `dsh-reflex: the step decision for "${agentKey(payload.agent) ?? 'agent'}" did not finish in ${budget}ms; the step keeps the selection it fixed`
          );
          return decision;
        }
        // A read-only payload (frozen by an embedder, or a future Host that
        // freezes it) rejects the writes below; that is the same safe outcome.
        applyPlan(selection, settled);
      } catch {
        // Decision failure never vetoes a step: the selection keeps exactly what
        // the loop fixed, and the virtual provider's `resolveCallConfig` strips
        // the marker if one survives, so the request lands on the model default.
      }
      return decision;
    }, { prepend: true })
  );

  // Read-only by contract (see the module docstring): `await next()` and hand
  // the configuration back exactly as produced. DSH 0.2.2 throws when this
  // waterfall proposes a different provider, model, or reasoning effort than the
  // step's selection, and a listener that can only pass through can never do so.
  disposers.push(
    ctx.on('agent/request', async (_payload, next) => next(), { prepend: true })
  );

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const detach of disposers.reverse()) detach();
    disposers.length = 0;
    for (const detach of agentFilterDisposers.splice(0)) detach();
    facts.clear();
    surface.dispose();
    releaseRoute();
  };

  return {
    get router() {
      return router;
    },
    get adapter() {
      return adapter;
    },
    get registered() {
      return created;
    },
    get registrationEvents() {
      return registrationEvents;
    },
    refresh(policy: LiveRoutingPolicy): void {
      reconcile(policy);
    },
    dispose
  };
}

/**
 * Join the text blocks of the user messages admitted to one step.
 * @param messages - messages carried by `agent/pre-step`.
 * @param budget - maximum characters to keep.
 * @returns the joined task text, or `undefined` when the step carries no text.
 */
function captureTask(messages: readonly UserMessage[], budget: number): string | undefined {
  const limit = Math.max(1, budget);
  const parts: string[] = [];
  let length = 0;

  for (const message of messages ?? []) {
    for (const block of (message?.content ?? []) as readonly ContentBlock[]) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      const text = block.text.trim();
      if (text.length === 0) continue;
      parts.push(text);
      length += text.length;
      if (length >= limit) break;
    }
    if (length >= limit) break;
  }

  return parts.length === 0 ? undefined : parts.join('\n').slice(0, limit);
}

/**
 * Remember one agent's latest step, keeping the map bounded.
 *
 * A step that carries no text still counts towards the session's size and must
 * not erase the task the agent is working on, so the two facts are updated
 * independently.
 *
 * @param facts - the per-installation facts map.
 * @param agent - the agent proposing the step.
 * @param text - the captured task text, when the step carried any.
 * @param chars - characters of step input observed.
 * @param turn - the turn the step belongs to.
 */
function rememberStep(
  facts: Map<string, AgentRoutingFacts>,
  agent: Agent,
  text: string | undefined,
  chars: number,
  turn?: number
): void {
  const key = agentKey(agent);
  if (key === undefined) return;
  const previous = facts.get(key);
  const turns = rememberTurn(previous?.turns ?? [], text, turn);
  const next: AgentRoutingFacts = {
    ...(text ?? previous?.task ? { task: text ?? previous?.task } : {}),
    ...(previous?.currentModel ? { currentModel: previous.currentModel } : {}),
    contextChars: (previous?.contextChars ?? 0) + Math.max(0, Math.round(chars)),
    ...(previous?.decided ? { decided: previous.decided } : {}),
    ...(previous?.lastAdaptiveEffort ? { lastAdaptiveEffort: previous.lastAdaptiveEffort } : {}),
    ...(turns.length === 0 ? {} : { turns })
  };
  facts.delete(key);
  facts.set(key, next);
  while (facts.size > MAX_TRACKED_AGENTS) {
    const oldest = facts.keys().next();
    if (oldest.done) break;
    facts.delete(oldest.value);
  }
}

/**
 * Append one observed turn text, one entry per turn, bounded by the effort
 * layer's window.
 *
 * A second step of the *same* turn replaces that turn's entry instead of adding
 * another: the window is defined in turns, so a step count must not be able to
 * push an earlier turn out of it. Consecutive replies of the same text are folded
 * too — "继续" said three times is one piece of context, not three that grow
 * with every turn.
 *
 * @param turns - the turns kept so far, oldest first.
 * @param text - the text this step carried; a step without text adds nothing.
 * @param turn - the turn the step belongs to; `undefined` is treated as a new turn.
 * @returns the bounded turn list, oldest first.
 */
function rememberTurn(turns: readonly TrackedTurn[], text: string | undefined, turn?: number): TrackedTurn[] {
  if (text === undefined) return [...turns];
  const last = turns.at(-1);
  // Without a turn number every step is its own turn: the pre-step hook is the
  // only place this is read, and guessing an increment would merge a multi-step
  // turn into one entry — which is harmless — while a wrong merge across real
  // turns would drop history. Separate entries is the safe reading.
  const entry: TrackedTurn = { turn: turn ?? (last === undefined ? 0 : last.turn + 1), text };
  const kept =
    turn !== undefined && last !== undefined && last.turn === turn ? [...turns.slice(0, -1), entry] : [...turns, entry];
  // The same text repeated consecutively is one context, not an ever-growing one.
  const deduped: TrackedTurn[] = [];
  for (const item of kept) {
    if (deduped.at(-1)?.text === item.text) continue;
    deduped.push(item);
  }
  return deduped.slice(-EFFORT_CONTEXT_TURNS);
}

/**
 * Remember one turn's decision so its later steps cost nothing.
 *
 * Only an *adaptive* decision is cached: a request that carries its own
 * concrete level needs no decision at all, and caching it would turn the
 * caller's explicit choice into a per-step replay of a value the request
 * already carries.
 *
 * @param facts - the per-installation facts map.
 * @param agent - the requesting agent.
 * @param turn - the turn the decision belongs to.
 * @param routed - the call configuration the decision was taken for.
 * @param resolution - the effort resolution, carrying the status when decided.
 * @param generation - effort policy version the decision was taken under.
 */
function rememberDecision(
  facts: Map<string, AgentRoutingFacts>,
  agent: Agent,
  turn: number | undefined,
  routed: LlmCallConfig,
  resolution: EffortResolution,
  generation: number,
  virtualModel?: string
): void {
  const key = agentKey(agent);
  if (key === undefined) return;
  const status = resolution.status;
  const decision: TurnDecision = {
    turn: turn ?? 0,
    provider: routed.provider,
    model: routed.model,
    ...(virtualModel === undefined ? {} : { virtualModel }),
    ...(resolution.effort === undefined ? {} : { effort: resolution.effort }),
    ...(status === undefined ? {} : { status }),
    generation
  };
  const previous = facts.get(key);
  // g-063: a later step of the *same* turn replays this decision instead of
  // asking again, so the previous level the next decision is given must be the
  // level this turn settled on, not the one from before it. Otherwise a five-step
  // turn hands the turn after it a stale prior.
  const settledEffort = resolution.decision ? resolution.effort : (previous?.decided?.effort ?? previous?.lastAdaptiveEffort);
  facts.delete(key);
  facts.set(key, {
    ...(previous?.task ? { task: previous.task } : {}),
    ...(previous?.currentModel ? { currentModel: previous.currentModel } : {}),
    contextChars: previous?.contextChars ?? 0,
    decided: decision,
    // An echo is only recognisable when this layer, not the user, chose the
    // effort — so the marker is recorded for adaptive decisions alone — and
    // since g-063 it is also the previous level the next decision is told about.
    ...(settledEffort === undefined ? {} : { lastAdaptiveEffort: settledEffort }),
    ...(previous?.turns?.length ? { turns: previous.turns } : {})
  });
}

/**
 * Re-publish one reused decision for a later step of the same turn.
 * @param decision - the turn's decision.
 * @param turn - the step's turn.
 * @param step - the step number.
 * @returns a status carrying this step's numbers, or `undefined` when none was published.
 */
function statusForStep(
  decision: TurnDecision,
  turn: number | undefined,
  step: number | undefined
): ReflexEffortStatus | undefined {
  if (!decision.status) return undefined;
  const status: ReflexEffortStatus = {
    ...decision.status,
    latencyMs: 0,
    at: Date.now(),
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step })
  };
  return { ...status, line: formatEffortStatusLine(status) };
}

/**
 * Install the pseudo-switch filter on one agent's own context, once.
 *
 * Placement is the whole point. `installModelSelection` registers its notice
 * listener with `prepend` on the *agent* context, so it is the outermost
 * `agent/pre-step` wrapper and appends its notice after every other listener
 * returned. Registering this filter later, also with `prepend` but on that same
 * agent context, puts it at the front again, so it becomes the one wrapper that
 * sees the notice and can drop it. The first step of a turn never receives a
 * notice, which is exactly the step on which this filter gets installed.
 *
 * @param agent - the agent proposing the step.
 * @param router - the routing policy, naming the virtual route.
 * @param disposers - collector for the detachers.
 * @param installed - guard so one agent never gets two filters.
 */
function ensureVirtualSwitchFilter(
  agent: Agent,
  router: VirtualModelRouter,
  disposers: Array<() => void>,
  installed: WeakSet<object>
): void {
  const target = agent as unknown as object;
  if (!target || installed.has(target)) return;
  const agentCtx = (agent as { ctx?: Context }).ctx;
  if (!agentCtx || typeof agentCtx.on !== 'function') return;

  installed.add(target);
  try {
    const detach = agentCtx.on(
      'agent/pre-step',
      (async (_payload: { agent: Agent }, next: () => Promise<unknown>) => {
        const decision = await next();
        return filterVirtualSwitchNotices(
          decision as { messages?: readonly unknown[] },
          router.virtualProvider,
          router.modelIds
        );
      }) as never,
      { prepend: true }
    );
    disposers.push(detach as unknown as () => void);
  } catch {
    // A synthetic or torn-down agent context must never break a step.
    installed.delete(target);
  }
}

/**
 * Remember the physical model one agent's request was routed onto.
 *
 * This is what the next decision defends: the model whose prompt prefix the
 * session has already paid to cache.
 *
 * @param facts - the per-installation facts map.
 * @param agent - the requesting agent.
 * @param target - the physical route the request was rewritten to.
 */
function rememberTarget(facts: Map<string, AgentRoutingFacts>, agent: Agent, target: PhysicalTarget): void {
  const key = agentKey(agent);
  if (key === undefined) return;
  const previous = facts.get(key);
  facts.delete(key);
  facts.set(key, {
    ...(previous?.task ? { task: previous.task } : {}),
    currentModel: { provider: target.provider, model: target.model },
    contextChars: previous?.contextChars ?? 0,
    ...(previous?.decided ? { decided: previous.decided } : {}),
    ...(previous?.lastAdaptiveEffort ? { lastAdaptiveEffort: previous.lastAdaptiveEffort } : {}),
    ...(previous?.turns?.length ? { turns: previous.turns } : {})
  });
}

/**
 * Recall what one activation knows about one agent.
 * @param facts - the per-installation facts map.
 * @param agent - the requesting agent.
 * @returns the remembered task, current model and context size, when any.
 */
function recallFacts(facts: Map<string, AgentRoutingFacts>, agent: Agent): AgentRoutingFacts | undefined {
  const key = agentKey(agent);
  return key === undefined ? undefined : facts.get(key);
}

/**
 * Count the text carried by one step's messages, without truncation.
 *
 * The task text is capped for the prompt; the session size must not be, or a
 * long session would look as small as the first turn forever.
 *
 * @param messages - messages carried by `agent/pre-step`.
 * @returns the number of characters of text, or `0`.
 */
function measureMessages(messages: readonly UserMessage[]): number {
  let length = 0;
  for (const message of messages ?? []) {
    for (const block of (message?.content ?? []) as readonly ContentBlock[]) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      length += block.text.length;
    }
  }
  return length;
}

/**
 * Stable key for one agent.
 * @param agent - the agent to key.
 * @returns its id, or `undefined` when it has none.
 */
function agentKey(agent: Agent): string | undefined {
  try {
    return typeof agent?.id === 'string' && agent.id.length > 0 ? agent.id : undefined;
  } catch {
    return undefined;
  }
}
