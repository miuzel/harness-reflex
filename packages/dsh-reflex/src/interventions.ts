/**
 * Automatic interventions on the Host's native tool and agent lifecycle hooks.
 *
 * The plugin's eight MCP tools are pull-based: they act only when the *model*
 * decides to call one. This module is the push half — the same System 1
 * judgments, spent automatically at the four points where the Host already asks
 * its listeners a question:
 *
 * | Hook | Capability | What it may do |
 * | --- | --- | --- |
 * | `tools/pre-execute` | `stagnation` | deny a call the run is repeating |
 * | `tools/post-execute` | `prune` | replace an oversized result with its reduction |
 * | `tools/post-execute` | `gate` | turn a repeated failure into corrective feedback |
 * | `agent/pre-step` | `stagnation` | attach the correction to the next step |
 * | `agent/turn-stopping` | `closing` | object to a turn closing on contradicted evidence |
 *
 * ## The three-state discipline
 *
 * Every capability runs in one of three modes. The distinction is *not* "on/off
 * with logging": `observe` runs the same detection, the same judgment, and the
 * same plan as `active`, and withholds only the application. That is what makes
 * the mode worth having — what observe measures is exactly what active would
 * have done, on the same payloads, at the same cost.
 *
 * | Mode | Detection | Judgment | Application | Model-visible change |
 * | --- | --- | --- | --- | --- |
 * | `off` | none | none | none | none |
 * | `observe` | full | full | none | **none at all** |
 * | `active` | full | full | full | the planned text |
 *
 * `observe` is therefore *not* the reference plugin's shadow mode: that one
 * injects a model-visible notice saying it changed nothing. Here an observation
 * has no model-visible surface whatsoever — no message, no rewritten content, no
 * denial, no steering. The one thing it produces is an audit record in the
 * session log, which the model cannot read.
 *
 * ## Cost discipline
 *
 * A deterministic, local pre-trigger decides whether a *judgment* may be spent
 * at all, and judgments are budgeted per turn and per session: at most
 * {@link ResolvedInterventionsConfig.maxJudgmentsPerTurn} per turn and
 * {@link ResolvedInterventionsConfig.maxJudgmentsPerSession} per agent, with one
 * verdict reused by every hook of the same turn. A turn presenting twenty
 * similar results therefore costs one judgment, not twenty. Applied
 * interventions carry their own ceiling, so an intervention can never become the
 * loop it was meant to break.
 *
 * ## Fail-open and isolation
 *
 * Every hook delegates first (`await next()`), and every planning step is
 * wrapped: an exception, an aborted signal, or an unusable verdict leaves the
 * call, the result, the messages, and the turn exactly as the rest of the
 * waterfall left them. Detection state is keyed by agent id, so two agents in one
 * process can never see each other's history, verdicts, or budgets. Nothing here
 * grants a permission the Host would not have granted, and nothing here overrides
 * one either: a call the rest of the waterfall denied, cancelled, or routed to an
 * approval flow is returned untouched, so the only decision this module can add
 * is a strictly narrower one on top of a plain `allow`.
 *
 * ## Retained originals
 *
 * A reduction is installed only after the bytes it replaces have been retained
 * in the agent's own Session log, in the plugin-record channel the audit trail
 * already uses. The replacement publishes a locator derived from the payload's
 * digest, a reader resolves it back to the verbatim original, and a payload that
 * cannot be retained — too large, no session, a log that did not commit — is
 * never replaced: `saved` is reported only for a replacement that really
 * happened and can really be checked.
 *
 * @module dsh-reflex/interventions
 */
import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { MessageId, boundContextSummary } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm';
import type { PreStepDecision } from '@deepseek-ai/dsh-agent';
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';

import {
  INTERVENTION_CAPABILITIES,
  type InterventionCapability,
  type InterventionMode,
  type ResolvedInterventionsConfig
} from './config.js';
import { appendInterventionRecord, pruneLocator, type InterventionAuditRecord } from './session-audit.js';
import type { ReflexGateService, StagnationDetector, ToolResultPruner } from './vendor/harness-reflex/index.js';
import type { ActionStep, PruneResponse, StagnationCheckResponse } from './vendor/harness-reflex/index.js';

/**
 * Producer-owned source kind of every message this plugin appends.
 *
 * Session format v4 has no catch-all `plugin` kind and refuses that literal
 * outright, so the producer names itself — the same identity this plugin already
 * uses for its audit records.
 */
export const INTERVENTION_SOURCE_KIND = 'plugin:dsh-reflex';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** One corrective context this plugin attached to a step. */
    'plugin:dsh-reflex': { kind: 'plugin:dsh-reflex' } & ContextFormed;
  }
}

/** Default share of a floored reduction's context budget taken from the head. */
const FLOOR_HEAD_CHARS = 400;
/** Default share of a floored reduction's context budget taken from the tail. */
const FLOOR_TAIL_CHARS = 400;
/** Characters of one observed step's input or output retained for judging. */
const STEP_CHARS = 600;
/** Steps one agent's detection window may retain. */
const MAX_STEPS = 12;
/** Characters of assistant text retained per turn for the closing check. */
const CLAIM_CHARS = 4000;
/**
 * Evidence entries retained per turn for the closing check.
 *
 * Entries are candidates, not conclusions: every observed result contributes its
 * tail summary, and a failure-marker line is kept as a safety floor. The
 * character budget (not this count) decides what the judgment reads.
 */
const MAX_EVIDENCE = 16;
/** Characters of one evidence line. */
const EVIDENCE_CHARS = 400;
/** Characters of one result's tail summary. */
const EVIDENCE_TAIL_CHARS = 240;
/** Characters of the "other" (non-diagnostic, non-tail) fallback per result. */
const EVIDENCE_OTHER_CHARS = 120;
/** Completion claim candidates submitted to one closing judgment. */
const MAX_CLAIMS = 3;
/** Minimum sentence length worth classifying as a claim candidate. */
const MIN_CLAIM_CHARS = 8;
/** Agent states retained before the least recently used is dropped. */
const MAX_AGENTS = 64;
/** Reductions memoized per activation, bounded by least recent use. */
const MAX_MEMO = 128;
/** Audit records retained for the panel, per activation. */
const MAX_RECENT = 20;
/** Longest corrective text this module hands to the model, in characters. */
const FEEDBACK_CHARS = 600;
/**
 * Line breaks a payload needs before it is treated as line-oriented output.
 *
 * A prune rewrites a *result* — command output, a test log, a build trace — and
 * the judgment is asked to extract the diagnostics from exactly that shape. A
 * payload with no line structure (one long JSON document, a single runaway
 * line) is not that shape: its value is semantic rather than diagnostic, and
 * cutting it in half would destroy it rather than compress it. Those payloads
 * are left alone, in both modes, and the skip is reported as
 * `unsupported-payload`.
 */
const PRUNE_MIN_LINES = 4;
/**
 * Largest payload this module is willing to copy into the session log.
 *
 * Retention is what makes a reduction safe, so the cap is a *precondition* of
 * pruning rather than a fallback: above it the engine reports
 * `retention-too-large` and leaves the result untouched, so an oversized
 * payload can never be reported as saved on the strength of a copy that was
 * never kept. A hundred kilobyte log line stays readable and bounded.
 */
const MAX_RETAINED_CHARS = 100_000;

/**
 * Matches the failure markers that make a result a *candidate* for the closing
 * evidence. A hit is a safety floor: the line is kept whatever the budget says.
 * A miss is never a "failure-free" conclusion — the tail summary goes to System
 * One, which decides what the result means.
 */
export const FAILURE_MARKER = /(\berror\b|\berrors\b|\bfailed\b|\bfailure\b|\bfailures\b|\bfail\b|exit code [1-9]|\bnot ok\b|\bFAIL\b|\bexception\b|\btraceback\b)/i;

/**
 * Prefilter for a failure *suspicion* — the deterministic trigger that makes a
 * closing judgment worth buying. It is broader than {@link FAILURE_MARKER}
 * because `{ok:false}`, a timeout, and a Chinese error must reach System One
 * too; none of these decides anything by itself.
 */
const FAILURE_CUE = new RegExp(
  `${FAILURE_MARKER.source}|\\bok\\b\\s*[:=]\\s*false|"ok"\\s*:\\s*false|\\btimed?\\s*out\\b|\\btimeout\\b|`
    + '失败|错误|异常|超时|无法|未通过|仍有失败|还有失败|报错',
  'i'
);

/** The action names one plan may carry. */
export type InterventionAction =
  | 'deny-call'
  | 'prune-result'
  | 'corrective-feedback'
  | 'corrective-context'
  | 'steer-closing';

/**
 * One planned intervention, before the mode decides whether it is applied.
 *
 * The plan is the *same* object in observe and active mode; only the audit
 * record's `applied` differs. That is what lets a reader compare what a mode
 * measured with what it did.
 */
export interface InterventionPlan {
  capability: InterventionCapability;
  action: InterventionAction;
  reason: string;
  /** Text the active path hands to the model; never empty. */
  feedback: string;
  detail: {
    pattern?: string;
    confidence?: number;
    repeats?: number;
    digest?: string;
    floorApplied?: boolean;
    /** Whether the reduction was installed short of the floor's promised share. */
    floorMissed?: boolean;
    /** Whether a floor miss had to omit its locator marker to stay smaller. */
    markerOmitted?: boolean;
    turn?: number;
    step?: number;
    /** Which judging path produced the prune candidate. */
    judgePath?: 'segmented' | 'local' | 'fallback';
    /** Segments handed to System One by the prune judgment. */
    judgedSegments?: number;
    /** Segments beyond the per-request limit, kept deterministically instead. */
    unjudgedSegments?: number;
    /** Segments the composed candidate kept whole. */
    keptSegments?: number;
    /** Characters of the aggressive-budget candidate the judgment built. */
    aggressiveChars?: number;
    /** Characters of the balanced-budget candidate the judgment built. */
    balancedChars?: number;
    /** Characters of the conservative-budget candidate the judgment built. */
    conservativeChars?: number;
    /** Segments System One really scored, out of the judged ones. */
    scoredSegments?: number;
    /** Segments kept whole without a score (the unjudged safety margin). */
    autoKeptSegments?: number;
    /** Answers returned for a judged segment that carried no usable score. */
    unparsedScoreAnswers?: number;
    /** Characters of the payload the plan was about. */
    originalChars?: number;
    /** Characters of the candidate the plan would install. */
    candidateChars?: number;
    /** Why the segmented judge fell back to the local candidates, when it did. */
    fallbackReason?: string;
  };
}

/**
 * Prune-path facts an abandoned plan carries into its audit record.
 *
 * The engine computes these on the way to a decision — the payload's identity
 * and size up front, the judged path and segment counts once the service has
 * answered — so a skip can say *which* decision path was abandoned instead of
 * only that one was. Nothing here is recomputed for the audit; the values are
 * the ones the decision itself used.
 */
export interface InterventionSkipDetail {
  /** Payload identity, when a payload was the subject of the decision. */
  digest?: string;
  /** Characters of that payload. */
  originalChars?: number;
  /** Characters of the candidate the decision would have installed. */
  candidateChars?: number;
  /** Tokens of that payload, when already known. */
  originalTokens?: number;
  /** Tokens of that candidate, when already known. */
  candidateTokens?: number;
  /** Whether the installed text carried the floor form (`floored` in the audit). */
  floored?: boolean;
  /** Whether the installed reduction fell short of the floor's promised share. */
  floorMissed?: boolean;
  /** Whether a floor miss had to omit its locator marker to stay smaller. */
  markerOmitted?: boolean;
  /** Which judging path produced the candidate. */
  judgePath?: 'segmented' | 'local' | 'fallback';
  /** Segments handed to System One by the judgment. */
  judgedSegments?: number;
  /** Segments beyond the per-request limit, kept deterministically instead. */
  unjudgedSegments?: number;
  /** Segments the candidate kept whole. */
  keptSegments?: number;
  /** Characters of the aggressive-budget candidate the judgment built. */
  aggressiveChars?: number;
  /** Characters of the balanced-budget candidate the judgment built. */
  balancedChars?: number;
  /** Characters of the conservative-budget candidate the judgment built. */
  conservativeChars?: number;
  /** Segments System One really scored, out of the judged ones. */
  scoredSegments?: number;
  /** Segments kept whole without a score (the unjudged safety margin). */
  autoKeptSegments?: number;
  /** Answers returned for a judged segment that carried no usable score. */
  unparsedScoreAnswers?: number;
  /** Why the segmented judge fell back to the local candidates. */
  fallbackReason?: string;
}

/** What one abandoned plan tells the audit sink about itself. */
interface SkipContext {
  /** Capability whose plan was abandoned. */
  capability: InterventionCapability;
  /** The deciding agent's bookkeeping, when the hook had it. */
  state?: AgentState;
  /** The agent (or payload carrying one) whose session receives the record. */
  agent?: unknown;
  /** Prune-path facts, when a payload was involved. */
  detail?: InterventionSkipDetail;
  /** The judgment this decision rode on, so a paid skip is not booked as free. */
  judgment?: JudgmentCharge;
}

/**
 * The identity of one tool call, stable across its pre- and post-execute hooks.
 * @param exec - the execution.
 * @returns the call's own identity, falling back to its name.
 */
function callKeyOf(exec: ToolExecution): string {
  const token = (exec as { token?: unknown }).token;
  if (typeof token === 'string' && token.length > 0) return token;
  const callId = (exec as { callId?: unknown }).callId;
  return typeof callId === 'string' && callId.length > 0 ? callId : exec.name;
}

/**
 * The Host's background-job *query* tools, and the call shape each one needs
 * before it counts as a legitimate wait.
 *
 * This is the documented default of the stagnation exemption, and it is
 * deliberately identity-based rather than wording-based: the keys are the names
 * the DSH Host itself registers for background jobs — `@deepseek-ai/dsh-tool-jobs`
 * registers `job_output`, `job_list`, and `job_kill`, and the background modes
 * of the shell tools hand their jobs to the same `job_output` verb. The
 * tool's *description* is never parsed, and no result text is ever read, so an
 * output that happens to contain `wait`, `sleep`, or `poll` earns nothing.
 *
 * The shape is the structured job handle the call is about, in the Host's own
 * declared parameter name (`job_id`). `job_list` declares no parameters at all —
 * it lists the caller's own jobs — so its shape is the empty argument object.
 * `job_kill` is deliberately absent: it is a terminating action, not a query a
 * waiting run repeats, and a run that repeats it is not waiting for anything.
 */
export const WAIT_QUERY_TOOLS: Readonly<Record<string, { handles: readonly string[]; argumentless?: boolean }>> = {
  job_output: { handles: ['job_id'] },
  job_list: { handles: [], argumentless: true }
};

/**
 * One call's arguments as a plain object, or `undefined` when they are not one.
 * @param exec - the execution.
 * @returns the argument object, never an array or a primitive.
 */
