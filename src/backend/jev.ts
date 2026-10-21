import {
  ActionStep,
  ChoiceOption,
  ChoiceRequest,
  ChoiceResponse,
  DecisionBackend,
  GateAssertion,
  GateRequest,
  GateResponse,
  GateResultItem,
  PruneRequest,
  PruneResponse,
  RouteCandidateItem,
  RouteRequest,
  RouteResponse,
  StagnationCheckRequest,
  StagnationCheckResponse
} from './types.js';
import { CURRENT_MODEL_MARK, buildRouteContext } from './route-prompt.js';

export interface JevBackendConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /**
   * Character count from which `prune()` judges the payload segment by segment
   * through System One. Below it the deterministic local candidates are used and
   * no request is sent. Defaults to 10000 (or
   * `SYSTEM_ONE_PRUNE_JUDGE_MIN_CHARS`); mirrors
   * `interventions.pruneJudgeMinChars` of the plugin config.
   */
  pruneJudgeMinChars?: number;
}

/* -------------------------------------------------------------------------- */
/* Wire contract of the single endpoint                                        */
/* -------------------------------------------------------------------------- */

/**
 * One `choice` question of `POST /v1/systemone`.
 *
 * The gateway decides *between criteria*: the dictionary keys are the answers
 * the model may name, the values the descriptions it reads. There is no
 * free-text answer, which is why a caller's option list becomes this dictionary
 * and comes back as `answers[id].probabilities`, keyed exactly like the
 * criteria.
 */
export interface SystemOneChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

/** One `score` question: `criteria` is a list, and the answer indexes it. */
export interface SystemOneScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

/** A question of the single-endpoint contract; `type` discriminates the union. */
export type SystemOneQuestion = SystemOneChoiceQuestion | SystemOneScoreQuestion;

/** Body of the one and only request this backend sends. */
export interface SystemOneRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, SystemOneQuestion>;
}

/** Answer of a `choice` question: the named criterion plus its distribution. */
export interface SystemOneChoiceAnswer {
  type?: string;
  /** Criterion key the model named; equals the argmax of `probabilities`. */
  choice?: string;
  /** The gateway's own confidence, distinct from the argmax probability. */
  confidence?: number;
  probabilities?: Record<string, number>;
}

/**
 * Answer of a `score` question.
 *
 * `probabilities` is keyed by the *index* of the criteria list and `score` is
 * the probability-weighted mean index (measured against `jev-1.13.0`), so
 * `Math.round(score)` is the argmax index and `legend` names each index.
 */
export interface SystemOneScoreAnswer {
  type?: string;
  score?: number;
  confidence?: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
}

/** Response envelope of `POST /v1/systemone`. */
export interface SystemOneResponse {
  model?: string;
  answers?: Record<string, SystemOneChoiceAnswer | SystemOneScoreAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Path of the one endpoint the current gateway exposes. */
export const SYSTEMONE_ENDPOINT_PATH = '/v1/systemone';

/** Endpoint used when neither configuration nor environment supplies a base. */
export const DEFAULT_SYSTEMONE_ENDPOINT = `https://api.typesafe.ai${SYSTEMONE_ENDPOINT_PATH}`;

/** Illustration of a choice request, for docs and drift checks. */
export const CHOICE_REQUEST_EXAMPLE = {
  model: 'jev-latest',
  state: {},
  questions: {
    q: { type: 'choice', instructions: 'Which option is better?', criteria: { a: 'the first option', b: 'the second option' } }
  }
} as const satisfies SystemOneRequest;

/** Question id of a plain {@link JevDecisionBackend.choice} call. */
export const CHOICE_QUESTION_ID = 'choice';
/** Question id of a {@link JevDecisionBackend.route} call. */
export const ROUTE_QUESTION_ID = 'route';
/** Question id of a {@link JevDecisionBackend.prune} call. */
export const PRUNE_QUESTION_ID = 'prune';
/** Question id of a {@link JevDecisionBackend.checkStagnation} call. */
export const STAGNATION_QUESTION_ID = 'stagnation';
/** Prefix of the per-assertion question ids of a {@link JevDecisionBackend.gate} call. */
export const GATE_QUESTION_PREFIX = 'assertion-';

/* -------------------------------------------------------------------------- */
/* Domain vocabularies expressed as criteria                                   */
/* -------------------------------------------------------------------------- */

/** Verdicts the model may name for one gate assertion. Escalation is ours, never its. */
export type GateVerdict = 'verified' | 'contradicted' | 'not_addressed';

/** Criteria of a gate assertion, in the order ties are broken. */
export const GATE_VERDICTS: readonly GateVerdict[] = ['verified', 'contradicted', 'not_addressed'];

/** What each gate verdict means to the model. */
export const GATE_VERDICT_CRITERIA: Readonly<Record<GateVerdict, string>> = {
  verified: 'The evidence directly supports the assertion.',
  contradicted: 'The evidence contradicts the assertion.',
  not_addressed: 'The evidence neither supports nor contradicts the assertion.'
};

/**
 * Minimum probability on `verified` for a strictness level to claim success.
 * Anything below is escalated: a three-way choice at chance is 1/3, so the
 * lenient floor never accepts a distribution the model did not actually prefer.
 */
export const GATE_CONFIDENCE_FLOOR: Readonly<Record<'high' | 'normal' | 'lenient', number>> = {
  high: 0.7,
  normal: 0.5,
  lenient: 0.34
};

/** Patterns a run can be stuck in. */
export type StagnationPattern = 'repetition' | 'oscillation' | 'failing_retry' | 'zero_progress' | 'none';

/** Pattern criteria, in the order ties are broken. */
export const STAGNATION_PATTERNS: readonly StagnationPattern[] = [
  'repetition',
  'oscillation',
  'failing_retry',
  'zero_progress',
  'none'
];

/** What each stagnation pattern means to the model. */
export const STAGNATION_PATTERN_CRITERIA: Readonly<Record<StagnationPattern, string>> = {
  repetition: 'The same action with the same input repeats with no new information.',
  oscillation: 'Execution alternates between the same two actions or edits without progress.',
  failing_retry: 'Actions keep failing with recurring errors and are retried unchanged.',
  zero_progress: 'Actions run but nothing observable advances the goal.',
  none: 'The run is progressing; none of the stagnation patterns apply.'
};

/** One-line diagnosis of each pattern. */
export const STAGNATION_DIAGNOSIS: Readonly<Record<StagnationPattern, string>> = {
  repetition: 'Identical consecutive tool executions with unchanged input.',
  oscillation: 'The run alternates between two identical actions or edits.',
  failing_retry: 'Recent actions keep failing with recurring errors.',
  zero_progress: 'Actions run, but nothing observable advances the goal.',
  none: 'Execution flow appears progressive.'
};

/** Corrective action recommended for each stuck pattern. */
export const STAGNATION_INTERVENTION: Readonly<Record<StagnationPattern, string>> = {
  repetition: 'Interrupt execution. Change the approach or inspect the previous failure output.',
  oscillation: 'Break the loop: stop alternating, restate the requirement, verify independently.',
  failing_retry: 'Step back and diagnose the root cause before retrying the same action.',
  zero_progress: 'Re-read the goal and pick a step that produces observable evidence of progress.',
  none: 'Continue.'
};

/** Minimum probability for a stuck pattern to be reported as a real alert. */
export const STAGNATION_STUCK_FLOOR = 0.4;

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported for tests)                                           */
/* -------------------------------------------------------------------------- */

