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
  CandidateItem,
  ChoiceResponse,
  DecisionBackend,
  GateResponse,
  PruneResponse,
  RouteResponse,
  ScreenResult,
  StagnationCheckResponse
} from './vendor/harness-reflex/index.js';

import type { ResolvedReflexConfig } from './config.js';
import { resolveApiKey } from './config.js';
import { EffortInterceptor, EffortStatusFeed, type ReflexEffortStatus } from './effort.js';
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

/** Payload of the `status_ledger` operation. */
export interface ReflexLedgerResult {
  summary: ReturnType<DecisionLedger['getSummary']>;
  recentEntries?: ReturnType<DecisionLedger['getEntries']>;
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
   * System 1 virtual→physical model router of this activation. It owns the
   * configured pools and writes one `model-route` ledger entry per decision;
   * the plugin installs it on the LLM runtime and dispatches through it.
   */
  readonly modelRouter: VirtualModelRouter;
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

  /**
   * @param config - resolved plugin configuration.
   * @param dependencies - test seams for the ledger, backend, and routing clock.
   */
  constructor(
    config: ResolvedReflexConfig,
    dependencies: { backend?: DecisionBackend; ledger?: DecisionLedger; now?: () => number } = {}
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
    this.modelRouter = new VirtualModelRouter({
      virtualProvider: config.routing.virtualProvider,
      models: config.routing.models,
      backendName: this.backend.name,
      ledger: this.ledger,
      route: (goal, candidates, topK, input) =>
        this.routeService.selectBest(goal, candidates, topK, { record: false, ...(input ?? {}) }),
      ...(config.routing.fallback ? { fallback: config.routing.fallback } : {}),
      ...(dependencies.now ? { now: dependencies.now } : {})
    });
    this.effortStatusFeed = new EffortStatusFeed();
    this.effort = new EffortInterceptor({
      ...(config.effort.setting === undefined ? {} : { setting: config.effort.setting }),
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
   * @param request - whether to attach the ten most recent entries.
   * @returns the aggregate summary and, on request, recent entries.
   */
  statusLedger(request: { includeEntries?: boolean } = {}): ReflexLedgerResult {
    this.#assertLive();
    const summary = this.ledger.getSummary();
    if (!request.includeEntries) return { summary };
    return { summary, recentEntries: this.ledger.getEntries().slice(-10) };
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

  /** Whether the owning plugin activation has been disposed. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /** Release the runtime. Called from the plugin's `ctx.effect` cleanup. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
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
        ...(timeoutMs === undefined ? {} : { timeoutMs })
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
  dependencies: { backend?: DecisionBackend; ledger?: DecisionLedger; now?: () => number } = {}
): ReflexRuntime {
  return new ReflexRuntime(config, dependencies);
}
