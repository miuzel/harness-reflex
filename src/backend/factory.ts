import { DecisionBackend } from './types.js';
import { MockDecisionBackend } from './mock.js';
import { JevDecisionBackend } from './jev.js';
import { SimpleJevDecisionBackend } from './simple-jev.js';

export function createDecisionBackend(): DecisionBackend {
  const backendType = (process.env.REFLEX_BACKEND || '').toLowerCase();

  if (backendType === 'jev' || (!backendType && process.env.JEV_API_KEY)) {
    return new JevDecisionBackend();
  }

  if (backendType === 'simple-jev' || backendType === 'vllm' || (!backendType && process.env.VLLM_BASE_URL)) {
    return new SimpleJevDecisionBackend();
  }

  // Default to zero-dep mock / heuristic backend
  return new MockDecisionBackend();
}
