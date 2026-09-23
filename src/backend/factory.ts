import { DecisionBackend, SystemOneBackend } from './types.js';
import { MockDecisionBackend } from './mock.js';
import { JevDecisionBackend } from './jev.js';
import { SimpleJevDecisionBackend } from './simple-jev.js';

/**
 * Factory to create System One Decision Backend
 *
 * Supported providers:
 * - 'jev': Official Jev System One Gateway
 * - 'vllm' / 'simple-jev' / 'logits': Next-token logits scoring on standard LLMs
 * - 'mock' / 'heuristic': Fast deterministic local baseline
 */
export function createSystemOneBackend(): SystemOneBackend {
  const backendType = (
    process.env.SYSTEM_ONE_BACKEND ||
    process.env.REFLEX_BACKEND ||
    ''
  ).toLowerCase();

  // 1. Jev Provider
  if (backendType === 'jev' || (!backendType && (process.env.SYSTEM_ONE_API_KEY || process.env.JEV_API_KEY))) {
    return new JevDecisionBackend({
      apiKey: process.env.SYSTEM_ONE_API_KEY || process.env.JEV_API_KEY,
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
      apiKey: process.env.SYSTEM_ONE_API_KEY || process.env.VLLM_API_KEY,
      model: process.env.SYSTEM_ONE_MODEL || process.env.VLLM_MODEL
    });
  }

  // 3. Default: Local Mock / Heuristic Provider
  return new MockDecisionBackend();
}

// Backward-compatible alias
export const createDecisionBackend = createSystemOneBackend;
