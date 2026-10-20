import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { isAgentLoopRequest, markAgentLoopRequest, type ContentBlock, type LlmCallConfig, type LlmRuntime, type UserMessage } from '@deepseek-ai/dsh-llm';

import type { EffortInterceptor, EffortResolution, ReflexEffortStatus } from './effort.js';
import { formatEffortStatusLine, isEffortLevel } from './effort.js';
import { appendEffortRecord } from './session-audit.js';
import { resolveAdaptiveIntent } from './adaptive-intent.js';
import type { PhysicalTarget, ReasoningProbe, RouteContext, VirtualModelRouter } from './router.js';
import { alignReasoningEffort, estimateContextTokens } from './router.js';
import { ReflexVirtualAdapter } from './virtual-adapter.js';

/**
 * Install the virtual provider route and the interception layers that route its
 * requests through System 1.
 *
 * Layer 1 — `agent/request` (waterfall): the loop hands out the *frozen call
 * configuration* it would use and accepts a replacement. This is the only
 * place a loop request can be re-routed, because the request object the loop
 * later builds is deep-frozen and marked as loop-owned. Rewriting the config
 * here means the logged header, the prepared call and the dispatched request
 * all name the physical route, so the routing decision is auditable from the
 * session log alone.
 *
 * Layer 2 — the same waterfall decides the turn's reasoning effort. A request
 * carrying the `reflex`/`auto` marker (or a deployment that configured the
 * marker) has no physical effort id yet; {@link EffortInterceptor} turns it into
 * one, projects it onto the routed model's vocabulary, audits it in the session
 * log, and publishes it to the status feed. A request that named a concrete
 * effort is passed through untouched.
 *
 * Layer 3 — the virtual adapter's `stream()`: anything that does not pass
 * through layer 1 (hand-built one-shot calls, `prepareCall()` consumers) is
 * routed at dispatch time and delegated to the physical adapter through
 * `ctx.llm.stream`.
 *
 * The task text each decision reasons about comes from `agent/pre-step`, which
 * carries the user messages admitted to the step: a subagent's first step
 * carries its delegated task, so a delegated agent routes on its *own* task
 * rather than inheriting its parent's decision. That is also the input the
 * effort decision reads, because the request waterfall only sees a frozen config.
 *
 * The same listener accumulates each agent's *session size* (characters of step
 * input seen so far), and every routed request remembers the physical model it
 * landed on. Both ride into the next decision as cache-affinity facts, so a
 * session that already holds a warm prompt prefix is not moved onto another
 * physical model for a marginal score difference.
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
  /** Task-text budget captured from `agent/pre-step` (characters). */
  maxTaskChars: number;
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

/** What {@link installModelRouting} installed. */
export interface ModelRoutingInstallation {
  /**
   * The router actually in force. With several activations on one runtime the
   * first activation owns the process-wide virtual route and later activations
   * route through the owner's policy, so every path agrees on the pools.
   */
  router: VirtualModelRouter;
  /** The adapter registered for the virtual route, when this call registered it. */
  adapter?: ReflexVirtualAdapter;
  /** Whether this call registered the virtual provider route itself. */
  registered: boolean;
  /** Detach the listeners and release the route when this call owned it. */
  dispose: () => void;
}

/** Nothing to undo. */
const NOOP = (): void => {};

/**
 * Virtual routes already owned in this process, keyed by the LLM runtime that
 * holds them. A DSH deployment can activate this plugin more than once (one
 * activation per tool prefix); provider routes are process-wide, so the first
 * activation registers and the rest reuse its policy instead of colliding with
 * `DUPLICATE_ADAPTER`.
 */
const OWNED_ROUTES = new WeakMap<LlmRuntime, Map<string, ReflexVirtualAdapter>>();

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
  /**
   * Whether the most recent `agent/pre-step` carried new user text. A step that
   * carries none is a continuation of the step before it, not a new instruction,
   * so its decision may be reused instead of asking System 1 again.
   */
  stepHasText?: boolean;
  /** The decision this turn already made, reused by its later steps. */
  decided?: TurnDecision;
  /** Adaptive effort this layer dispatched most recently, used to recognise a header echo. */
  lastAdaptiveEffort?: string;
}

