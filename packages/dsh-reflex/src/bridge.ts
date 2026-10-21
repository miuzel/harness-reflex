import {
  Calibrator,
  DecisionLedger,
  JevDecisionBackend,
  MockDecisionBackend,
  ReflexGateService,
  ReflexRouter,
  ReflexScreenService,
  SimpleJevDecisionBackend,
  StagnationDetector,
  ToolResultPruner,
  createSystemOneBackend,
  scoreStatement
} from './vendor/harness-reflex/index.js';
import type {
  ActionStep,
  BackendHealth,
  CandidateItem,
  ChoiceResponse,
  DecisionBackend,
  GateResponse,
  PruneResponse,
  RouteResponse,
  ScreenResult,
  StagnationCheckResponse
} from './vendor/harness-reflex/index.js';

import type { ReflexConfig, ResolvedInterventionsConfig, ResolvedReflexConfig, ResolvedToolsConfig } from './config.js';
import { resolveApiKey, resolveConfig, volatileSnapshots } from './config.js';
import { EffortInterceptor, EffortStatusFeed, type ReflexEffortStatus } from './effort.js';
import type { InterventionEngine } from './interventions.js';
import { VirtualModelRouter } from './router.js';

/** Payload of the `choice` operation, mirroring the stdio MCP surface. */
export type ReflexChoiceResult = ChoiceResponse & { calibratedConfidence?: number };

/** Payload of the `prune` operation, mirroring the stdio MCP surface. */
export interface ReflexPruneResult {
  tokensSaved: number;
  reductionPercentage: string;
  shadow: boolean;
  processedOutput: string;
}

/** Payload of the ledger read, mirroring the stdio MCP `status_ledger` payload. */
export interface ReflexLedgerResult {
  summary: ReturnType<DecisionLedger['getSummary']>;
  recentEntries?: ReturnType<DecisionLedger['getEntries']>;
  /**
   * Health of the backend at read time, when it tracks one.
   *
   * `/reflex-ledger` prints a degraded notice from it. It is deliberately not
   * part of any model-facing tool payload: a health warning is a diagnostics
   * fact for the person reading the command, not context for the agent.
   */
  systemOneHealth?: BackendHealth;
}

/**
 * In-process System One runtime shared by every reflex tool of one plugin
 * activation.
 *
 * The bridge owns the backend, the audit ledger, and the five decision services,
 * so a plugin reload builds a fresh runtime and drops the previous one whole —
 * no module-level singleton is mutated and nothing survives the activation.
 */
export class ReflexRuntime {
  readonly config: ResolvedReflexConfig;
  readonly backend: DecisionBackend;
  readonly ledger: DecisionLedger;
  readonly calibrator: Calibrator;
  readonly gateService: ReflexGateService;
  readonly pruneService: ToolResultPruner;
  readonly stagnationService: StagnationDetector;
  readonly routeService: ReflexRouter;
  readonly screenService: ReflexScreenService;
  /**
   * System 1 virtual→physical model router this activation routes through. It
   * owns the configured pools and writes one `model-route` ledger entry per
   * decision; the plugin installs it on the LLM runtime and dispatches through
   * it. With several live activations the process-wide route has one shared
   * router, and {@link adoptModelRouter} points this runtime at it.
   */
  #modelRouter: VirtualModelRouter;
  /**
   * Per-turn adaptive reasoning-effort policy. It writes one `effort-decision`
   * ledger entry per decided turn and publishes each decision to
   * {@link effortStatusFeed}.
   */
  readonly effort: EffortInterceptor;
  /** Status-bar surface of the adaptive effort decisions of this activation. */
  readonly effortStatusFeed: EffortStatusFeed;