function structuredArguments(exec: ToolExecution): Record<string, unknown> | undefined {
  const raw: unknown = exec.arguments;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Whether one call is a legitimate wait rather than a candidate repetition.
 *
 * Two structured facts decide it, and nothing else: the tool's identity in
 * {@link WAIT_QUERY_TOOLS}, and the argument shape that identity requires — a
 * non-empty job handle in a string field the Host itself declares. A call that
 * repeats the same handle is exactly the sanctioned poll of a background job, so
 * its repetition carries no information about progress, while any other tool
 * (however its output reads) is judged as before.
 *
 * @param exec - the call about to run.
 * @returns whether the call is a wait query.
 */
export function isWaitQuery(exec: ToolExecution): boolean {
  const shape = WAIT_QUERY_TOOLS[exec.name];
  if (!shape) return false;
  const args = structuredArguments(exec);
  if (!args) return false;
  if (shape.argumentless === true) return Object.keys(args).length === 0;
  return shape.handles.some((field) => typeof args[field] === 'string' && (args[field] as string).length > 0);
}

/** Field names that name a background handle a status query is about. */
const POLL_HANDLE_FIELD = /(?:^|_)(?:job|task|run|process|pid|handle|call|query|poll|id)$/i;

/**
 * The argument shape that makes a *non-listed* repetition a wait suspect.
 *
 * The tool-name list is deliberately narrow (the Host's own job tools), but a
 * run can wait through another backend's poll verb. A non-empty handle-shaped
 * field is the cue that the repetition may be a status query; it only makes the
 * call worth asking about — System One still decides whether it is a wait.
 * @param exec - the call about to run.
 * @returns a shape label, or `undefined` when the arguments carry no handle.
 */
export function pollShapeOf(exec: ToolExecution): string | undefined {
  const args = structuredArguments(exec);
  if (!args) return undefined;
  for (const [key, value] of Object.entries(args)) {
    if (!POLL_HANDLE_FIELD.test(key)) continue;
    if (typeof value === 'string' && value.length > 0) return 'poll-handle';
    if (typeof value === 'number' && Number.isFinite(value)) return 'poll-handle';
  }
  return undefined;
}

/** A compact, bounded rendering of one call's arguments. */
function argumentShapeOf(exec: ToolExecution): string {
  const args = structuredArguments(exec);
  if (!args) return 'non-object';
  const entries = Object.entries(args).map(([key, value]) => {
    const rendered = value === null || typeof value !== 'object' ? clip(String(value), 60) : '…';
    return `${key}=${rendered}`;
  });
  return entries.length > 0 ? entries.join(', ') : 'empty';
}

/**
 * The context one wait question carries into the stagnation judgment.
 *
 * It is *context*, not a verdict: the tool name, the argument shape, and the
 * repeat count let System One tell a sanctioned wait from a no-progress loop,
 * and nothing here allows or refuses the call by itself.
 */
export function waitGoalOf(exec: ToolExecution, shape: string, repeats: number): string {
  return [
    `suspect: ${shape}`,
    `tool: ${exec.name}`,
    `argument-shape: ${argumentShapeOf(exec)}`,
    `repeats: ${repeats}`,
    'A repeated status/job query can be a legitimate wait for background work rather than a no-progress loop; decide from the action history and the polled outputs.'
  ].join('; ');
}

/**
 * Label each poll of one series with its place in it.
 *
 * The backend reasons about the run, not about string identity: two polls of the
 * same job are successive observations, and telling them apart keeps a
 * sanctioned wait from being read as the same action retried forever. Every
 * other step is passed through untouched.
 * @param steps - the window the question is about.
 * @param signature - identity of the poll being proposed.
 * @returns a copy with `[poll #n]` appended to each poll's input.
 */
export function annotateWaitHistory(steps: readonly ObservedStep[], signature: string): ObservedStep[] {
  let poll = 0;
  return steps.map((step) => {
    if (step.signature !== signature) return step;
    poll += 1;
    return { ...step, input: clip(`${step.input} [poll #${poll}]`, STEP_CHARS) };
  });
}

/** One step of one agent's detection window. */
interface ObservedStep {
  /** `tool:argumentsDigest` — the identity a repetition is measured on. */
  signature: string;
  tool: string;
  input: string;
  output: string;
  error: string;
  failed: boolean;
  turn: number;
  at: number;
  /** Whether the step was a legitimate wait query (see {@link isWaitQuery}). */
  wait?: boolean;
}

/**
 * The window a stagnation trigger and its judgment are measured on.
 *
 * A wait query is not progress the run can be repeating: an identically repeated
 * status/result query of the same background job is the sanctioned way to wait,
 * so those steps are dropped before the repetition, failure, and oscillation
 * triggers read the window. Genuine calls on either side of a wait stay adjacent
 * instead of being separated by it, which is what keeps a real loop visible
 * while a run is waiting.
 * @param steps - observed steps, oldest first.
 * @returns the steps that count as progress.
 */
function progressSteps(steps: readonly ObservedStep[]): readonly ObservedStep[] {
  return steps.some((step) => step.wait === true) ? steps.filter((step) => step.wait !== true) : steps;
}

/** One agent's detection state, budgets, and counters. */
interface AgentState {
  /** Session this agent's state belongs to; memoized reductions never cross it. */
  sessionKey: string;
  turn: number;
  step: number;
  steps: ObservedStep[];
  /** Assistant text of the current turn, for the closing check. */
  claims: string;
  /** Evidence candidates the current turn produced (see {@link EvidenceEntry}). */
  evidence: EvidenceEntry[];
  /** Whether any evidence candidate is a failure suspicion worth judging. */
  evidenceSuspect: boolean;
  /** Interventions applied in the current turn. */
  interventions: number;
  judgmentsTurn: number;
  judgmentsCount: number;
  judgmentsSession: number;
  verdictTurn: number;
  /** Identity of the window the cached verdict was about. */
  verdictKey: string;
  verdict?: StagnationCheckResponse;
  /** Wait-suspect call identities already classified this turn. */
  waited: Set<string>;
  /** Identities this turn already intervened on, so no action repeats itself. */
  applied: Set<string>;
  /** Call signatures already refused this turn. */
  denied: Set<string>;
  /** Calls this engine refused, keyed by the call identity. */
  refused: Set<string>;
}

/** One token and latency account of a mode or a capability. */
export interface InterventionCostBucket {
  /** Decisions planned. */
  plans: number;
  /** Decisions whose plan was executed. */
  applied: number;
  /** System 1 judgments paid for. */
  judgments: number;
  /** Judgments served from the per-turn verdict memo instead of a new call. */
  memoHits: number;
  /** Milliseconds spent in local, deterministic work. */
  localLatencyMs: number;
  /** Milliseconds spent waiting for System 1. */
  remoteLatencyMs: number;
  /** Tokens the judgments reasoned about. */
  judgeTokens: number;
  /** Tokens of the payloads decisions were made about. */
  originalTokens: number;
  /** Tokens the candidates would carry. */
  candidateTokens: number;
  /** Tokens the candidates would have saved. */
  potentialSavedTokens: number;
  /** Tokens actually removed from the model-visible surface. */
  actualSavedTokens: number;
  /** Tokens actually added to the model-visible surface. */
  injectedTokens: number;
}

/** The baseline side of the accounting: what the hooks were shown, untouched. */
export interface InterventionBaseline {
  /** Results the post-execute hook was shown. */
  results: number;
  /** Tokens those results carried. */
  originalTokens: number;
  /** Failing results the post-execute hook was shown. */
  failures: number;
}

/** One activation's intervention accounting, as the panel and tests read it. */
export interface InterventionReport {
  mode: InterventionMode;
  capabilities: Record<InterventionCapability, InterventionMode>;
  baseline: InterventionBaseline;
  observe: InterventionCostBucket;
  active: InterventionCostBucket;
  byCapability: Record<InterventionCapability, InterventionCostBucket>;
  /** Hook-level refusals, by reason, sorted. */
  skips: Record<string, number>;
  /** The most recent decisions, oldest first, bounded. */
  recent: InterventionAuditRecord[];
  /**
   * Originals this activation retained before replacing them.
   *
   * `copies` counts every verified retention; `locators` keeps the most recent
   * ones, so a reader can resolve a live replacement back to its bytes without
   * scanning the whole log.
   */
  retained: { copies: number; locators: string[] };
  /**
   * Closing-evidence bytes kept vs. dropped by the character budget.
   *
   * Truncation is by priority (diagnostic lines, then tail summaries, then the
   * rest); a diagnostic floor line is never dropped, so a nonzero `truncatedChars`
   * describes tail/other material only.
   */
  evidence: { retainedChars: number; truncatedChars: number };
}

/** Dependencies of one intervention engine. */
export interface InterventionEngineOptions {
  /** Resolved `interventions` block. */
  config: ResolvedInterventionsConfig;
  /** Character threshold above which a result is a pruning candidate. */
  pruneThreshold: number;
  stagnation: Pick<StagnationDetector, 'check'>;
  prune: Pick<ToolResultPruner, 'prune'>;
  /** Verification plus the closing-claim classification that precedes it. */
  gate: Pick<ReflexGateService, 'verify' | 'classifyClaims'>;
  /** Names of this plugin's own tools: their output is already optimized. */
  ownTools?: readonly string[];
  /** Clock seam. */
  now?: () => number;
  /**
   * Controlled retention of a payload a reduction is about to replace.
   *
   * Mandatory for pruning: the engine asks the sink to keep the original, and
   * only a *verifiable* copy — the locator the replacement will publish — makes
   * the reduction installable. A sink that returns `undefined`, throws, or is not
   * configured at all leaves the result untouched and the saving at zero, so a
   * deployment without controlled retention still runs, it just does not prune.
   */
  retain?: (session: unknown, request: PruneRetentionRequest) => PruneRetention | undefined;
  /** Audit sink; the plugin attaches the session log here. */
  audit?: (record: InterventionAuditRecord, session: unknown) => void;
}

/** A fresh, zeroed cost bucket. */
function emptyBucket(): InterventionCostBucket {
  return {
    plans: 0,
    applied: 0,
    judgments: 0,
    memoHits: 0,
    localLatencyMs: 0,
    remoteLatencyMs: 0,
    judgeTokens: 0,
    originalTokens: 0,
    candidateTokens: 0,
    potentialSavedTokens: 0,
    actualSavedTokens: 0,
    injectedTokens: 0
  };
}

/**
 * The payload half of a prune decision's audit fields.
 *
 * Taken before the service is asked, so a branch that refuses the payload early
 * still names the payload it refused. An empty payload has no identity worth
 * recording.
 * @param text - the effective text the decision is about.
 * @returns the digest and size of that text, or nothing for an empty payload.
 */
function prunePayloadDetail(text: string): InterventionSkipDetail {
  return text.length === 0 ? {} : { digest: digestOf(text), originalChars: text.length };
}

/**
 * The judgment-path half of a prune decision's audit fields.
 *
 * Pure pass-through of what the prune service computed: which path produced the
 * candidate, how many segments it judged, and why it fell back when it did.
 * @param response - the service's answer.
 * @returns the diagnostics it reported.
 */
function pruneDiagnosticsOf(response: PruneResponse): InterventionSkipDetail {
  return {
    ...(response.judgePath === undefined ? {} : { judgePath: response.judgePath }),
    ...(response.judgedSegments === undefined ? {} : { judgedSegments: response.judgedSegments }),
    ...(response.unjudgedSegments === undefined ? {} : { unjudgedSegments: response.unjudgedSegments }),
    ...(response.keptSegments === undefined ? {} : { keptSegments: response.keptSegments }),
    ...(response.aggressiveChars === undefined ? {} : { aggressiveChars: response.aggressiveChars }),
    ...(response.balancedChars === undefined ? {} : { balancedChars: response.balancedChars }),
    ...(response.conservativeChars === undefined ? {} : { conservativeChars: response.conservativeChars }),
    ...(response.scoredSegments === undefined ? {} : { scoredSegments: response.scoredSegments }),
    ...(response.autoKeptSegments === undefined ? {} : { autoKeptSegments: response.autoKeptSegments }),
    ...(response.unparsedScoreAnswers === undefined ? {} : { unparsedScoreAnswers: response.unparsedScoreAnswers }),
    ...(response.fallbackReason === undefined ? {} : { fallbackReason: response.fallbackReason })
  };
}

/**
 * Tokens one text costs, at the ledger's shared four-characters-per-token rate.
 * @param text - any text.
 * @returns the estimated token count.
 */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/**
 * Stable short digest of one value, used as a tool-call identity.
 * @param value - the text to digest.
 * @returns sixteen hexadecimal characters.
 */
export function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Concatenate the text blocks of one content list.
 * @param content - message or result content.
 * @returns the text, in block order.
 */
export function textOfContent(content: readonly ContentBlock[] | undefined): string {
  if (!content) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      parts.push((block as { text?: string }).text ?? '');
    }
  }
  return parts.join('\n');
}

/**
 * Whether one content list carries at least one text block.
 * @param content - message or result content.
 * @returns whether there is text to rewrite.
 */
export function hasTextBlock(content: readonly ContentBlock[] | undefined): boolean {
  if (!content) return false;
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') return true;
  }
  return false;
}

/**
 * Bound one text to a character budget, marking the cut.
 * @param text - any text.
 * @param max - maximum characters to keep.
 * @returns the bounded text.
 */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ── what counts as a failed result ──────────────────────────────────────────

/**
 * The exit status one tool result carries in its own canonical value.
 *
 * A shell result is *reported*, not errored: a command that exits 1 returns a
 * successful `ToolExecutionResult` whose `value.exitCode` is the whole truth. The
 * distinction matters twice over — a correction that never fires because the
 * failure looked like a success, and a closing check that reads a green claim
 * over a red build — so the status is taken from the tool's own structured field
 * whenever the payload exposes one.
 *
 * @param value - the result's canonical value, when it has one.
 * @returns the exit status, or `undefined` when the value is not a shell result.
 */
export function structuredExitStatus(value: unknown): { exitCode: number; signal?: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { exitCode?: unknown; signal?: unknown };
  if (typeof candidate.exitCode !== 'number' || !Number.isFinite(candidate.exitCode)) return undefined;
  const status: { exitCode: number; signal?: string } = { exitCode: candidate.exitCode };
  if (typeof candidate.signal === 'string') status.signal = candidate.signal;
  return status;
}

/**
 * Whether the text ends in the Host's own exit marker for a failed command.
 *
 * The marker is the last line of the model-facing content, so anchoring it to the
 * end of the text keeps an *ordinary* result that merely mentions "exit code 1"
 * in its body from being misread as a failure. This is the fallback for a result
 * that carries no structured value — a Virtual tool, a replay from an older
 * record — not a replacement for {@link structuredExitStatus}.
 * @param text - the model-facing text.
 * @returns whether the last marker line reports a non-zero exit or a signal.
 */
export function exitMarkerFailure(text: string): boolean {
  const match = /(?:^|\n)\[exit code: ([0-9]+)\]\s*$/.exec(text);
  if (match) return Number(match[1]) !== 0;
  return /(?:^|\n)\[killed by signal: [^\]\n]+\]\s*$/.test(text);
}

/**
 * Whether one result is a failure the interventions may act on.
 *
 * Three sources, in order of authority: the Host's own `isError` flag, the exit
 * status inside the tool's structured value, and the exit marker the Host appends
 * to the text. A text heuristic over words like "failed" is deliberately absent:
 * a test log that prints the word is not a failing command, and treating it as
 * one would both spend a judgment on it and block a legitimate retry.
 *
 * @param result - the execution-local result.
 * @param text - the effective model-facing text of that result.
 * @returns whether the result proves a failure.
 */
export function failureOf(result: Readonly<ToolExecutionResult> | undefined, text: string): boolean {
  if (!result) return false;
  if (result.isError === true) return true;
  const status = structuredExitStatus((result as { value?: unknown }).value);
  if (status) return status.exitCode !== 0 || status.signal !== undefined;
  return exitMarkerFailure(text);
}

/**
 * Priority of one closing-evidence candidate when the budget truncates.
 *
 * `diagnostic` lines are the safety floor: a FAILURE_MARKER hit is kept even
 * past the budget. `tail` summaries carry the structured/status facts of every
 * observed result (so `{ok:false}`, a timeout, or a Chinese error reaches System
 * One). `other` is the head fallback, dropped first.
 */
export type EvidencePriority = 'diagnostic' | 'tail' | 'other';

/** One candidate the closing judgment may read. */
export interface EvidenceEntry {
  /** Tool that produced the result. */
  tool: string;
  /** Bounded line or summary. */
  text: string;
  /** Truncation priority (lower is safer). */
  priority: EvidencePriority;
  /** Whether the result behind this entry is a failure suspicion. */
  suspect: boolean;
}

