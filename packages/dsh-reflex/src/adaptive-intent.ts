import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm';

/** Durable user/default intent, distinct from the physical request envelope. */
interface Selection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

function selection(value: unknown): Selection | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== 'string' || !record.provider ||
      typeof record.model !== 'string' || !record.model ||
      (record.reasoningEffort !== undefined &&
        (typeof record.reasoningEffort !== 'string' || !record.reasoningEffort))) return undefined;
  return {
    provider: record.provider,
    model: record.model,
    ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort as string })
  };
}

function adaptive(value: Selection, ownsProvider: (provider: string) => boolean): boolean {
  return ownsProvider(value.provider) || value.reasoningEffort === 'reflex' || value.reasoningEffort === 'auto';
}

/**
 * Preserve an implicit virtual/adaptive default before the first physical header
 * replaces it in the Host's fallback selection. The public modelSelection
 * projection remains authoritative, including after plugin reload: explicit
 * selections supersede this pending intent, and matching physical pins consume
 * themselves in the Host projection. No private controller or global default is
 * changed. Call from the outer request waterfall after awaiting next().
 *
 * Hosts without the modelSelection projection retain their existing behavior.
 */
export function resolveAdaptiveIntent(
  ctx: Context,
  agent: Agent,
  config: LlmCallConfig,
  ownsProvider: (provider: string) => boolean
): LlmCallConfig {
  // This service is optional for non-Web hosts and intentionally not a required
  // plugin injection. Keep the structural boundary independent of its package.
  const projections = ctx.get('sessionProjections') as unknown as {
    stateOf(session: unknown, key: string): unknown;
  } | undefined;
  if (!projections || typeof projections.stateOf !== 'function' || !agent?.session) return config;
  const state = projections.stateOf(agent.session, 'modelSelection');
  if (state === null || typeof state !== 'object' || !('pending' in state)) return config;
  const pendingValue = (state as { pending: unknown }).pending;
  if (pendingValue !== null) {
    const pending = selection(pendingValue);
    if (!pending || !adaptive(pending, ownsProvider)) return config;
    // An absent effort is itself intent (provider/default). Never retain a
    // concrete effort that came from the last routed physical request.
    const { reasoningEffort: _physicalEffort, ...rest } = config;
    return {
      ...rest,
      ...pending,
      ...(pending.reasoningEffort === undefined ? {} : {
        reasoningEffort: pending.reasoningEffort as LlmCallConfig['reasoningEffort']
      })
    } as LlmCallConfig;
  }
  const initial = selection(config);
  if (!initial || !adaptive(initial, ownsProvider)) return config;
  // Older supported SDK typings predate this event. The required projection
  // above is the runtime capability check for the newer Host event contract.
  const append = agent.session.append as unknown as (type: 'model/selection', value: Selection) => unknown;
  append.call(agent.session, 'model/selection', initial);
  return config;
}
