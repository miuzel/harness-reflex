import { Context } from '@deepseek-ai/cordis';
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent';
import LlmRuntime, {
  LlmAdapter,
  isAgentLoopRequest,
  type GenerateOptions,
  type LlmCallConfig,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type UserMessage
} from '@deepseek-ai/dsh-llm';
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';

import { apply, applyReflex, Config, inject, name as pluginName } from './index.js';
import type { ReflexRuntime } from './bridge.js';
import type { ReflexConfig } from './config.js';

/** Branded call id, taken from the registry signature so no extra dependency is needed. */
type CallId = Parameters<Context['tools']['execute']>[0]['callId'];

/**
 * Mint a registry-legal call id.
 * @param id - unique suffix.
 * @returns the branded id.
 */
function callId(id: string): CallId {
  return id as CallId;
}

/**
 * Test harness for the reflex Host plugin.
 *
 * It boots a real Cordis application with the three services the plugin depends
 * on (`systemPrompt` for the tool registry, then `tools` itself, plus `llm` for
 * the virtual provider route), so tests exercise the production registration,
 * validation, routing, and disposal paths rather than a stand-in.
 *
 * @module dsh-reflex/testing
 */

/** The plugin as Cordis sees it, for `ctx.plugin()`-based lifecycle tests. */
export const reflexPlugin = { name: pluginName, inject, Config, apply };

/** A booted application with the reflex tools registered. */
export interface ReflexTestHost {
  /** Root context carrying `systemPrompt`, `tools`, and `llm`. */
  readonly ctx: Context;
  /** Runtime returned by {@link apply}. */
  readonly runtime: ReflexRuntime;
  /** Execute one registered tool through the real registry pipeline. */
  callTool(name: string, args?: unknown): Promise<ToolExecutionResult>;
  /** Dispose the application (and with it the plugin's effects). */
  dispose(): Promise<void>;
}

/**
 * Boot Cordis with `systemPrompt`, `tools`, and `llm` loaded.
 * @returns the root context, ready for `apply` or `ctx.plugin`.
 */
export async function createToolContext(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(LlmRuntime);
  return ctx;
}

/**
 * Boot a context and register the reflex tools on it with the exported
 * {@link applyReflex}, mirroring a Host that loads the plugin while keeping a
 * handle on the activation's runtime.
 * @param config - deployment config; defaults are resolved by the plugin.
 * @returns the host handle.
 */
export async function createReflexHost(config?: ReflexConfig): Promise<ReflexTestHost> {
  const ctx = await createToolContext();
  const runtime = applyReflex(ctx, config);
  let calls = 0;

  return {
    ctx,
    runtime,
    callTool: (name: string, args: unknown = {}) =>
      ctx.tools.execute({
        callId: callId(`reflex-test-${++calls}`),
        name,
        arguments: args,
        signal: new AbortController().signal
      }),
    dispose: () => ctx.fiber.dispose()
  };
}

/**
 * Execute one tool on an existing context.
 * @param ctx - a context whose `tools` service is live.
 * @param name - registered tool name.
 * @param args - model-shaped arguments.
 * @returns the registry result (never throws for tool-level failures).
 */
export function callTool(ctx: Context, name: string, args: unknown = {}): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: callId(`reflex-test-${name}-${Math.random().toString(36).slice(2, 8)}`),
    name,
    arguments: args,
    signal: new AbortController().signal
  });
}

/**
 * Read the text a model would receive from one tool result.
 * @param result - a registry result.
 * @returns the first text block, or an empty string.
 */
export function resultText(result: ToolExecutionResult): string {
  const block = result.content?.[0];
  return block && block.type === 'text' ? block.text : '';
}

/**
 * Read the structured value of a successful tool result.
 * @param result - a registry result.
 * @returns the parsed value.
 * @throws Error when the call failed.
 */
export function resultValue<T = any>(result: ToolExecutionResult): T {
  if (result.isError) throw new Error(`tool failed: ${resultText(result)}`);
  return result.value as T;
}

/** One observed dispatch of the fake physical adapter. */
export interface PhysicalCall {
  provider: string;
  model: string;
  reasoningEffort?: string;
  /** Text of the last user message, proving the payload survived routing. */
  lastUserText?: string;
  /** Whether the request was marked as loop-assembled. */
  loopOwned: boolean;
}

/** Options of {@link FakePhysicalAdapter}. */
export interface FakePhysicalAdapterOptions {
  /** Model ids the adapter advertises and resolves. */
  models?: string[];
  /** Reasoning efforts the adapter declares for every model; omitted = none declared. */
  reasoningEfforts?: string[];
  /** Default reasoning effort declared for every model. */
  defaultEffort?: string;
  /** When set, every dispatch fails with this error. */
  failWith?: Error;
}

/**
 * A physical provider adapter that records every dispatch, so a test can prove
 * which provider/model a routed request actually reached.
 */
export class FakePhysicalAdapter extends LlmAdapter {
  /** Provider route this adapter serves. */
  readonly provider: string;
  /** Dispatches observed so far, oldest first. */
  readonly calls: PhysicalCall[] = [];