/** Elapsed milliseconds, rounded and never negative. */
function elapsed(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}

/** Message of an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A probability, clamped into `[0, 1]`; anything unusable reads as 0. */
function toProbability(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(1, numeric);
}

/** A probability rounded to the four decimals the decision surfaces report. */
function round4(value: number): number {
  return Number(value.toFixed(4));
}

/** Comparison key for a criterion: the gateway echoes keys, but be forgiving. */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * Resolve the endpoint the single request goes to.
 *
 * Every accepted spelling of the base — the full `…/v1/systemone` URL the docs
 * and `JEV_API_BASE` use, a `/v1` root, or a bare host — collapses onto exactly
 * one URL, so a retired per-capability sub-path can never be appended.
 * @param baseUrl - configured or environment base; empty selects the default.
 * @returns the absolute URL of `POST /v1/systemone`.
 */
export function normalizeSystemOneEndpoint(baseUrl?: string): string {
  const trimmed = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return DEFAULT_SYSTEMONE_ENDPOINT;
  if (trimmed.endsWith(SYSTEMONE_ENDPOINT_PATH)) return trimmed;
  if (trimmed.endsWith('/systemone')) return `${trimmed.slice(0, -'/systemone'.length)}${SYSTEMONE_ENDPOINT_PATH}`;
  if (trimmed.endsWith('/v1')) return `${trimmed}/systemone`;
  return `${trimmed}${SYSTEMONE_ENDPOINT_PATH}`;
}

/**
 * Turn a list of labels into the unique criteria keys of a choice question.
 *
 * Criteria keys are the option labels themselves, which is what makes the
 * answer's probability dictionary readable as option probabilities. Duplicates
 * (two pool entries with the same name) get a numeric suffix so no option can be
 * lost in the dictionary.
 * @param labels - the option labels, in caller order.
 * @returns one unique key per label, in the same order.
 */
export function uniqueCriteriaKeys(labels: readonly string[]): string[] {
  const used = new Set<string>();
  return labels.map((raw, index) => {
    const label = typeof raw === 'string' ? raw.trim() : '';
    let key = label.length > 0 ? label : `option ${String(index + 1)}`;
    if (used.has(key)) {
      let suffix = 2;
      while (used.has(`${key} (${String(suffix)})`)) suffix++;
      key = `${key} (${String(suffix)})`;
    }
    used.add(key);
    return key;
  });
}

/**
 * Read one answer's distribution against the criteria keys it was asked about.
 * @param probabilities - `answers[id].probabilities`, when present.
 * @param keys - criteria keys of the question, in declared order.
 * @returns every key mapped to its probability (missing keys read 0), or
 *   `undefined` when the answer carries no usable distribution at all.
 */
export function readDistribution(
  probabilities: Record<string, number> | undefined,
  keys: readonly string[]
): Map<string, number> | undefined {
  if (!probabilities || typeof probabilities !== 'object') return undefined;
  const declared = new Map<string, string>();
  for (const key of keys) declared.set(normalizeKey(key), key);

  const distribution = new Map<string, number>(keys.map((key) => [key, 0]));
  let matched = false;
  for (const [rawKey, rawValue] of Object.entries(probabilities)) {
    const key = declared.get(normalizeKey(rawKey));
    if (key === undefined) continue;
    distribution.set(key, (distribution.get(key) ?? 0) + toProbability(rawValue));
    matched = true;
  }
  return matched ? distribution : undefined;
}

/**
 * Highest-probability key of a distribution.
 * @param distribution - probabilities keyed by criteria key.
 * @param order - declared key order, used to break ties deterministically.
 * @returns the winning key, or `undefined` for an empty order.
 */
export function argmaxKey(distribution: Map<string, number>, order: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestValue = -Infinity;
  for (const key of order) {
    const value = distribution.get(key) ?? 0;
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}

/** Move `index` to the front when it ties the current leader. */
function promoteTiedWinner<T>(entries: T[], index: number, scoreOf: (entry: T) => number): void {
  if (index <= 0 || entries.length <= index) return;
  const winner = entries[index] as T;
  const leader = entries[0] as T;
  if (scoreOf(winner) !== scoreOf(leader)) return;
  entries.splice(index, 1);
  entries.unshift(winner);
}

/**
 * Build the choice response options from one gateway answer.
 *
 * The distribution is authoritative; the gateway's discrete `choice` only
 * breaks a tie. When the gateway returns no distribution but does name a
 * criterion, the answer is reconstructed around that name and flagged
 * `uncalibrated`, because the probabilities are then ours, not the gateway's.
 * @param labels - option labels in caller order.
 * @param keys - criteria keys, aligned with `labels`.
 * @param distribution - parsed distribution, when the answer had one.
 * @param answer - the raw gateway answer.
 * @returns sorted options plus the uncalibrated flag, or `undefined` when the
 *   answer cannot be turned into a distribution at all.
 */
export function toChoiceOptions(
  labels: readonly string[],
  keys: readonly string[],
  distribution: Map<string, number> | undefined,
  answer: SystemOneChoiceAnswer | undefined
): { options: ChoiceOption[]; uncalibrated: boolean } | undefined {
  const declaredKey =
    typeof answer?.choice === 'string'
      ? keys.find((key) => normalizeKey(key) === normalizeKey(String(answer.choice)))
      : undefined;

  let resolved = distribution;
  let uncalibrated = false;
  if (resolved === undefined) {
    if (declaredKey === undefined) return undefined;
    resolved = new Map<string, number>(keys.map((key) => [key, 0]));
    const confidence = toProbability(answer?.confidence) || 1;
    resolved.set(declaredKey, confidence);
    const others = keys.filter((key) => key !== declaredKey);
    const share = others.length > 0 ? (1 - confidence) / others.length : 0;
    for (const key of others) resolved.set(key, share);
    uncalibrated = true;
  }

  const options: ChoiceOption[] = labels.map((rawLabel, index) => ({
    label: typeof rawLabel === 'string' ? rawLabel : String(rawLabel),
    probability: round4(resolved?.get(keys[index] ?? '') ?? 0)
  }));
  options.sort((a, b) => b.probability - a.probability);
  if (declaredKey !== undefined) {
    const declaredLabel = labels[keys.indexOf(declaredKey)] ?? '';
    promoteTiedWinner(options, options.findIndex((option) => option.label === declaredLabel), (option) => option.probability);
  }
  return { options, uncalibrated };
}

/**
 * Read the winning criteria index out of a `score` answer.
 * @param answer - the gateway's score answer.
 * @param count - number of criteria the question offered.
 * @returns the argmax index, or `undefined` when the answer is unusable.
 */
export function readScoreIndex(answer: SystemOneScoreAnswer | undefined, count: number): number | undefined {
  if (count <= 0) return undefined;
  const keys = Array.from({ length: count }, (_, index) => String(index));
  const distribution = readDistribution(answer?.probabilities, keys);
  if (distribution !== undefined) {
    const key = argmaxKey(distribution, keys);
    if (key === undefined || (distribution.get(key) ?? 0) <= 0) return undefined;
    return Number(key);
  }
  const raw = typeof answer?.score === 'number' ? answer.score : Number(answer?.score);
  if (!Number.isFinite(raw)) return undefined;
  return Math.min(count - 1, Math.max(0, Math.round(raw)));
}

/** Instruction block of one choice question. */
function buildChoiceInstructions(question: string | undefined): string {
  const trimmed = (question ?? '').trim();
  return trimmed.length > 0 ? trimmed : 'Choose the criterion that best answers the task.';
}

/** Instruction block of one gate assertion. */
function buildGateInstructions(assertion: GateAssertion, strictness: string): string {
  const rubric = (assertion.criteria ?? '').trim();
  return [
    'Decide which criterion describes how the STATE evidence relates to the ASSERTION.',
    `ASSERTION: ${assertion.statement}`,
    ...(rubric.length > 0 ? [`ASSERTION RUBRIC: ${rubric}`] : []),
    `STRICTNESS: ${strictness}`
  ].join('\n');
}

/** Instruction block of a stagnation classification. */
function buildStagnationInstructions(): string {
  return [
    'Classify the recent agent run in the STATE: choose the criterion that best describes the execution pattern.',
    'Judge the action history itself, not the quality of the tool output.'
  ].join('\n');
}

/** Instruction block of a route decision; renders the same facts the logits backend scores. */
export function buildRouteInstructions(req: RouteRequest): string {
  return [
    buildRouteContext(req),
    'Select the single criterion whose candidate best serves the goal.'
  ]
    .filter((line) => line.trim().length > 0)
    .join('\n\n');
}

/** Criterion description of one route candidate. */
function candidateCriterion(candidate: RouteCandidateItem): string {
  const description = (candidate.description ?? '').trim() || candidate.name;
  const type = candidate.type ? `[${candidate.type}] ` : '';
  const mark = candidate.current ? ` ${CURRENT_MODEL_MARK}` : '';
  return `${type}${description}${mark}`;
}

/** Clamp a fragment carried into a decision prompt. */
function clip(text: string | undefined, limit: number): string {
  const value = typeof text === 'string' ? text : '';
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** Words a line must share with the intent to count as relevant. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_\u4e00-\u9fff]+/)
    .filter((word) => word.length > 2);
}

