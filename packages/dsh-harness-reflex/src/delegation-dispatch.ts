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
 *    switch off the tool accepts no level at all.
 *
 * The parameter list is the model-facing schema the Host publishes, so this is
 * an observable contract, not internals.
 *
 * ## Why the scope argument is not optional decoration
 *
 * `dsh-tools` is a *scoped* registry: `get(name)` with no scope reads the
 * **global** view, and a tool mounted inside an **agent preset** — which is
 * where a real deployment attaches `tool-subagent` — is not in that view at
 * all. Reading the global view to decide whether this Host can delegate
 * therefore answers "no tool" on every preset-hosted deployment, however
 * correctly `modelSelection` is configured. Passing the calling agent reads the
 * view that deployment actually serves, and is the only reading that can tell
 * "the capability is off" from "this scope does not show it".
 * @param ctx - context whose `tools` service is live.
 * @param agent - the scope to read as; omitted selects the global view.
 * @returns the registered name and whether it accepts a level, or `undefined`
 * when that scope exposes no delegation tool at all.
 */
export function inspectDelegationTool(ctx: Context, agent?: Agent): DelegationTarget | undefined {
  for (const candidate of DELEGATION_TARGET_CANDIDATES) {
    const definition = ctx.tools.get(candidate, agent);
    if (definition === undefined) continue;
    const properties = (definition.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
    return { toolName: candidate, acceptsReasoningEffort: properties !== undefined && 'reasoning_effort' in properties };
  }
  return undefined;
}

/** Candidate names of the Host delegation tool, in lookup order. */
const DELEGATION_TARGET_CANDIDATES = ['subagent', 'reflex_subagent'] as const;

/**
 * The name the seam dispatches to when no scope is available to confirm it.
 *
 * This is the Host tool's documented default (`toolName`, default `subagent`).
 * Naming it here rather than reading it at mount is the whole point of the
 * registration fix: at mount there is no agent scope, so the registry cannot
 * answer, and "cannot answer" must not read as "cannot delegate".
 */
export const DELEGATION_TOOL_NAME: string = DELEGATION_TARGET_CANDIDATES[0];

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
  'dsh-reflex: the subagent tool does not declare reasoning_effort (modelSelection is off), so a delegated call that carries a level will be refused by the Host; ' +
  'enable modelSelection to let System 1 choose the child\'s reasoning level';

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
 * ## Why this does not inspect the registry
 *
 * It used to refuse to build unless the live registry showed a delegation tool
 * that *declares* `reasoning_effort`. That probe ran during `apply()`, where the
 * plugin has no agent scope — and `dsh-tools` is scoped, so the probe read the
 * **global** view. A real deployment attaches `tool-subagent` inside an **agent
 * preset**, which the global view does not contain. The consequence was the bug
 * this seam now avoids: a correctly configured Host (patch written,
 * `modelSelection: true` dumped from the running config, the panel switch on)
 * still got no `reflex_delegate`, because the one place the plugin looked for
 * the capability is the one place a preset can never appear.
 *
 * So the capability question is not answered here at all. What this Host can
 * serve is judged at **call time**, in the caller's own scope, by the Host's own
 * argument validation: a `subagent` that does not accept `reasoning_effort`
 * rejects the call, and {@link delegationFailure} rethrows that refusal verbatim.
 * That refusal is strictly better evidence than a schema probe taken at mount —
 * it comes from the very scope that would serve the call.
 *
 * Whether the *user* consented is a separate question, and it is not answered
 * here either: `delegationExecutables` withholds the target unless
 * `delegation.enabled` is true, so the registry only ever asks for a seam that
 * configuration already asked for.
 *
 * @param options - the registry, the ledger, System One, and the confidence floor.
 * @returns the seam. Never `undefined` for a capability reason: registration is
 *   decided by configuration, not by a registry view taken at mount.
 */
export function createReflexDelegation(options: ReflexDelegationOptions): ReflexDelegationSeam | undefined {
  // The Host tool's own default name. It is not read from the registry because
  // no scope is available at mount (see above); the Host still owns the name, so
  // a deployment that renamed it gets an honest "unknown tool" from dispatch
  // rather than a wrapper that silently fails to appear.
  const toolName = DELEGATION_TOOL_NAME;

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
      // Resolved per call, in the caller's own scope. This is where the registry
      // *can* answer — unlike at mount — so a Host that renamed its delegation
      // tool (`toolName`) is still reached. When the scope exposes none of the
      // candidate names, the default is used and the dispatcher's own "unknown
      // tool" is the answer, which is the honest one: this plugin must not
      // report a Host capability it cannot see.
      const target = agent === undefined ? undefined : inspectDelegationTool(ctx, agent);
      const name = target === undefined ? toolName : target.toolName;
      const batch = await ctx.tools.execute({
        calls: [
          {
            type: 'tool-call',
            id: `reflex-delegate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` as never,
            name,
            arguments: JSON.stringify(arguments_)
          }
        ],
        signal,
        ...(agent === undefined ? {} : { agent })
      });

      const entry = batch.results[0];
      if (entry === undefined) throw new Error(`the delegation tool ${name} settled no result`);
      if (entry.result.isError) throw delegationFailure(entry.result);
      const value = entry.result.value as { subagentId?: unknown } | undefined;
      if (typeof value?.subagentId !== 'string' || value.subagentId.length === 0) {
        throw new Error(`the delegation tool ${name} returned no subagentId`);
      }
      return { subagentId: value.subagentId };
    }
  };
}