  #disposed = false;
  #surface: readonly string[] = [];
  #interventions?: InterventionEngine;
  /**
   * The config the Host resolved for this activation, kept as it was passed in.
   *
   * With the Cordis loader this object holds schema-declared *volatile
   * references*: a config-only update mutates those references in place and
   * dispatches `loader/volatile-update` instead of remounting the plugin, so
   * this is the only handle that sees the new values. A programmatic caller
   * passes a plain object, in which case there is nothing to watch.
   */
  readonly #source: unknown;
  /** Snapshot identities of {@link #source} at the last applied refresh. */
  #mark: unknown[] = [];
  /** Whether {@link #source} actually exposes volatile references. */
  readonly #watchable: boolean;
  #warn: (message: string) => void;
  /**
   * The intervention policy currently in force.
   *
   * Kept even when the engine is inert (`mode: off`), so the panel reports the
   * authored block rather than the activation-time snapshot, and so turning a
   * capability back on can install its listeners without a remount.
   */
  #interventionsConfig: ResolvedInterventionsConfig;
  /** The prune threshold currently in force (top-level `pruneThreshold`). */
  #pruneThreshold: number;
  /**
   * The per-tool switches and deployment prefix currently in force.
   *
   * Kept here rather than read from {@link config} because a config-only save
   * never remounts the activation: the registry has to follow the committed
   * values, and the panel has to report the same ones.
   */
  #toolsConfig: ResolvedToolsConfig;
  #toolPrefix: string;
  /** Applies a freshly resolved intervention policy to the installed listeners. */
  #reconfigureInterventions?: (config: ResolvedInterventionsConfig, pruneThreshold: number) => void;
  /** Reads how many intervention listeners are currently attached. */
  #interventionListenerCount?: () => number;
  /** Reconciles the registered tool set with a freshly resolved config. */
  #reconfigureTools?: (config: ResolvedReflexConfig) => void;
  /** Reads how many tools this activation currently has registered. */
  #toolRegistrationCount?: () => number;
  /** Reads how many `tools.register` calls this activation has made in total. */
  #toolRegistrationEvents?: () => number;
  /** Full schema resolutions performed by this activation (diagnostics/measurement). */
  #configResolves = 0;

