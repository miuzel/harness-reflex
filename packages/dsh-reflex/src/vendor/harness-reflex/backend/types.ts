/**
 * Core types for System One Decision Runtime & APIs (Jev, vLLM/Simple-Jev, DSPy, etc.)
 */

export interface ChoiceOption {
  label: string;
  probability: number;
}

export interface ChoiceRequest {
  question: string;
  options: string[];
  context?: string;
  temperature?: number;
}

export interface ChoiceResponse {
  options: ChoiceOption[];
  bestOption: string;
  confidence: number;
  uncalibrated?: boolean;
  latencyMs: number;
}

export type GateOutcome = 'verified' | 'contradicted' | 'not_addressed' | 'escalate';

export interface GateAssertion {
  statement: string;
  criteria?: string;
}

export interface GateRequest {
  assertions: GateAssertion[];
  evidence: string;
  context?: string;
  strictness?: 'high' | 'normal' | 'lenient';
}

export interface GateResultItem {
  statement: string;
  outcome: GateOutcome;
  confidence: number;
  explanation: string;
}

export interface GateResponse {
  passed: boolean;
  results: GateResultItem[];
  needsEscalation: boolean;
  latencyMs: number;
}

export interface PruneRequest {
  rawOutput: string;
  intent: string;
  maxTokens?: number;
  shadowMode?: boolean;
  /**
   * Character count from which the backend judges segments through System One.
   * The caller's resolved `interventions.pruneJudgeMinChars`; when omitted the
   * backend's own configuration/environment/default applies.
   */
  pruneJudgeMinChars?: number;
}

export interface PruneResponse {
  processedOutput: string;
  originalChars: number;
  prunedChars: number;
  estimatedTokensSaved: number;
  reductionPercentage: number;
  shadow: boolean;
  latencyMs: number;
  /**
   * Which judging path produced the candidate: `segmented` ran the per-segment
   * System One scoring for a payload at/above `interventions.pruneJudgeMinChars`;
   * `local` used the deterministic candidates (small payload, or a fallback).
   * Optional so existing response literals stay valid.
   */
  judgePath?: 'segmented' | 'local' | 'fallback';
  /** Why the segmented path fell back to the local candidates, when it did. */
  fallbackReason?: string;
  /**
   * How the returned text was reduced, when it was.
   *
   * `none` means the returned text is the payload: a judgment that ran scored
   * every segment and kept everything (honoured as-is), or the degraded path's
   * template compression could not reduce it either. `fallbackReason` and
   * `judgePath` tell the two apart.
   */
  compression?: 'segmented' | 'local' | 'template' | 'none';
  /** Segments handed to System One in one request (0 when the local path ran). */
  judgedSegments?: number;
  /** Segments beyond the per-request limit, kept deterministically instead. */
  unjudgedSegments?: number;
  /**
   * Segments the composed scored candidate kept whole, out of all segments.
   *
   * The count belongs to the candidate that was installed; when no scored
   * candidate reduced the payload it is the balanced candidate's count, which is
   * what explains "the judge kept five segments and nothing shrank". It counts
   * the segments kept without a score too, which is why
   * {@link autoKeptSegments} is reported beside it. Absent on paths that never
   * selected segments by score (local, or a judgment with no usable score).
   */
  keptSegments?: number;
  /** Characters of the aggressive-budget candidate, before one is installed. */
  aggressiveChars?: number;
  /** Characters of the balanced-budget candidate, before one is installed. */
  balancedChars?: number;
  /** Characters of the conservative-budget candidate, before one is installed. */
  conservativeChars?: number;
  /**
   * Segments System One really scored (`scores.size`).
   *
   * `judgedSegments` counts the questions sent; this counts the answers that
   * were usable. A gap between the two is a judgment that could not be read.
   */
  scoredSegments?: number;
  /**
   * Segments kept whole because they carried no score.
   *
   * They are the unjudged safety margin (no answer, an unreadable answer, or a
   * segment beyond the per-request limit), counted over the whole payload. When
   * this is close to the segment count the candidate cannot shrink through the
   * scored budgets, because almost nothing was judged.
   */
  autoKeptSegments?: number;
  /** Answers returned for a judged segment that carried no usable keep score. */
  unparsedScoreAnswers?: number;
}

/**
 * Diagnostic fields of a prune response.
 *
 * Every path reports what it measured and omits the rest, so a reader can tell
 * a field that was not measured from one that measured zero.
 */
export type PruneDiagnostics = Pick<
  PruneResponse,
  | 'judgePath'
  | 'fallbackReason'
  | 'compression'
  | 'judgedSegments'
  | 'unjudgedSegments'
  | 'keptSegments'
  | 'aggressiveChars'
  | 'balancedChars'
  | 'conservativeChars'
  | 'scoredSegments'
  | 'autoKeptSegments'
  | 'unparsedScoreAnswers'
