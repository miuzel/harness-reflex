import { DecisionBackend } from '../backend/types.js';

/**
 * Continuous 0.0 – 1.0 scoring projected from a System One multi-class choice.
 *
 * Shared by every surface (stdio MCP server, DSH Host tools) so the score a
 * model sees never depends on which adapter called it.
 */

export interface ScoreRequest {
  statement: string;
  criteria?: string;
  context?: string;
}

export interface ScoreDistribution {
  high: number;
  medium: number;
  low: number;
}

export interface ScoreResponse {
  statement: string;
  score: number;
  distribution: ScoreDistribution;
  latencyMs: number;
}

export const DEFAULT_SCORE_CRITERIA = 'Rate alignment from 0.0 to 1.0';

/** The three scored buckets; the labels double as the probability lookup key. */
export const SCORE_OPTIONS: readonly [string, string, string] = [
  'High alignment (score ~0.9)',
  'Moderate alignment (score ~0.5)',
  'Poor alignment (score ~0.1)'
];

/** Representative score of each bucket, indexed like {@link SCORE_OPTIONS}. */
const BUCKET_SCORES = [0.9, 0.5, 0.1] as const;

/**
 * Build the System One question that makes the backend classify one statement
 * into a scored bucket.
 * @param criteria - the rubric the statement is graded against.
 * @returns the classification prompt sent to the backend.
 */
export function buildScoreQuestion(criteria: string): string {
  return `Evaluate the following statement against the criteria: "${criteria}". Is the quality/truth high, medium, or low?`;
}

/**
 * Score one statement against a rubric with a single System One choice call.
 * @param backend - decision backend performing the classification.
 * @param request - statement, rubric, and optional supporting context.
 * @returns the expected-value score plus the raw bucket distribution.
 */
export async function scoreStatement(backend: DecisionBackend, request: ScoreRequest): Promise<ScoreResponse> {
  const statement = request.statement || '';
  const criteria = request.criteria || DEFAULT_SCORE_CRITERIA;
  const evalRes = await backend.choice({
    question: buildScoreQuestion(criteria),
    options: [...SCORE_OPTIONS],
    context: `Statement: ${statement}\nContext: ${request.context || 'None'}`
  });

  const probabilityOf = (label: string): number =>
    evalRes.options.find((option) => option.label.includes(label))?.probability || 0;

  const distribution: ScoreDistribution = {
    high: probabilityOf('High'),
    medium: probabilityOf('Moderate'),
    low: probabilityOf('Poor')
  };

  const score = Number(
    (
      distribution.high * BUCKET_SCORES[0] +
      distribution.medium * BUCKET_SCORES[1] +
      distribution.low * BUCKET_SCORES[2]
    ).toFixed(3)
  );

  return {
    statement,
    score,
    distribution,
    latencyMs: evalRes.latencyMs
  };
}
