import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';

import type { ChoiceRequest, ChoiceResponse } from './vendor/harness-reflex/backend/types.js';
import type { DecisionLedger } from './vendor/harness-reflex/core/ledger.js';
import {
  decideDelegationEffort,
  recordDelegationDecision,
  type DelegationDecision,
  type DelegationEffort,
  type DelegationParentFacts,
  type ReflexDelegateArgs
} from './delegation.js';
import type { ReflexDelegationSeam } from './tools.js';

/**
 * Bind `reflex_delegate` to the Host's own delegation tool.
 *
 * The whole point of this adapter is that it *adds no authority of its own*. It
 * decides one reasoning level, and then hands the call to the registry through
 * `ctx.tools.execute()` — the same public pipeline a model-issued call takes, so
 * the pre-execute policy, approvals, guards, the Host tool's own route policy
 * (`assertAllowedModelSelection`), its route preflight, and its recursion limit
 * all run exactly as they would for a direct call. When the Host refuses, its
 * refusal is rethrown verbatim; this layer never turns "not allowed" into a
 * different answer, and never checks a route itself.
 *
 * @module dsh-reflex/delegation-dispatch
 */

/** Facts one activation needs to expose `reflex_delegate`, so a single descriptor covers them all. */
export interface ReflexDelegationOptions {
  /** The registry the delegation tool is registered in. */
  readonly ctx: Context;
  /** The activation's audit ledger. */
  readonly ledger: DecisionLedger;
  /** System One choice execution; the runtime's backend. */
  readonly decide: (request: ChoiceRequest) => Promise<ChoiceResponse>;
  /** Minimum System One confidence for its answer to be trusted. */
  readonly minConfidence: number;
  /** Agent the delegated call is attributed to; resolved per call when possible. */
  readonly agent?: () => Agent | undefined;
  /** Sink for the one deployment warning this module can raise. */
  readonly warn?: (message: string) => void;
}

/**
 * The `subagent` tool's model-facing route fields, spelled the way the Host
 * declares them.
 *
 * `reasoning_effort` is snake_case here because that *is* the Host tool's
 * parameter name; the camelCase id is what the Host maps it onto internally.
 */
interface DelegationToolArguments {
  prompt: string;
  description: string;
  reasoning_effort: DelegationEffort;
  provider?: string;
  model?: string;
  cwd?: string;
}

/**
 * Find the Host's delegation tool in the registry, when it can carry a level.
 *
 * Two facts have to hold, and both are read from the live registry rather than
 * assumed:
 *
 * 1. the tool is registered — the Host owns its name as configuration
 *    (`toolName`, default `subagent`), so candidate names are tried in order;
 * 2. the tool *declares* `reasoning_effort`. The Host only adds that parameter
 *    to its schema when the deployment sets `modelSelection: true`; with the
 *    switch off the tool accepts no level at all, and a wrapper that registered
 *    anyway could only either silently drop the System One decision or send a
 *    parameter the Host will reject.
 *
 * The parameter list is the model-facing schema the Host publishes, so this is
 * an observable contract, not internals.
 * @param ctx - context whose `tools` service is live.
 * @returns the registered name and whether it accepts a level, or `undefined`
 * when this Host exposes no delegation tool at all.
 */
export function inspectDelegationTool(ctx: Context): DelegationTarget | undefined {
  for (const candidate of DELEGATION_TARGET_CANDIDATES) {
    const definition = ctx.tools.get(candidate);
    if (definition === undefined) continue;
    const properties = (definition.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
    return { toolName: candidate, acceptsReasoningEffort: properties !== undefined && 'reasoning_effort' in properties };
  }
  return undefined;
}

/** Candidate names of the Host delegation tool, in lookup order. */
const DELEGATION_TARGET_CANDIDATES = ['subagent', 'reflex_subagent'] as const;

/**
 * The Host delegation tool as this activation can use it.
 *
 * Separates "there is no such tool" from "there is one, but it cannot carry a
 * reasoning level", because the two need different answers: the first is silent,
 * the second is a loud deployment problem the operator has to hear about.
 */
export interface DelegationTarget {
  /** Registered tool name. */
  readonly toolName: string;
  /** Whether the tool declares `reasoning_effort` (Host `modelSelection: true`). */
  readonly acceptsReasoningEffort: boolean;
}

/** The log line emitted when the Host tool exists but cannot carry a level. */
export const DELEGATION_MODEL_SELECTION_DISABLED =
  'dsh-reflex: reflex_delegate is not registered because the subagent tool has modelSelection disabled; enable it to let System 1 choose the child\'s reasoning level';

/**
 * Read the parent's own effort and model from its composed options.
 *
 * Read live on every call rather than captured at mount: a session's selection
 * changes between steps, and the fallback must inherit what the parent is using
 * *now*.
 * @param agent - the calling agent, when one is known.
 * @returns the parent facts, with unknown fields omitted.
 */
export function parentDelegationFacts(agent: Agent | undefined): DelegationParentFacts {
  const options = (agent as { options?: { model?: string; reasoningEffort?: unknown } } | undefined)?.options;
  const effort = options?.reasoningEffort;
  return {
    ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}),
    ...(typeof options?.model === 'string' ? { model: options.model } : {})
  };
}