  /**
   * @param config - resolved plugin configuration.
   * @param dependencies - test seams for the ledger, backend, and routing clock,
   *   plus the raw config (whose volatile references carry live updates) and a
   *   diagnostic sink.
   */
  constructor(
    config: ResolvedReflexConfig,
    dependencies: {
      backend?: DecisionBackend;
      ledger?: DecisionLedger;
      now?: () => number;
      configSource?: unknown;
      warn?: (message: string) => void;
    } = {}
  ) {
    this.config = config;
    this.backend = dependencies.backend ?? createBackend(config);
    this.ledger = dependencies.ledger ?? new DecisionLedger(config.ledgerPath ?? null);
    this.calibrator = config.calibrationPath ? new Calibrator(config.calibrationPath) : new Calibrator();
    this.gateService = new ReflexGateService(this.backend, this.ledger, this.calibrator);
    this.pruneService = new ToolResultPruner(this.backend, this.ledger, config.pruneThreshold);
    this.stagnationService = new StagnationDetector(this.backend, this.ledger);
    this.routeService = new ReflexRouter(this.backend, this.ledger);
    this.screenService = new ReflexScreenService(this.backend, this.ledger);
    this.#source = dependencies.configSource;
    this.#warn = dependencies.warn ?? (() => {});
    this.#interventionsConfig = config.interventions;
    this.#pruneThreshold = config.pruneThreshold;
    this.#toolsConfig = config.tools;
    this.#toolPrefix = config.toolPrefix;
    const initialMark = dependencies.configSource === undefined ? [] : volatileSnapshots(dependencies.configSource);
    this.#mark = initialMark;
    this.#watchable = initialMark.length > 0;
    this.#modelRouter = new VirtualModelRouter({
      virtualProvider: config.routing.virtualProvider,
      models: config.routing.models,
      backendName: this.backend.name,
      ledger: this.ledger,
      route: (goal, candidates, topK, input) =>
        this.routeService.selectBest(goal, candidates, topK, { record: false, ...(input ?? {}) }),
      ...(config.routing.fallback ? { fallback: config.routing.fallback } : {}),
      ...(dependencies.now ? { now: dependencies.now } : {}),
      // The loader commits a config-only update without remounting the plugin;
      // this is how every routing decision and panel read sees the new policy.
      refresh: () => { this.refreshIfChanged(); }
    });
    this.effortStatusFeed = new EffortStatusFeed();
    this.effort = new EffortInterceptor({
      ...(config.effort.setting === undefined ? {} : { setting: config.effort.setting }),
      enabled: config.effort.enabled,
      fallback: config.effort.fallback,
      minConfidence: config.effort.minConfidence,
      decide: (request) => this.backend.choice(request),
      backendName: this.backend.name,
      ledger: this.ledger,
      feed: this.effortStatusFeed,
      ...(dependencies.now ? { now: dependencies.now } : {})
    });
  }

  /** Name of the active decision backend, for diagnostics and tests. */
  get backendName(): string {
    return this.backend.name;
  }

  /** The routing policy this activation routes through (live). */
  get modelRouter(): VirtualModelRouter {
    return this.#modelRouter;
  }

  /**
   * Route through the process-wide router another activation registered.
   *
   * A reload can leave one provider registration shared by two activations. The
   * shared router is where the live pools and fallback live, so this runtime must
   * read (and refresh) that one — a private copy would show the panel, and route
   * requests, on a policy nobody applies.
   * @param router - the shared router the virtual provider dispatches through.
   */
  adoptModelRouter(router: VirtualModelRouter): void {
    this.#modelRouter = router;
  }

  /**
   * Health of the backend's gateway conversation, or `undefined` for a backend
   * that answers every call in-process.
   *
   * Read by the settings panel and `/reflex-ledger`; never passed to a model.
   * @returns a copy of the counters.
   */
  systemOneHealth(): BackendHealth | undefined {
    const health = (this.backend as Partial<DecisionBackend>).health;
    return typeof health === 'function' ? health.call(this.backend) : undefined;
  }

  /**
   * Multi-class choice, with the deployment's calibration curve applied to the
   * winning confidence when one is loaded.
   * @param request - question, options, and optional context.
   * @returns the choice response plus the calibrated confidence, when available.
   */
  async choice(request: { question: string; options: string[]; context?: string }): Promise<ReflexChoiceResult> {
    this.#assertLive();
    const started = performance.now();
    const result = await this.backend.choice(request);

    let calibratedConfidence: number | undefined;
    if (this.calibrator.isLoaded()) {
      calibratedConfidence = this.calibrator.calibrate(result.confidence).calibrated;
    }

    this.ledger.record({
      type: 'choice',
      backend: this.backend.name,
      latencyMs: Math.round(performance.now() - started),
      details: { action: 'choice', options: request.options.length }
    });

    return { ...result, calibratedConfidence };
  }

  /**
   * Continuous 0.0 – 1.0 scoring projected from one choice call.
   * @param request - statement, rubric, and optional context.
   * @returns the score response recorded in the ledger.
   */
  async score(request: { statement: string; criteria?: string; context?: string }): Promise<Awaited<ReturnType<typeof scoreStatement>>> {
    this.#assertLive();
    const result = await scoreStatement(this.backend, request);

    this.ledger.record({
      type: 'choice',
      backend: this.backend.name,
      latencyMs: result.latencyMs,
      details: { action: 'score', score: result.score }
    });

    return result;
  }

  /**
   * Rank candidate skills/tools against a goal.
   * @param request - goal, candidates, and how many to return.
   * @returns the ranked candidates.
   */
  async route(request: { goal: string; candidates: CandidateItem[]; topK?: number }): Promise<RouteResponse> {
    this.#assertLive();
    return this.routeService.selectBest(request.goal, request.candidates, request.topK ?? 3);
  }

  /**
   * Screen untrusted content for prompt injection and instruction hijacking.
   * @param request - content, its source, and whether to force deep screening.
   * @returns the screening verdict and a sanitized fence when unsafe.
   */
  async screen(request: {
    content: string;
    source?: 'tool_output' | 'web_page' | 'user_input' | 'file_content';
    strict?: boolean;
  }): Promise<ScreenResult> {
    this.#assertLive();
    return this.screenService.screen(request);
  }

  /**
   * Fail-closed verification of assertions against evidence.
   * @param request - assertions, evidence, and optional strictness.
   * @returns one outcome per assertion plus the overall verdict.
   */
  async gate(request: {
    assertions: Array<{ statement: string; criteria?: string }>;
    evidence: string;
    strictness?: 'high' | 'normal' | 'lenient';
  }): Promise<GateResponse> {
    this.#assertLive();
    return this.gateService.verify(request.assertions, request.evidence, { strictness: request.strictness });
  }

  /**
   * Prune bulky output, preserving the lines the intent depends on.
   *
   * Programmatic seam for the pruning capability: the automatic intervention
   * layer drives {@link pruneService} directly, and this entry point stays for
   * in-process callers (tests, diagnostics, an embedding Host).
   * @param request - raw output, lookup intent, and shadow-mode flag.
   * @returns the compacted payload and the measured token savings.
   */
  async prune(request: { rawOutput: string; intent?: string; shadowMode?: boolean }): Promise<ReflexPruneResult> {
    this.#assertLive();
    const result: PruneResponse = await this.pruneService.prune(request.rawOutput, {
      intent: request.intent,
      shadowMode: request.shadowMode
    });

    return {
      tokensSaved: result.estimatedTokensSaved,
      reductionPercentage: `${result.reductionPercentage}%`,
      shadow: result.shadow,
      processedOutput: result.processedOutput
    };
  }

  /**
   * Record one action and check whether the run is stagnating.
   *
   * `history` exists for callers that bring their own run: a resumed session, a
   * delegated agent, or a caller that did not record its steps through this
   * tool. Supplied steps are treated as earlier than the ones recorded here, so
   * a caller can hand over a whole run and still add the action it just took.
   *
   * Programmatic seam for the stagnation capability: the automatic intervention
   * layer drives {@link stagnationService} directly, and this entry point stays
   * for in-process callers.
   *
   * @param request - the action just taken, the overall goal, and any prior steps.
   * @returns the stagnation verdict and corrective suggestion.
   */
  async detectStagnation(request: {
    goal?: string;
    recentAction?: ActionStep;
    history?: readonly ActionStep[];
  }): Promise<StagnationCheckResponse> {
    this.#assertLive();
    if (request.recentAction) this.stagnationService.recordAction(request.recentAction);
    return this.stagnationService.check(request.goal, request.history);
  }

  /**
   * Read the decision ledger.
   *
   * Programmatic seam behind `/reflex-ledger`: the Host command formats this
   * same read for a person, and an embedding Host can call it directly. Nothing
   * in the tool surface depends on it.
   * @param request - whether to attach the ten most recent entries.
   * @returns the aggregate summary and, on request, recent entries.
   */
  statusLedger(request: { includeEntries?: boolean } = {}): ReflexLedgerResult {
    this.#assertLive();
    const summary = this.ledger.getSummary();
    const health = this.systemOneHealth();
    const base: ReflexLedgerResult = health === undefined ? { summary } : { summary, systemOneHealth: health };
    if (!request.includeEntries) return base;
    return { ...base, recentEntries: this.ledger.getEntries().slice(-10) };
  }

  /**
   * Publish the reflex tool names this activation currently owns, so a Host
   * observer can mirror the live surface.
   * @param names - the registered tool names.
   */
  noteToolSurface(names: readonly string[]): void {
    this.#surface = [...names];
  }

  /** The reflex tool names of this activation. */
  get toolSurface(): readonly string[] {
    return this.#surface;
  }

  /**
   * The latest adaptive effort decision this activation published.
   * @param agentId - agent to read; omitted reads the most recent of any agent.
   * @returns the status, or `undefined` before the first decided turn.
   */
  effortStatus(agentId?: string): ReflexEffortStatus | undefined {
    return this.effortStatusFeed.latest(agentId);
  }

  /**
   * The status-bar line of the latest adaptive effort decision.
   * @param agentId - agent to read; omitted reads the most recent of any agent.
   * @returns the rendered line, or `undefined` before the first decided turn.
   */
  effortStatusLine(agentId?: string): string | undefined {
    return this.effortStatusFeed.statusLine(agentId);
  }

  /**
   * Attach the automatic-intervention engine of this activation.
   *
   * Set by the plugin lifecycle right after the listeners are installed, so the
   * panel and the tests read the same engine the hooks drive. Absent when every
   * capability is `off`: nothing is installed, and nothing is reported.
   *
   * The optional reconfiguration seam is what makes a config-only save live: the
   * installer owns the listeners (which hooks exist depends on the capability
   * modes), so swapping thresholds or turning a capability on/off has to go
   * through it rather than through the engine alone.
   * @param engine - the engine behind this activation's listeners.
   * @param reconfigure - applies a new resolved policy to the listeners.
   * @param listenerCount - reads how many listeners are currently attached.
   */
  attachInterventions(
    engine: InterventionEngine | undefined,
    reconfigure?: (config: ResolvedInterventionsConfig, pruneThreshold: number) => void,
    listenerCount?: () => number
  ): void {
    this.#interventions = engine;
    this.#reconfigureInterventions = reconfigure;
    this.#interventionListenerCount = listenerCount;
  }

  /**
   * How many intervention listeners this activation currently has attached.
   *
   * `0` is the honest answer of an `off` deployment: the capability is absent,
   * not a listener that checks a flag on every hook.
   */
  get interventionListenerCount(): number {
    return this.#interventionListenerCount?.() ?? 0;
  }

  /** The automatic-intervention engine, when this activation installed one. */
  get interventions(): InterventionEngine | undefined {
    return this.#interventions;
  }

  /**
   * Attach the tool-surface reconciler of this activation.
   *
   * Set by the plugin lifecycle right after the tools are registered. The
   * registry lives on the Host context, not on this runtime, so a config-only
   * save has to call back out to the installer that owns the registrations. The
   * seam is also what lets the tests prove idempotence: an unchanged save must
   * not unregister and re-register anything.
   * @param reconfigure - reconciles the registered set with a new resolved config.
   * @param registrationCount - reads how many tools are currently registered.
   * @param registrationEvents - reads how many registrations happened in total.
   */
  attachToolSurface(
    reconfigure?: (config: ResolvedReflexConfig) => void,
    registrationCount?: () => number,
    registrationEvents?: () => number
  ): void {
    this.#reconfigureTools = reconfigure;
    this.#toolRegistrationCount = registrationCount;
    this.#toolRegistrationEvents = registrationEvents;
  }

  /** The number of reflex tools this activation currently has registered. */
  get toolRegistrationCount(): number {
    return this.#toolRegistrationCount?.() ?? 0;
  }

  /**
   * How many `tools.register` calls this activation has made since it loaded.
   *
   * Monotonic on purpose: an idempotent save leaves it unchanged, which is the
   * measurement a test can assert without spying on the registry.
   */
  get toolRegistrationEvents(): number {
    return this.#toolRegistrationEvents?.() ?? 0;
  }

  /**
   * The configuration the panel and diagnostics must report: the values
   * currently in force for every block this slice has made live.
   *
   * The panel promise is "show what is in force", not "show what was written at
   * startup". `effort`, `interventions`, `pruneThreshold`, `tools` and
   * `toolPrefix` are read from their live fields; blocks whose live path is a
   * separate slice (backend, ledger sink, route lifecycle) keep reporting their
   * activation values until that slice lands.
   */
  get effectiveConfig(): ResolvedReflexConfig {
    return {
      ...this.config,
      toolPrefix: this.#toolPrefix,
      tools: this.#toolsConfig,
      effort: { ...this.effort.policy },
      interventions: this.#interventionsConfig,
      pruneThreshold: this.#pruneThreshold
    };
  }

  /**
   * Full schema resolutions this activation performed.
   *
   * Incremented only by {@link refresh}; the request/step/tool hot paths never
   * resolve the schema, which is the measurement this counter makes provable.
   */
  get configResolveCount(): number {
    return this.#configResolves;
  }

  /** Whether the owning plugin activation has been disposed. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * Re-read this activation's live policy from its config.
   *
   * Called when the Host reports a config commit (`loader/volatile-update`) and
   * lazily once per `agent/pre-step`. The schema runs here — once per actual
   * commit — and nowhere on the request/tool hot paths.
   *
   * Applied without a remount:
   * - routing pools and fallback (replaced in the router);
   * - the whole adaptive-effort policy (switch, marker, fallback, confidence
   *   floor), read live by the request interception and the selector surface;
   * - the intervention thresholds and capability modes, with the listeners
   *   added or removed according to the effective modes;
   * - the per-tool switches and the deployment prefix, with the registry
   *   reconciled by the installer through {@link attachToolSurface}. The
   *   reconciler is idempotent: a commit that changes neither the enabled
   *   suffixes nor the prefix unregisters and re-registers nothing.
   *
   * Still activation-time (their own live path is a separate slice): the
   * backend, the ledger sink and the virtual provider lifecycle.
   * @returns whether a new policy was applied.
   */
  refresh(): boolean {
    if (this.#source === undefined || this.#disposed) return false;
    let resolved: ResolvedReflexConfig;
    try {
      resolved = resolveConfig(this.#source as ReflexConfig);
    } catch (error) {
      this.#warn(
        `dsh-reflex: the updated configuration cannot be applied (${(error as Error).message}); keeping the previous live values`
      );
      return false;
    }
    this.#configResolves += 1;
    this.#modelRouter.updatePolicy({
      models: resolved.routing.models,
      ...(resolved.routing.fallback ? { fallback: resolved.routing.fallback } : {})
    });
    this.effort.updatePolicy({
      enabled: resolved.effort.enabled,
      ...(resolved.effort.setting === undefined ? {} : { setting: resolved.effort.setting }),
      fallback: resolved.effort.fallback,
      minConfidence: resolved.effort.minConfidence
    });
    this.#interventionsConfig = resolved.interventions;
    this.#pruneThreshold = resolved.pruneThreshold;
    // The tool block is applied before the intervention reconfigure so the
    // callback can derive the renamed `ownTools` set from this runtime's live
    // values rather than from the activation-time snapshot.
    this.#toolsConfig = resolved.tools;
    this.#toolPrefix = resolved.toolPrefix;
    this.#reconfigureInterventions?.(resolved.interventions, resolved.pruneThreshold);
    this.#reconfigureTools?.(resolved);
    this.#mark = volatileSnapshots(this.#source);
    return true;
  }

  /**
   * Refresh only when the loader actually committed a new config value.
   *
   * The volatile references hand out a new snapshot object on every commit, so
   * an identity comparison over them is O(config blocks) and never runs the
   * schema again for an unchanged config.
   * @returns whether a new policy was applied.
   */
  refreshIfChanged(): boolean {
    if (!this.#watchable || this.#source === undefined || this.#disposed) return false;
    const next = volatileSnapshots(this.#source);
    const previous = this.#mark;
    const unchanged =
      next.length === previous.length && next.every((snapshot, index) => snapshot === previous[index]);
    if (unchanged) return false;
    return this.refresh();
  }

  /** Release the runtime. Called from the plugin's `ctx.effect` cleanup. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // No residue on unload: the per-agent detection state, the reduction memo,
    // and the accounts of the intervention engine are dropped with the runtime,
    // exactly like the effort feed and the ledger.
    this.#interventions?.reset();
    this.#interventions = undefined;
    this.effortStatusFeed.clear();
    this.ledger.clear();
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error('reflex runtime has been disposed');
  }
}

/**
 * Build the backend a plugin activation should use.
 *
 * The connection block of the resolved config overrides the environment for
 * this plugin instance only: the backend implementations already fall back to
 * the environment for every omitted option, so an explicitly configured
 * deployment and an env-configured one behave the same when the block is empty.
 * @param config - resolved plugin configuration.
 * @param env - environment the API-key indirection reads; defaults to `process.env`.
 * @returns the forced backend, or one chosen from the environment for `auto`.
 */
export function createBackend(
  config: ResolvedReflexConfig,
  env: Record<string, string | undefined> = process.env
): DecisionBackend {
  const { backend, baseUrl, model, timeoutMs } = config.systemOne;
  const apiKey = resolveApiKey(config.systemOne, env);
  switch (backend) {
    case 'mock':
      return new MockDecisionBackend();
    case 'jev':
      return new JevDecisionBackend({
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(model === undefined ? {} : { model }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        // The resolved config wins over SYSTEM_ONE_PRUNE_JUDGE_MIN_CHARS: the
        // backend only reads the environment when no explicit value is given.
        pruneJudgeMinChars: config.interventions.pruneJudgeMinChars
      });
    case 'vllm':
      return new SimpleJevDecisionBackend({
        ...(baseUrl === undefined ? {} : { vllmBaseUrl: baseUrl }),
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(model === undefined ? {} : { model }),
        ...(timeoutMs === undefined ? {} : { timeoutMs })
      });
    default:
      return createSystemOneBackend();
  }
}

/**
 * Build a runtime for one plugin activation.
 * @param config - resolved plugin configuration.
 * @param dependencies - test seams for the ledger, backend, and routing clock.
 * @returns the runtime the tools close over.
 */
export function createReflexRuntime(
  config: ResolvedReflexConfig,
  dependencies: {
    backend?: DecisionBackend;
    ledger?: DecisionLedger;
    now?: () => number;
    configSource?: unknown;
    warn?: (message: string) => void;
  } = {}
): ReflexRuntime {
  return new ReflexRuntime(config, dependencies);
}