/** The primitive structured facts one result exposes, for the tail summary. */
function structuredFacts(
  result: Readonly<ToolExecutionResult> | undefined
): Record<string, string | number | boolean> {
  const facts: Record<string, string | number | boolean> = {};
  if (!result) return facts;
  if (result.isError !== undefined) facts.isError = result.isError === true;
  const status = structuredExitStatus((result as { value?: unknown }).value);
  if (status) {
    facts.exitCode = status.exitCode;
    if (status.signal !== undefined) facts.signal = status.signal;
  }
  let value: unknown = (result as { value?: unknown }).value;
  if (typeof value === 'string' && /^\s*[{[]/.test(value)) {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ['ok', 'status', 'timedOut', 'timeout', 'isError', 'exitCode', 'signal']) {
      const field = record[key];
      if (typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean') facts[key] = field;
    }
  }
  return facts;
}

/** Whether structured facts alone prove (or at least suspect) a failure. */
function factsSuspectFailure(facts: Readonly<Record<string, string | number | boolean>>): boolean {
  if (facts.isError === true) return true;
  if (typeof facts.exitCode === 'number' && facts.exitCode !== 0) return true;
  if (typeof facts.signal === 'string' && facts.signal.length > 0) return true;
  if (facts.ok === false || facts.timedOut === true || facts.timeout === true) return true;
  if (typeof facts.status === 'string' && /fail|error|timeout|timed_?out/i.test(facts.status)) return true;
  return false;
}

/**
 * Turn one observed result into closing-evidence candidates.
 *
 * The regex is a prefilter and a floor, never a conclusion: matching lines are
 * kept whatever else happens, and a non-matching result still contributes its
 * tail summary (with the structured facts) to System One. A result is a failure
 * *suspicion* when a structured fact, a marker line, or a broader cue says so;
 * what the result really means is decided by `gate.verify`.
 *
 * @param tool - tool name that produced the result.
 * @param result - the execution-local result.
 * @param text - the effective model-facing text.
 * @returns bounded candidates, diagnostics first.
 */
export function evidenceOf(
  tool: string,
  result: Readonly<ToolExecutionResult> | undefined,
  text: string
): EvidenceEntry[] {
  const entries: EvidenceEntry[] = [];
  const lines = text.split(/\r?\n/);
  const diagnostics = lines.filter((line) => FAILURE_MARKER.test(line));
  for (const line of diagnostics) {
    const clipped = clip(line.trim(), EVIDENCE_CHARS);
    if (clipped.length > 0) entries.push({ tool, text: clipped, priority: 'diagnostic', suspect: true });
  }
  const facts = structuredFacts(result);
  const factText = Object.keys(facts).length > 0 ? `{${JSON.stringify(facts)}} ` : '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const tail = clip(`${factText}${collapsed}`, EVIDENCE_TAIL_CHARS);
  if (tail.length > 0) {
    entries.push({
      tool,
      text: `${tool} tail: ${tail}`,
      priority: 'tail',
      suspect:
        failureOf(result, text)
        || diagnostics.length > 0
        || factsSuspectFailure(facts)
        || FAILURE_CUE.test(text)
    });
  }
  if (diagnostics.length === 0) {
    const head = clip(collapsed, EVIDENCE_OTHER_CHARS);
    if (head.length > 0) {
      entries.push({ tool, text: `${tool}: ${head}`, priority: 'other', suspect: FAILURE_CUE.test(text) });
    }
  }
  return entries;
}

/**
 * Assemble the turn's evidence candidates into one budgeted string.
 *
 * Priority order is diagnostic → tail → other. A diagnostic line is the safety
 * floor and is never dropped; everything else competes for the budget and the
 * dropped characters are reported so the truncation is auditable.
 *
 * @param entries - candidates, oldest first.
 * @param budget - character budget of the assembled text.
 * @returns assembled text plus the kept/dropped character counts.
 */
export function assembleEvidence(
  entries: readonly EvidenceEntry[],
  budget: number
): { text: string; retainedChars: number; truncatedChars: number } {
  const lines: string[] = [];
  let retained = 0;
  let truncated = 0;
  for (const priority of ['diagnostic', 'tail', 'other'] as const) {
    for (const entry of entries) {
      if (entry.priority !== priority) continue;
      const size = entry.text.length + (lines.length > 0 ? 1 : 0);
      const fits = priority === 'diagnostic' || retained + size <= budget;
      if (!fits) {
        truncated += size;
        continue;
      }
      lines.push(entry.text);
      retained += size;
    }
  }
  return { text: lines.join('\n'), retainedChars: retained, truncatedChars: truncated };
}

/**
 * The floor decision of one reduction, computed from lengths alone.
 *
 * {@link pruneFloorPlan} returns the *decision*: whether the floor applies and
 * the size that decision was modelled on. {@link applyPruneFloor} returns the
 * same decision next to the size the composed text *really* has, because line
 * alignment and duplicate removal move that size. Callers account for the text
 * a mode really installs, so the composed numbers are the authoritative ones.
 */
export interface PruneFloorPlan {
  /** Whether the floor form replaces the judged candidate. */
  floored: boolean;
  /**
   * Whether the installed reduction fell short of the floor's promised share.
   *
   * True exactly when the composition could not build a form that both carries
   * `floorRatio` of the original and stays smaller than it, so the judged
   * candidate itself was installed. It is what separates "nothing was reduced"
   * from "the reduction was real, but it did not reach the floor's promise"; a
   * plan that never needed the floor reports `false`.
   */
  floorMissed: boolean;
  /** Characters the installed text carries: modelled by the plan, real once composed. */
  resultChars: number;
  /** Characters the installed form does not carry. */
  omittedChars: number;
  /** Context characters taken from the head of the original. */
  headChars: number;
  /** Context characters taken from the tail of the original. */
  tailChars: number;
  /**
   * Marker characters the installed form carries, summed over its sides.
   *
   * Zero when nothing is floored, one marker when only the mandatory locator side
   * fits, two when the share's budget can pay for a matching marker after the
   * candidate. Publishing it is what lets {@link applyPruneFloor} rebuild exactly
   * the form whose size the plan promised.
   */
  markerChars: number;
  /**
   * Whether a floor-missed install wanted the locator marker but could not carry it.
   *
   * The marker is what tells a reader that the reduction happened and where the
   * full payload lives, so a candidate that fits only *without* it is still
   * installed — the reduction is real — but the omission is recorded instead of
   * being silently dropped. Always `false` when `floorMissed` is false.
   */
  markerOmitted: boolean;
}

/** The floor options shared by the plan and the composition. */
export interface PruneFloorOptions {
  /** Lowest share of the original a reduction may keep. */
  floorRatio: number;
  /** Default split of the context budget, in characters. */
  headChars?: number;
  /** Default split of the context budget, in characters. */
  tailChars?: number;
  /**
   * Length of the marker the installed form carries per side.
   *
   * A caller that composes a locator-carrying form passes the real marker
   * length here; a caller that only accounts for it passes the same number. That
   * is what keeps the predicted size and the installed size identical in both
   * modes.
   */
  markerChars?: number;
}

/**
 * Decide the deterministic floor of one reduction from lengths alone.
 *
 * Lengths are enough because the floor form is fixed: context, marker, candidate,
 * marker, context. Deciding it this way is what lets `observe` account for the
 * *same* candidate `active` would install without building it.
 *
 * The floor is a *share*, not a suggestion. `pruneFloorRatio` says how much of
 * the original must survive, so the context budget is derived from it rather than
 * capped by the head/tail hints: a candidate that keeps 8% of a long payload is
 * not "floored" to 8% plus two small slices, it is widened until the installed
 * form really carries the promised share. The head/tail hints only decide how
 * that budget is split. A plan that cannot reach the share — because the marker
 * alone would eat the whole allowance — is refused, so a reduction never grows
 * the context.
 *
 * @param originalChars - length of the raw payload.
 * @param candidateChars - length of the judged candidate.
 * @param options - floor ratio, split hints, and marker length.
 * @returns the floor decision.
 */
export function pruneFloorPlan(
  originalChars: number,
  candidateChars: number,
  options: PruneFloorOptions
): PruneFloorPlan {
  if (candidateChars === 0 || candidateChars >= originalChars) {
    return idleFloorPlan(originalChars);
  }
  const marker = Math.max(0, options.markerChars ?? 0);
  const head = Math.max(0, options.headChars ?? FLOOR_HEAD_CHARS);
  const tail = Math.max(0, options.tailChars ?? FLOOR_TAIL_CHARS);
  const share = Math.min(1, Math.max(0, options.floorRatio));
  const target = Math.ceil(originalChars * share);
  // The judged candidate is already the installed text when the floor does not
  // apply, and it carries no marker; only a deeper cut pays for the marker.
  if (candidateChars >= target) {
    return {
      floored: false,
      floorMissed: false,
      resultChars: candidateChars,
      omittedChars: originalChars - candidateChars,
      headChars: 0,
      tailChars: 0,
      markerChars: 0,
      markerOmitted: false
    };
  }
  // One marker side is mandatory: it carries the locator of the original. The
  // second is bought only when the share's budget leaves room for it. A candidate
  // that cannot even pay for the mandatory marker is still a real reduction, so
  // it is installed *without* the marker and the omission is recorded: dropping
  // it would trade a smaller answer for the whole payload over a missing line.
  if (candidateChars + marker >= originalChars) {
    return {
      floored: false,
      floorMissed: true,
      resultChars: candidateChars,
      omittedChars: originalChars - candidateChars,
      headChars: 0,
      tailChars: 0,
      markerChars: 0,
      markerOmitted: true
    };
  }
  let budget = Math.max(candidateChars + marker, Math.min(originalChars, target));
  let markerChars = marker;
  let context = budget - candidateChars - markerChars;
  if (context >= marker) {
    markerChars += marker;
    context -= marker;
  }
  const split = splitContext(context, head, tail);
  const resultChars = candidateChars + markerChars + context;
  if (resultChars >= originalChars) return idleFloorPlan(originalChars);
  return {
    floored: true,
    floorMissed: false,
    resultChars,
    omittedChars: originalChars - resultChars,
    headChars: split.head,
    tailChars: split.tail,
    markerChars,
    markerOmitted: false
  };
}

/**
 * Split one context budget between the head and the tail.
 *
 * The hints describe the *shape* of the context, not its ceiling, so a large
 * budget keeps their proportion instead of stopping at their sum. A zero-shaped
 * split degrades to an even one rather than dropping the context.
 * @param context - characters available for context.
 * @param head - head hint.
 * @param tail - tail hint.
 * @returns the two slice lengths, summing to the context.
 */
function splitContext(context: number, head: number, tail: number): { head: number; tail: number } {
  const total = head + tail;
  const headChars = total <= 0 ? Math.ceil(context / 2) : Math.ceil((context * head) / total);
  return { head: Math.min(context, headChars), tail: context - Math.min(context, headChars) };
}

/** The plan of a reduction that is not happening. */
function idleFloorPlan(originalChars: number): PruneFloorPlan {
  return {
    floored: false,
    floorMissed: false,
    resultChars: originalChars,
    omittedChars: 0,
    headChars: 0,
    tailChars: 0,
    markerChars: 0,
    markerOmitted: false
  };
}

/** The marker one floored reduction carries on each side of its candidate. */
export function pruneMarker(locator: string): string {
  return `\n… [reflex prune: full original retrievable as ${locator}] …\n`;
}

/**
 * The marker a floor-missed install appends after its candidate.
 *
 * The floored form opens with the marker because the head has just ended with a
 * newline. A candidate that already ends with one needs no blank line before the
 * marker, so only the leading newline is dropped in that case; the trailing
 * newline is the same one the floored form carries.
 * @param candidate - the judged candidate about to be installed.
 * @param marker - the locator marker.
 * @returns the suffix to append.
 */
function pruneMarkerSuffix(candidate: string, marker: string): string {
  return candidate.endsWith('\n') ? marker.slice(1) : marker;
}

/** Split one payload into whole lines, the terminator kept with its line. */
function floorLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** The identity of one line for the duplicate test: its text without its terminator. */
function floorLineIdentity(line: string): string {
  return line.replace(/\r?\n$/, '').replace(/\r$/, '');
}

/**
 * How many whole lines of the head a budget can pay for.
 *
 * The head never crosses its budget and never stops inside a line: a cut that
 * cannot pay for the next line stops before it, so the kept prefix is always a
 * run of complete lines.
 * @param lines - the payload, split into whole lines.
 * @param budget - characters the head may spend.
 * @returns the number of lines to keep from the top.
 */
function alignedHeadLines(lines: readonly string[], budget: number): number {
  let used = 0;
  let count = 0;
  for (const line of lines) {
    if (used + line.length > budget) break;
    used += line.length;
    count += 1;
  }
  return count;
}

/**
 * How many whole lines of the tail a budget needs.
 *
 * The tail is the *shortest* run of complete lines from the end that still
 * carries the budget. A payload whose lines are longer than the budget cannot
 * honour it with a line-aligned suffix; the caller refuses instead of cutting
 * one, because half a line is not a shorter answer but a broken one.
 * @param lines - the payload, split into whole lines.
 * @param budget - characters the tail must carry.
 * @returns the number of lines to keep from the bottom.
 */
function alignedTailLines(lines: readonly string[], budget: number): number {
  if (budget <= 0) return 0;
  let used = 0;
  let count = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    used += lines[index]!.length;
    count += 1;
    if (used >= budget) break;
  }
  return count;
}

/**
 * Drop the candidate lines the kept context already shows verbatim.
 *
 * The judgment reads the whole payload, so its extract repeats the lines a
 * reader can already see around it — `BEGIN`, `RESULT`, `END` in the trace that
 * prompted this. Repeating them is pure cost: the same line twice in one
 * message. Removal is per line and verbatim, so a diagnostic the context does
 * *not* carry always survives.
 * @param candidate - the judged extract.
 * @param head - the kept head.
 * @param tail - the kept tail.
 * @returns the candidate without the lines the context already shows.
 */
function dedupeCandidateLines(candidate: string, head: string, tail: string): string {
  const seen = new Set([...floorLines(head), ...floorLines(tail)].map(floorLineIdentity));
  const lines = floorLines(candidate);
  if (seen.size === 0 || lines.length === 0) return candidate;
  return lines.filter((line) => !seen.has(floorLineIdentity(line))).join('');
}

/** One composed floor form and the sizes it really kept. */
interface ComposedFloor {
  text: string;
  headChars: number;
  tailChars: number;
  markerChars: number;
}

/**
 * Compose one floored form out of whole lines of the original.
 * @param lines - the original, split into whole lines.
 * @param headCount - lines kept from the top.
 * @param tailCount - lines kept from the bottom.
 * @param candidate - the judged extract.
 * @param marker - the locator marker.
 * @param secondMarker - the closing marker, or `''` when the share cannot pay for it.
 * @returns the installed text and the sizes it really carries.
 */
function composeFloorLines(
  lines: readonly string[],
  headCount: number,
  tailCount: number,
  candidate: string,
  marker: string,
  secondMarker: string
): ComposedFloor {
  const head = lines.slice(0, headCount).join('');
  const tail = tailCount === 0 ? '' : lines.slice(lines.length - tailCount).join('');
  const middle = dedupeCandidateLines(candidate, head, tail);
  // The marker opens with a newline so it sits on its own line after the head.
  // With no head there is nothing to separate it from, and a leading blank line
  // would be the first thing a reader sees.
  const lead = head.length === 0 ? marker.replace(/^\n/, '') : marker;
  const closing = middle.length === 0 ? '' : secondMarker;
  return {
    text: `${head}${lead}${middle}${closing}${tail}`,
    headChars: head.length,
    tailChars: tail.length,
    markerChars: lead.length + closing.length
  };
}

/**
 * The plan of a floor the composition refused.
 *
 * A refusal is *not* a reason to throw the candidate away. The candidate is the
 * reduction the judgment already produced, and a floor that cannot widen it
 * without either breaking the share or growing past the original has simply
 * missed the floor, not invalidated the reduction: installing the candidate is
 * strictly better than carrying the whole payload. So the candidate is installed
 * with `floored: false` (no head/tail form was built) and `floorMissed: true`
 * (the promised share is not carried), and the sizes are booked against the text
 * that is really installed.
 *
 * The locator marker is appended when the candidate can still pay for it, so the
 * reader sees that a prune happened and where the full payload lives. When the
 * marker would push the install to the original's size or past it, the reduction
 * wins and the marker is omitted — recorded as `markerOmitted: true`, never
 * silently dropped.
 *
 * Only a candidate that is not actually smaller leaves the original untouched —
 * that is a real "no reduction", and the caller's own degradation path owns it.
 *
 * @param original - the raw payload.
 * @param candidate - the judged reduction the composition could not widen.
 * @param marker - the locator marker a floor-missed install wants to carry.
 * @returns the text to install and the floor decision that says why.
 */
function refusedFloor(original: string, candidate: string, marker: string): PruneFloorPlan & { text: string } {
  if (candidate.length >= original.length) {
    return { ...idleFloorPlan(original.length), text: original };
  }
  const suffix = pruneMarkerSuffix(candidate, marker);
  if (candidate.length + suffix.length < original.length) {
    return {
      floored: false,
      floorMissed: true,
      resultChars: candidate.length + suffix.length,
      omittedChars: original.length - candidate.length - suffix.length,
      headChars: 0,
      tailChars: 0,
      markerChars: suffix.length,
      markerOmitted: false,
      text: `${candidate}${suffix}`
    };
  }
  return {
    floored: false,
    floorMissed: true,
    resultChars: candidate.length,
    omittedChars: original.length - candidate.length,
    headChars: 0,
    tailChars: 0,
    markerChars: 0,
    markerOmitted: true,
    text: candidate
  };
}

/**
 * Enforce the deterministic floor of a judged reduction.
 *
 * The judgment proposes; this floor disposes. A candidate that cut deeper than
 * {@link ResolvedInterventionsConfig.pruneFloorRatio} of the original is replaced
 * by a form that keeps the head and the tail — the two places a compiler error, a
 * stack-trace summary, and a final result usually are — around the judgment's own
 * extract, with explicit markers that name where the full original was retained.
 * A candidate that is not actually smaller is refused outright, so a "reduction"
 * can never grow the context.
 *
 * The context is composed out of *whole lines* of the original, never out of
 * character slices: a cut that lands mid-line leaves the reader a fragment like
 * `=] progress 092`, which is not a shorter answer but a broken one. The head is
 * the longest run of complete lines its budget can pay for, the tail the shortest
 * run of complete lines that still carries its own, and any candidate line the
 * kept context already shows verbatim is dropped as a duplicate. Alignment and
 * removal move the real size, so the decision's modelled size is replaced here by
 * the size the text really has: a form that would fall short of the promised
 * share, or that would not be smaller than the original at all, is refused. A
 * refusal installs the judgment's own candidate with `floorMissed: true` rather
 * than the original — the candidate is a real reduction, and dropping it would
 * trade a smaller answer for the whole payload just because the floor form could
 * not be built.
 *
 * @param original - the raw payload.
 * @param candidate - the judged reduction.
 * @param options - floor options plus the locator the replacement publishes.
 * @returns the text to install, the floor decision, and the sizes involved.
 */
export function applyPruneFloor(
  original: string,
  candidate: string,
  options: PruneFloorOptions & { locator: string }
): PruneFloorPlan & { text: string } {
  const marker = pruneMarker(options.locator);
  const plan = pruneFloorPlan(original.length, candidate.length, { ...options, markerChars: marker.length });
  if (!plan.floored) {
    return { ...plan, text: plan.resultChars === candidate.length ? candidate : original };
  }
  const lines = floorLines(original);
  const share = Math.min(1, Math.max(0, options.floorRatio));
  const target = Math.ceil(original.length * share);
  const secondMarker = plan.markerChars > marker.length ? marker : '';
  let headCount = alignedHeadLines(lines, plan.headChars);
  if (headCount === 0 && plan.headChars > 0 && lines.length > 0) {
    // A first line longer than the head budget: taking it whole keeps a real line
    // where a cut could only produce a fragment. Whether the enlarged form is
    // installable at all is decided by the size checks below.
    headCount = 1;
  }
  let tailCount = alignedTailLines(lines, plan.tailChars);
  if (headCount + tailCount > lines.length) return refusedFloor(original, candidate, marker);
  let composed = composeFloorLines(lines, headCount, tailCount, candidate, marker, secondMarker);
  // The share is a promise, and rounding to a boundary or dropping duplicates can
  // fall short of it: widen by whole lines until the form really carries the
  // share. A payload with no room left is refused by the checks below, never
  // installed short.
  while (composed.text.length < target) {
    // Grow the smaller side first, so the two keep their configured proportion.
    const order = composed.headChars <= composed.tailChars ? [0, 1] : [1, 0];
    let grew = false;
    for (const side of order) {
      const nextHead = side === 0 ? headCount + 1 : headCount;
      const nextTail = side === 1 ? tailCount + 1 : tailCount;
      if (nextHead + nextTail > lines.length) continue;
      const next = composeFloorLines(lines, nextHead, nextTail, candidate, marker, secondMarker);
      if (next.text.length <= composed.text.length) continue;
      headCount = nextHead;
      tailCount = nextTail;
      composed = next;
      grew = true;
      break;
    }
    if (!grew) break;
  }
  if (composed.text.length >= original.length || composed.text.length < target) {
    return refusedFloor(original, candidate, marker);
  }
  return {
    ...plan,
    resultChars: composed.text.length,
    omittedChars: original.length - composed.text.length,
    headChars: composed.headChars,
    tailChars: composed.tailChars,
    markerChars: composed.markerChars,
    text: composed.text
  };
}

/**
 * Count the identical trailing repeats of one signature.
 * @param steps - observed steps, oldest first.
 * @param signature - the identity to count.
 * @returns the length of the trailing run of that signature.
 */
export function countTrailingRepeats(steps: readonly ObservedStep[], signature: string): number {
  let count = 0;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]!.signature !== signature) break;
    count += 1;
  }
  return count;
}

