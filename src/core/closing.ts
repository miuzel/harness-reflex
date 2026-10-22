/**
 * Closing-check candidate selection and the closing decision.
 *
 * Two deterministic jobs live here: split a turn's own words into *candidate*
 * completion claims (splitting, de-duplication, the length floor, the trailing
 * cap), and decide what a classification/verification answer means. Whether a
 * sentence really claims completion is a semantic question and is answered by
 * the backend; this module never guesses with a word list.
 *
 * @module core/closing
 */
import { clip, estimateTokens } from './text.js';

/** Completion claim candidates submitted to one closing judgment. */
export const MAX_CLAIMS = 3;
/** Minimum sentence length worth classifying as a claim candidate. */
export const MIN_CLAIM_CHARS = 8;

/** One classified candidate. */
export interface ClaimClassificationLike {
  readonly statement: string;
  readonly isClaim: boolean;
  readonly confidence: number;
}

/** The classification half of a closing judgment's answer. */
export interface ClaimClassificationResponseLike {
  readonly results: readonly ClaimClassificationLike[];
  readonly latencyMs: number;
}

/** One verification result. */
export interface ClosingResultLike {
  readonly statement: string;
  readonly outcome: string;
  readonly confidence: number;
}

/** The verification half of a closing judgment's answer. */
export interface ClosingVerdictLike {
  readonly passed: boolean;
  readonly results: readonly ClosingResultLike[];
}

/**
 * The *candidate* sentences of one turn's assistant text.
 *
 * Deterministic and semantic-free on purpose: splitting, de-duplication, the
 * length floor, and the last-{@link MAX_CLAIMS} bound are all the local work
 * this module may do. Whether a candidate really claims completion is the
 * backend's answer — an English word list would miss a Chinese "全部通过" and
 * read `not complete` as the opposite, so there is none here.
 *
 * @param text - the turn's assistant text.
 * @returns bounded, deduplicated candidates in their original order.
 */
export function claimCandidates(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/(?<=[.!?。！？\n])/)) {
    const sentence = raw.replace(/\s+/g, ' ').trim();
    if (sentence.length < MIN_CLAIM_CHARS) continue;
    const statement = clip(sentence, 200);
    if (seen.has(statement)) continue;
    seen.add(statement);
    candidates.push(statement);
  }
  return candidates.length > MAX_CLAIMS ? candidates.slice(candidates.length - MAX_CLAIMS) : candidates;
}

/**
 * The classified statements that really claim completion, above the confidence
 * floor.
 * @param classification - the backend's answer.
 * @param minConfidence - the resolved claim floor.
 * @returns one assertion per accepted claim.
 */
export function claimsOf(
  classification: ClaimClassificationResponseLike,
  minConfidence: number
): Array<{ statement: string }> {
  return classification.results
    .filter((item) => item.isClaim && item.confidence >= minConfidence)
    .map((item) => ({ statement: item.statement }));
}

/**
 * The contradicted statements, clipped for the corrective message.
 * @param verdict - the verification answer.
 * @returns the statements whose evidence contradicts them.
 */
export function contradictedOf(verdict: ClosingVerdictLike): string[] {
  return verdict.results
    .filter((item) => item.outcome === 'contradicted')
    .map((item) => clip(item.statement, 160));
}

/**
 * How many verification results could not decide.
 * @param verdict - the verification answer.
 * @returns the `escalate` count.
 */
export function undecidedOf(verdict: ClosingVerdictLike): number {
  return verdict.results.filter((item) => item.outcome === 'escalate').length;
}

/**
 * The skip reason of a closing judgment that does not object.
 *
 * `escalate` is not a contradiction: it means the gate could not decide — an
 * unavailable backend degrades exactly this way — and steering a turn on an
 * undecided verdict would turn a backend failure into a model-visible objection.
 *
 * @param verdict - the verification answer.
 * @param contradicted - the statements that really contradict.
 * @returns the machine reason to record, or `undefined` when the turn is steered.
 */
export function closingSkipReason(verdict: ClosingVerdictLike, contradicted: readonly string[]): string | undefined {
  if (contradicted.length > 0) return undefined;
  const undecided = undecidedOf(verdict);
  return undecided > 0 ? 'closing-undecided' : verdict.passed ? 'closing-evidence-consistent' : 'closing-unconfirmed';
}

/**
 * Tokens the classification request reasoned about.
 * @param statements - submitted candidates.
 * @returns the estimated token count.
 */
export function classificationTokens(statements: readonly string[]): number {
  return statements.reduce((sum, statement) => sum + estimateTokens(statement), 0);
}

/**
 * Tokens the verification request reasoned about: the classification batch plus
 * the evidence the gate read.
 * @param classificationTokensSpent - tokens of the classification request.
 * @param claims - accepted claims submitted to verification.
 * @param evidence - the assembled evidence text.
 * @returns the estimated token count.
 */
export function verificationTokens(
  classificationTokensSpent: number,
  claims: readonly { statement: string }[],
  evidence: string
): number {
  return (
    classificationTokensSpent
    + claims.reduce((sum, item) => sum + estimateTokens(item.statement), estimateTokens(evidence))
  );
}