>;

/**
 * In-memory health of one System One backend.
 *
 * Every request the backend sends updates it: a success clears the failure
 * fields, a failure records when and why it happened and counts the run. It is
 * deliberately not persisted — a restarted Host starts healthy and discovers
 * the truth with its first call.
 */
export interface BackendHealth {
  /** Whether the most recent request succeeded (true before the first request). */
  available: boolean;
  /** Reason of the most recent failure; cleared by a success. */
  lastFailureReason?: string;
  /** ISO timestamp of the most recent failure; cleared by a success. */
  lastFailureAt?: string;
  /** Consecutive failed requests; a single success resets it to 0. */
  consecutiveFailures: number;
}

export interface ActionStep {
  tool: string;
  input: string;
  output?: string;
  error?: string;
  timestamp?: number;
}

export interface StagnationCheckRequest {
  history: ActionStep[];
  goal?: string;
  windowSize?: number;
}

export interface StagnationCheckResponse {
  isStuck: boolean;
  patternType?: 'repetition' | 'oscillation' | 'failing_retry' | 'zero_progress' | 'none';
  confidence: number;
  diagnosis?: string;
  recommendedIntervention?: string;
  latencyMs: number;
}

/**
 * Session facts one routing decision reasons about.
 *
 * They exist for prompt-cache affinity: switching a session onto another
 * physical model invalidates the upstream prompt prefix cache, so the decision
 * needs to know which model holds the cached prefix and how much context is
 * already in it. Every field is optional — a caller that knows nothing about
 * the session (a hand-built one-shot call) simply omits the block.
 */
export interface RouteRequestState {
  /** Physical `provider:model` the session is currently using, when known. */
  currentModel?: string;
  /** Estimated tokens of the session context accumulated so far. */
  contextTokens?: number;
  /** Character count the token estimate was derived from. */
  contextChars?: number;
}

/** One candidate of a {@link RouteRequest}. */
export interface RouteCandidateItem {
  name: string;
  description: string;
  type?: 'tool' | 'skill' | 'action';
  /**
   * Whether this candidate is the physical model the session already uses.
   * Returning it costs no cache miss; a backend that builds a prompt should
   * say so next to the candidate.
   */
  current?: boolean;
}

export interface RouteRequest {
  goal: string;
  candidates: RouteCandidateItem[];
  topK?: number;
  /** Cache-affinity facts: the model in use and the accumulated context size. */
  state?: RouteRequestState;
  /**
   * Decision instructions the backend must carry into its prompt — the
   * cache-affinity policy ("keep the current model unless clearly outmatched").
   */
  instructions?: string;
}

export interface RouteResponse {
  rankedCandidates: Array<{ name: string; score: number; reason?: string }>;
  bestCandidate?: string;
  latencyMs: number;
}

/**
 * One batch of sentences a closing check must classify before it may verify
 * anything.
 *
 * The candidates are chosen deterministically (the last few sentences of the
 * turn), but *which* of them claims completion is a semantic question: a word
 * list would miss a Chinese "全部通过" and read a negated "not complete" as the
 * opposite. System One answers it, one scored question per sentence.
 */
export interface ClaimClassificationRequest {
  /** Candidate sentences, in the order the caller will treat them. */
  statements: string[];
  /** What the turn was doing, so the classifier reads the sentences in context. */
  intent: string;
  /** Extra context (the turn's own summary) when the caller has one. */
  context?: string;
}

/** One sentence's classification. */
export interface ClaimClassification {
  statement: string;
  /** Whether the winning criterion says the sentence claims completion. */
  isClaim: boolean;
  /** Probability of the completion-claim criterion, in `[0, 1]`. */
  confidence: number;
}

export interface ClaimClassificationResponse {
  /** One entry per submitted statement, in submission order when answered. */
  results: ClaimClassification[];
  latencyMs: number;
}

/**
 * Common interface for decision backends (Jev official, Simple-Jev, vLLM, mock)
 */
export interface DecisionBackend {
  readonly name: string;
  readonly model: string;
  
  choice(req: ChoiceRequest): Promise<ChoiceResponse>;
  gate(req: GateRequest): Promise<GateResponse>;
  prune(req: PruneRequest): Promise<PruneResponse>;
  checkStagnation(req: StagnationCheckRequest): Promise<StagnationCheckResponse>;
  route(req: RouteRequest): Promise<RouteResponse>;
  /**
   * Health of the backend's outbound conversation, when it has one.
   *
   * In-process backends (mock) serve every call locally and simply omit this:
   * absence means "healthy by construction", not "unknown".
   */
  health?(): BackendHealth;
  /** Classify whether each candidate sentence claims the task is complete. */
  classifyClaims(req: ClaimClassificationRequest): Promise<ClaimClassificationResponse>;
}

export type SystemOneBackend = DecisionBackend;