/**
 * Count the trailing consecutive failures.
 * @param steps - observed steps, oldest first.
 * @returns the length of the trailing run of failing steps.
 */
export function countTrailingFailures(steps: readonly ObservedStep[]): number {
  let count = 0;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (!steps[index]!.failed) break;
    count += 1;
  }
  return count;
}

/**
 * Whether the window's tail alternates between exactly two call identities.
 *
 * `A B A B` is the cheapest loop to miss and among the most wasteful to run:
 * neither call repeats consecutively, so a consecutive-repeat trigger never
 * fires.
 * @param steps - observed steps, oldest first.
 * @param window - how many trailing steps to inspect.
 * @returns whether the tail oscillates.
 */
export function detectOscillation(steps: readonly ObservedStep[], window: number): boolean {
  const tail = steps.slice(Math.max(0, steps.length - window));
  if (tail.length < 4) return false;
  const signatures = new Set(tail.map((step) => step.signature));
  if (signatures.size !== 2) return false;
  for (let index = 2; index < tail.length; index += 1) {
    if (tail[index]!.signature !== tail[index - 2]!.signature) return false;
  }
  return true;
}

/** Why a deterministic pre-trigger wants a judgment. */
export interface StagnationSuspicion {
  suspicious: boolean;
  /** The pattern the trigger suspects, before System 1 confirms it. */
  pattern?: 'repetition' | 'oscillation' | 'failing_retry';
  /** Human-readable trigger facts, for the audit record. */
  note: string;
  /** How many steps the pattern was measured on. */
  repeats: number;
}

/**
 * Decide, locally and deterministically, whether a judgment is worth spending.
 *
 * This is the cost gate of the whole module: the expensive path is a System 1
 * call, and it only opens when the *cheap* path already sees a pattern. A single
 * distinctive call is never judged, however large its output.
 *
 * @param steps - observed steps, oldest first.
 * @param options - thresholds, window, and the current call identity.
 * @returns the suspicion, with `suspicious: false` when nothing justifies a call.
 */
export function suspicionOf(
  steps: readonly ObservedStep[],
  options: { repeatThreshold: number; failureThreshold: number; window: number; signature: string }
): StagnationSuspicion {
  const window = steps.slice(Math.max(0, steps.length - options.window));
  const repeats = countTrailingRepeats(window, options.signature);
  if (repeats >= options.repeatThreshold) {
    return { suspicious: true, pattern: 'repetition', note: `identical call repeated ${repeats}x`, repeats };
  }
  const failures = countTrailingFailures(window);
  if (failures >= options.failureThreshold) {
    return { suspicious: true, pattern: 'failing_retry', note: `${failures} consecutive failing steps`, repeats: failures };
  }
  if (detectOscillation(window, options.window)) {
    return { suspicious: true, pattern: 'oscillation', note: `two calls alternating over ${window.length} steps`, repeats: window.length };
  }
  return { suspicious: false, note: 'no local pattern', repeats: 0 };
}

/** One memoized reduction, keyed by the payload's digest within one session. */
interface PruneMemo {
  /** The real reduction, absent until the mode that installs one has computed it. */
  text?: string;
  originalChars: number;
  prunedChars: number;
  tokensSaved: number;
  /** Whether the reduction was floored, so a memo hit reports the same plan. */
  floored: boolean;
  /** Whether the reduction missed the floor's promised share, replayed on a hit. */
  floorMissed?: boolean;
  /** Whether that miss installed without its locator marker, replayed on a hit. */
  markerOmitted?: boolean;
  /** Locator of the retained original, once a retention for this payload succeeded. */
  locator?: string;
  /**
   * Diagnostics of the judgment that composed this form.
   *
   * Replayed by a memo hit so its audit record keeps the provenance of the plan
   * that really judged the payload, instead of looking like a path that never
   * ran the judge. Observability only: no decision reads these back.
   */
  diagnostics?: Pick<
    PruneResponse,
    | 'judgePath'
    | 'judgedSegments'
    | 'unjudgedSegments'
    | 'keptSegments'
    | 'aggressiveChars'
    | 'balancedChars'
    | 'conservativeChars'
    | 'scoredSegments'
    | 'autoKeptSegments'
    | 'unparsedScoreAnswers'
    | 'fallbackReason'
  >;
}

/**
 * What the engine hands its retention sink before it replaces a payload.
 *
 * The request carries the payload *verbatim*, so a sink never has to reconstruct
 * it, and the digest, so the sink can name it the same way the judgment and the
 * replacement do.
 */
export interface PruneRetentionRequest {
  /** Payload identity: `digestOf(text)`. */
  digest: string;
  /** Identity and name of the call whose result is about to shrink. */
  callId: string;
  tool: string;
  /** Turn and step of the replacement. */
  turn: number;
  step: number;
  /** The replaced payload, verbatim. */
  text: string;
}

/** The controlled copy one retention produced. */
export interface PruneRetention {
  /** Locator the replacement publishes. */
  locator: string;
  /** Committed log position, when the sink can report one. */
  seq?: number;
}

/** What one judgment cost, charged exactly once per judgment. */
interface JudgmentCharge {
  judgments: number;
  memoHits: number;
  localLatencyMs: number;
  remoteLatencyMs: number;
  judgeTokens: number;
}

/** One charge against a mode's and a capability's account. */
interface Charge {
  judgments?: number;
  memoHits?: number;
  localLatencyMs?: number;
  remoteLatencyMs?: number;
  judgeTokens?: number;
  originalTokens?: number;
  candidateTokens?: number;
  potentialSavedTokens?: number;
  actualSavedTokens?: number;
  injectedTokens?: number;
}

/** The verdict that stands in when no judgment could be spent. */
const EMPTY_VERDICT: StagnationCheckResponse = { isStuck: false, confidence: 0, latencyMs: 0 };

/**
 * The automatic-intervention engine of one plugin activation.
 *
 * One instance serves every agent in the process; all per-agent facts live in
 * {@link AgentState}, keyed by agent id, so isolation is structural rather than
 * conventional.
 */
export class InterventionEngine {
  /** Resolved `interventions` block. */
  readonly config: ResolvedInterventionsConfig;
  readonly #pruneThreshold: number;
  readonly #stagnation: Pick<StagnationDetector, 'check'>;
  readonly #prune: Pick<ToolResultPruner, 'prune'>;
  readonly #gate: Pick<ReflexGateService, 'verify' | 'classifyClaims'>;
  readonly #now: () => number;
  readonly #retain?: (session: unknown, request: PruneRetentionRequest) => PruneRetention | undefined;
  readonly #audit?: (record: InterventionAuditRecord, session: unknown) => void;

  readonly #states = new Map<string, AgentState>();
  readonly #ownTools: ReadonlySet<string>;
  readonly #memo = new Map<string, PruneMemo>();
  readonly #costs: { observe: InterventionCostBucket; active: InterventionCostBucket };
  readonly #byCapability: Record<InterventionCapability, InterventionCostBucket>;
  readonly #baseline: InterventionBaseline = { results: 0, originalTokens: 0, failures: 0 };
  readonly #skips = new Map<string, number>();
  readonly #recent: InterventionAuditRecord[] = [];
  readonly #retained: string[] = [];
  readonly #evidenceStats = { retainedChars: 0, truncatedChars: 0 };
  #retainedCopies = 0;
  #counter = 0;

