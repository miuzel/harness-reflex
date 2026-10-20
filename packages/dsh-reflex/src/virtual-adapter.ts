import {
  LlmAdapter,
  isAgentLoopRequest,
  markAgentLoopRequest,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmReasoningEffortInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ReasoningEffortId,
  type StreamChunk
} from '@deepseek-ai/dsh-llm';

import {
  alignReasoningEffort,
  formatTargetName,
  type PhysicalTarget,
  type ReasoningProbe,
  type VirtualModelRouter
} from './router.js';
import { ADAPTIVE_EFFORT_LEVELS, EFFORT_LEVELS } from './effort.js';

/** Effort id that means "let System 1 pick the level for this turn". */
export const ADAPTIVE_VIRTUAL_EFFORT = 'reflex';

/** Display names of the concrete levels, for the virtual model's effort list. */
const VIRTUAL_EFFORT_NAMES: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max'
};

/**
 * The effort choices every virtual model advertises.
 *
 * `reflex` comes first so it reads as the top (and default) choice, and every
 * concrete ladder level follows, so a user who wants to pin one can do it from
 * the same selector. The virtual route then translates a pinned level to the
 * physical model it routes to, exactly as a fixed physical model would.
 */
export const VIRTUAL_EFFORT_CHOICES: readonly LlmReasoningEffortInfo[] = [
  {
    id: ADAPTIVE_VIRTUAL_EFFORT as ReasoningEffortId,
    name: 'Reflex (Auto)',
    description: 'System 1 adaptive reasoning effort, decided per turn'
  },
  ...EFFORT_LEVELS.map((level) => ({
    id: level as ReasoningEffortId,
    name: VIRTUAL_EFFORT_NAMES[level] ?? level
  }))
];

/** Whether one effort id is the adaptive marker (or its accepted alias). */
export function isVirtualAdaptiveEffort(effort: string | undefined): boolean {
  return effort !== undefined && (effort === ADAPTIVE_VIRTUAL_EFFORT || effort === 'auto');
}

/** Whether one requested effort is a concrete adaptive level. */
export function isAdaptiveLevelChoice(effort: string | undefined): boolean {
  return effort !== undefined && (ADAPTIVE_EFFORT_LEVELS as readonly string[]).includes(effort);
}

/**
 * The virtual provider's DSH adapter.
 *
 * Registering this adapter makes the virtual route a first-class provider: it
 * appears in `ctx.llm.listProviders()`, advertises its virtual models to
 * catalog surfaces (the model picker), and can be selected as an
 * `AgentOptions.provider` by a main agent or — because subagents inherit their
 * parent's provider/model — by a delegated subagent.
 *
 * Its `stream()` is the *dispatch-level* routing seam, the second of the two
 * interception layers (the first is the `agent/request` waterfall, which
 * rewrites the logged call config before dispatch). Anything that reaches this
 * adapter — a hand-built one-shot call, a prepared call, or a loop request
 * whose config was not rewritten — is routed here and delegated to the winning
 * physical adapter through the injected `dispatch`.
 *
 * @module dsh-reflex/virtual-adapter
 */

/** Dependencies of {@link ReflexVirtualAdapter}. */
export interface ReflexVirtualAdapterOptions {
  /** The virtual provider route this adapter owns. */
  provider: string;
  /** Pool policy and System 1 decision seam. */
  router: VirtualModelRouter;
  /**
   * Dispatch one already-routed request through the LLM runtime. The plugin
   * supplies `(options) => ctx.llm.stream(options)`, so the physical adapter is
   * resolved by the Host and this adapter is never re-entered (the routed
   * target can never be the virtual provider).
   */
  dispatch: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
  /** Reasoning-effort capability lookup for the routed target. */
  probeReasoning?: ReasoningProbe;
  /** Display name shown by provider surfaces. */
  displayName?: string;
  /** Context window lookup for the candidate models. */
  resolveContextWindow?: (provider: string, model: string) => Promise<number | undefined>;
}

/** Extract the task text a hand-built request carries, for the routing decision. */
function taskFromMessages(messages: GenerateOptions['messages']): string | undefined {
  const parts: string[] = [];
  for (let index = messages.length - 1; index >= 0 && parts.length === 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
        parts.push(block.text.trim());
      }
    }
  }
  return parts.length === 0 ? undefined : parts.join('\n');
}

/** One provider route that resolves its virtual models onto physical routes. */
export class ReflexVirtualAdapter extends LlmAdapter {
  /** The virtual provider route this adapter owns. */
  readonly provider: string;

  #router: VirtualModelRouter;
  #dispatch: ReflexVirtualAdapterOptions['dispatch'];
  #probeReasoning?: ReasoningProbe;
  #resolveContextWindow?: (provider: string, model: string) => Promise<number | undefined>;
  #displayName: string;

  /**
   * @param options - router, dispatch seam, and display metadata.
   */
  constructor(options: ReflexVirtualAdapterOptions) {
    super();
    this.provider = options.provider;
    this.#router = options.router;
    this.#dispatch = options.dispatch;
    this.#probeReasoning = options.probeReasoning;
    this.#resolveContextWindow = options.resolveContextWindow;
    this.#displayName = options.displayName ?? 'Reflex (System 1 router)';
  }

