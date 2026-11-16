import { DecisionBackend, SystemOneBackend } from './types.js';
import { MockDecisionBackend } from './mock.js';
import { JevDecisionBackend } from './jev.js';
import { SimpleJevDecisionBackend } from './simple-jev.js';

/**
 * A credential the caller has already resolved (g-059).
 *
 * The plugin resolves the key exactly once, through
 * `resolveApiKeyWithSource`, so that the panel and the transport can never
 * disagree. Passing the outcome here keeps the factory's *provider selection*
 * (which still reads the environment) while removing its *key lookup* from the
 * decision: without the override, an empty `SYSTEM_ONE_API_KEY` would make the
 * Jev branch read `JEV_API_KEY` behind the caller's back.
 *
 * **Plugin-only extension.** The vendored backends are a manual port verified by
 * behaviour (`vendor-contract.test.ts`), not a generated mirror; the root
 * factory has no such parameter and is not changed by this goal. Consolidating
 * the two copies is g-060.
 */
export interface ResolvedKeyOverride {
  /**
   * The caller resolved the credential: `apiKey` is used verbatim — including
   * "absent", which means no credential at all. The constructed backend then
   * never consults the environment for a key.
   */
  apiKeyResolved?: boolean;
  /** The resolved key; empty or omitted means there is none. */
  apiKey?: string;
}

/**
 * Factory to create System One Decision Backend
 *
 * Supported providers:
 * - 'jev': Official Jev System One Gateway
 * - 'vllm' / 'simple-jev' / 'logits': Next-token logits scoring on standard LLMs
 * - 'mock' / 'heuristic': Fast deterministic local baseline
 *
 * @param override - a credential the caller already resolved. Omitted (the MCP
 *   server, the CLI, a bare import) the factory behaves exactly as before and
 *   reads the key from the environment itself.
 * @returns the provider the environment selects.
 */
export function createSystemOneBackend(override?: ResolvedKeyOverride): SystemOneBackend {
  const backendType = (
    process.env.SYSTEM_ONE_BACKEND ||
    process.env.REFLEX_BACKEND ||
    ''
  ).toLowerCase();

  // Provider *selection* is deliberately untouched by the override: which
  // backend to build is a deployment question, and only the credential changes.
  const keyFor = (envChain: string | undefined): { apiKey?: string; apiKeyResolved?: boolean } =>
    override?.apiKeyResolved === true
      ? // Verbatim, empty included: `apiKeyResolved` on the backend class makes
        // an empty value final, so no environment read can resurrect a key the
        // caller decided not to send.
        { apiKey: override.apiKey ?? '', apiKeyResolved: true }
      : envChain === undefined
        ? {}
        : { apiKey: envChain };

  // 1. Jev Provider
  if (backendType === 'jev' || (!backendType && (process.env.SYSTEM_ONE_API_KEY || process.env.JEV_API_KEY))) {
    return new JevDecisionBackend({
      ...keyFor(process.env.SYSTEM_ONE_API_KEY || process.env.JEV_API_KEY),
      baseUrl: process.env.SYSTEM_ONE_BASE_URL || process.env.JEV_BASE_URL,
      model: process.env.SYSTEM_ONE_MODEL || process.env.JEV_MODEL
    });
  }

  // 2. Open LLM / vLLM Next-Token Logits Provider
  if (
    backendType === 'vllm' ||
    backendType === 'simple-jev' ||
    backendType === 'logits' ||
    (!backendType && (process.env.VLLM_BASE_URL || process.env.OPENAI_BASE_URL))
  ) {
    return new SimpleJevDecisionBackend({
      vllmBaseUrl: process.env.SYSTEM_ONE_BASE_URL || process.env.VLLM_BASE_URL,
      ...keyFor(process.env.SYSTEM_ONE_API_KEY || process.env.VLLM_API_KEY),
      model: process.env.SYSTEM_ONE_MODEL || process.env.VLLM_MODEL
    });
  }

  // 3. Default: Local Mock / Heuristic Provider
  return new MockDecisionBackend();
}

// Backward-compatible alias
export const createDecisionBackend = createSystemOneBackend;