  /**
   * @param options - services, thresholds, clock, and audit sink.
   */
  constructor(options: InterventionEngineOptions) {
    this.config = options.config;
    this.#pruneThreshold = options.pruneThreshold;
    this.#stagnation = options.stagnation;
    this.#prune = options.prune;
    this.#gate = options.gate;
    this.#now = options.now ?? (() => Date.now());
    this.#retain = options.retain;
    this.#audit = options.audit;
    this.#ownTools = new Set(options.ownTools ?? []);
    this.#costs = { observe: emptyBucket(), active: emptyBucket() };
    this.#byCapability = {
      stagnation: emptyBucket(),
      prune: emptyBucket(),
      gate: emptyBucket(),
      closing: emptyBucket()
    };
  }

  /** Whether any capability may act at all. */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Effective mode of one capability.
   * @param capability - the capability to ask about.
   * @returns its resolved three-state mode.
   */
  modeOf(capability: InterventionCapability): InterventionMode {
    return this.config.capabilities[capability];
  }

  /**
   * Whether a hook serving one capability must be registered at all.
   * @param capabilities - capabilities the hook serves.
   * @returns whether at least one of them is not `off`.
   */
  serves(...capabilities: InterventionCapability[]): boolean {
    if (!this.config.enabled) return false;
    return capabilities.some((capability) => this.modeOf(capability) !== 'off');
  }

  /** The whole activation's accounting. */
  report(): InterventionReport {
    return {
      mode: this.config.mode,
      capabilities: { ...this.config.capabilities },
      baseline: { ...this.#baseline },
      observe: { ...this.#costs.observe },
      active: { ...this.#costs.active },
      byCapability: {
        stagnation: { ...this.#byCapability.stagnation },
        prune: { ...this.#byCapability.prune },
        gate: { ...this.#byCapability.gate },
        closing: { ...this.#byCapability.closing }
      },
      skips: Object.fromEntries([...this.#skips.entries()].sort()),
      recent: [...this.#recent],
      retained: { copies: this.#retainedCopies, locators: [...this.#retained] },
      evidence: { ...this.#evidenceStats }
    };
  }

  /**
   * Whether one capability already acted on one identity this turn.
   * @param agentId - agent identity.
   * @param key - capability-qualified identity.
   * @returns whether it already acted.
   */
  hasApplied(agentId: string, key: string): boolean {
    return this.#states.get(agentId)?.applied.has(key) ?? false;
  }

  /**
   * Detection state of one agent, for tests and diagnostics.
   * @param agentId - agent identity.
   * @returns the observable facts, or undefined for an agent never seen.
   */
  stateOf(
    agentId: string
  ): { turn: number; step: number; steps: number; interventions: number; judgmentsSession: number; claims: number; evidence: number } | undefined {
    const state = this.#states.get(agentId);
    if (!state) return undefined;
    return {
      turn: state.turn,
      step: state.step,
      steps: state.steps.length,
      interventions: state.interventions,
      judgmentsSession: state.judgmentsSession,
      claims: state.claims.length,
      evidence: state.evidence.length
    };
  }

  /**
   * Drop one agent's state — on disposal, so nothing outlives its session.
   * @param agentId - agent identity.
   */
  forget(agentId: string): void {
    this.#states.delete(agentId);
  }

  /** Drop every agent's state and every account, for a fresh measurement. */
  reset(): void {
    this.#states.clear();
    this.#memo.clear();
    this.#costs.observe = emptyBucket();
    this.#costs.active = emptyBucket();
    for (const capability of INTERVENTION_CAPABILITIES) this.#byCapability[capability] = emptyBucket();
    this.#baseline.results = 0;
    this.#baseline.originalTokens = 0;
    this.#baseline.failures = 0;
    this.#skips.clear();
    this.#recent.length = 0;
    this.#retained.length = 0;
    this.#retainedCopies = 0;
    this.#evidenceStats.retainedChars = 0;
    this.#evidenceStats.truncatedChars = 0;
  }

  // ── hook entry points ──────────────────────────────────────────────────────

  /**
   * `tools/pre-execute`: refuse a call the run is repeating.
   *
   * Delegates first and returns the downstream decision **by identity** whenever
   * that decision is not a plain `allow`. A later listener may already have sent
   * the call to an approval flow, denied it with its own structured error
   * identity, or cancelled it; overwriting any of those would drop information the
   * Host attached and could turn a stricter decision into a weaker one. The only
   * decision this hook ever *adds* is a `deny` on top of an `allow`, which is
   * strictly narrower than what the waterfall already permitted — permissions
   * here are monotone by construction, never escalated and never relaxed.
   *
   * @param exec - the tool call about to run.
   * @param next - the rest of the waterfall.
   * @returns the decision the Host dispatches on.
   */
  async toolCall(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    const downstream = await next();
    const capability = this.modeOf('stagnation');
    if (capability === 'off' || !this.config.enabled) return downstream;
    if (this.#ownTools.has(exec.name)) return downstream;
    if (exec.signal?.aborted) return downstream;

    let waitSuspected = false;
    const started = this.#now();
    try {
      const agentId = agentKeyOf(exec.agent);
      const state = this.#state(agentId, exec.agent);
      const signature = callSignature(exec);
      // The call about to run is part of its own window: three identical calls
      // are a repetition at the moment the third one is proposed, and the
      // judgment has to see all three. The pending entry is local — it is not
      // committed to the agent's history, which the result records for real.
      const pending = this.#observed(state, exec, signature);
      const allWindow = [...state.steps, pending];
      // Wait queries already in the window are dropped from the *progress*
      // trigger: they are not progress the run could be repeating, and keeping
      // them would both hide a real loop that waits between its attempts and
      // manufacture an oscillation out of two identical polls.
      const window = progressSteps(allWindow);
      const waitShape = isWaitQuery(exec) ? 'wait-query' : pollShapeOf(exec);
      // A wait-suspect call that this turn already classified is answered by
      // that verdict, not re-asked; anything else is only worth a question when
      // it actually repeats (the same threshold as any other repetition).
      if (waitShape !== undefined && state.waited.has(signature)) {
        this.#skip('wait-query', { capability: 'stagnation', state, agent: exec.agent });
        return downstream;
      }
      const priorSame = allWindow.filter((step) => step.signature === signature).length - 1;
      let suspicion = suspicionOf(window, {
        repeatThreshold: this.config.repeatThreshold,
        failureThreshold: this.config.failureThreshold,
        window: this.config.windowSize,
        signature
      });
      if (waitShape !== undefined && priorSame + 1 >= this.config.repeatThreshold) {
        // The tool list only decides that this repetition is worth asking
        // about; it does not pass or refuse anything by itself.
        suspicion = {
          suspicious: true,
          pattern: 'repetition',
          note: `wait-suspect ${waitShape} repeated ${priorSame + 1}x`,
          repeats: priorSame + 1
        };
        waitSuspected = true;
      }
      if (!suspicion.suspicious || state.denied.has(signature)) return downstream;
      if (state.applied.has(`stagnation:${signature}`)) {
        this.#skip('duplicate-intervention', { capability: 'stagnation', state, agent: exec.agent });
        return downstream;
      }
      if (!this.#actionWithinBudget(state)) {
        this.#skip('intervention-cap', { capability: 'stagnation', state, agent: exec.agent });
        return downstream;
      }

      // A wait question is judged on the polls themselves (each labelled with
      // its place in the series, so the backend can read a wait rather than an
      // exact repeat); every other question keeps the progress-only window.
      const judgeSteps = waitSuspected ? annotateWaitHistory(allWindow, signature) : window;
      const verdict = await this.#judge(
        state,
        exec.signal,
        judgeSteps,
        waitSuspected ? waitGoalOf(exec, waitShape ?? 'poll-shape', priorSame + 1) : undefined
      );
      const judgment = this.#judgmentCharge(verdict, started, this.#now());
      // Denial is latched per signature whether or not it was applied: in observe
      // mode the refusal is what would have happened, and `denied` is what keeps
      // the *next* identical attempt from being judged again in the same turn.
      state.denied.add(signature);
      if (!verdict.useful) {
        this.#charge('stagnation', judgment);
        if (waitSuspected) state.waited.add(signature);
        // A budget/abort skip keeps its own reason; only a real "not stuck"
        // answer to a wait question is recorded as the wait outcome.
        this.#skip(verdict.skip ?? (waitSuspected ? 'wait-query' : 'unconfirmed'), {
          capability: 'stagnation',
          state,
          agent: exec.agent,
          judgment
        });
        return downstream;
      }

      const plan: InterventionPlan = {
        capability: 'stagnation',
        action: 'deny-call',
        reason: `System 1 confirmed ${verdict.response.patternType ?? suspicion.pattern} stagnation before ${exec.name}`,
        feedback: this.#denyFeedback(exec.name, suspicion, verdict.response),
        detail: {
          pattern: String(verdict.response.patternType ?? suspicion.pattern ?? 'unknown'),
          confidence: verdict.response.confidence,
          repeats: suspicion.repeats,
          turn: state.turn,
          step: state.step
        }
      };
      const applied = capability === 'active' && downstream.kind === 'allow';
      if (capability === 'active' && !applied) {
        this.#skip('downstream-decided', { capability: 'stagnation', state, agent: exec.agent });
      }
      // The decision is latched in both modes. Observe has to plan exactly what
      // active would do — one refusal per episode, subject to the same turn cap —
      // otherwise its column would over-count the very thing it is measuring.
      state.refused.add(callKeyOf(exec));
      state.applied.add(`stagnation:${signature}`);
      this.#bookAction(state);
      this.#conclude(plan, applied, exec.agent, { potentialSavedTokens: 0 }, judgment);
      return applied ? { kind: 'deny', reason: plan.feedback } : downstream;
    } catch {
      // FAIL-OPEN: a planning failure must never veto a call the rest of the
      // waterfall already allowed. A wait whose judge could not answer is
      // reported with its own reason instead of the generic one.
      this.#skip(waitSuspected ? 'wait-query-unavailable' : 'planning-error', {
        capability: 'stagnation',
        agent: exec.agent
      });
      return downstream;
    }
  }

  /**
   * `tools/post-execute`: reduce an oversized result, or correct a repeated
   * failure — and observe both without touching either.
   *
   * @param exec - the call that produced the result.
   * @param result - its canonical outcome.
   * @param next - the rest of the waterfall.
   * @returns the decision the Host commits.
   */
  async toolResult(
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>
  ): Promise<PostToolDecision> {
    const downstream = await next();
    if (!this.config.enabled) return downstream;
    if (this.#ownTools.has(exec.name)) return downstream;
    const started = this.#now();
    try {
      const agentId = agentKeyOf(exec.agent);
      const state = this.#state(agentId, exec.agent);
      if (state.refused.has(callKeyOf(exec))) {
        // The result of a call this engine refused is the refusal itself. It is
        // neither evidence about the run nor a payload worth reducing, and
        // correcting it would bill one episode twice.
        this.#skip('refused-result', { capability: 'prune', state, agent: exec.agent });
        return downstream;
      }
      // The *effective* content: whatever the rest of the waterfall decided the
      // model will read, which is not the same thing as the result's own content.
      // An earlier listener may have replaced it, and the replacement is what this
      // hook must reason about and, in active mode, reduce.
      const content = 'content' in downstream && Array.isArray(downstream.content) ? downstream.content : result.content;
      const text = textOfContent(content);
      const failed = failureOf(result, text);
      const signature = callSignature(exec);
      this.#observe(state, {
        signature,
        tool: exec.name,
        input: clip(this.#argumentsOf(exec), STEP_CHARS),
        output: clip(text, STEP_CHARS),
        error: failed ? clip(this.#errorOf(result), STEP_CHARS) : '',
        failed,
        turn: state.turn,
        at: this.#now(),
        wait: isWaitQuery(exec)
      });

      this.#baseline.results += 1;
      this.#baseline.originalTokens += estimateTokens(text);
      if (failed) this.#baseline.failures += 1;

      // Every result contributes evidence candidates: a failure-marker line is
      // the safety floor, a tail summary carries the structured/status facts,
      // and the closing judgment — not a regex — decides what they mean.
      this.#rememberEvidence(state, exec.name, result, text, this.#errorOf(result));
      if (!failed) return await this.#pruneResult(exec, downstream, content, state, text, started);
      return await this.#correctFailure(exec, result, downstream, state, signature, started);
    } catch {
      // FAIL-OPEN: the result is handed on exactly as the waterfall produced it.
      this.#skip('planning-error', { capability: 'prune', agent: exec.agent });
      return downstream;
    }
  }

  /**
   * `agent/pre-step`: attach the correction to the step after the loop repeated
   * itself, and keep the turn and step bookkeeping every other hook shares.
   *
   * @param payload - the proposed step.
   * @param next - the rest of the waterfall.
   * @returns the decision the loop enters with.
   */
  async preStep(
    payload: { agent: unknown; messages: readonly UserMessage[]; turn: number; step: number; signal?: AbortSignal },
    next: () => Promise<PreStepDecision>
  ): Promise<PreStepDecision> {
    const downstream = await next();
    const started = this.#now();
    try {
      const agentId = agentKeyOf(payload.agent);
      const state = this.#state(agentId, payload.agent);
      // Turn bookkeeping is unconditional: the closing check needs the turn's own
      // words and evidence to exist even when stagnation is off.
      if (state.turn !== payload.turn) {
        state.turn = payload.turn;
        state.step = payload.step;
        state.interventions = 0;
        state.judgmentsCount = 0;
        state.judgmentsTurn = payload.turn;
        state.verdictTurn = payload.turn;
        state.verdictKey = '';
        state.verdict = undefined;
        state.claims = '';
        state.evidence = [];
        state.evidenceSuspect = false;
        state.waited.clear();
        state.applied.clear();
        state.denied.clear();
        state.refused.clear();
      }
      state.step = payload.step;

      const capability = this.modeOf('stagnation');
      if (capability === 'off' || !this.config.enabled) return downstream;
      if (payload.signal?.aborted || downstream.kind !== 'enter') return downstream;

      const last = state.steps[state.steps.length - 1];
      if (last === undefined) return downstream;
      // A poll that already passed the semantic wait judgment has nothing to
      // correct here: the run asked about a background job again, it did not
      // repeat its work. A poll this turn never judged was not a repetition, so
      // it is not a stagnation episode either.
      if (last.wait === true) {
        this.#skip(state.waited.has(last.signature) ? 'wait-query' : 'wait-query-unjudged', {
          capability: 'stagnation',
          state,
          agent: payload.agent
        });
        return downstream;
      }
      const signature = last.signature;
      if (state.applied.has(`stagnation:${signature}`)) {
        this.#skip('duplicate-intervention', { capability: 'stagnation', state, agent: payload.agent });
        return downstream;
      }
      if (!this.#actionWithinBudget(state)) {
        this.#skip('intervention-cap', { capability: 'stagnation', state, agent: payload.agent });
        return downstream;
      }
      // The same window the pre-execute trigger measures: waits are not progress
      // to count, so a real loop either side of them is still one loop.
      const window = progressSteps(state.steps);
      const suspicion = suspicionOf(window, {
        repeatThreshold: this.config.repeatThreshold,
        failureThreshold: this.config.failureThreshold,
        window: this.config.windowSize,
        signature
      });
      if (!suspicion.suspicious) return downstream;

      const verdict = await this.#judge(state, payload.signal, window);
      const judgment = this.#judgmentCharge(verdict, started, this.#now());
      if (!verdict.useful) {
        this.#charge('stagnation', judgment);
        this.#skip(verdict.skip ?? 'unconfirmed', {
          capability: 'stagnation',
          state,
          agent: payload.agent,
          judgment
        });
        return downstream;
      }

      const plan: InterventionPlan = {
        capability: 'stagnation',
        action: 'corrective-context',
        reason: `System 1 confirmed ${verdict.response.patternType ?? suspicion.pattern} stagnation before step ${payload.step}`,
        feedback: this.#contextFeedback(suspicion, verdict.response),
        detail: {
          pattern: String(verdict.response.patternType ?? suspicion.pattern ?? 'unknown'),
          confidence: verdict.response.confidence,
          repeats: suspicion.repeats,
          turn: state.turn,
          step: payload.step
        }
      };
      const applied = capability === 'active';
      // The latch is mode-independent on purpose. Observe has to consume the same
      // episode — one intervention per detected loop, one charge against the turn's
      // cap — or its accounting would describe a run nobody could reproduce;
      // installing the message is the only thing the mode gates.
      state.applied.add(`stagnation:${signature}`);
      this.#bookAction(state);
      this.#conclude(plan, applied, payload.agent, { potentialSavedTokens: 0 }, judgment);
      if (!applied) return downstream;
      return {
        ...downstream,
        messages: [...downstream.messages, this.#message(agentId, state.turn, payload.step, plan.feedback)]
      };
    } catch {
      // FAIL-OPEN: the step enters with exactly the messages it would have had.
      this.#skip('planning-error', { capability: 'stagnation', agent: payload.agent });
      return downstream;
    }
  }

  /**
   * `agent/turn-stopping`: object when the turn is about to close on evidence
   * that contradicts what the turn claims.
   *
   * The objection is *data*, not a veto: this method steers the corrective text
   * into the agent's inbox, and the loop's own rule decides. Steering is the only
   * way a listener may extend a turn, so a failure here can never block a turn
   * from closing.
   *
   * @param payload - the agent whose turn reached its stop boundary.
   */
  async turnStopping(payload: { agent: unknown; turn: number; signal?: AbortSignal }): Promise<void> {
    const capability = this.modeOf('closing');
    if (capability === 'off' || !this.config.enabled) return;
    const started = this.#now();
    try {
      const agentId = agentKeyOf(payload.agent);
      const state = this.#state(agentId, payload.agent);
      const claimsText = state.claims;
      // Two deterministic facts decide whether a closing judgment is worth
      // buying: the turn said something, and at least one result is a failure
      // suspicion. Neither fact concludes *which* sentence claims completion —
      // that is the System One question asked below.
      if (claimsText.length === 0 || !state.evidenceSuspect) return;
      const candidates = claimCandidates(claimsText);
      if (candidates.length === 0) return;
      if (state.applied.has(`closing:turn:${payload.turn}`)) {
        this.#skip('duplicate-intervention', { capability: 'closing', state, agent: payload.agent });
        return;
      }
      if (!this.#actionWithinBudget(state)) {
        this.#skip('intervention-cap', { capability: 'closing', state, agent: payload.agent });
        return;
      }
      if (payload.signal?.aborted) return;

      // Assemble what the judgment will read. Truncation is by priority and
      // never removes a failure-marker line; the amount dropped is reported.
      const assembled = assembleEvidence(state.evidence, this.config.closingEvidenceChars);
      this.#evidenceStats.retainedChars += assembled.retainedChars;
      this.#evidenceStats.truncatedChars += assembled.truncatedChars;
      if (assembled.truncatedChars > 0) {
        this.#skip('evidence-truncated', { capability: 'closing', state, agent: payload.agent });
      }

      // The closing classification is a judgment like any other: one request
      // with at most MAX_CLAIMS scored questions, bought from the same turn and
      // session budget as a stagnation check.
      const classifySkip = this.#spendJudgment(state);
      if (classifySkip) {
        this.#skip(classifySkip, { capability: 'closing', state, agent: payload.agent });
        return;
      }
      const classifyStarted = this.#now();
      let classification: Awaited<ReturnType<ReflexGateService['classifyClaims']>>;
      try {
        classification = await this.#gate.classifyClaims({
          statements: candidates,
          intent: this.config.intent,
          context: assembled.text.slice(0, 600)
        });
      } catch {
        // FAIL-OPEN: an unavailable classifier must not become a model-visible
        // objection, and it must never fall back to the retired word list.
        this.#skip('closing-claim-unavailable', { capability: 'closing', state, agent: payload.agent });
        return;
      }
      const claims = classification.results
        .filter((item) => item.isClaim && item.confidence >= this.config.claimMinConfidence)
        .map((item) => ({ statement: item.statement }));
      const classifyTokens = candidates.reduce((sum, statement) => sum + estimateTokens(statement), 0);
      const classificationCharge: JudgmentCharge = {
        judgments: 1,
        memoHits: 0,
        localLatencyMs: Math.max(0, this.#now() - classifyStarted - classification.latencyMs),
        remoteLatencyMs: classification.latencyMs,
        judgeTokens: classifyTokens
      };
      if (claims.length === 0) {
        this.#charge('closing', classificationCharge);
        this.#skip('closing-no-claim', {
          capability: 'closing',
          state,
          agent: payload.agent,
          judgment: classificationCharge
        });
        return;
      }

      // Classification and verification are one logical closing judgment: the
      // classification decides *whether* anything is worth verifying, and both
      // requests are charged (tokens and latency) against the one judgment the
      // turn budget allowed.
      const verdict = await this.#gate.verify(claims, assembled.text, {
        latchCacheKey: `reflex-closing:${agentId}:${payload.turn}`
      });
      const judgeTokens =
        classifyTokens + claims.reduce((sum, item) => sum + estimateTokens(item.statement), estimateTokens(assembled.text));
      const judgment: JudgmentCharge = {
        judgments: 1,
        memoHits: 0,
        localLatencyMs: Math.max(0, this.#now() - started - verdict.latencyMs - classification.latencyMs),
        remoteLatencyMs: classification.latencyMs + verdict.latencyMs,
        judgeTokens
      };
      // `escalate` is not a contradiction. It means the gate could not decide —
      // an unavailable backend degrades exactly this way — and steering a turn on
      // an undecided verdict would turn a backend failure into a model-visible
      // objection. Only a verdict that really contradicts the claim steers.
      const contradicted = verdict.results
        .filter((item) => item.outcome === 'contradicted')
        .map((item) => clip(item.statement, 160));
      const undecided = verdict.results.filter((item) => item.outcome === 'escalate').length;
      if (contradicted.length === 0) {
        this.#charge('closing', judgment);
        this.#skip(undecided > 0 ? 'closing-undecided' : verdict.passed ? 'closing-evidence-consistent' : 'closing-unconfirmed', {
          capability: 'closing',
          state,
          agent: payload.agent,
          judgment
        });
        return;
      }

      const plan: InterventionPlan = {
        capability: 'closing',
        action: 'steer-closing',
        reason: `closing evidence contradicts ${contradicted.length} completion claim(s)`,
        feedback: this.#closingFeedback(contradicted),
        detail: { confidence: verdict.results[0]?.confidence, turn: payload.turn, step: state.step }
      };
      const applied = capability === 'active';
      // Latched in both modes, for the same reason as the stagnation path: the
      // episode is consumed once, and only the steering is gated on the mode.
      state.applied.add(`closing:turn:${payload.turn}`);
      this.#bookAction(state);
      this.#conclude(plan, applied, payload.agent, { potentialSavedTokens: 0 }, judgment);
      if (applied) this.#steer(payload.agent, this.#message(agentId, payload.turn, state.step, plan.feedback));
    } catch {
      // FAIL-OPEN: a failed closing check leaves the turn boundary alone.
      this.#skip('planning-error', { capability: 'closing', agent: payload.agent });
    }
  }

  /**
   * `agent/assistant-stream`: retain the turn's own words for the closing check.
   *
   * Deliberately not model-visible: this is a read of what the model already
   * said, kept so the turn can be checked against its own evidence. Nothing is
   * published, and the text is bounded per turn.
   *
   * @param payload - one stream frame of one attempt.
   */
  observeAssistantStream(payload: { agent: unknown; frame?: { type?: string; chunk?: { type?: string; text?: string } } }): void {
    if (!this.serves('closing')) return;
    try {
      const frame = payload.frame;
      if (frame?.type !== 'chunk' || frame.chunk?.type !== 'text-delta') return;
      const text = frame.chunk.text ?? '';
      if (text.length === 0) return;
      const state = this.#state(agentKeyOf(payload.agent), payload.agent);
      state.claims = clip(`${state.claims}${text}`, CLAIM_CHARS);
    } catch {
      // Advisory only: a malformed frame must not disturb streaming.
    }
  }

  // ── capabilities ───────────────────────────────────────────────────────────

  /**
   * Plan, and in active mode apply, the reduction of one oversized result.
   *
   * The order of operations here *is* the safety property, so it is spelled out:
   * decide whether this payload is one the module is willing to rewrite, make sure
   * an original can be retained, buy a judgment from the shared budget, obtain the
   * real candidate, retain the original, build the replacement, check that the
   * replacement really shrank the text, and only then record a saving. Every "no"
   * on that path returns the downstream decision untouched, which is why an
   * unverifiable reduction can never be reported as applied.
   *
   * @param exec - the call that produced the result.
   * @param downstream - what the rest of the waterfall decided.
   * @param effective - the content the model will read (`downstream` first).
   * @param state - the deciding agent's state.
   * @param text - the effective text of that content.
   * @param started - clock reading at hook entry, for local latency.
   * @returns the decision the Host commits.
   */
  async #pruneResult(
    exec: ToolExecution,
    downstream: PostToolDecision,
    effective: readonly ContentBlock[] | undefined,
    state: AgentState,
    text: string,
    started: number
  ): Promise<PostToolDecision> {
    const capability = this.modeOf('prune');
    if (capability === 'off') return downstream;
    if (downstream.kind === 'block') return downstream;
    // The payload identity is taken once, before any branch can refuse it: every
    // skip below names the payload it was about, so the log answers "which result
    // was not pruned" as well as "why".
    const payloadDetail = prunePayloadDetail(text);
    if ('value' in downstream && downstream.value !== undefined) {
      // A value-shaped accept replaced the payload wholesale; nothing here knows
      // what its text is, so nothing here may touch it.
      this.#skip('value-shaped-accept', { capability: 'prune', state, agent: exec.agent });
      return downstream;
    }
    if (!hasTextBlock(effective)) {
      // Nothing to replace, and nothing that could be reported as replaced. Asked
      // before the size checks: an image-only payload is not "small", it is out of
      // scope, and the skip reason should say so.
      this.#skip('no-text-block', { capability: 'prune', state, agent: exec.agent, detail: payloadDetail });
      return downstream;
    }
    if (text.length < this.#pruneThreshold) {
      this.#skip('below-threshold', { capability: 'prune', state, agent: exec.agent, detail: payloadDetail });
      return downstream;
    }
    if ((text.match(/\n/g)?.length ?? 0) < PRUNE_MIN_LINES) {
      // Not line-oriented output: the judge is asked to extract diagnostics, and a
      // payload with no lines does not have any to extract. Rewriting it would
      // destroy semantic data rather than compress a trace.
      this.#skip('unsupported-payload', { capability: 'prune', state, agent: exec.agent, detail: payloadDetail });
      return downstream;
    }
    if (text.length > MAX_RETAINED_CHARS) {
      // Retention is a precondition of replacing anything, so an oversized payload
      // is refused *before* it is judged or reported as a saving.
      this.#skip('retention-too-large', { capability: 'prune', state, agent: exec.agent, detail: payloadDetail });
      return downstream;
    }
    const retain = this.#retain;
    if (!retain) {
      // Without a retention sink nothing may be replaced: the module will not
      // destroy the only copy of a result it cannot give back.
      this.#skip('retention-unavailable', { capability: 'prune', state, agent: exec.agent, detail: payloadDetail });
      return downstream;
    }
    if (!this.#actionWithinBudget(state)) {
      // A reduction is an intervention like a refusal or a correction, so it draws
      // on the same per-turn allowance — and it is asked here, before a judgment is
      // bought, so a full turn costs nothing to refuse. Both modes are checked:
      // observe has to plan no more actions than active could take, including the
      // ones the memo would have answered for free.
      this.#skip('intervention-cap', { capability: 'prune', state, agent: exec.agent, detail: payloadDetail });
      return downstream;
    }
    // Whether *this* agent can retain is the sink's answer, not this module's
    // guess: the production sink refuses a session-less agent by returning nothing,
    // which lands on the same fail-open path below.
    const session = sessionOf(exec.agent);

    const digest = digestOf(text);
    // The locator is derived from the payload, and the production sink names the
    // retained copy the same way — which is what makes the plan's size the size of
    // the form active will install, in both modes.
    const locator = pruneLocator(digest);
    const memo = this.#memoGet(state, digest);
    // A memo hit answers the question the judgment already answered; only a mode
    // that needs the reduction's *text* has to ask for it again.
    const needsCandidate = capability === 'active' && (memo?.text === undefined);
    if (!memo || needsCandidate) {
      const skip = this.#spendJudgment(state);
      if (skip) {
        this.#skip(skip, { capability: 'prune', state, agent: exec.agent, detail: payloadDetail });
        return downstream;
      }
    }

    const response: PruneResponse =
      memo && !needsCandidate
        ? {
            processedOutput: memo.text ?? text,
            originalChars: memo.originalChars,
            prunedChars: memo.prunedChars,
            estimatedTokensSaved: memo.tokensSaved,
            reductionPercentage: reductionPercentage(memo.originalChars, memo.prunedChars),
            shadow: memo.text === undefined,
            latencyMs: 0,
            ...(memo.diagnostics ?? {})
          }
        // Both modes take the *real* candidate, and both ask for it measure-only.
        // `shadow` only decides whether the backend hands its text back, while
        // `prunedChars` is that candidate's size either way; the text is what the floor
        // composes from, so a withheld measurement would not be the same input at all.
        // Whether the payload is installed is decided here, by the floor, *after* the
        // service has written its ledger entry — so this path never lets the service
        // declare a saving: it measures (`tokensSaved` 0, the candidate's size in
        // `details.potentialTokensSaved`) and the intervention record carries what was
        // really installed. The explicit `reflex_prune` tool, which does hand the
        // reduced text back to its caller, keeps booking the reduction it returns.
        : await this.#prune.prune(text, {
            intent: this.config.intent,
            measureOnly: true,
            // Per-segment System One judging starts at this size; below it the
            // backend's deterministic candidates run and no judgment is spent.
            pruneJudgeMinChars: this.config.pruneJudgeMinChars
          });

    const originalTokens = estimateTokens(text);
    // One composition, both modes: the floored text the plan describes is the text
    // active installs, byte for byte. Line alignment and duplicate removal move its
    // real size away from the modelled one, so the number both modes account for is
    // the length of the composed text — never a prediction about it.
    const composed = applyPruneFloor(text, response.processedOutput, {
      floorRatio: this.config.pruneFloorRatio,
      headChars: this.config.pruneHeadChars,
      tailChars: this.config.pruneTailChars,
      locator
    });
    const candidateTokens = Math.ceil(composed.text.length / 4);
    // What the judgment reported about its own path, plus the sizes both the plan
    // and a skip record quote. Recorded even when the candidate is not smaller,
    // because that is exactly the branch a real run cannot explain from its log.
    const diagnostics = pruneDiagnosticsOf(response);
    // A memo hit hands back a form that was composed for this payload already. It is
    // its own fixed point — it carries the share, so the plan of the same lengths
    // stays "not floored" and gives that text straight back — but its provenance is
    // not readable from those lengths any more. The memo, which was written by the
    // composition, answers for it: without this the audit would report a floored
    // install as an unfloored one and flip the wording of the feedback with it.
    const reusedFromMemo = !needsCandidate && memo?.text !== undefined ? memo : undefined;
    const floorApplied = reusedFromMemo ? reusedFromMemo.floored : composed.floored;
    const floorMissed = reusedFromMemo ? reusedFromMemo.floorMissed === true : composed.floorMissed;
    const markerOmitted = reusedFromMemo ? reusedFromMemo.markerOmitted === true : composed.markerOmitted;
    const measured: InterventionSkipDetail = {
      ...payloadDetail,
      ...diagnostics,
      originalTokens,
      candidateTokens,
      floored: floorApplied,
      floorMissed,
      markerOmitted,
      candidateChars: composed.text.length
    };
    const judged = !memo || needsCandidate;
    const judgment: JudgmentCharge = {
      judgments: judged ? 1 : 0,
      memoHits: judged ? 0 : 1,
      localLatencyMs: Math.max(0, this.#now() - started - (judged ? response.latencyMs : 0)),
      remoteLatencyMs: judged ? response.latencyMs : 0,
      // The pre-prune payload is what the pruner reasoned about; a backend call is
      // a judgment even when it returns locally in under a millisecond.
      judgeTokens: judged ? originalTokens : 0
    };
    if (candidateTokens >= originalTokens) {
      this.#charge('prune', { ...judgment, originalTokens });
      // The branch a real "prune: active but nothing happened" run lands in: the
      // judgment ran, and the candidate it produced was not smaller. The record
      // says so with the path that produced it and the sizes both sides had.
      this.#skip('no-reduction', {
        capability: 'prune',
        state,
        agent: exec.agent,
        detail: measured,
        judgment
      });
      return downstream;
    }

    const plan: InterventionPlan = {
      capability: 'prune',
      action: 'prune-result',
      reason: `${exec.name} returned ${originalTokens} tokens; the judged reduction carries ${candidateTokens}`,
      feedback: this.#pruneFeedback(exec.name, originalTokens, candidateTokens, {
        floored: floorApplied,
        floorMissed,
        markerOmitted,
        locator,
        keptSegments: diagnostics.keptSegments,
        judgedSegments: diagnostics.judgedSegments
      }),
      detail: {
        digest,
        floorApplied,
        floorMissed,
        markerOmitted,
        confidence: response.reductionPercentage,
        turn: state.turn,
        step: state.step,
        ...diagnostics,
        originalChars: text.length,
        candidateChars: composed.text.length
      }
    };
    const planCosts = { originalTokens, candidateTokens, potentialSavedTokens: originalTokens - candidateTokens };

    if (capability !== 'active') {
      // Observe: the plan is real and charged, the surface is untouched, and the
      // memo keeps the composed form — the same form active would install, from the
      // same candidate — so a later hit reports the reduction this mode really saw.
      // A plan this mode records is the action active would have taken, so it books
      // the slot active would have booked.
      this.#bookAction(state);
      this.#conclude(plan, false, exec.agent, planCosts, judgment);
      if (!memo) {
        this.#memoSet(state, digest, {
          text: composed.text,
          originalChars: text.length,
          prunedChars: composed.text.length,
          tokensSaved: originalTokens - candidateTokens,
          floored: floorApplied,
          floorMissed,
          markerOmitted,
          diagnostics
        });
      }
      return downstream;
    }

    // Active. The original is retained *before* anything is replaced, and only a
    // verified retention makes the replacement installable at all. A payload whose
    // copy is already retained keeps that copy instead of writing a second one.
    const alreadyRetained = memo?.locator;
    const retention = alreadyRetained
      ? { locator: alreadyRetained }
      : retain(session, {
          digest,
          callId: exec.callId,
          tool: exec.name,
          turn: state.turn,
          step: state.step,
          text
        });
    if (!retention || typeof retention.locator !== 'string' || retention.locator.length === 0) {
      // No controlled copy, no reduction. The result stays exactly as the rest of
      // the waterfall produced it, and no saving is recorded — but the judgment
      // that got this far was really made, so it is charged rather than hidden.
      this.#charge('prune', judgment);
      this.#skip('retention-failed', {
        capability: 'prune',
        state,
        agent: exec.agent,
        detail: measured,
        judgment
      });
      return downstream;
    }

    // The form both modes accounted for is the form that gets installed: the locator
    // is derived from the payload and the sink names its copy the same way, so the
    // composition already published is reused byte for byte — with the provenance the
    // plan gave it, rather than with what re-reading its own lengths would say. Only a
    // sink that named the copy differently forces a rebuild, and then the real length
    // and provenance of that rebuild are what gets accounted for.
    const installed =
      retention.locator === locator
        ? { ...composed, floored: floorApplied, floorMissed, markerOmitted }
        : applyPruneFloor(text, response.processedOutput, {
            floorRatio: this.config.pruneFloorRatio,
            headChars: this.config.pruneHeadChars,
            tailChars: this.config.pruneTailChars,
            locator: retention.locator
          });
    if (installed.text.length === 0 || installed.text.length >= text.length) {
      // The plan said the form is smaller; the form that was really built must be
      // too, or nothing is installed and nothing is saved.
      this.#skip('no-reduction', {
        capability: 'prune',
        state,
        agent: exec.agent,
        detail: {
          ...measured,
          floored: installed.floored,
          floorMissed: installed.floorMissed,
          markerOmitted: installed.markerOmitted,
          candidateChars: installed.text.length,
          candidateTokens: Math.max(0, Math.ceil(installed.text.length / 4))
        },
        judgment
      });
      return downstream;
    }
    const replacement = this.#replaceText(effective, installed.text);
    if (!replacement) {
      this.#skip('no-text-block', {
        capability: 'prune',
        state,
        agent: exec.agent,
        detail: {
          ...measured,
          floored: installed.floored,
          floorMissed: installed.floorMissed,
          markerOmitted: installed.markerOmitted,
          candidateChars: installed.text.length,
          candidateTokens: Math.max(0, Math.ceil(installed.text.length / 4))
        },
        judgment
      });
      return downstream;
    }

    // Only now is there a decision that really took effect, so only now is the
    // saving recorded — against the text that is really about to enter the context.
    const installedTokens = Math.max(0, Math.ceil(installed.text.length / 4));
    plan.detail.floorApplied = installed.floored;
    plan.detail.floorMissed = installed.floorMissed;
    plan.detail.markerOmitted = installed.markerOmitted;
    plan.detail.candidateChars = installed.text.length;
    plan.feedback = this.#pruneFeedback(exec.name, originalTokens, installedTokens, {
      floored: installed.floored,
      floorMissed: installed.floorMissed,
      markerOmitted: installed.markerOmitted,
      locator: retention.locator,
      keptSegments: diagnostics.keptSegments,
      judgedSegments: diagnostics.judgedSegments
    });
    // Booked only here: a candidate that was not smaller, a replacement that could
    // not be composed, and a retention that failed all returned above, so none of
    // them consumed the turn's allowance for an action that never happened.
    this.#bookAction(state);
    this.#conclude(
      plan,
      true,
      exec.agent,
      {
        originalTokens,
        candidateTokens: installedTokens,
        potentialSavedTokens: originalTokens - installedTokens,
        actualSavedTokens: originalTokens - installedTokens
      },
      judgment,
      retention.locator
    );
    // Retention is counted once per payload: a duplicate install reuses the copy
    // that is already in the log, and the locator naming it never changes.
    if (!this.#retained.includes(retention.locator)) {
      this.#retained.push(retention.locator);
      if (this.#retained.length > MAX_RECENT) this.#retained.shift();
    }
    this.#retainedCopies += 1;
    this.#memoSet(state, digest, {
      text: installed.text,
      originalChars: text.length,
      prunedChars: installed.text.length,
      tokensSaved: originalTokens - installedTokens,
      floored: installed.floored,
      floorMissed: installed.floorMissed,
      markerOmitted: installed.markerOmitted,
      locator: retention.locator,
      diagnostics
    });
    return {
      kind: 'accept',
      content: replacement,
      ...(downstream.additionalContexts && downstream.additionalContexts.length > 0
        ? { additionalContexts: [...downstream.additionalContexts] }
        : {})
    };
  }

  /** Plan, and in active mode apply, the correction of one repeated failure. */
  async #correctFailure(
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    downstream: PostToolDecision,
    state: AgentState,
    signature: string,
    started: number
  ): Promise<PostToolDecision> {
    const capability = this.modeOf('gate');
    if (capability === 'off') return downstream;
    if (downstream.kind === 'block') return downstream;
    const suspicion = suspicionOf(state.steps, {
      repeatThreshold: this.config.repeatThreshold,
      failureThreshold: this.config.failureThreshold,
      window: this.config.windowSize,
      signature
    });
    if (!suspicion.suspicious || state.applied.has(`gate:${signature}`)) {
      if (suspicion.suspicious) {
        this.#skip('duplicate-intervention', { capability: 'gate', state, agent: exec.agent });
      }
      return downstream;
    }
    if (!this.#actionWithinBudget(state)) {
      this.#skip('intervention-cap', { capability: 'gate', state, agent: exec.agent });
      return downstream;
    }
    const agentId = agentKeyOf(exec.agent);
    const verdict = await this.#judge(state, exec.signal);
    const judgment = this.#judgmentCharge(verdict, started, this.#now());
    if (!verdict.useful) {
      this.#charge('gate', judgment);
      this.#skip(verdict.skip ?? 'unconfirmed', {
        capability: 'gate',
        state,
        agent: exec.agent,
        judgment
      });
      return downstream;
    }

    const plan: InterventionPlan = {
      capability: 'gate',
      action: 'corrective-feedback',
      reason: `${exec.name} failed ${suspicion.repeats} times; System 1 confirmed ${verdict.response.patternType ?? suspicion.pattern}`,
      feedback: this.#failureFeedback(exec.name, this.#errorOf(result), suspicion, verdict.response),
      detail: {
        pattern: String(verdict.response.patternType ?? suspicion.pattern ?? 'unknown'),
        confidence: verdict.response.confidence,
        repeats: suspicion.repeats,
        turn: state.turn,
        step: state.step
      }
    };
    const applied = capability === 'active';
    state.applied.add(`gate:${signature}`);
    this.#bookAction(state);
    this.#conclude(plan, applied, exec.agent, { potentialSavedTokens: 0 }, judgment);
    if (!applied) return downstream;
    return {
      kind: 'block',
      feedback: [{ type: 'text', text: plan.feedback }],
      ...(downstream.additionalContexts && downstream.additionalContexts.length > 0
        ? { additionalContexts: [...downstream.additionalContexts] }
        : {})
    };
  }

  // ── judgment, budgets, and memo ─────────────────────────────────────────────

  /**
   * Whether this turn still has room for one more planned action.
   *
   * This is the *action* ceiling, and it is deliberately not the judgment budget:
   * a judgment is the question System 1 was asked, this is the number of things
   * the run is allowed to do about the answer. Every capability draws on the same
   * allowance, and both modes draw on it the same way — the plan observe measures
   * is the action active would install, so an observe run that planned more than
   * the ceiling would be measuring a turn that cannot exist.
   *
   * Asked before a judgment is bought, so a turn that is already full is refused
   * for free.
   * @param state - the deciding agent's state.
   * @returns whether one more planned action fits this turn.
   */
  #actionWithinBudget(state: AgentState): boolean {
    return state.interventions < this.config.maxInterventionsPerTurn;
  }

  /**
   * Book one planned action against the turn's shared allowance.
   *
   * Called at the one point where a plan becomes real: observe books the plan it
   * records, active books the replacement its retention made installable. Never
   * called earlier — a plan abandoned by a failed judgment, a failed retention, or
   * a candidate that turned out not to be smaller must not consume the turn's
   * allowance, or a turn would be spent on actions that never happened.
   * @param state - the deciding agent's state.
   */
  #bookAction(state: AgentState): void {
    state.interventions += 1;
  }

  /**
   * Spend at most one System 1 stagnation judgment per agent and turn.
   *
   * Every hook of one turn shares the verdict — the pre-execute refusal, the
   * pre-step correction, and the failure correction all ask the same question
   * about the same window, so asking it three times would be three times the cost
   * for one answer.
   */
  async #judge(
    state: AgentState,
    signal?: AbortSignal,
    steps: readonly ObservedStep[] = state.steps,
    goal?: string
  ): Promise<{
    useful: boolean;
    paid: boolean;
    reused: boolean;
    judgeTokens: number;
    localLatencyMs: number;
    remoteLatencyMs: number;
    skip?: string;
    response: StagnationCheckResponse;
  }> {
    // The question is the trailing window plus the context it is asked in, so
    // the answer is cached against both: the same episode is never judged twice,
    // while a *different* episode or a different wait context in the same turn is
    // a new question — and therefore subject to the turn's budget.
    const key = `${goal ?? ''}\u0000${steps
      .slice(-Math.max(1, this.config.repeatThreshold))
      .map((step) => step.signature)
      .join('|')}`;
    const cached = state.verdictTurn === state.turn && state.verdictKey === key ? state.verdict : undefined;
    if (cached) {
      return {
        useful: this.#useful(cached),
        paid: false,
        reused: true,
        judgeTokens: 0,
        localLatencyMs: 0,
        remoteLatencyMs: 0,
        response: cached
      };
    }
    if (state.judgmentsCount >= this.config.maxJudgmentsPerTurn) {
      return this.#noJudgment('judgment-turn-cap');
    }
    if (state.judgmentsSession >= this.config.maxJudgmentsPerSession) {
      return this.#noJudgment('judgment-session-cap');
    }
    if (signal?.aborted) return this.#noJudgment('aborted');
    this.#spendJudgment(state);

    const history: ActionStep[] = steps.map((step) => ({
      tool: step.tool,
      input: step.input,
      ...(step.output ? { output: step.output } : {}),
      ...(step.error ? { error: step.error } : {}),
      timestamp: step.at
    }));
    const judgeTokens = history.reduce(
      (sum, step) => sum + estimateTokens(`${step.tool}${step.input}${step.output ?? ''}${step.error ?? ''}`),
      0
    );
    const started = this.#now();
    const response = await this.#stagnation.check(goal, history);
    const remoteLatencyMs = Number.isFinite(response.latencyMs) ? response.latencyMs : 0;
    state.verdict = response;
    state.verdictTurn = state.turn;
    state.verdictKey = key;
    return {
      useful: this.#useful(response),
      paid: true,
      reused: false,
      judgeTokens,
      localLatencyMs: Math.max(0, this.#now() - started - remoteLatencyMs),
      remoteLatencyMs,
      response
    };
  }

  /**
   * Charge one judgment against the turn's and the session's budget.
   *
   * Both budgets are spent at the one place a judgment is actually made, so a
   * capability cannot buy its way around them by calling a service directly. The
   * caller decides whether a refusal means "plan nothing" or "do not act"; what
   * matters here is that the count is never overrun and that a shadowed
   * application is charged like a real one — an observe run has to cost what the
   * active run would cost, or its column would flatter it.
   * @param state - the deciding agent's state.
   * @returns `undefined` when the judgment was spent, else the skip reason.
   */
  #spendJudgment(state: AgentState): string | undefined {
    if (state.judgmentsCount >= this.config.maxJudgmentsPerTurn) return 'judgment-turn-cap';
    if (state.judgmentsSession >= this.config.maxJudgmentsPerSession) return 'judgment-session-cap';
    state.judgmentsCount += 1;
    state.judgmentsSession += 1;
    return undefined;
  }

  /** The zero-cost verdict of a judgment that could not be spent. */
  #noJudgment(skip: string): {    useful: boolean;
    paid: boolean;
    reused: boolean;
    judgeTokens: number;
    localLatencyMs: number;
    remoteLatencyMs: number;
    skip?: string;
    response: StagnationCheckResponse;
  } {
    // Not a memo hit: nothing was reused, the budget simply refused to spend.
    return {
      useful: false,
      paid: false,
      reused: false,
      judgeTokens: 0,
      localLatencyMs: 0,
      remoteLatencyMs: 0,
      skip,
      response: EMPTY_VERDICT
    };
  }

  /** The charge of one judgment, so every judgment is billed exactly once. */
  #judgmentCharge(
    verdict: { paid: boolean; reused: boolean; judgeTokens: number; localLatencyMs: number; remoteLatencyMs: number },
    started: number,
    finished: number
  ): JudgmentCharge {
    if (!verdict.paid) {
      return { judgments: 0, memoHits: verdict.reused ? 1 : 0, localLatencyMs: 0, remoteLatencyMs: 0, judgeTokens: 0 };
    }
    return {
      judgments: 1,
      memoHits: 0,
      localLatencyMs: Math.max(verdict.localLatencyMs, Math.max(0, finished - started - verdict.remoteLatencyMs)),
      remoteLatencyMs: verdict.remoteLatencyMs,
      judgeTokens: verdict.judgeTokens
    };
  }

  /** Whether a verdict justifies acting: stuck, confident, and about a pattern. */
  #useful(response: StagnationCheckResponse): boolean {
    return (
      response.isStuck === true &&
      response.confidence >= this.config.minConfidence &&
      (response.patternType ?? 'none') !== 'none'
    );
  }

  // ── accounting and audit ───────────────────────────────────────────────────

  /**
   * Record one planned decision and bill its plan side.
   *
   * The judgment is passed in rather than recomputed: it was already charged
   * (or is charged here for the first time) exactly once, and it appears in the
   * audit record so one decision's full cost is readable in one place.
   *
   * Two rules keep the record honest. `injectedTokens` counts only text that was
   * *really* injected — a reduction's explanatory note is never sent to the model,
   * so reducing costs no context. And `actualSavedTokens` is the caller's
   * measurement of the payload that really left the surface, not the plan's
   * intention; `#pruneResult` passes the size of the text it actually installed.
   *
   * @param plan - what was planned.
   * @param applied - whether active mode executed it.
   * @param agent - the agent it concerns, for isolation and the audit trail.
   * @param planCosts - the payload sizes of this decision.
   * @param judgment - the judgment this decision rode on.
   * @param originalLocator - locator of the retained original, when one exists.
   */
  #conclude(
    plan: InterventionPlan,
    applied: boolean,
    agent: unknown,
    planCosts: {
      originalTokens?: number;
      candidateTokens?: number;
      potentialSavedTokens: number;
      /** Tokens really removed; defaults to the plan's own estimate. */
      actualSavedTokens?: number;
    },
    judgment?: JudgmentCharge,
    originalLocator?: string
  ): void {
    const originalTokens = planCosts.originalTokens ?? 0;
    const candidateTokens = planCosts.candidateTokens ?? 0;
    const potentialSavedTokens = planCosts.potentialSavedTokens;
    // The injection column counts text handed to the model. A deny's reason and a
    // correction's feedback are injected; a prune's note travels in the audit
    // record only, so its plan never inflates the cost of the saving it made.
    const injects = applied && plan.action !== 'prune-result';
    const injectedTokens = injects ? estimateTokens(plan.feedback) : 0;
    const actualSavedTokens =
      applied && plan.action === 'prune-result'
        ? planCosts.actualSavedTokens ?? potentialSavedTokens
        : 0;
    const charge: Charge = {
      ...(judgment ?? { judgments: 0, memoHits: 0, localLatencyMs: 0, remoteLatencyMs: 0, judgeTokens: 0 }),
      originalTokens,
      candidateTokens,
      potentialSavedTokens,
      actualSavedTokens,
      injectedTokens
    };
    this.#charge(plan.capability, charge, 1, applied ? 1 : 0);

    const record: InterventionAuditRecord = {
      capability: plan.capability,
      action: plan.action,
      mode: this.modeOf(plan.capability),
      applied,
      reason: plan.reason,
      feedback: applied ? plan.feedback : '',
      localLatencyMs: judgment?.localLatencyMs ?? 0,
      remoteLatencyMs: judgment?.remoteLatencyMs ?? 0,
      judgeTokens: judgment?.judgeTokens ?? 0,
      originalTokens,
      candidateTokens,
      potentialSavedTokens,
      actualSavedTokens,
      injectedTokens,
      at: this.#now(),
      agentId: agentKeyOf(agent),
      ...(plan.detail.pattern === undefined ? {} : { pattern: plan.detail.pattern }),
      ...(plan.detail.confidence === undefined ? {} : { confidence: plan.detail.confidence }),
      ...(plan.detail.repeats === undefined ? {} : { repeats: plan.detail.repeats }),
      ...(plan.detail.digest === undefined ? {} : { digest: plan.detail.digest }),
      ...(plan.detail.floorApplied === undefined ? {} : { floorApplied: plan.detail.floorApplied, floored: plan.detail.floorApplied }),
      ...(plan.detail.floorMissed === undefined ? {} : { floorMissed: plan.detail.floorMissed }),
      ...(plan.detail.markerOmitted ? { markerOmitted: true } : {}),
      ...(judgment?.memoHits ? { memoHit: true } : {}),
      ...(originalLocator === undefined ? {} : { originalLocator }),
      ...(plan.detail.turn === undefined ? {} : { turn: plan.detail.turn }),
      ...(plan.detail.step === undefined ? {} : { step: plan.detail.step }),
      ...(plan.detail.judgePath === undefined ? {} : { judgePath: plan.detail.judgePath }),
      ...(plan.detail.judgedSegments === undefined ? {} : { judgedSegments: plan.detail.judgedSegments }),
      ...(plan.detail.unjudgedSegments === undefined ? {} : { unjudgedSegments: plan.detail.unjudgedSegments }),
      ...(plan.detail.keptSegments === undefined ? {} : { keptSegments: plan.detail.keptSegments }),
      ...(plan.detail.aggressiveChars === undefined ? {} : { aggressiveChars: plan.detail.aggressiveChars }),
      ...(plan.detail.balancedChars === undefined ? {} : { balancedChars: plan.detail.balancedChars }),
      ...(plan.detail.conservativeChars === undefined ? {} : { conservativeChars: plan.detail.conservativeChars }),
      ...(plan.detail.scoredSegments === undefined ? {} : { scoredSegments: plan.detail.scoredSegments }),
      ...(plan.detail.autoKeptSegments === undefined ? {} : { autoKeptSegments: plan.detail.autoKeptSegments }),
      ...(plan.detail.unparsedScoreAnswers === undefined ? {} : { unparsedScoreAnswers: plan.detail.unparsedScoreAnswers }),
      ...(plan.detail.originalChars === undefined ? {} : { originalChars: plan.detail.originalChars }),
      ...(plan.detail.candidateChars === undefined ? {} : { candidateChars: plan.detail.candidateChars }),
      ...(plan.detail.fallbackReason === undefined ? {} : { fallbackReason: plan.detail.fallbackReason })
    };
    this.#recent.push(record);
    if (this.#recent.length > MAX_RECENT) this.#recent.shift();
    try {
      this.#audit?.(record, (agent as { session?: unknown } | undefined)?.session);
    } catch {
      // An audit sink is never allowed to fail a turn.
    }
  }

  /**
   * Bill one decision against its mode's and its capability's account.
   *
   * Every counter has exactly one writer, so a reader can add the parts up
   * without meeting a number twice.
   */
  #charge(capability: InterventionCapability, charge: Charge, plans = 0, applied = 0): void {
    const mode = this.modeOf(capability) === 'active' ? 'active' : 'observe';
    for (const bucket of [this.#costs[mode], this.#byCapability[capability]]) {
      bucket.plans += plans;
      bucket.applied += applied;
      bucket.judgments += charge.judgments ?? 0;
      bucket.memoHits += charge.memoHits ?? 0;
      bucket.localLatencyMs += charge.localLatencyMs ?? 0;
      bucket.remoteLatencyMs += charge.remoteLatencyMs ?? 0;
      bucket.judgeTokens += charge.judgeTokens ?? 0;
      bucket.originalTokens += charge.originalTokens ?? 0;
      bucket.candidateTokens += charge.candidateTokens ?? 0;
      bucket.potentialSavedTokens += charge.potentialSavedTokens ?? 0;
      bucket.actualSavedTokens += charge.actualSavedTokens ?? 0;
      bucket.injectedTokens += charge.injectedTokens ?? 0;
    }
  }

  /**
   * Count one hook-level refusal by reason, and leave it in the session log.
   *
   * The counter is process-local and only answers "what did this activation
   * skip"; the record is the durable half, because the question a real run
   * raises is *why was nothing pruned* — and a branch that never planned
   * anything otherwise leaves no trace at all. The write is best-effort by
   * construction: no budget is charged, nothing is projected into the model's
   * context, and a sink that throws or a session that is missing leaves the
   * hook's own decision untouched.
   *
   * @param reason - the machine reason of the branch that abandoned the plan.
   * @param context - capability, deciding state, agent, and prune diagnostics.
   */
  #skip(reason: string, context: SkipContext): void {
    this.#skips.set(reason, (this.#skips.get(reason) ?? 0) + 1);
    this.#auditSkip(reason, context);
  }

  /** Write one abandoned plan to the audit channel, fail-open. */
  #auditSkip(reason: string, context: SkipContext): void {
    const audit = this.#audit;
    if (!audit) return;
    try {
      const detail = context.detail;
      const record: InterventionAuditRecord = {
        capability: context.capability,
        action: 'skip',
        mode: this.modeOf(context.capability),
        applied: false,
        reason,
        feedback: '',
        localLatencyMs: context.judgment?.localLatencyMs ?? 0,
        remoteLatencyMs: context.judgment?.remoteLatencyMs ?? 0,
        judgeTokens: context.judgment?.judgeTokens ?? 0,
        originalTokens: detail?.originalTokens ?? 0,
        candidateTokens: detail?.candidateTokens ?? 0,
        potentialSavedTokens: 0,
        actualSavedTokens: 0,
        injectedTokens: 0,
        at: this.#now(),
        skip: reason,
        ...(context.state === undefined ? {} : { turn: context.state.turn, step: context.state.step }),
        ...(detail?.digest === undefined ? {} : { digest: detail.digest }),
        ...(detail?.floored === undefined ? {} : { floored: detail.floored }),
        ...(detail?.floorMissed === undefined ? {} : { floorMissed: detail.floorMissed }),
        ...(detail?.markerOmitted ? { markerOmitted: true } : {}),
        ...(detail?.judgePath === undefined ? {} : { judgePath: detail.judgePath }),
        ...(detail?.judgedSegments === undefined ? {} : { judgedSegments: detail.judgedSegments }),
        ...(detail?.unjudgedSegments === undefined ? {} : { unjudgedSegments: detail.unjudgedSegments }),
        ...(detail?.keptSegments === undefined ? {} : { keptSegments: detail.keptSegments }),
        ...(detail?.aggressiveChars === undefined ? {} : { aggressiveChars: detail.aggressiveChars }),
        ...(detail?.balancedChars === undefined ? {} : { balancedChars: detail.balancedChars }),
        ...(detail?.conservativeChars === undefined ? {} : { conservativeChars: detail.conservativeChars }),
        ...(detail?.scoredSegments === undefined ? {} : { scoredSegments: detail.scoredSegments }),
        ...(detail?.autoKeptSegments === undefined ? {} : { autoKeptSegments: detail.autoKeptSegments }),
        ...(detail?.unparsedScoreAnswers === undefined ? {} : { unparsedScoreAnswers: detail.unparsedScoreAnswers }),
        ...(detail?.originalChars === undefined ? {} : { originalChars: detail.originalChars }),
        ...(detail?.candidateChars === undefined ? {} : { candidateChars: detail.candidateChars }),
        ...(detail?.fallbackReason === undefined ? {} : { fallbackReason: detail.fallbackReason })
      };
      audit(record, sessionOf(context.agent));
    } catch {
      // An audit sink is never allowed to fail a turn, and a skip is reported
      // even when the log refused it: the counter above is already committed.
    }
  }

  // ── state ─────────────────────────────────────────────────────────────────

  /** One agent's state, created on first sight and bounded overall. */
  #state(agentId: string, agent?: unknown): AgentState {
    const sessionKey = sessionKeyOf(agent);
    const existing = this.#states.get(agentId);
    if (existing && existing.sessionKey === sessionKey) {
      this.#states.delete(agentId);
      this.#states.set(agentId, existing);
      return existing;
    }
    // A new session for the same agent id is a new run: no window, verdict,
    // budget, or memoized reduction of the old one may leak into it.
    if (existing) this.#memoForget(existing.sessionKey);
    const state: AgentState = {
      sessionKey,
      turn: 0,
      step: 0,
      steps: [],
      claims: '',
      evidence: [],
      evidenceSuspect: false,
      interventions: 0,
      judgmentsTurn: 0,
      judgmentsCount: 0,
      judgmentsSession: 0,
      verdictTurn: 0,
      verdictKey: '',
      waited: new Set<string>(),
      applied: new Set<string>(),
      denied: new Set<string>(),
      refused: new Set<string>()
    };
    this.#states.set(agentId, state);
    if (this.#states.size > MAX_AGENTS) {
      const oldest = this.#states.keys().next().value;
      if (typeof oldest === 'string' && oldest !== agentId) this.#states.delete(oldest);
    }
    return state;
  }

  /**
   * The step a call about to run would add, without committing it.
   * @param state - the agent's bookkeeping.
   * @param exec - the proposed call.
   * @param signature - its identity.
   * @returns the step the result path will record once the call completes.
   */
  #observed(state: AgentState, exec: ToolExecution, signature: string): ObservedStep {
    return {
      signature,
      tool: exec.name,
      input: clip(this.#argumentsOf(exec), STEP_CHARS),
      output: '',
      error: '',
      // The call about to run is a retry exactly when this identity failed before.
      failed: state.steps.some((step) => step.signature === signature && step.failed),
      turn: state.turn,
      at: this.#now()
    };
  }

  /** Append one observed step, bounded. */
  #observe(state: AgentState, step: ObservedStep): void {
    state.steps.push(step);
    if (state.steps.length > MAX_STEPS) state.steps.shift();
  }

  /**
   * Retain one result's evidence candidates for the closing check.
   *
   * Called for every observed result, not only structurally failing ones: a
   * `{ok:false}`, a timeout, or a Chinese error has no exit code to prove it,
   * and the closing judgment must be able to see it. The regex only guarantees
   * that its own hits survive; it never decides that the rest is benign.
   * @param state - the agent's bookkeeping.
   * @param tool - tool name that produced the result.
   * @param result - the execution-local result.
   * @param text - the effective model-facing text.
   * @param error - the result's error message, when it has a distinct one.
   */
  #rememberEvidence(
    state: AgentState,
    tool: string,
    result: Readonly<ToolExecutionResult>,
    text: string,
    error: string
  ): void {
    const haystack = error.length > 0 && !text.includes(error) ? `${text}\n${error}` : text;
    const entries = evidenceOf(tool, result, haystack);
    if (entries.length === 0) return;
    state.evidence.push(...entries);
    if (state.evidence.length > MAX_EVIDENCE) {
      state.evidence.splice(0, state.evidence.length - MAX_EVIDENCE);
    }
    if (entries.some((entry) => entry.suspect)) state.evidenceSuspect = true;
  }

  /** The arguments of one call, as the text a judgment and a digest see. */
  #argumentsOf(exec: ToolExecution): string {
    const args: unknown = exec.arguments;
    if (typeof args === 'string') return args;
    try {
      return JSON.stringify(args ?? {}) ?? '';
    } catch {
      return '';
    }
  }

  /** The failure text of one result. */
  #errorOf(result: Readonly<ToolExecutionResult>): string {
    const failure = (result as { error?: { message?: string } }).error;
    if (failure && typeof failure.message === 'string' && failure.message.length > 0) return failure.message;
    return textOfContent(result.content);
  }

  /** Replace the text blocks of one content list, preserving every other block. */
  #replaceText(content: readonly ContentBlock[] | undefined, text: string): ContentBlock[] | undefined {
    if (!content) return undefined;
    const out: ContentBlock[] = [];
    let placed = false;
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        if (!placed) {
          out.push({ type: 'text', text } as ContentBlock);
          placed = true;
        }
        continue;
      }
      out.push(block);
    }
    return placed ? out : undefined;
  }

  /**
   * The explanatory note of one reduction.
   *
   * It travels in the audit record, never in the model's context: a prune is
   * supposed to *remove* context, so sending an explanation of the removal would
   * work against the thing it is accounting for.
   *
   * The wording follows the data: "kept whole" is only said when the judgment
   * really kept every segment it judged. A candidate that was floored says the
   * head/extract/tail form it carries, and a floor miss says how many segments
   * survived, how many were omitted, and that the promised share was not reached
   * — plus where the full payload can be read back, marker or no marker.
   *
   * @param tool - name of the reduced call.
   * @param originalTokens - tokens of the raw payload.
   * @param candidateTokens - tokens of the text really installed.
   * @param outcome - the floor's decision and the judgment's segment counts.
   * @returns the note, clipped to the audit's text budget.
   */
  #pruneFeedback(
    tool: string,
    originalTokens: number,
    candidateTokens: number,
    outcome: {
      floored: boolean;
      floorMissed: boolean;
      markerOmitted: boolean;
      locator: string;
      keptSegments?: number;
      judgedSegments?: number;
    }
  ): string {
    const kept = originalTokens === 0 ? 100 : Math.round((candidateTokens / originalTokens) * 100);
    const head = `Reflex reduced ${tool}: ${originalTokens} → ${candidateTokens} tokens (${kept}% kept). `;
    const keptSegments = outcome.keptSegments;
    const judgedSegments = outcome.judgedSegments;
    const segmentsShort =
      keptSegments !== undefined && judgedSegments !== undefined && keptSegments < judgedSegments;
    const segmentNote = segmentsShort
      ? `Kept ${keptSegments}/${judgedSegments} segments, omitted ${judgedSegments - keptSegments}. `
      : '';
    let body: string;
    if (outcome.floored) {
      body =
        'The head, the judged extract and the tail were kept; ' +
        `the full output was retained in this session's log and is not in context.`;
    } else if (outcome.floorMissed) {
      const floorPercent = Math.round(this.config.pruneFloorRatio * 100);
      const install =
        outcome.markerOmitted
          ? 'no locator marker was added because it would not have kept the text smaller than the original'
          : 'the judged extract was installed as-is';
      body = `${segmentNote}The candidate fell short of the ${floorPercent}% floor, so ${install}; ` +
        `the full output is retrievable as ${outcome.locator}.`;
    } else if (segmentsShort) {
      body = `${segmentNote}The judged extract was installed as-is; ` +
        `the full output is retrievable as ${outcome.locator}.`;
    } else {
      body =
        'The judged extract was kept whole; ' +
        `the full output was retained in this session's log and is not in context.`;
    }
    return clip(`${head}${body}`, FEEDBACK_CHARS);
  }

  /** The memoized reduction of one payload, when it is still remembered. */
  #memoGet(state: AgentState, digest: string): PruneMemo | undefined {
    const key = `${state.sessionKey}:${digest}`;
    const hit = this.#memo.get(key);
    if (!hit) return undefined;
    this.#memo.delete(key);
    this.#memo.set(key, hit);
    return hit;
  }

  /**
   * Remember one payload's reduction, bounded by least recent use.
   *
   * The entry records the *plan* — the sizes both modes report — and, once a mode
   * really computed it, the reduction's text. Observe never has that text (the
   * shadow service withholds it and reports only its size) and never pretends to:
   * a later active decision re-plans that payload for real instead of installing a
   * cached fragment it never saw.
   */
  #memoSet(state: AgentState, digest: string, memo: PruneMemo): void {
    const key = `${state.sessionKey}:${digest}`;
    this.#memo.set(key, memo);
    if (this.#memo.size > MAX_MEMO) {
      const oldest = this.#memo.keys().next().value;
      if (typeof oldest === 'string') this.#memo.delete(oldest);
    }
  }

  /** Drop the memo entries of one session, so a replaced run leaves nothing behind. */
  #memoForget(sessionKey: string): void {
    const prefix = `${sessionKey}:`;
    for (const key of [...this.#memo.keys()]) {
      if (key.startsWith(prefix)) this.#memo.delete(key);
    }
  }

  /** Build one model-facing message, attributed to this plugin. */
  #message(agentId: string, turn: number, step: number, text: string): UserMessage {
    this.#counter += 1;
    const summary = boundContextSummary(text.replace(/\s+/g, ' ').trim());
    return {
      id: MessageId(`reflex-intervention-${agentId}-${turn}-${step}-${this.#counter}`),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: INTERVENTION_SOURCE_KIND, form: 'notice', summary }
    };
  }

  /** Steer one message into an agent's inbox, when the agent can receive it. */
  #steer(agent: unknown, message: UserMessage): void {
    const steer = (agent as { steer?: (message: UserMessage) => void } | undefined)?.steer;
    if (typeof steer !== 'function') return;
    steer.call(agent, message);
  }

  /** The refusal text handed to the model when a repeated call is denied. */
  #denyFeedback(tool: string, suspicion: StagnationSuspicion, verdict: StagnationCheckResponse): string {
    const advice = clip((verdict.recommendedIntervention ?? '').replace(/\s+/g, ' ').trim(), 240);
    return clip(
      `Reflex intervention: ${tool} was called with identical arguments ${suspicion.repeats} times in this turn and System 1 confirms ` +
        `${verdict.patternType ?? suspicion.pattern} stagnation (confidence ${verdict.confidence.toFixed(2)}). The call was not executed. ` +
        `Change the approach: ${advice || 'use different arguments or a different tool, and inspect the previous result before retrying.'}`,
      FEEDBACK_CHARS
    );
  }

  /** The corrective context attached to the step after a repeated loop. */
  #contextFeedback(suspicion: StagnationSuspicion, verdict: StagnationCheckResponse): string {
    const advice = clip((verdict.recommendedIntervention ?? '').replace(/\s+/g, ' ').trim(), 240);
    return clip(
      `Reflex intervention: the last steps repeated the same call ${suspicion.repeats} times (System 1: ${verdict.patternType ?? suspicion.pattern}, ` +
        `confidence ${verdict.confidence.toFixed(2)}). Stop the loop and change strategy: ` +
        `${advice || 're-read the last failure, then either fix the cause or try a different tool.'}`,
      FEEDBACK_CHARS
    );
  }

  /** The corrective feedback carried by a repeated failing result. */
  #failureFeedback(tool: string, error: string, suspicion: StagnationSuspicion, verdict: StagnationCheckResponse): string {
    const advice = clip((verdict.recommendedIntervention ?? '').replace(/\s+/g, ' ').trim(), 240);
    return clip(
      `Reflex intervention: ${tool} failed ${suspicion.repeats} consecutive times with ${clip(error.replace(/\s+/g, ' ').trim(), 160)}. ` +
        `System 1 confirms ${verdict.patternType ?? suspicion.pattern} (confidence ${verdict.confidence.toFixed(2)}). ` +
        `This result is treated as a policy failure: change the command or the code before retrying. ${advice}`,
      FEEDBACK_CHARS
    );
  }

  /** The objection steered into a turn that is closing on contradicted evidence. */
  #closingFeedback(contradicted: readonly string[]): string {
    return clip(
      `Reflex closing check: this turn is about to close while its own tool results carry failures that contradict what it claims ` +
        `(${contradicted.map((item) => `"${item}"`).join('; ')}). Before concluding, either fix the failing evidence or state the failure ` +
        `plainly instead of the completion claim.`,
      FEEDBACK_CHARS
    );
  }
}

