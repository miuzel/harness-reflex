/**
 * Prompt rendering for one System 1 route decision.
 *
 * The affinity facts ({@link RouteRequest.state}) and the policy instructions
 * ({@link RouteRequest.instructions}) are part of the decision *prompt*, not of
 * the decision *result*: a backend that builds a text prompt (the logits
 * backend, and the HTTP body of the Jev gateway) renders them with these pure
 * helpers, so what the model reads is unit-testable without a network call.
 *
 * Rendering one request with no state and no instructions reproduces the
 * historical `name: description` context block byte for byte, so an unchanged
 * caller sees an unchanged prompt.
 *
 * @module harness-reflex/backend/route-prompt
 */
import type { RouteCandidateItem, RouteRequest, RouteRequestState } from './types.js';

/** How the incumbent candidate is marked inside a decision prompt. */
export const CURRENT_MODEL_MARK = '[current model — keeping it preserves the prompt cache]';

/**
 * Render one candidate line, marking the session's incumbent model.
 * @param candidate - one pool candidate.
 * @returns `name: description`, plus the incumbent mark when the candidate is current.
 */
export function renderCandidateLine(candidate: RouteCandidateItem): string {
  const mark = candidate.current ? ` ${CURRENT_MODEL_MARK}` : '';
  return `${candidate.name}: ${candidate.description}${mark}`;
}

/**
 * Render the session facts and the policy instructions of one decision.
 * @param state - cache-affinity facts, when the caller supplied any.
 * @param instructions - policy instructions, when the caller supplied any.
 * @returns one line per fact; an empty array when there is nothing to say.
 */
export function renderRouteStateLines(
  state: RouteRequestState | undefined,
  instructions: string | undefined
): string[] {
  const lines: string[] = [];
  if (state?.currentModel) lines.push(`current physical model: ${state.currentModel}`);

  if (typeof state?.contextTokens === 'number' || typeof state?.contextChars === 'number') {
    const tokens = typeof state?.contextTokens === 'number' ? state.contextTokens : 0;
    const chars = typeof state?.contextChars === 'number' ? state.contextChars : 0;
    lines.push(`accumulated session context: about ${String(tokens)} tokens (${String(chars)} characters)`);
  }

  const instruction = instructions?.trim();
  if (instruction) lines.push(instruction);
  return lines;
}

/**
 * Build the context block one System 1 route decision receives.
 * @param req - the route request being decided.
 * @returns candidate lines followed by the session facts and instructions.
 */
export function buildRouteContext(req: RouteRequest): string {
  return [...req.candidates.map(renderCandidateLine), ...renderRouteStateLines(req.state, req.instructions)]
    .filter((line) => line.length > 0)
    .join('\n');
}