/**
 * Rebuild the Host's refusal as the wrapper's own error.
 *
 * A failed tool call comes back as a settled failure, not as a thrown value.
 * The message is passed through untouched — the assertions that prove "the Host
 * refused, not this plugin" match on the Host's own wording — while the error
 * identity is kept on the boxed `info` so a caller can tell a policy denial from
 * a crash.
 * @param result - the settled failure.
 * @returns the error to throw.
 */
function delegationFailure(result: { error?: { message?: string; info?: { name?: string; code?: string } } }): Error {
  const error = new Error(result.error?.message ?? 'the delegation tool failed');
  error.name = result.error?.info?.name ?? 'DelegationToolError';
  if (result.error?.info?.code !== undefined) error.cause = result.error.info;
  return error;
}

/**
 * Build the seam `reflex_delegate` dispatches through.
 *
 * Returns `undefined` in both cases where the wrapper must not exist:
 * the Host exposes no delegation tool at all (nothing to wrap), or it exposes
 * one that cannot carry a reasoning level (see {@link inspectDelegationTool}).
 * Registering in the second case would be the one outcome the design forbids —
 * a tool that appears to let System One decide while the decision is silently
 * dropped — so the refusal is logged loudly instead.
 *
 * @param options - the registry, the ledger, System One, and the confidence floor.
 * @returns the seam, or `undefined` when the wrapper must not register.
 */
export function createReflexDelegation(options: ReflexDelegationOptions): ReflexDelegationSeam | undefined {
  const target = inspectDelegationTool(options.ctx);
  if (target === undefined) return undefined;
  if (!target.acceptsReasoningEffort) {
    options.warn?.(DELEGATION_MODEL_SELECTION_DISABLED);
    return undefined;
  }
  const toolName = target.toolName;

  const { ctx, ledger } = options;

  return {
    toolName,

    async decide(args: ReflexDelegateArgs, agent?: Agent): Promise<DelegationDecision> {
      const parent = parentDelegationFacts(agent ?? options.agent?.());
      const decision = await decideDelegationEffort({
        description: args.description,
        prompt: args.prompt,
        decide: options.decide,
        minConfidence: options.minConfidence,
        parent
      });
      recordDelegationDecision(ledger, decision, args, parent);
      return decision;
    },

    async dispatch(
      args: ReflexDelegateArgs,
      effort: DelegationEffort,
      signal: AbortSignal,
      callingAgent?: Agent
    ): Promise<{ subagentId: string }> {
      const arguments_: DelegationToolArguments = {
        prompt: args.prompt,
        description: args.description,
        reasoning_effort: effort,
        ...(args.provider === undefined ? {} : { provider: args.provider }),
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.cwd === undefined ? {} : { cwd: args.cwd })
      };

      const agent = callingAgent ?? options.agent?.();
      const batch = await ctx.tools.execute({
        calls: [
          {
            type: 'tool-call',
            id: `reflex-delegate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` as never,
            name: toolName,
            arguments: JSON.stringify(arguments_)
          }
        ],
        signal,
        ...(agent === undefined ? {} : { agent })
      });

      const entry = batch.results[0];
      if (entry === undefined) throw new Error(`the delegation tool ${toolName} settled no result`);
      if (entry.result.isError) throw delegationFailure(entry.result);
      const value = entry.result.value as { subagentId?: unknown } | undefined;
      if (typeof value?.subagentId !== 'string' || value.subagentId.length === 0) {
        throw new Error(`the delegation tool ${toolName} returned no subagentId`);
      }
      return { subagentId: value.subagentId };
    }
  };
}