/** The installer's product: the detachers and the engine behind them. */
export interface InterventionInstallation {
  /** Detachers of every registered listener, in registration order. */
  disposers: Array<() => void>;
  /** The engine the listeners drive, for the panel and for tests. */
  engine: InterventionEngine;
}

/**
 * Install the automatic interventions of one activation.
 *
 * Registration itself is mode-aware: a capability in `off` gets no listener at
 * all, so "off" is the absence of the feature rather than a flag every hook has
 * to remember to check. A Host missing one of these hooks is tolerated: the
 * registration is guarded, so a stripped-down embedder loses one capability
 * instead of failing to load.
 *
 * What is *not* per-capability is the turn frame. One turn has one lifecycle
 * whatever combination of capabilities is enabled: `agent/pre-step` opens it —
 * the turn's counters, its step number, and its stale latches — and
 * `agent/disposed` closes it. A prune-only deployment used to get neither, so its
 * first result was counted against turn 0, its intervention cap never reset, and
 * nothing was disposed. Registering the frame once for every enabled capability is
 * what makes the budget a per-turn budget rather than an accident of which
 * capability happened to be on.
 *
 * @param ctx - registrant context.
 * @param options - engine options, including the audit sink.
 * @returns the detachers and the engine.
 */
export function installInterventions(ctx: Context, options: InterventionEngineOptions): InterventionInstallation {
  const engine = new InterventionEngine(options);
  const disposers: Array<() => void> = [];
  if (!engine.enabled) return { disposers, engine };

  const guard = (register: () => unknown): void => {
    try {
      const detach = register();
      if (typeof detach === 'function') disposers.push(detach as unknown as () => void);
    } catch {
      // A Host without the hook simply does not get that intervention.
    }
  };

  // ── the turn frame, shared by every capability that acts inside a turn ─────
  guard(() => ctx.on('agent/pre-step', (payload, next) => engine.preStep(payload, next)));
  guard(() =>
    ctx.on('agent/disposed', (payload) => {
      engine.forget(agentKeyOf(payload));
    })
  );

  // ── the result pipeline: stagnation evidence, pruning, failure evidence ────
  // Every capability reads this pipeline: stagnation needs the recorded calls,
  // pruning needs the payloads, the gate needs the failures, and the closing check
  // needs the failing evidence of the turn. Registering it for a subset would
  // silently disable the capability that was left out of the list.
  if (engine.serves('stagnation', 'prune', 'gate', 'closing')) {
    guard(() => ctx.on('tools/pre-execute', (exec, next) => engine.toolCall(exec, next)));
    guard(() => ctx.on('tools/post-execute', (exec, result, next) => engine.toolResult(exec, result, next)));
  }

  // ── the closing check's own inputs and its turn boundary ──────────────────
  if (engine.serves('closing')) {
    guard(() => ctx.on('agent/turn-stopping', (payload) => engine.turnStopping(payload)));
    guard(() =>
      ctx.on('agent/assistant-stream', (payload) => {
        engine.observeAssistantStream(payload);
      })
    );
  }

  return { disposers, engine };
}