  /** The routing policy this adapter dispatches through. */
  get router(): VirtualModelRouter {
    return this.#router;
  }

  /**
   * Describe the virtual route.
   * @param provider - one owned provider route.
   * @returns display metadata whose id preserves the route.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.#displayName };
  }

  /**
   * Advertise the configured virtual models so catalog-driven surfaces list them.
   * @param provider - one owned provider route.
   * @returns one entry per virtual model, newest configuration first.
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.#router.modelIds.map((model) => ({
      provider,
      id: model,
      name: model,
      description: this.#router.describe(model)
    }));
  }

  /**
   * Resolve one virtual model's identity and capabilities.
   * @param provider - one owned provider route.
   * @param model - virtual model id.
   * @returns identity plus the pool description.
   * @throws Error when the virtual model is not declared in the routing configuration.
   */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const pool = this.#router.poolFor(model);
    if (pool === undefined) {
      throw new Error(
        `${this.provider}: unknown virtual model "${model}"; declared models: ${this.#router.modelIds.join(', ') || '(none)'}`
      );
    }

    // A virtual route can choose any candidate: only advertise a conservative
    // capacity when every candidate's exact-route metadata is known. Neither
    // the first candidate nor an invented default describes the whole pool.
    const windows = this.#resolveContextWindow
      ? await Promise.all(pool.map(async (candidate) => {
          try {
            return await this.#resolveContextWindow!(candidate.provider, candidate.model);
          } catch {
            return undefined;
          }
        }))
      : [];
    const contextWindow = windows.length > 0 && windows.every((value) =>
      typeof value === 'number' && Number.isFinite(value) && value > 0)
      ? Math.min(...windows as number[])
      : undefined;

    return {
      provider,
      id: model,
      name: model,
      description: this.#router.describe(model),
      ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
      // The virtual route is where "let System 1 decide" is actually selectable.
      // Without a declared `reasoning` block the host model selector offers no
      // effort at all for a virtual model, so the adaptive mode could only be
      // turned on from configuration — never from the surface the user is
      // looking at. Declaring `reflex` first makes "Reflex (Auto)" the first
      // choice for every virtual model, and the concrete levels stay selectable
      // for a manual pin.
      //
      // `defaultEffort` is deliberately *not* declared. A declared default is
      // materialized by the runtime as a rewritten call config, which replaces
      // the caller's request object — and a request object's identity is what
      // carries the loop-owned mark downstream listeners gate on. With no
      // default, the runtime leaves the config untouched, the mark survives, and
      // an unpinned virtual request still decides per turn: the deployment
      // setting or the adaptive-effort surface supplies the marker.
      reasoning: {
        efforts: VIRTUAL_EFFORT_CHOICES.map((effort) => ({ ...effort }))
      }
    };
  }

  /**
   * Bind one virtual model to this adapter generation.
   * @param provider - one owned provider route.
   * @param model - virtual model id.
   * @param signal - cancellation for model resolution.
   * @returns the resolved model and this adapter's stream entry point.
   */
  override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model),
      stream: (options) => this.stream(options)
    };
  }

  /**
   * Route one request onto its physical target and delegate the stream.
   * @param options - the fully-assembled request naming the virtual route.
   * @returns the physical adapter's chunks.
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const decision = await this.#router.routeModel({
      provider: options.provider,
      model: options.model,
      task: taskFromMessages(options.messages)
    });

    const aligned = this.#probeReasoning
      ? await alignReasoningEffort(options.reasoningEffort, decision.target, this.#probeReasoning)
      : options.reasoningEffort;

    const rerouted = {
      ...options,
      provider: decision.target.provider,
      model: decision.target.model,
      // Like the `agent/request` layer, the key is only added when the caller
      // carried one, so a request that never named an effort stays identical.
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: aligned })
    } as GenerateOptions;

    // The request content is unchanged — only the route is rewritten — so a
    // loop-assembled request keeps its identity for downstream listeners that
    // gate on it (session titles, compaction).
    if (isAgentLoopRequest(options)) {
      markAgentLoopRequest(rerouted);
      (rerouted as any).__reflexLoopOwned = true;
    }

    yield* this.#dispatch(rerouted);
  }

  /**
   * Human-readable target of one virtual model, for diagnostics and tests.
   * @param model - virtual model id.
   * @returns the first candidate as `provider:model`, or `undefined`.
   */
  firstCandidate(model: string): PhysicalTarget | undefined {
    const [first] = this.#router.poolFor(model) ?? [];
    return first ? { provider: first.provider, model: first.model } : undefined;
  }

  /**
   * Description of the routing target actually used for a model, for logging.
   * @param model - virtual model id.
   * @returns the formatted first candidate, or an empty string.
   */
  describeFirstCandidate(model: string): string {
    const first = this.firstCandidate(model);
    return first ? formatTargetName(first) : '';
  }
}