/** One decided turn, kept so a same-turn follow-up step costs nothing. */
interface TurnDecision {
  turn: number;
  provider: string;
  model: string;
  /** Effort the rewritten request carried; `undefined` when the key was cleared. */
  effort?: string;
  /** The published status of that decision. */
  status?: ReflexEffortStatus;
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
  return OWNED_ROUTES.get(llm)?.has(provider) === true;
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
 * @param ctx - plugin context (kept for API compatibility).
 * @param llm - the LLM runtime to extend.
 * @param setting - deployment `reasoningEffort`, the initial mode of the surface.
 * @param enabled - the deployment `effort.enabled` switch; defaults to `true`.
 * @returns the installed surface, whose `dispose()` restores the runtime.
 */
export function installAdaptiveEffortSurface(
  _ctx: Context,
  llm: LlmRuntime,
  setting: string | undefined,
  enabled = true
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
    if (!enabled) return info;
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

    if (!enabled) {
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
    if (requested === undefined && isAdaptiveMarker(setting) &&
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
    // bypass the `agent/request` interception (hand-built one-shot calls,
    // `prepareCall` consumers). With the switch off there is no policy to
    // resolve it *to*, so it is deleted and the provider default applies.
    if (!enabled) {
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
      return enabled && isAdaptiveMarker(setting);
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

  const surface = installAdaptiveEffortSurface(ctx, llm, options.effort.setting, options.effort.enabled);

  const owned = OWNED_ROUTES.get(llm) ?? new Map<string, ReflexVirtualAdapter>();
  OWNED_ROUTES.set(llm, owned);

  /**
   * Whether these listeners may rewrite a request's route. Registering the
   * route and *using* one are different questions: an activation without pools
   * must not fall through to a fails-closed pool it never configured, and it
   * must not steal the policy of the activation that does own the route.
   */
  let routes = false;
  const reuse = owned.get(options.router.virtualProvider);
  let adapter: ReflexVirtualAdapter | undefined;
  let router = options.router;
  let release: (() => void) | undefined;

  if (options.route === false || !router.hasPools) {
    // Deliberately silent: a deployment that configured no pool asked for the
    // tool surface only, and the effort layer may still be configured.
  } else if (reuse) {
    router = reuse.router;
    routes = true;
    warn(
      `dsh-reflex: virtual route "${router.virtualProvider}" is already registered in this process; this activation reuses its pool policy`
    );
  } else if (llm.listProviders().some((provider) => provider.id === router.virtualProvider)) {
    warn(
      `dsh-reflex: provider "${router.virtualProvider}" is already registered by another adapter; System 1 model routing stays off for this activation`
    );
  } else {
    adapter = new ReflexVirtualAdapter({
      provider: router.virtualProvider,
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
    let handle;
    try {
      handle = llm.registerAdapter([router.virtualProvider], adapter);
    } catch (error) {
      warn(
        `dsh-reflex: could not register the virtual provider "${router.virtualProvider}" (${(error as Error).message}); System 1 model routing stays off`
      );
      return { router, registered: false, dispose: NOOP };
    }
    owned.set(router.virtualProvider, adapter);
    routes = true;
    release = () => {
      owned.delete(router.virtualProvider);
      handle();
      try { (llm as any).emitAdaptersUpdated?.(); } catch {}
    };
    try { (llm as any).emitAdaptersUpdated?.(); } catch {}
  }

  const registered = release !== undefined;
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

  disposers.push(
    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        ensureVirtualSwitchFilter(payload.agent, router, agentFilterDisposers, agentFilters);
        rememberStep(facts, payload.agent, captureTask(payload.messages, options.maxTaskChars), measureMessages(payload.messages));
      } catch {
        // Task capture is advisory: a malformed message must not veto the step.
      }
      return next();
    })
  );

  disposers.push(
    ctx.on('agent/request', async (payload, next) => {
      const rawConfig = await next();
      if (!rawConfig || payload.signal?.aborted) return rawConfig;
      const config = resolveAdaptiveIntent(ctx, payload.agent, rawConfig, (provider) => router.owns(provider));

      const remembered = recallFacts(facts, payload.agent);
      const requested = config.reasoningEffort as unknown as string | undefined;
      const task = remembered?.task;

      // With `effort.enabled` off this layer manages no effort at all: it still
      // routes, but the only edit it is allowed to make to `reasoningEffort` is
      // removing its own marker. That keeps a concrete level byte-identical on
      // its way to the adapter, and it means no decision, no audit entry and no
      // status can be produced for a deployment that switched the layer off.
      const effortOff = options.effort.enabled === false;

      // Reflex only automatically adapts reasoning effort when the effort was
      // explicitly chosen as reflex/auto, or when an unpinned request names the
      // virtual provider (which defaults to adaptive effort). If the user selected
      // High, Low, Medium, Off, or Provider Default, reflex does not touch effort.
      const isAdaptive =
        !effortOff &&
        (isAdaptiveMarker(requested) ||
          (requested === undefined && router.owns(config.provider) && isAdaptiveMarker(options.effort.setting)));

      // Same-turn follow-up steps (step > 1 without new user text) reuse the turn's
      // decision: no second System 1 call, no second effort event, 0ms latency.
      const isFollowupStep =
        (payload.step ?? 1) > 1 &&
        remembered?.decided !== undefined &&
        remembered.decided.turn === payload.turn &&
        remembered.stepHasText !== true;

      if (isAdaptive && isFollowupStep && remembered?.decided) {
        const reuse = remembered.decided;
        const routedReuse =
          routes && router.owns(config.provider)
            ? { ...config, provider: reuse.provider, model: reuse.model }
            : config;
        const effort = reuse.effort;
        if (effort === requested && routedReuse === config) return config;
        const rewritten: LlmCallConfig = { ...routedReuse };
        if (effort === undefined) delete (rewritten as { reasoningEffort?: unknown }).reasoningEffort;
        else rewritten.reasoningEffort = effort as LlmCallConfig['reasoningEffort'];
        return rewritten;
      }

      let routed = config;
      let switched: boolean | undefined;
      let heldForCache: boolean | undefined;
      if (routes && router.owns(config.provider)) {
        const decision = await router.routeModel({
          provider: config.provider,
          model: config.model,
          task,
          ...describeAgent(payload.agent),
          turn: payload.turn,
          step: payload.step,
          // Cache-affinity facts: the model this session already holds and how
          // much context it is defending.
          ...(remembered?.currentModel ? { currentModel: remembered.currentModel } : {}),
          ...(remembered === undefined ? {} : { contextChars: remembered.contextChars }),
          contextTokens: estimateContextTokens(remembered?.contextChars ?? 0)
        });
        routed = { ...config, provider: decision.target.provider, model: decision.target.model };
        switched = decision.switched;
        heldForCache = decision.reason === 'sticky-affinity';
        rememberTarget(facts, payload.agent, decision.target);
      }

      const isPinnedConfig = !effortOff && requested === undefined && isEffortLevel(options.effort.setting);
      if (!isAdaptive && !isPinnedConfig) {
        if (effortOff) {
          // Transparent pass-through: the request keeps the caller's own level
          // (never aligned, never snapped onto the routed model's vocabulary),
          // and the plugin's marker is deleted instead of being translated — the
          // adapter then applies the provider default, which is the only safe
          // reading of "reflex" once the adaptive layer is switched off.
          const kept = isAdaptiveMarker(requested) ? undefined : requested;
          if (routed === config && kept === requested) return config;
          const rewritten: LlmCallConfig = { ...routed };
          if (kept === undefined) delete (rewritten as { reasoningEffort?: unknown }).reasoningEffort;
          else rewritten.reasoningEffort = kept as LlmCallConfig['reasoningEffort'];
          return rewritten;
        }
        // Concrete effort (high, low, off...) or provider default: align if needed, never adapt!
        if (routed === config && requested !== undefined) {
          const aligned = await alignReasoningEffort(requested, { provider: routed.provider, model: routed.model }, probe);
          if (aligned === requested) return config;
          const rewritten: LlmCallConfig = { ...routed };
          if (aligned !== undefined) rewritten.reasoningEffort = aligned as LlmCallConfig['reasoningEffort'];
          else delete (rewritten as { reasoningEffort?: unknown }).reasoningEffort;
          return rewritten;
        }
        if (routed !== config) {
          const aligned = requested ? await alignReasoningEffort(requested, { provider: routed.provider, model: routed.model }, probe) : undefined;
          const rewritten: LlmCallConfig = { ...routed };
          if (aligned !== undefined) rewritten.reasoningEffort = aligned as LlmCallConfig['reasoningEffort'];
          else delete (rewritten as { reasoningEffort?: unknown }).reasoningEffort;
          return rewritten;
        }
        return config;
      }

      const resolution = await options.effort.resolve({
        requested,
        target: { provider: routed.provider, model: routed.model },
        probe,
        task,
        agent: describeAgent(payload.agent),
        turn: payload.turn,
        step: payload.step,
        requestedProvider: config.provider,
        requestedModel: config.model,
        ...(switched === undefined ? {} : { switched }),
        ...(heldForCache === undefined ? {} : { heldForCache })
      });

      if (resolution.status) {
        reportEffort(ctx, payload.agent, resolution.status);
        rememberDecision(facts, payload.agent, payload.turn, routed, resolution);
      }
      if (!resolution.changed && routed === config) return config;

      const rewritten: LlmCallConfig = { ...routed };
      // Only requests that carried an effort — or whose effort this layer just
      // decided — get one back. A cleared effort deletes the key instead of
      // leaving an `undefined` one behind: a request that never asked for an
      // effort must look exactly as it did before the interception.
      const effort = resolution.changed ? resolution.effort : requested;
      if (config.reasoningEffort !== undefined || resolution.changed) {
        if (effort === undefined) delete (rewritten as { reasoningEffort?: unknown }).reasoningEffort;
        else rewritten.reasoningEffort = effort as LlmCallConfig['reasoningEffort'];
      }

      return rewritten;
    }, { prepend: true })
  );

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const detach of disposers.reverse()) detach();
    disposers.length = 0;
    for (const detach of agentFilterDisposers.splice(0)) detach();
    facts.clear();
    surface.dispose();
    release?.();
  };

  return { router, adapter, registered, dispose };
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
 */
function rememberStep(facts: Map<string, AgentRoutingFacts>, agent: Agent, text: string | undefined, chars: number): void {
  const key = agentKey(agent);
  if (key === undefined) return;
  const previous = facts.get(key);
  const next: AgentRoutingFacts = {
    ...(text ?? previous?.task ? { task: text ?? previous?.task } : {}),
    ...(previous?.currentModel ? { currentModel: previous.currentModel } : {}),
    contextChars: (previous?.contextChars ?? 0) + Math.max(0, Math.round(chars)),
    stepHasText: text !== undefined,
    ...(previous?.decided ? { decided: previous.decided } : {}),
    ...(previous?.lastAdaptiveEffort ? { lastAdaptiveEffort: previous.lastAdaptiveEffort } : {})
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
 * Remember one turn's decision so its later steps cost nothing.
 *
 * Only an *adaptive* decision is cached: a pinned level needs no decision at
 * all, and caching it would turn a user's explicit choice into a per-step replay
 * of a value the request already carries.
 *
 * @param facts - the per-installation facts map.
 * @param agent - the requesting agent.
 * @param turn - the turn the decision belongs to.
 * @param routed - the call configuration the decision was taken for.
 * @param resolution - the effort resolution, carrying the status when decided.
 */
function rememberDecision(
  facts: Map<string, AgentRoutingFacts>,
  agent: Agent,
  turn: number | undefined,
  routed: LlmCallConfig,
  resolution: EffortResolution
): void {
  const key = agentKey(agent);
  if (key === undefined) return;
  const status = resolution.status;
  const decision: TurnDecision = {
    turn: turn ?? 0,
    provider: routed.provider,
    model: routed.model,
    ...(resolution.effort === undefined ? {} : { effort: resolution.effort }),
    ...(status === undefined ? {} : { status })
  };
  const previous = facts.get(key);
  facts.delete(key);
  facts.set(key, {
    ...(previous?.task ? { task: previous.task } : {}),
    ...(previous?.currentModel ? { currentModel: previous.currentModel } : {}),
    contextChars: previous?.contextChars ?? 0,
    ...(previous?.stepHasText === undefined ? {} : { stepHasText: previous.stepHasText }),
    decided: decision,
    // An echo is only recognisable when this layer, not the user, chose the
    // effort — so the marker is recorded for adaptive decisions alone.
    ...(resolution.decision ? { lastAdaptiveEffort: resolution.effort } : {})
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
    ...(previous?.stepHasText === undefined ? {} : { stepHasText: previous.stepHasText }),
    ...(previous?.decided ? { decided: previous.decided } : {}),
    ...(previous?.lastAdaptiveEffort ? { lastAdaptiveEffort: previous.lastAdaptiveEffort } : {})
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