/**
 * The isolation key of one agent, tolerating a disposal payload that wraps it.
 * @param value - an agent, or a payload carrying one.
 * @returns its key; `anonymous` when no identity is available.
 */
export function agentKeyOf(value: unknown): string {
  const direct = value as { id?: unknown } | undefined;
  if (typeof direct?.id === 'string' && direct.id.length > 0) return direct.id;
  const wrapped = (value as { agent?: { id?: unknown } } | undefined)?.agent;
  if (typeof wrapped?.id === 'string' && wrapped.id.length > 0) return wrapped.id;
  return 'anonymous';
}

/**
 * The session one agent decides in.
 * @param value - an agent, or a payload carrying one.
 * @returns the session object, or `undefined` when the agent has none.
 */
export function sessionOf(value: unknown): unknown {
  const agent = (value as { agent?: unknown } | undefined)?.agent ?? value;
  const session = (agent as { session?: unknown } | undefined)?.session;
  return session && typeof session === 'object' ? session : undefined;
}

/**
 * The identity of the session one agent decides in.
 *
 * A memo of reductions is only valid inside the run that produced it: the same
 * agent id in a resumed or forked session is a different log, with different
 * retained originals behind the same payload digests. Keying by the session —
 * and falling back to the agent itself when no session is visible — is what keeps
 * one run's cached reduction from being installed into another run.
 * @param value - an agent, or a payload carrying one.
 * @returns the session identity, or the agent's own key when it has none.
 */