  #models: string[];
  #options: FakePhysicalAdapterOptions;

  /**
   * @param provider - provider route to serve.
   * @param options - advertised models, reasoning metadata, and failure injection.
   */
  constructor(provider: string, options: FakePhysicalAdapterOptions = {}) {
    super();
    this.provider = provider;
    this.#models = options.models ?? ['default-model'];
    this.#options = options;
  }

  /**
   * Describe the provider route.
   * @param provider - the owned route.
   * @returns display metadata.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: `fake(${provider})` };
  }

  /**
   * Advertise the configured models.
   * @param provider - the owned route.
   * @returns one entry per configured model.
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.#models.map((model) => ({ provider, id: model, name: model }));
  }

  /**
   * Resolve one model, declaring the configured reasoning vocabulary.
   * @param provider - the owned route.
   * @param model - requested model id.
   * @returns identity plus reasoning metadata.
   */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const efforts = this.#options.reasoningEfforts;
    const reasoning =
      efforts && efforts.length > 0
        ? {
            efforts: efforts.map((effort) => ({ id: effort, name: effort })),
            ...(this.#options.defaultEffort ? { defaultEffort: this.#options.defaultEffort } : {})
          }
        : undefined;
    return {
      provider,
      id: model,
      name: model,
      ...(reasoning ? { reasoning: reasoning as unknown as LlmResolvedModelInfo['reasoning'] } : {})
    };
  }

  /**
   * Record one dispatch and emit a deterministic single-chunk response.
   * @param options - the routed request.
   * @returns the chunk stream.
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const lastUser = [...options.messages].reverse().find((message) => message.role === 'user');
    const text = (lastUser?.content ?? []).find((block) => block.type === 'text');
    this.calls.push({
      provider: options.provider,
      model: options.model,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort as unknown as string }),
      ...(text && text.type === 'text' ? { lastUserText: text.text } : {}),
      loopOwned: isAgentLoopRequest(options)
    });

    if (this.#options.failWith) throw this.#options.failWith;

    yield { type: 'text-delta', index: 0, text: `${options.provider}:${options.model}` };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

/**
 * Register one fake physical adapter on a context.
 * @param ctx - a context whose `llm` service is live.
 * @param provider - provider route to register.
 * @param options - adapter behavior.
 * @returns the adapter, with its recorded calls.
 */
export function registerPhysicalAdapter(
  ctx: Context,
  provider: string,
  options: FakePhysicalAdapterOptions = {}
): FakePhysicalAdapter {
  const adapter = new FakePhysicalAdapter(provider, options);
  ctx.llm.registerAdapter([provider], adapter);
  return adapter;
}

/** An agent-shaped dispatch subject for routing tests. */
export interface FakeAgentSeed {
  /** Agent/session id. */
  id: string;
  /** `subagent` marks a delegated child session. */
  origin?: 'subagent';
  /** Delegation depth recorded on the session header. */
  delegationDepth?: number;
  /** Provider the agent was composed with. */
  provider?: string;
  /** Model the agent was composed with. */
  model?: string;
}

/**
 * Build the minimal agent shape the routing listeners read.
 * @param seed - identity and lineage facts.
 * @returns an object usable as the `agent` payload field.
 */
export function fakeAgent(seed: FakeAgentSeed): Agent {
  return {
    id: seed.id,
    options: { provider: seed.provider, model: seed.model },
    session: { header: { origin: seed.origin, delegationDepth: seed.delegationDepth } }
  } as unknown as Agent;
}

/**
 * Dispatch one `agent/pre-step` and then one `agent/request` for an agent, the
 * way the loop does, and return the configuration the waterfall produced.
 * @param ctx - context the plugin was loaded on.
 * @param agent - the requesting agent.
 * @param options - step identity and the config the loop would use.
 * @returns the rewritten call configuration.
 */
export async function dispatchAgentRequest(
  ctx: Context,
  agent: Agent,
  options: {
    turn?: number;
    step?: number;
    task?: string;
    config?: LlmCallConfig;
    /** Cancellation state the loop would carry into the request. */
    signal?: AbortSignal;
  } = {}
): Promise<LlmCallConfig> {
  const events = agentEvents(ctx, agent);
  const fallback: LlmCallConfig = options.config ?? { provider: 'reflex', model: 'reflex-auto' };
  const signal = options.signal ?? new AbortController().signal;

  const messages = options.task !== undefined ? [userMessage(options.task)] : [];
  await events.waterfall(
    'agent/pre-step',
    { turn: options.turn ?? 1, step: options.step ?? 1, signal, messages },
    async () => ({ kind: 'enter' as const, messages })
  );

  return events.waterfall(
    'agent/request',
    { turn: options.turn ?? 1, step: options.step ?? 1, signal },
    async () => fallback
  );
}

/**
 * Build a minimal user message carrying one text block.
 * @param text - message text.
 * @returns the message shape `agent/pre-step` carries.
 */
export function userMessage(text: string): UserMessage {
  return {
    id: `test-message-${text.length}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' }
  } as unknown as UserMessage;
}