/* -------------------------------------------------------------------------- */
/* Deterministic prune candidates                                              */
/* -------------------------------------------------------------------------- */

/** One deterministic pruning of a raw output. */
export interface PruneCandidate {
  id: 'aggressive' | 'balanced' | 'conservative';
  /** Human-readable label including the reduction it achieved. */
  label: string;
  text: string;
}

const PROGRESS_ART = /\[=+[>\s]|█|^\s*\d+%\s|\[K/;
const NOISE_LINE = /^\s*(?:npm (?:warn|notice)|Downloading|Fetching|Progress:|added \d+ packages|audited \d+ packages)\b/i;
const DIAGNOSTIC_MARK =
  /(?:error|fail|exception|panic|traceback|assert|expected|actual|✗|✘|warn|not ok|denied|refused|cannot|undefined is not|stack)/i;

/** Drop progress art, then collapse repeated lines and blank runs. */
function condenseLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  let blanks = 0;
  let previous: string | undefined;
  for (const line of lines) {
    if (PROGRESS_ART.test(line)) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      blanks++;
      if (blanks <= 1) out.push('');
      continue;
    }
    blanks = 0;
    if (trimmed === previous) continue;
    previous = trimmed;
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

/** Cap a candidate to a token budget, keeping its head and its tail. */
function capToBudget(text: string, maxTokens?: number): string {
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens <= 0) return text;
  const budget = Math.floor(maxTokens) * 4;
  if (text.length <= budget) return text;
  const head = Math.floor(budget * 0.7);
  const tail = Math.max(0, budget - head - 64);
  const dropped = text.length - head - tail;
  const marker = `\n… [${String(dropped)} characters elided by the prune budget] …\n`;
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(text.length - tail) : ''}`;
}

/** Label of one pruning, including its reduction. */
function pruneLabel(id: PruneCandidate['id'], originalChars: number, prunedChars: number): string {
  const strategy: Record<PruneCandidate['id'], string> = {
    aggressive: 'keeps only diagnostic and intent-matching lines',
    balanced: 'drops progress noise and irrelevant dependency traces',
    conservative: 'collapses blank runs and repeated lines'
  };
  const reduction = originalChars > 0 ? Math.round(((originalChars - prunedChars) / originalChars) * 100) : 0;
  return `candidate "${id}" (${strategy[id]}, ${String(reduction)}% smaller)`;
}

/**
 * Build the deterministic prunings used below the judging threshold and as the
 * fallback when System One cannot judge the segments.
 *
 * These are the legacy line filters: {@link JevDecisionBackend.prune} no longer
 * uses them as its primary decision for large payloads — the per-segment scores
 * are — so `PROGRESS_ART`/`NOISE_LINE` are one input among two, never the sole
 * basis of a reduction.
 * @param rawOutput - the bulk output to reduce.
 * @param intent - what the caller is looking for.
 * @param maxTokens - optional token budget applied to every candidate.
 * @returns distinct candidates, most aggressive first; empty for empty input.
 */
export function buildPruneCandidates(rawOutput: string, intent: string, maxTokens?: number): PruneCandidate[] {
  if (rawOutput.length === 0) return [];
  const intentWords = tokenize(intent);
  const matchesIntent = (line: string): boolean => {
    const lower = line.toLowerCase();
    return intentWords.some((word) => lower.includes(word));
  };

  const condensed = condenseLines(rawOutput.split('\n'));
  const balanced = condensed.filter((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return true;
    if (NOISE_LINE.test(trimmed) && !matchesIntent(trimmed)) return false;
    if (trimmed.includes('node_modules/') && !matchesIntent(trimmed)) return false;
    return true;
  });
  const aggressive = balanced.filter((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return true;
    return DIAGNOSTIC_MARK.test(trimmed) || matchesIntent(trimmed);
  });

  const drafts: Array<{ id: PruneCandidate['id']; text: string }> = [
    { id: 'aggressive', text: capToBudget(aggressive.join('\n').trim(), maxTokens) },
    { id: 'balanced', text: capToBudget(balanced.join('\n').trim(), maxTokens) },
    { id: 'conservative', text: capToBudget(condensed.join('\n').trim(), maxTokens) }
  ];

  const seen = new Set<string>();
  return drafts
    .filter((draft) => {
      if (draft.text.length === 0 || seen.has(draft.text)) return false;
      seen.add(draft.text);
      return true;
    })
    .map((draft) => ({
      id: draft.id,
      label: pruneLabel(draft.id, rawOutput.length, draft.text.length),
      text: draft.text
    }));
}

/**
 * Candidate used when the ranking is unavailable: the balanced filter, which is
 * the safest reduction that still removes noise.
 * @param candidates - candidates of {@link buildPruneCandidates}.
 * @returns the local default, or `undefined` for an empty list.
 */
export function pickLocalPruneCandidate(candidates: readonly PruneCandidate[]): PruneCandidate | undefined {
  const balanced = candidates.find((candidate) => candidate.id === 'balanced');
  if (balanced !== undefined) return balanced;
  return candidates[Math.floor(candidates.length / 2)] ?? candidates[0];
}

/* -------------------------------------------------------------------------- */
/* System One segment judging                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Character count from which {@link JevDecisionBackend.prune} judges segments
 * with System One. Kept in sync with `interventions.pruneJudgeMinChars`.
 */
export const PRUNE_JUDGE_MIN_CHARS_DEFAULT = 10000;

/** A scored segment never exceeds this many characters (a single long line stays whole). */
const PRUNE_SEGMENT_MAX_CHARS = 1600;

/** Upper bound on segments judged by one request; the rest are kept deterministically. */
export const PRUNE_MAX_JUDGED_SEGMENTS = 40;

/** Prefix of the per-segment question ids of a pruning judgment. */
export const PRUNE_SEGMENT_QUESTION_PREFIX = 'prune-seg-';

/** Criterion pair of one segment question; index 1 (keep) is the score we read. */
const PRUNE_KEEP_CRITERIA: readonly string[] = [
  'omit: repetitive, irrelevant, or safe to drop',
  'keep: unique, relevant, or diagnostic content'
];

/**
 * Share of the original characters each candidate may spend on scored
 * segments. Forced lines (anchors, diagnostics, intent matches) never compete
 * with this budget.
 */
const PRUNE_SCORED_BUDGET_RATIO: Readonly<Record<PruneCandidate['id'], number>> = {
  aggressive: 0.25,
  balanced: 0.5,
  conservative: 0.7
};

/**
 * Lines that must survive verbatim whatever the segment score says: diagnostic
 * evidence, plus the first and last content lines of the payload. Matched
 * case-insensitively.
 */
const PRUNE_FORCED_LINE =
  /error|failed|FAIL|warn|exception|traceback|assert|exit code [1-9]|non-zero/i;

/**
 * Resolve the segment-judging character threshold from an explicit value, then
 * the environment, then the documented default.
 * @param value - explicit backend configuration, when supplied.
 * @returns a non-negative finite character count.
 */
export function resolvePruneJudgeMinChars(value?: number): number {
  const raw = value ?? process.env.SYSTEM_ONE_PRUNE_JUDGE_MIN_CHARS;
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim().length > 0 ? Number(raw) : NaN;
  if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
  return PRUNE_JUDGE_MIN_CHARS_DEFAULT;
}

/** One contiguous run of non-blank lines, the unit System One judges. */
interface PruneSegment {
  /** Position in the original output, oldest first. */
  index: number;
  /** 0-based inclusive line range in the original output. */
  startLine: number;
  endLine: number;
  /** The segment text exactly as it appears in the output. */
  text: string;
  chars: number;
  /** Absolute line indexes always kept, regardless of the score. */
  forcedLines: number[];
}

/** Whether one line carries diagnostic evidence or matches the intent. */
function isForcedPruneLine(line: string, intentWords: readonly string[]): boolean {
  if (PRUNE_FORCED_LINE.test(line)) return true;
  const lower = line.toLowerCase();
  return intentWords.some((word) => lower.includes(word));
}

/**
 * Cut an output into the segments System One judges.
 *
 * Paragraphs are separated by blank lines; a paragraph longer than
 * {@link PRUNE_SEGMENT_MAX_CHARS} is split on line windows, so the model never
 * sees one oversized block and the local replay can reassemble the exact lines.
 * Line order and line numbers are preserved: every segment is a half-open view
 * of the original line array.
 * @param rawOutput - the bulk output.
 * @param intent - what the caller is looking for.
 * @returns segments in original order, with their forced line indexes.
 */
export function segmentPruneOutput(rawOutput: string, intent: string): PruneSegment[] {
  const lines = rawOutput.split('\n');
  const intentWords = tokenize(intent);
  const segments: PruneSegment[] = [];

  let firstContent = -1;
  let lastContent = -1;
  for (let index = 0; index < lines.length; index++) {
    if ((lines[index] as string).trim().length === 0) continue;
    if (firstContent < 0) firstContent = index;
    lastContent = index;
  }

  const push = (startLine: number, endLine: number): void => {
    const forced: number[] = [];
    for (let line = startLine; line <= endLine; line++) {
      const text = lines[line] as string;
      if (line === firstContent || line === lastContent || isForcedPruneLine(text, intentWords)) {
        forced.push(line);
      }
    }
    const text = lines.slice(startLine, endLine + 1).join('\n');
    segments.push({ index: segments.length, startLine, endLine, text, chars: text.length, forcedLines: forced });
  };

  let cursor = 0;
  while (cursor < lines.length) {
    while (cursor < lines.length && (lines[cursor] as string).trim().length === 0) cursor++;
    if (cursor >= lines.length) break;
    const blockStart = cursor;
    while (cursor < lines.length && (lines[cursor] as string).trim().length > 0) cursor++;
    const blockEnd = cursor - 1;

    let windowStart = blockStart;
    let windowChars = (lines[blockStart] as string).length;
    for (let line = blockStart + 1; line <= blockEnd; line++) {
      const length = (lines[line] as string).length + 1;
      if (windowChars + length > PRUNE_SEGMENT_MAX_CHARS) {
        push(windowStart, line - 1);
        windowStart = line;
        windowChars = (lines[line] as string).length;
      } else {
        windowChars += length;
      }
    }
    push(windowStart, blockEnd);
  }
  return segments;
}

/** Instruction block of one segment question. */
function buildSegmentInstructions(intent: string, segment: PruneSegment, total: number): string {
  const trimmed = intent.trim() || 'extract diagnostics, relevant results and errors';
  return [
    'Decide whether one segment of a tool output must be kept to serve the INTENT, or may be omitted as noise.',
    `INTENT: ${trimmed}`,
    `SEGMENT: ${String(segment.index + 1)} of ${String(total)} (lines ${String(segment.startLine + 1)}-${String(segment.endLine + 1)}).`,
    'Score 0 when the segment is repetitive or irrelevant; score 1 when it carries information the INTENT needs.'
  ].join('\n');
}

/**
 * Read one segment's keep score (0 = omit, 1 = keep) out of its `score` answer.
 * The distribution over the two criteria is authoritative; the weighted `score`
 * is the fallback, and nothing usable reads as `undefined`.
 * @param answer - the gateway's answer for this segment question.
 * @returns the keep score in `[0, 1]`, or `undefined` when unusable.
 */
export function readSegmentKeepScore(answer: SystemOneScoreAnswer | undefined): number | undefined {
  if (answer === undefined || answer === null) return undefined;
  const distribution = readDistribution(answer.probabilities, ['0', '1']);
  if (distribution !== undefined) return round4(toProbability(distribution.get('1')));
  const raw = typeof answer.score === 'number' ? answer.score : Number(answer.score);
  if (!Number.isFinite(raw)) return undefined;
  return round4(Math.min(1, Math.max(0, raw)));
}

/**
 * Pick the segments a budget keeps from their scores.
 *
 * Segments without a usable score are an unjudged safety margin and are always
 * kept; scored segments are taken from the highest score down until the
 * character budget is spent. Ties follow the original order.
 * @param segments - all segments of the output.
 * @param scores - keep score per segment index, absent for unjudged segments.
 * @param originalChars - character count of the unpruned output.
 * @param ratio - share of the original characters scored segments may use.
 * @returns indexes of the segments this candidate keeps in full.
 */
export function selectPruneSegments(
  segments: readonly PruneSegment[],
  scores: ReadonlyMap<number, number>,
  originalChars: number,
  ratio: number
): Set<number> {
  const selected = new Set<number>();
  let used = 0;
  for (const segment of segments) {
    if (scores.has(segment.index)) continue;
    selected.add(segment.index);
    used += segment.chars;
  }
  const budget = Math.floor(originalChars * ratio);
  const ranked = segments
    .filter((segment) => scores.has(segment.index))
    .sort((left, right) => {
      const difference = (scores.get(right.index) ?? 0) - (scores.get(left.index) ?? 0);
      return difference !== 0 ? difference : left.index - right.index;
    });
  for (const segment of ranked) {
    // Stop at the budget instead of skipping ahead: a smaller low-score segment
    // must never slip into the space a higher-score one did not fit.
    if (used + segment.chars > budget) break;
    selected.add(segment.index);
    used += segment.chars;
  }
  return selected;
}

/** Build the marker of one run of omitted segments. */
function omittedSegmentsMarker(count: number): string {
  return `… [${String(count)} segments omitted] …`;
}

/**
 * Reassemble one candidate in the original line order.
 *
 * A selected segment is kept whole; an unselected one keeps only its forced
 * lines (first/last anchors, diagnostics, intent matches). Consecutive fully
 * omitted segments collapse into one marker that names how many were dropped.
 * Blank runs between kept lines collapse to a single blank line.
 * @param rawOutput - the original output, for its lines.
 * @param segments - segments in original order.
 * @param selected - segment indexes kept whole.
 * @returns the reduced text.
 */
export function assemblePruneCandidate(
  rawOutput: string,
  segments: readonly PruneSegment[],
  selected: ReadonlySet<number>
): string {
  const lines = rawOutput.split('\n');
  const out: string[] = [];
  let omitted = 0;
  let lastEmitted = -1;

  const emitLine = (lineIndex: number): void => {
    if (lastEmitted >= 0 && lineIndex > lastEmitted + 1) out.push('');
    out.push(lines[lineIndex] as string);
    lastEmitted = lineIndex;
  };
  const flushOmitted = (): void => {
    if (omitted === 0) return;
    out.push(omittedSegmentsMarker(omitted));
    omitted = 0;
  };

  for (const segment of segments) {
    // A selected segment is kept whole; an unselected one keeps forced lines only.
    const keepWhole = selected.has(segment.index);
    const lineIndexes: number[] = [];
    if (keepWhole) {
      for (let line = segment.startLine; line <= segment.endLine; line++) lineIndexes.push(line);
    } else {
      lineIndexes.push(...segment.forcedLines);
    }
    if (lineIndexes.length === 0) {
      omitted++;
      continue;
    }
    flushOmitted();
    for (const lineIndex of lineIndexes) emitLine(lineIndex);
  }
  flushOmitted();
  return out.join('\n').trim();
}

/** Label of one score-driven candidate, including its reduction. */
function scoredPruneLabel(id: PruneCandidate['id'], originalChars: number, prunedChars: number): string {
  const strategy: Record<PruneCandidate['id'], string> = {
    aggressive: 'keeps the segments System One judged essential within a quarter of the original',
    balanced: 'keeps the segments System One judged essential within half of the original',
    conservative: 'keeps the segments System One judged essential within most of the original'
  };
  const reduction = originalChars > 0 ? Math.round(((originalChars - prunedChars) / originalChars) * 100) : 0;
  return `candidate "${id}" (${strategy[id]}, ${String(reduction)}% smaller)`;
}

/**
 * Build the three System One–scored prunings from one segment judgment.
 *
 * The segment keep/drop decision is the model's score; the three ids only
 * differ in their character budget, so the ranking the engine used to make is
 * now made per segment.
 * @param rawOutput - the original output.
 * @param segments - segments of that output in original order.
 * @param scores - keep score per segment index.
 * @param maxTokens - optional hard token ceiling applied to every candidate.
 * @returns candidates ordered from aggressive to conservative.
 */
export function buildScoredPruneCandidates(
  rawOutput: string,
  segments: readonly PruneSegment[],
  scores: ReadonlyMap<number, number>,
  maxTokens?: number
): PruneCandidate[] {
  const ids: PruneCandidate['id'][] = ['aggressive', 'balanced', 'conservative'];
  return ids.map((id) => {
    const selected = selectPruneSegments(segments, scores, rawOutput.length, PRUNE_SCORED_BUDGET_RATIO[id]);
    const text = capToBudget(assemblePruneCandidate(rawOutput, segments, selected), maxTokens);
    return { id, label: scoredPruneLabel(id, rawOutput.length, text.length), text };
  });
}


/* -------------------------------------------------------------------------- */
/* Local fallbacks                                                             */
/* -------------------------------------------------------------------------- */

/** A local stagnation verdict, used when the gateway cannot supply one. */
export interface LocalStagnationVerdict {
  isStuck: boolean;
  patternType: StagnationPattern;
  confidence: number;
  diagnosis: string;
  recommendedIntervention?: string;
}

/**
 * Deterministic stagnation detector over a recent action window.
 *
 * It is the offline half of {@link JevDecisionBackend.checkStagnation}: the
 * gateway classifies the pattern, and this reads the same history with explicit
 * rules, so a dead gateway degrades the verdict instead of losing it.
 * @param recent - the recent action window, oldest first.
 * @returns the locally detected pattern.
 */
export function detectStagnationLocally(recent: readonly ActionStep[]): LocalStagnationVerdict {
  const stuck = (patternType: Exclude<StagnationPattern, 'none'>, confidence: number): LocalStagnationVerdict => ({
    isStuck: true,
    patternType,
    confidence,
    diagnosis: `${STAGNATION_DIAGNOSIS[patternType]} [local heuristic]`,
    recommendedIntervention: STAGNATION_INTERVENTION[patternType]
  });

  const signatures = recent.map((step) => `${step.tool}:${(step.input ?? '').trim()}`);
  let identical = 1;
  for (let index = signatures.length - 1; index > 0; index--) {
    if (signatures[index] === signatures[index - 1]) identical++;
    else break;
  }
  if (identical >= 3) return stuck('repetition', 0.95);

  const failing = recent.filter(
    (step) => Boolean(step.error) || /(?:error|fail|panic|not ok)/i.test(step.output ?? '')
  );
  if (failing.length >= 3 && recent.length >= 4) return stuck('failing_retry', 0.85);

  if (recent.length >= 4) {
    const last = recent.slice(-4);
    const alternates =
      last[0]?.tool === last[2]?.tool &&
      last[1]?.tool === last[3]?.tool &&
      last[0]?.input === last[2]?.input &&
      last[1]?.input === last[3]?.input;
    if (alternates) return stuck('oscillation', 0.9);
  }

  return {
    isStuck: false,
    patternType: 'none',
    confidence: 0.6,
    diagnosis: `${STAGNATION_DIAGNOSIS.none} [local heuristic]`
  };
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Jev System One Provider Adapter
 *
 * Speaks only the current gateway contract: one `POST /v1/systemone` carrying
 * `{ model, state, questions }`, where every question is a `choice` between
 * criteria or a `score` over a criteria list. The gateway returns discrete
 * distributions, never free text, so the four composite capabilities
 * (`gate`, `prune`, `checkStagnation`, `route`) are expressed as criteria
 * questions and backed by deterministic local fallbacks.
 */
export class JevDecisionBackend implements DecisionBackend {
  readonly name = 'system-one-jev';
  readonly model: string;
  /** Absolute URL of the single endpoint; no call appends a sub-path to it. */
  readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  /** Character count from which pruning judges segments through System One. */
  private readonly pruneJudgeMinChars: number;

  constructor(config?: JevBackendConfig) {
    this.endpoint = normalizeSystemOneEndpoint(
      config?.baseUrl ||
        process.env.SYSTEM_ONE_BASE_URL ||
        process.env.JEV_BASE_URL ||
        process.env.JEV_API_BASE ||
        DEFAULT_SYSTEMONE_ENDPOINT
    );
    this.apiKey =
      config?.apiKey ||
      process.env.SYSTEM_ONE_API_KEY ||
      process.env.JEV_API_KEY ||
      '';
    this.model =
      config?.model ||
      process.env.SYSTEM_ONE_MODEL ||
      process.env.JEV_MODEL ||
      'jev-latest';
    this.timeoutMs = config?.timeoutMs || 10000;
    this.pruneJudgeMinChars = resolvePruneJudgeMinChars(config?.pruneJudgeMinChars);
  }

  /**
   * Send one request to the single endpoint.
   * @param questions - questions keyed by id; answers come back under the same ids.
   * @param state - machine-readable situation the questions reason about.
   * @returns the gateway's answer envelope.
   */
  private async postSystemOne(
    questions: Record<string, SystemOneQuestion>,
    state: Record<string, unknown>
  ): Promise<SystemOneResponse> {
    const body: SystemOneRequest = { model: this.model, state, questions };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey.length > 0 ? { Authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Jev API error (${resp.status} ${resp.statusText}): ${text.slice(0, 500)}`);
      }

      const data = (await resp.json()) as SystemOneResponse;
      if (!data || typeof data !== 'object' || typeof data.answers !== 'object' || data.answers === null) {
        throw new Error('Jev API response carries no answers object');
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Classify one question into a probability distribution over the options.
   *
   * The options become the `criteria` dictionary (key = option label, value =
   * the description the model reads) and `answers[id].probabilities` — keyed by
   * criterion — becomes the returned option distribution. An answer without a
   * usable distribution fails loudly: the caller asked for a decision, and a
   * fabricated one would be worse than an error.
   * @param req - question, options, optional context.
   * @returns options sorted by probability, plus the winning option.
   */
  async choice(req: ChoiceRequest): Promise<ChoiceResponse> {
    const start = performance.now();
    try {
      const labels = Array.isArray(req.options) ? req.options : [];
      if (labels.length === 0) throw new Error('at least one option is required');

      const keys = uniqueCriteriaKeys(labels);
      const criteria: Record<string, string> = {};
      keys.forEach((key, index) => {
        criteria[key] = typeof labels[index] === 'string' ? (labels[index] as string) : key;
      });

      const context = (req.context ?? '').trim();
      const data = await this.postSystemOne(
        {
          [CHOICE_QUESTION_ID]: {
            type: 'choice',
            instructions: buildChoiceInstructions(req.question),
            criteria
          }
        },
        context.length > 0 ? { context } : {}
      );

      const answer = data.answers?.[CHOICE_QUESTION_ID] as SystemOneChoiceAnswer | undefined;
      const scored = toChoiceOptions(labels, keys, readDistribution(answer?.probabilities, keys), answer);
      if (scored === undefined) {
        throw new Error('the gateway returned neither a probability distribution nor a named criterion');
      }

      const options = scored.options;
      return {
        options,
        bestOption: options[0]?.label ?? '',
        confidence: options[0]?.probability ?? 0,
        uncalibrated: scored.uncalibrated,
        latencyMs: elapsed(start)
      };
    } catch (err) {
      throw new Error(`[JevBackend.choice] Failed: ${errorMessage(err)}`);
    }
  }

  /**
   * Verify assertions against evidence, fail-closed.
   *
   * Every assertion becomes one `choice` question in the same request, and the
   * answer's distribution over `verified` / `contradicted` / `not_addressed`
   * becomes the verdict. Anything unusable — a failed call, a missing answer, a
   * distribution below the strictness floor — escalates that assertion; the
   * method never returns a pass it could not observe.
   * @param req - assertions, evidence, strictness.
   * @returns one result per assertion plus the aggregate verdict.
   */
  async gate(req: GateRequest): Promise<GateResponse> {
    const start = performance.now();
    const assertions = Array.isArray(req.assertions) ? req.assertions : [];
    const strictness = req.strictness ?? 'normal';

    try {
      if (assertions.length === 0 || (req.evidence ?? '').trim().length === 0) {
        return this.failClosedGate(assertions, 'Evidence is empty or no assertions were supplied. Fail-closed.');
      }

      const ids = assertions.map((_, index) => `${GATE_QUESTION_PREFIX}${String(index)}`);
      const questions: Record<string, SystemOneQuestion> = {};
      assertions.forEach((assertion, index) => {
        questions[ids[index] as string] = {
          type: 'choice',
          instructions: buildGateInstructions(assertion, strictness),
          criteria: { ...GATE_VERDICT_CRITERIA }
        };
      });

      const context = (req.context ?? '').trim();
      const data = await this.postSystemOne(questions, {
        evidence: req.evidence,
        strictness,
        ...(context.length > 0 ? { context } : {})
      });

      const results: GateResultItem[] = assertions.map((assertion, index) =>
        this.gateItem(assertion, data.answers?.[ids[index] as string], strictness)
      );

      let passed = true;
      let needsEscalation = false;
      for (const item of results) {
        if (item.outcome === 'verified') continue;
        passed = false;
        if (item.outcome === 'escalate') needsEscalation = true;
        else if (item.outcome === 'not_addressed' && strictness !== 'lenient') needsEscalation = true;
      }

      return {
        passed: passed && !needsEscalation,
        results,
        needsEscalation,
        latencyMs: elapsed(start)
      };
    } catch (err) {
      return this.failClosedGate(
        assertions,
        `Jev API call failed: ${errorMessage(err)}. Fail-closed escalation triggered.`
      );
    }
  }

  /** One assertion's outcome from its answer; unusable answers escalate. */
  private gateItem(
    assertion: GateAssertion,
    answer: SystemOneChoiceAnswer | SystemOneScoreAnswer | undefined,
    strictness: 'high' | 'normal' | 'lenient'
  ): GateResultItem {
    const statement = assertion?.statement ?? '';
    const choiceAnswer = answer as SystemOneChoiceAnswer | undefined;
    const distribution = readDistribution(choiceAnswer?.probabilities, GATE_VERDICTS);
    if (distribution === undefined) {
      return {
        statement,
        outcome: 'escalate',
        confidence: 0,
        explanation: 'The gateway returned no usable verdict distribution for this assertion. Fail-closed escalation.'
      };
    }

    const verdict = argmaxKey(distribution, GATE_VERDICTS) as GateVerdict;
    const confidence = round4(distribution.get(verdict) ?? 0);
    const floor = GATE_CONFIDENCE_FLOOR[strictness];
    if (confidence < floor) {
      return {
        statement,
        outcome: 'escalate',
        confidence,
        explanation: `System One named "${verdict}" at ${(confidence * 100).toFixed(1)}%, below the ${strictness} floor of ${(floor * 100).toFixed(0)}%. Fail-closed escalation.`
      };
    }

    return {
      statement,
      outcome: verdict,
      confidence,
      explanation: `System One named "${verdict}" at ${(confidence * 100).toFixed(1)}% (evidence supplied as state).`
    };
  }

  /** Every assertion escalated for one reason — the fail-closed shape. */
  private failClosedGate(assertions: readonly GateAssertion[], reason: string): GateResponse {
    const started = performance.now();
    return {
      passed: false,
      needsEscalation: true,
      results: assertions.map((assertion) => ({
        statement: assertion?.statement ?? '',
        outcome: 'escalate' as const,
        confidence: 0,
        explanation: reason
      })),
      latencyMs: elapsed(started)
    };
  }

  /**
   * Reduce a bulk output to the segments the intent needs, fail-open.
   *
   * Two paths share one contract. A payload below `pruneJudgeMinChars` is
   * reduced by the deterministic local candidates and sends no request at all.
   * A payload at/above it is cut into segments, and one `score` question per
   * segment lets System One decide what to keep; the three budgets only decide
   * how much of the top-scored material fits. Forced lines (first/last anchors,
   * diagnostics, intent matches) survive either way. Any failure — call,
   * transport, unusable answer — falls back to the local candidates, so pruning
   * never breaks the harness and never returns the raw blob just because the
   * network blinked.
   * @param req - raw output, intent, budget, shadow flag.
   * @returns the pruned text plus its reduction metrics and the path taken.
   */
  async prune(req: PruneRequest): Promise<PruneResponse> {
    const start = performance.now();
    const raw = typeof req.rawOutput === 'string' ? req.rawOutput : '';
    const intent = req.intent ?? '';
    if (raw.length === 0) return this.pruneResponse(raw, raw, req.shadowMode, start, { judgePath: 'local' });

    if (raw.length < this.pruneJudgeMinChars) {
      return this.pruneResponse(raw, this.localPruneText(raw, intent, req.maxTokens), req.shadowMode, start, {
        judgePath: 'local'
      });
    }
    return this.pruneWithSegments(req, raw, intent, start);
  }

  /** The deterministic candidate text, or the raw output when it does not shrink. */
  private localPruneText(raw: string, intent: string, maxTokens?: number): string {
    const candidates = buildPruneCandidates(raw, intent, maxTokens);
    const local = pickLocalPruneCandidate(candidates);
    if (local === undefined) return raw;
    return local.text.length < raw.length ? local.text : raw;
  }

  /** The per-segment System One path, with the local candidates as its fallback. */
  private async pruneWithSegments(
    req: PruneRequest,
    raw: string,
    intent: string,
    start: number
  ): Promise<PruneResponse> {
    const segments = segmentPruneOutput(raw, intent);
    if (segments.length <= 1) {
      // One segment has nothing to choose between; spending a judgment would
      // only reproduce the whole payload.
      return this.pruneResponse(raw, this.localPruneText(raw, intent, req.maxTokens), req.shadowMode, start, {
        judgePath: 'local',
        judgedSegments: 0,
        unjudgedSegments: segments.length
      });
    }

    const judged = segments.slice(0, PRUNE_MAX_JUDGED_SEGMENTS);
    const unjudgedSegments = segments.length - judged.length;
    const diagnostics = { judgedSegments: judged.length, unjudgedSegments };

    try {
      const scores = await this.scoreSegments(judged, segments.length, intent);
      if (scores.size === 0) {
        return this.pruneResponse(raw, this.localPruneText(raw, intent, req.maxTokens), req.shadowMode, start, {
          judgePath: 'local',
          fallbackReason: 'System One returned no usable segment score',
          ...diagnostics
        });
      }
      const candidates = buildScoredPruneCandidates(raw, segments, scores, req.maxTokens);
      const balanced = candidates.find((candidate) => candidate.id === 'balanced') ?? candidates[0];
      const text = balanced !== undefined && balanced.text.length < raw.length ? balanced.text : raw;
      return this.pruneResponse(raw, text, req.shadowMode, start, { judgePath: 'segmented', ...diagnostics });
    } catch (err) {
      // FAIL-OPEN: the deterministic candidate still prunes; the harness never breaks.
      return this.pruneResponse(raw, this.localPruneText(raw, intent, req.maxTokens), req.shadowMode, start, {
        judgePath: 'local',
        fallbackReason: errorMessage(err),
        ...diagnostics
      });
    }
  }

  /**
   * Judge every segment in one request: one `score` question per segment, with
   * the segment text and the intent in the shared state.
   * @param judged - the segments selected for judging, in original order.
   * @param totalSegments - segment count of the whole output (for the prompt).
   * @param intent - what the caller is looking for.
   * @returns keep score per segment index; segments without a usable answer are absent.
   */
  private async scoreSegments(
    judged: readonly PruneSegment[],
    totalSegments: number,
    intent: string
  ): Promise<Map<number, number>> {
    const questions: Record<string, SystemOneQuestion> = {};
    const stateSegments: Record<string, string> = {};
    for (const segment of judged) {
      const id = `${PRUNE_SEGMENT_QUESTION_PREFIX}${String(segment.index)}`;
      questions[id] = {
        type: 'score',
        instructions: buildSegmentInstructions(intent, segment, totalSegments),
        criteria: [...PRUNE_KEEP_CRITERIA]
      };
      stateSegments[id] = segment.text;
    }

    const data = await this.postSystemOne(questions, {
      intent,
      segments: stateSegments,
      judgedSegments: judged.length,
      unjudgedSegments: totalSegments - judged.length,
      segmentMaxChars: PRUNE_SEGMENT_MAX_CHARS
    });

    const scores = new Map<number, number>();
    for (const segment of judged) {
      const id = `${PRUNE_SEGMENT_QUESTION_PREFIX}${String(segment.index)}`;
      const score = readSegmentKeepScore(data.answers?.[id] as SystemOneScoreAnswer | undefined);
      if (score !== undefined) scores.set(segment.index, score);
    }
    return scores;
  }

  /** Shape one pruning as the shared prune response. */
  private pruneResponse(
    raw: string,
    text: string,
    shadow: boolean | undefined,
    start: number,
    meta?: Pick<PruneResponse, 'judgePath' | 'fallbackReason' | 'judgedSegments' | 'unjudgedSegments'>
  ): PruneResponse {
    const originalChars = raw.length;
    const prunedChars = text.length;
    return {
      processedOutput: shadow ? raw : text,
      originalChars,
      prunedChars,
      estimatedTokensSaved: Math.max(0, Math.ceil((originalChars - prunedChars) / 4)),
      reductionPercentage:
        originalChars > 0 ? Number((((originalChars - prunedChars) / originalChars) * 100).toFixed(1)) : 0,
      shadow: Boolean(shadow),
      latencyMs: elapsed(start),
      ...meta
    };
  }

  /**
   * Classify the recent action window into one execution pattern.
   *
   * One `choice` question over the five patterns; the distribution decides the
   * verdict and its confidence. When the gateway cannot answer, the same window
   * is read by {@link detectStagnationLocally}, so a network failure lowers the
   * quality of the verdict instead of removing it.
   * @param req - action history and optional goal.
   * @returns the pattern, whether it is stuck, and the intervention.
   */
  async checkStagnation(req: StagnationCheckRequest): Promise<StagnationCheckResponse> {
    const start = performance.now();
    const history = Array.isArray(req.history) ? req.history : [];
    const windowSize = typeof req.windowSize === 'number' && req.windowSize > 0 ? req.windowSize : 6;
    const recent = history.slice(-windowSize);

    if (recent.length < 3) {
      return {
        isStuck: false,
        patternType: 'none',
        confidence: 1,
        diagnosis: 'Action count below stagnation threshold (< 3).',
        latencyMs: elapsed(start)
      };
    }

    try {
      const criteria: Record<string, string> = {};
      for (const pattern of STAGNATION_PATTERNS) criteria[pattern] = STAGNATION_PATTERN_CRITERIA[pattern];

      const data = await this.postSystemOne(
        {
          [STAGNATION_QUESTION_ID]: {
            type: 'choice',
            instructions: buildStagnationInstructions(),
            criteria
          }
        },
        {
          goal: (req.goal ?? '').trim() || null,
          window: recent.length,
          actions: recent.map((step) => ({
            tool: step.tool,
            input: clip(step.input, 240),
            ...(step.output === undefined ? {} : { output: clip(step.output, 240) }),
            ...(step.error === undefined ? {} : { error: clip(step.error, 240) })
          }))
        }
      );

      const answer = data.answers?.[STAGNATION_QUESTION_ID] as SystemOneChoiceAnswer | undefined;
      const distribution = readDistribution(answer?.probabilities, STAGNATION_PATTERNS);
      if (distribution === undefined) {
        return this.localStagnation(recent, 'the gateway returned no usable pattern distribution', start);
      }

      const pattern = argmaxKey(distribution, STAGNATION_PATTERNS) as StagnationPattern;
      const confidence = round4(distribution.get(pattern) ?? 0);
      const isStuck = pattern !== 'none' && confidence >= STAGNATION_STUCK_FLOOR;
      return {
        isStuck,
        patternType: pattern,
        confidence,
        diagnosis: `${STAGNATION_DIAGNOSIS[pattern]} (System One p=${confidence.toFixed(3)})`,
        ...(isStuck ? { recommendedIntervention: STAGNATION_INTERVENTION[pattern] } : {}),
        latencyMs: elapsed(start)
      };
    } catch (err) {
      return this.localStagnation(recent, errorMessage(err), start);
    }
  }

  /** The local half of {@link checkStagnation}, annotated with why it ran. */
  private localStagnation(recent: readonly ActionStep[], reason: string, start: number): StagnationCheckResponse {
    const local = detectStagnationLocally(recent);
    return {
      isStuck: local.isStuck,
      patternType: local.patternType,
      confidence: local.confidence,
      diagnosis: `${local.diagnosis} [System One unavailable: ${reason}]`,
      ...(local.recommendedIntervention === undefined
        ? {}
        : { recommendedIntervention: local.recommendedIntervention }),
      latencyMs: elapsed(start)
    };
  }

  /**
   * Rank candidates for a goal with one `choice` question.
   *
   * The criteria are the candidate names carrying their descriptions and the
   * incumbent mark, and the answer's distribution is the ranking. The rendered
   * context block of {@link buildRouteContext} — the same facts the logits
   * backend scores — rides in the instructions, so cache-affinity facts and the
   * policy reach the model. A failing gateway falls back to a local keyword
   * ranking whose reasons say so, keeping routing alive.
   * @param req - goal, candidates, topK, session facts, policy.
   * @returns the ranked candidates, best first.
   */
  async route(req: RouteRequest): Promise<RouteResponse> {
    const start = performance.now();
    const candidates = Array.isArray(req.candidates) ? req.candidates : [];
    const topK = typeof req.topK === 'number' && req.topK > 0 ? req.topK : 3;
    if (candidates.length === 0) return { rankedCandidates: [], latencyMs: elapsed(start) };

    try {
      const keys = uniqueCriteriaKeys(candidates.map((candidate) => candidate.name));
      const criteria: Record<string, string> = {};
      keys.forEach((key, index) => {
        const candidate = candidates[index] as RouteCandidateItem;
        criteria[key] = candidateCriterion(candidate);
      });

      const data = await this.postSystemOne(
        {
          [ROUTE_QUESTION_ID]: {
            type: 'choice',
            instructions: buildRouteInstructions(req),
            criteria
          }
        },
        {
          goal: req.goal,
          ...(req.state === undefined ? {} : { session: req.state }),
          topK
        }
      );

      const answer = data.answers?.[ROUTE_QUESTION_ID] as SystemOneChoiceAnswer | undefined;
      const distribution = readDistribution(answer?.probabilities, keys);
      if (distribution === undefined) {
        return this.localRoute(candidates, req.goal, 'the gateway returned no usable candidate distribution', topK, start);
      }

      const ranked = candidates
        .map((candidate, index) => ({ name: candidate.name, score: round4(distribution.get(keys[index] as string) ?? 0) }))
        .sort((a, b) => b.score - a.score);

      const declaredKey =
        typeof answer?.choice === 'string'
          ? keys.find((key) => normalizeKey(key) === normalizeKey(String(answer.choice)))
          : undefined;
      if (declaredKey !== undefined) {
        const declaredName = candidates[keys.indexOf(declaredKey)]?.name ?? '';
        promoteTiedWinner(ranked, ranked.findIndex((entry) => entry.name === declaredName), (entry) => entry.score);
      }

      const sliced = ranked.slice(0, topK);
      return { rankedCandidates: sliced, bestCandidate: sliced[0]?.name, latencyMs: elapsed(start) };
    } catch (err) {
      return this.localRoute(candidates, req.goal, errorMessage(err), topK, start);
    }
  }

  /** Deterministic keyword ranking used when the gateway cannot rank. */
  private localRoute(
    candidates: readonly RouteCandidateItem[],
    goal: string,
    reason: string,
    topK: number,
    start: number
  ): RouteResponse {
    const goalWords = tokenize(goal ?? '');
    const weighted = candidates.map((candidate) => {
      const text = `${candidate.name} ${candidate.description ?? ''} ${candidate.type ?? ''}`.toLowerCase();
      const matches = goalWords.filter((word) => text.includes(word)).length;
      return { name: candidate.name, weight: 0.1 + matches };
    });
    const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    const ranked = weighted
      .map((entry) => ({
        name: entry.name,
        score: Number((entry.weight / total).toFixed(4)),
        reason: `local fallback (${reason})`
      }))
      .sort((a, b) => b.score - a.score);
    const sliced = ranked.slice(0, topK);
    return { rankedCandidates: sliced, bestCandidate: sliced[0]?.name, latencyMs: elapsed(start) };
  }
}