export function sessionKeyOf(value: unknown): string {
  const session = sessionOf(value) as { id?: unknown } | undefined;
  return typeof session?.id === 'string' && session.id.length > 0 ? session.id : `agent:${agentKeyOf(value)}`;
}

/** The identity a repeated call is measured on: its name and its arguments. */
function callSignature(exec: ToolExecution): string {
  let args: string;
  const raw: unknown = exec.arguments;
  if (typeof raw === 'string') args = raw;
  else {
    try {
      args = JSON.stringify(raw ?? {}) ?? '';
    } catch {
      args = '';
    }
  }
  return `${exec.name}:${digestOf(args)}`;
}

/** The percentage one reduction reports, at the shared token rate. */
function reductionPercentage(originalChars: number, prunedChars: number): number {
  return originalChars === 0 ? 0 : Math.round(((originalChars - prunedChars) / originalChars) * 1000) / 10;
}

/**
 * The *candidate* sentences of one turn's assistant text.
 *
 * Deterministic and semantic-free on purpose: splitting, de-duplication, the
 * length floor, and the last-{@link MAX_CLAIMS} bound are all the local work
 * this module may do. Whether a candidate really claims completion is System
 * One's answer — an English word list would miss 中文「全部通过」 and read
 * `not complete` as the opposite, so there is none here any more.
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

// Re-exported so a Host attaching the session log does not have to import the
// audit module directly.
export { appendInterventionRecord };
