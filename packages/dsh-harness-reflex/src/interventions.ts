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
import type { PruneResponse, StagnationCheckResponse } from './vendor/harness-reflex/index.js';
import { claimCandidates } from './vendor/harness-reflex/core/closing.js';
import {
  assembleEvidence,
  evidenceOf,
  failureOf,
  type EvidenceEntry
} from './vendor/harness-reflex/core/evidence.js';
import {
  applyCharge,
  emptyBucket,
  judgmentCharge,
  suspicionOf,
  type CostCharge,
  type InterventionCostBucket,
  type JudgmentCharge,
  type StagnationSuspicion,
  type ObservedStep
} from './vendor/harness-reflex/core/judge.js';
import {
  actionWithinBudget,
  bookAction,
  modeOf,
  serves as policyServes,
  spendJudgment
} from './vendor/harness-reflex/core/policy.js';
import { applyPruneFloor } from './vendor/harness-reflex/core/prune-plan.js';
import { orchestratePrune, type PruneFeedbackFacts } from './vendor/harness-reflex/core/orchestrate.js';
import {
  CLOSING_LATCH,
  orchestrateClosing,
  type HostClosingPort
} from './vendor/harness-reflex/core/orchestrate-closing.js';
import {
  orchestrateStagnationPre,
  orchestrateStagnationStep,
  progressSteps as sharedProgressSteps,
  type HostStagnationPort,
  type JudgedCharge,
  type StagnationFeedbackFacts,
  type StagnationPlanRecord
} from './vendor/harness-reflex/core/orchestrate-stagnation.js';
import {
  describeCorrection,
  orchestrateCorrection,
  type CorrectionFeedbackFacts,
  type CorrectionPlanRecord,
  type HostCorrectionPort
} from './vendor/harness-reflex/core/orchestrate-correction.js';
import { clip, digestOf, estimateTokens, hasTextBlock, textOfContent } from './vendor/harness-reflex/core/text.js';

// The decision primitives keep their historic import path: a caller that already
// imports the intervention surface does not need a second one for them.
export { claimCandidates } from './vendor/harness-reflex/core/closing.js';
export { assembleEvidence, evidenceOf, FAILURE_MARKER, failureOf } from './vendor/harness-reflex/core/evidence.js';
export { countTrailingFailures, countTrailingRepeats, detectOscillation, suspicionOf } from './vendor/harness-reflex/core/judge.js';
export { applyPruneFloor, pruneFloorPlan, pruneMarker } from './vendor/harness-reflex/core/prune-plan.js';
export { digestOf, estimateTokens, textOfContent } from './vendor/harness-reflex/core/text.js';
export type { EvidenceEntry, EvidencePriority } from './vendor/harness-reflex/core/evidence.js';
export type { InterventionCostBucket } from './vendor/harness-reflex/core/judge.js';
export type { PruneFloorOptions, PruneFloorPlan } from './vendor/harness-reflex/core/prune-plan.js';

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
  return sharedProgressSteps(steps);
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

/**
 * The automatic-intervention engine of one plugin activation.
 *
 * One instance serves every agent in the process; all per-agent facts live in
 * {@link AgentState}, keyed by agent id, so isolation is structural rather than
 * conventional.
 */
export class InterventionEngine {
  /**
   * Resolved `interventions` block currently in force.
   *
   * Mutable through {@link updatePolicy}: the loader commits a config-only save
   * into the running activation, and every hook below reads this block per call,
   * so a threshold change is effective on the very next tool call without
   * rebuilding the engine (and without re-spending a schema run on the hot path).
   */
  #config: ResolvedInterventionsConfig;
  /** Character count above which a result is a pruning candidate (live). */
  #pruneThreshold: number;
  readonly #stagnation: Pick<StagnationDetector, 'check'>;
  readonly #prune: Pick<ToolResultPruner, 'prune'>;
  readonly #gate: Pick<ReflexGateService, 'verify' | 'classifyClaims'>;
  readonly #now: () => number;
  readonly #retain?: (session: unknown, request: PruneRetentionRequest) => PruneRetention | undefined;
  readonly #audit?: (record: InterventionAuditRecord, session: unknown) => void;

  readonly #states = new Map<string, AgentState>();
  #ownTools: ReadonlySet<string>;
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
    this.#config = options.config;
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

  /** The resolved intervention block currently in force. */
  get config(): ResolvedInterventionsConfig {
    return this.#config;
  }

  /**
   * Replace the live policy.
   *
   * Called once per actual config commit (never per tool call). Detectors and
   * per-turn state are deliberately *not* reset: a turn that is already running
   * keeps its counters and latches, and only the values each hook reads change.
   * @param config - the freshly resolved `interventions` block.
   * @param pruneThreshold - the freshly resolved top-level prune threshold.
   * @param ownTools - the live `reflex_*` names of this activation. A prefix
   *   edit renames every tool, so a frozen set would stop recognising the
   *   plugin's own output and start judging it as foreign work.
   */
  updatePolicy(config: ResolvedInterventionsConfig, pruneThreshold: number, ownTools?: readonly string[]): void {
    this.#config = config;
    this.#pruneThreshold = pruneThreshold;
    if (ownTools !== undefined) this.#ownTools = new Set(ownTools);
    // The pruning service also carries a copy of the threshold (the explicit
    // `prune` tool reads it directly). Keep it in step, otherwise lowering the
    // threshold would still be shadowed by the activation-time value. Absent on
    // the test seams that only implement `prune()`.
    (this.#prune as { setMinCharsThreshold?: (value: number) => void }).setMinCharsThreshold?.(pruneThreshold);
  }

  /** The tool names this activation treats as its own (live). */
  get ownTools(): readonly string[] {
    return [...this.#ownTools];
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
    return modeOf(this.#config, capability);
  }

  /**
   * Whether a hook serving one capability must be registered at all.
   * @param capabilities - capabilities the hook serves.
   * @returns whether at least one of them is not `off`.
   */
  serves(...capabilities: InterventionCapability[]): boolean {
    return policyServes(this.#config, ...capabilities);
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
  /**
   * How many recorded steps already carry one identity.
   *
   * The call about to run is counted separately by the shared layer, so this is
   * the count of the ones that really ran — which is what "repeated N times"
   * means to a reader.
   * @param state - the agent's bookkeeping.
   * @param signature - the identity to count.
   * @returns the number of recorded occurrences.
   */
  #priorSame(state: AgentState, signature: string): number {
    return state.steps.filter((step) => step.signature === signature).length;
  }

  async toolCall(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    const downstream = await next();
    if (!this.config.enabled) return downstream;
    if (this.#ownTools.has(exec.name)) return downstream;
    // Checked here, outside the fail-open guard below, exactly as before: a call
    // whose signal is already aborted is not a planning failure and must not be
    // reported as one.
    if (exec.signal?.aborted) return downstream;

    const agentId = agentKeyOf(exec.agent);
    const state = this.#state(agentId, exec.agent);
    const signature = callSignature(exec);
    const waitShape = isWaitQuery(exec) ? 'wait-query' : pollShapeOf(exec);
    let waitSuspected = false;

    // The decision itself is the shared layer's (see
    // `core/orchestrate-stagnation.ts`); this method only answers the questions
    // this Host alone can answer. Everything that remains here is a DSH fact: the
    // agent's state slot, the call-signature algorithm, the job-tool list that
    // defines a wait, the message and decision types, and the wording the model
    // reads.
    const port: HostStagnationPort<PreToolDecision, PreStepDecision> = {
      policy: () => this.#config,
      budget: () => state,
      // One purchase: the service's answer, latency included. The purchase around
      // it (memo, budgets, latency split, charge) is the shared layer's.
      buy: async (step) => this.#stagnation.check(step.goal, [...step.history]),
      clock: () => ({ now: () => this.#now() }),
      serves: () => this.#config.enabled,
      toolName: () => exec.name,
      window: () => state.steps,
      // The call about to run is a retry exactly when this identity failed before.
      pendingStep: () =>
        ({
          signature,
          tool: exec.name,
          input: clip(this.#argumentsOf(exec), STEP_CHARS),
          output: '',
          error: '',
          failed: state.steps.some((step) => step.signature === signature && step.failed),
          turn: state.turn,
          at: this.#now()
        }) satisfies ObservedStep,
      signature: () => signature,
      progressWindow: () => progressSteps(state.steps),
      suspicion: (steps) =>
        suspicionOf(steps, {
          repeatThreshold: this.config.repeatThreshold,
          failureThreshold: this.config.failureThreshold,
          window: this.config.windowSize,
          signature
        }),
      alreadyIntervened: () => state.applied.has(`stagnation:${signature}`),
      alreadyDenied: () => state.denied.has(signature),
      wasClassifiedAsWait: (stepSignature) => state.waited.has(stepSignature),
      latchDenied: () => state.denied.add(signature),
      latchIntervened: () => state.applied.add(`stagnation:${signature}`),
      passThrough: () => downstream,
      deny: (feedback) => ({ kind: 'deny', reason: feedback }),
      // Pre-execute never corrects a step: the correction belongs to the pre-step
      // hook, whose port answers this. Reaching it here would mean the shared
      // layer asked the wrong hook, so it is a programming error, not a branch.
      correct: (feedback) => {
        throw new Error(`toolCall cannot attach a correction (${feedback.length} chars)`);
      },
      denyFeedback: (facts) => this.#denyFeedback(exec.name, facts.suspicion, facts.verdict),
      contextFeedback: (facts) => this.#contextFeedback(facts.suspicion, facts.verdict),
      skip: (reason, charge) =>
        this.#skip(reason, {
          capability: 'stagnation',
          state,
          agent: exec.agent,
          ...(charge === undefined ? {} : { judgment: charge })
        }),
      chargeJudgment: (charge: JudgedCharge) => this.#charge('stagnation', charge),
      conclude: (plan: StagnationPlanRecord, applied: boolean, charge: JudgedCharge) =>
        this.#conclude(plan as InterventionPlan, applied, exec.agent, { potentialSavedTokens: 0 }, charge)
    };

    // Whether this call reached the wait question, which only decides the
    // fail-open reason: a wait whose judge could not answer is reported with its
    // own reason instead of the generic one.
    waitSuspected =
      waitShape !== undefined &&
      this.#priorSame(state, signature) + 1 >= this.config.repeatThreshold;
    try {
      const outcome = await orchestrateStagnationPre(
        {
          downstreamKind: downstream.kind,
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
          ...(waitShape === undefined
            ? {}
            : {
                waitShape: () => ({ shape: waitShape, repeats: this.#priorSame(state, signature) + 1 }),
                waitClassified: () => state.waited.has(signature),
                latchWait: () => state.waited.add(signature),
                // A wait question is judged on the polls themselves: the backend
                // reasons about the run, and labelling each poll with its place in
                // the series keeps a sanctioned wait from reading as an exact
                // repeat. How a poll is labelled is this Host's business.
                judgeSteps: () => annotateWaitHistory([...state.steps, port.pendingStep()], signature),
                waitQuestion: () => waitGoalOf(exec, waitShape, this.#priorSame(state, signature) + 1)
              }),
          noteRefused: () => state.refused.add(callKeyOf(exec))
        },
        port
      );
      return outcome.result;
    } catch {
      // FAIL-OPEN: a planning failure must never veto a call the rest of the
      // waterfall already allowed.
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

      // Turn bookkeeping above is this Host's and stays here: it is what the
      // closing check and the prune memo read, and it belongs to whoever owns
      // the turn boundary. What is shared is the *decision* that follows.
      const agentIdForCorrection = agentId;
      const port: HostStagnationPort<PreStepDecision, PreStepDecision> = {
        policy: () => this.#config,
        budget: () => state,
        buy: async (step) => this.#stagnation.check(step.goal, [...step.history]),
        clock: () => ({ now: () => this.#now() }),
        serves: () => this.#config.enabled,
        toolName: () => state.steps[state.steps.length - 1]?.tool ?? '',
        window: () => state.steps,
        pendingStep: () => state.steps[state.steps.length - 1] as ObservedStep,
        signature: () => state.steps[state.steps.length - 1]?.signature ?? '',
        progressWindow: () => progressSteps(state.steps),
        suspicion: (steps) =>
          suspicionOf(steps, {
            repeatThreshold: this.config.repeatThreshold,
            failureThreshold: this.config.failureThreshold,
            window: this.config.windowSize,
            signature: state.steps[state.steps.length - 1]?.signature ?? ''
          }),
        alreadyIntervened: () => state.applied.has(`stagnation:${state.steps[state.steps.length - 1]?.signature ?? ''}`),
        alreadyDenied: () => false,
        wasClassifiedAsWait: (stepSignature) => state.waited.has(stepSignature),
        latchDenied: () => undefined,
        latchIntervened: () => state.applied.add(`stagnation:${state.steps[state.steps.length - 1]?.signature ?? ''}`),
        passThrough: () => downstream,
        deny: () => downstream,
        // The correction is appended to the messages the rest of the waterfall
        // admitted; the array it was given is not mutated in place.
        //
        // `downstream.messages` is read without a fallback on purpose. An `enter`
        // decision always carries the list, so an absent one means the rest of the
        // waterfall handed back something this Host cannot correct — and the
        // fail-open guard below is what should record that, not a silent
        // `messages: [correction]` that drops the very messages the step admitted.
        correct: (feedback) =>
          ({
            ...downstream,
            messages: [
              ...(downstream as unknown as { messages: UserMessage[] }).messages,
              this.#message(agentIdForCorrection, state.turn, payload.step, feedback)
            ]
          }) as PreStepDecision,
        denyFeedback: (facts) => this.#denyFeedback(facts.tool, facts.suspicion, facts.verdict),
        contextFeedback: (facts) => this.#contextFeedback(facts.suspicion, facts.verdict),
        skip: (reason, charge) =>
          this.#skip(reason, {
            capability: 'stagnation',
            state,
            agent: payload.agent,
            ...(charge === undefined ? {} : { judgment: charge })
          }),
        chargeJudgment: (charge: JudgedCharge) => this.#charge('stagnation', charge),
        conclude: (plan: StagnationPlanRecord, applied: boolean, charge: JudgedCharge) =>
          this.#conclude(plan as InterventionPlan, applied, payload.agent, { potentialSavedTokens: 0 }, charge)
      };

      // The abort is checked *before* the shared call and the catch below is
      // left to do what it always did: a pre-step that throws is reported as a
      // planning error, and that report is what a cancelled turn has always left
      // in the log. Passing the signal through instead would make the shared
      // layer answer `aborted` and leave no trace at all — a quieter outcome, but
      // a different one.
      if (payload.signal?.aborted === true) return downstream;
      const outcome = await orchestrateStagnationStep(
        {
          downstreamKind: downstream.kind,
          // `undefined` is not passed on: the shared layer only knows a signal it
          // can act on, and an absent one has to stay absent.
          signal: undefined
        },
        port
      );
      return outcome.result;
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
    // The mode check happens in the shared layer, deliberately: "off" is not a
    // weaker decision, it is the absence of one, and a host that read the mode
    // here as well would be the second place the switch is interpreted.
    // The very first question is whether this decision exists at all. A turn that
    // closes while the capability is off (or the master switch is off) must leave
    // no trace — not even an empty per-agent state, which would show up in
    // `stateOf()` as an agent the engine has seen. Asking it before touching any
    // state is what keeps "off" the absence of a decision rather than a decision
    // that did nothing.
    if (this.modeOf('closing') === 'off' || !this.config.enabled) return;
    const started = this.#now();
    try {
      const agentId = agentKeyOf(payload.agent);
      const state = this.#state(agentId, payload.agent);
      const turn = payload.turn;
      const port: HostClosingPort = {
        policy: () => this.#config,
        budget: () => state,
        clock: () => ({ now: () => this.#now() }),
        serves: () => this.#config.enabled,
        mode: () => this.modeOf('closing'),
        claims: () => state.claims,
        evidenceSuspect: () => state.evidenceSuspect,
        evidence: () => state.evidence,
        evidenceBudget: () => this.config.closingEvidenceChars,
        aborted: () => payload.signal?.aborted === true,
        // The latch is *per turn*, not per signature: a closing episode is the
        // turn itself. This is the one latch that does not fit the `Host*Port`
        // shape the other capabilities use.
        alreadyObjected: () => state.applied.has(CLOSING_LATCH.applied(turn)),
        latchObjected: () => state.applied.add(CLOSING_LATCH.applied(turn)),
        agentId: () => agentId,
        classify: async (request) => {
          const answer = await this.#gate.classifyClaims({
            statements: [...request.statements],
            intent: this.config.intent,
            context: request.context
          });
          return answer;
        },
        verify: async (claims, evidence, options) => {
          const answer = await this.#gate.verify([...claims], evidence, options);
          return answer;
        },
        claimMinConfidence: () => this.config.claimMinConfidence,
        describe: (facts) => this.#closingFeedback(facts.contradicted),
        // The action itself stays here. Steering is the only way a listener may
        // extend a turn, and the message it carries is this Host's to word.
        steer: (feedback) => this.#steer(payload.agent, this.#message(agentId, turn, state.step, feedback)),
        // `#evidenceStats` is engine-level, not per-agent: it counts what this
        // activation assembled, across every agent it served.
        noteEvidence: (stats) => {
          this.#evidenceStats.retainedChars += stats.retainedChars;
          this.#evidenceStats.truncatedChars += stats.truncatedChars;
        },
        skip: (reason, charge) =>
          this.#skip(reason, {
            capability: 'closing',
            state,
            agent: payload.agent,
            ...(charge === undefined ? {} : { judgment: charge })
          }),
        chargeJudgment: (charge) => this.#charge('closing', charge),
        conclude: (plan, applied, charge) =>
          this.#conclude(plan as InterventionPlan, applied, payload.agent, { potentialSavedTokens: 0 }, charge)
      };
      void started;
      // The position is an input of the closing decision, never a port accessor:
      // the turn is the boundary being closed (which can be a turn no step has
      // recorded yet), and the step is the one this engine last recorded.
      await orchestrateClosing({ position: { turn, step: state.step } }, port);
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
    // The decision itself is the shared layer's (see `core/orchestrate.ts`); this
    // method only answers the questions this Host alone can answer. Everything
    // that stays here is a DSH fact: the agent's state slot, the session log
    // sink, the content-block shape, and the wording the panel shows.
    const outcome = await orchestratePrune(
      {
        callId: exec.callId,
        tool: exec.name,
        text,
        blockedByDownstream: downstream.kind === 'block',
        valueShapedAccept: 'value' in downstream && downstream.value !== undefined,
        started
      },
      {
        policy: () => this.#config,
        budget: () => state,
        // The shared base asks "does this capability apply" the same way for every
        // capability; for pruning the answer is the effective mode. `mode()` stays
        // because the pruning decision needs the three-valued answer, not the
        // boolean.
        serves: () => this.modeOf('prune') !== 'off' && this.#config.enabled,
        clock: () => ({ now: () => this.#now() }),
        mode: () => this.modeOf('prune'),
        threshold: () => this.#pruneThreshold,
        floor: () => ({
          floorRatio: this.config.pruneFloorRatio,
          headChars: this.config.pruneHeadChars,
          tailChars: this.config.pruneTailChars
        }),
        now: () => this.#now(),
        memoKey: () => state.sessionKey,
        memoGet: (key) => this.#memoGetByKey(key),
        memoSet: (key, entry) => this.#memoSetByKey(key, entry),
        judge: async (raw) => {
          // Both modes ask for the *real* candidate, measure-only. The service
          // writes its own ledger entry first; whether the payload is installed is
          // decided afterwards, by the floor.
          const response = await this.#prune.prune(raw, {
            intent: this.config.intent,
            measureOnly: true,
            pruneJudgeMinChars: this.config.pruneJudgeMinChars
          });
          return {
            processedOutput: response.processedOutput,
            reductionPercentage: response.reductionPercentage,
            shadow: response.shadow,
            latencyMs: response.latencyMs,
            diagnostics: pruneDiagnosticsOf(response)
          };
        },
        // DSH's sink names a copy after the plugin record type, and the engine
        // must predict that name or every install would be rebuilt.
        locatorOf: (digest) => pruneLocator(digest),
        hasRetention: () => this.#retain !== undefined,
        retain: (request, session) => this.#retain?.(session, request),
        session: () => sessionOf(exec.agent),
        hasTextBlock: () => hasTextBlock(effective),
        install: (installedText) => {
          const replacement = this.#replaceText(effective, installedText);
          if (!replacement) return undefined;
          return {
            kind: 'accept',
            content: replacement,
            ...(downstream.additionalContexts && downstream.additionalContexts.length > 0
              ? { additionalContexts: [...downstream.additionalContexts] }
              : {})
          } satisfies PostToolDecision;
        },
        describe: (facts) => this.#pruneFeedback(facts),
        skip: (reason, detail, judgment) =>
          this.#skip(reason, {
            capability: 'prune',
            state,
            agent: exec.agent,
            ...(Object.keys(detail).length === 0 ? {} : { detail: detail as InterventionSkipDetail }),
            ...(judgment === undefined ? {} : { judgment })
          }),
        chargeJudgment: (judgment, originalTokens) =>
          this.#charge('prune', {
            ...judgment,
            originalTokens: originalTokens ?? 0,
            candidateTokens: 0,
            potentialSavedTokens: 0,
            actualSavedTokens: 0,
            injectedTokens: 0
          }),
        conclude: (plan, applied, costs, judgment, locator) =>
          this.#conclude(plan, applied, exec.agent, costs, judgment, locator),
        noteRetained: (locator) => this.#noteRetained(locator),
        passThrough: () => downstream
      }
    );
    // No cast: the port's `Result` is this host's decision type, so the generic
    // carries it from `passThrough`/`install` all the way out.
    return outcome.result;
  }

  /**
   * `tools/post-execute`: rewrite a result the run keeps failing to change.
   *
   * The *order* of this decision — the failure latch, the turn's allowance, the
   * judgment and its memo, the episode latch, the booking — is
   * `orchestrateCorrection`'s. What stays here is everything the shared layer
   * cannot know:
   *
   * - **the window**: `state.steps`, recorded by this engine. It is handed over
   *   *unfiltered*, unlike the stagnation windows: a failing poll is a failure
   *   even though a wait is not progress, so `progressSteps` would be the wrong
   *   rule on this path;
   * - **the strength of the action**: `apply` answers with a `block` carrying the
   *   feedback, which replaces the result outright. That is this Host's way of
   *   showing a correction; a command hook would carry the same text as context
   *   next to the untouched result, and the shared layer may not pick for it;
   * - **the wording**: `describeCorrection` is the product text, and it is this
   *   plugin's, not the core's — the same decision read by a different host
   *   should still read naturally to that host's user.
   *
   * @param exec - the call whose result failed.
   * @param result - the canonical outcome, for its error text.
   * @param downstream - what the rest of the waterfall decided for the result.
   * @param state - the deciding agent's bookkeeping.
   * @param signature - the identity of the failure episode.
   * @param started - clock reading at hook entry, for the latency split.
   * @returns the result the Host commits.
   */
  async #correctFailure(
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    downstream: PostToolDecision,
    state: AgentState,
    signature: string,
    started: number
  ): Promise<PostToolDecision> {
    const agentId = agentKeyOf(exec.agent);
    const error = this.#errorOf(result);
    const port: HostCorrectionPort<PostToolDecision> = {
      policy: () => this.#config,
      budget: () => state,
      buy: async (step) => this.#stagnation.check(step.goal, [...step.history]),
      clock: () => ({ now: () => this.#now() }),
      serves: () => this.#config.enabled,
      toolName: () => exec.name,
      error: () => error,
      // Deliberately the raw window, not the progress-only one: see the doc above.
      window: () => state.steps,
      signature: () => signature,
      suspicion: (steps) =>
        suspicionOf(steps, {
          repeatThreshold: this.config.repeatThreshold,
          failureThreshold: this.config.failureThreshold,
          window: this.config.windowSize,
          signature
        }),
      alreadyCorrected: () => state.applied.has(`gate:${signature}`),
      latchCorrected: () => state.applied.add(`gate:${signature}`),
      passThrough: () => downstream,
      // This Host's strength for a correction: the result is replaced by the
      // feedback. `additionalContexts` the rest of the waterfall attached are
      // carried over, so somebody else's context is not lost to ours.
      apply: (feedback) => ({
        kind: 'block',
        feedback: [{ type: 'text', text: feedback }],
        ...(downstream.additionalContexts && downstream.additionalContexts.length > 0
          ? { additionalContexts: [...downstream.additionalContexts] }
          : {})
      }),
      describe: (facts: CorrectionFeedbackFacts) =>
        describeCorrection(facts, { errorChars: 160, adviceChars: 240, totalChars: FEEDBACK_CHARS }),
      skip: (reason, charge) =>
        this.#skip(reason, {
          capability: 'gate',
          state,
          agent: exec.agent,
          ...(charge === undefined ? {} : { judgment: charge })
        }),
      chargeJudgment: (charge: JudgedCharge) => this.#charge('gate', charge),
      conclude: (plan: CorrectionPlanRecord, applied: boolean, charge: JudgedCharge) =>
        this.#conclude(plan as InterventionPlan, applied, exec.agent, { potentialSavedTokens: 0 }, charge)
    };
    // `started` is kept in the signature because it is what the *hook* measured,
    // and the shared layer takes its own reading at the moment the judgment is
    // bought. Both read the same clock, so the latency this decision reports is
    // unchanged by the lift; the parameter stays so a later local-latency rule
    // can still see the hook's own entry time.
    void started;
    void agentId;
    const outcome = await orchestrateCorrection({ failed: true, blockedByDownstream: downstream.kind === 'block' }, port);
    return outcome.result;
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
    const charge: CostCharge = {
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
  #charge(capability: InterventionCapability, charge: CostCharge, plans = 0, applied = 0): void {
    const mode = this.modeOf(capability) === 'active' ? 'active' : 'observe';
    for (const bucket of [this.#costs[mode], this.#byCapability[capability]]) {
      applyCharge(bucket, plans, applied, charge);
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
  #pruneFeedback(facts: PruneFeedbackFacts): string {
    const { tool, originalTokens, candidateTokens, ...outcome } = facts;
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

  /**
   * Count one retained copy for the panel, once per payload.
   *
   * A duplicate install reuses the copy that is already in the log, so the
   * locator naming it never changes and the recent list keeps one entry.
   * @param locator - the locator the replacement published.
   */
  #noteRetained(locator: string): void {
    if (!this.#retained.includes(locator)) {
      this.#retained.push(locator);
      if (this.#retained.length > MAX_RECENT) this.#retained.shift();
    }
    this.#retainedCopies += 1;
  }

  /** The memoized reduction under one already-namespaced key, when remembered. */
  #memoGetByKey(key: string): PruneMemo | undefined {
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
  #memoSetByKey(key: string, memo: PruneMemo): void {
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

/** The installer's product: the detachers, the engine behind them, and live reconfiguration. */
export interface InterventionInstallation {
  /** Detachers of every currently registered listener, in registration order. */
  disposers: Array<() => void>;
  /** The engine the listeners drive, for the panel and for tests. */
  engine: InterventionEngine;
  /**
   * Apply a freshly resolved intervention policy without a remount.
   *
   * Thresholds are swapped on the engine and the listener set is reconciled with
   * the new effective modes: a capability turned `off` loses its hooks (zero
   * listeners and zero per-call overhead), one turned back on gets them again.
   * The engine's per-agent turn state is deliberately preserved, so a settings
   * save in the middle of a turn does not restart that turn's counters.
   * @param config - freshly resolved `interventions` block.
   * @param pruneThreshold - freshly resolved top-level prune threshold.
   * @param ownTools - freshly resolved `reflex_*` names, so a prefix rename
   *   keeps the plugin's own output out of its own judgments.
   */
  reconfigure(config: ResolvedInterventionsConfig, pruneThreshold: number, ownTools?: readonly string[]): void;
  /** The number of listeners currently attached (0 when every capability is off). */
  readonly listenerCount: number;
  /** Detach every listener; idempotent. */
  dispose(): void;
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
 * The set is reconciled at install *and* on every config-only save, because the
 * loader commits the new volatile values into the running activation instead of
 * remounting it: {@link InterventionInstallation.reconfigure} adds the hooks a
 * newly enabled capability needs and removes those of a capability switched off.
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
 * @returns the detachers, the engine, and the live reconfiguration seam.
 */
export function installInterventions(ctx: Context, options: InterventionEngineOptions): InterventionInstallation {
  const engine = new InterventionEngine(options);
  const disposers: Array<() => void> = [];
  /** Attached hook groups, keyed by the capability set they serve. */
  const groups = new Map<'frame' | 'pipeline' | 'closing', Array<() => void>>();
  let disposed = false;

  /**
   * Register every hook of one group, tolerating a Host without that hook.
   * @param group - the group to attach.
   */
  const attach = (group: 'frame' | 'pipeline' | 'closing'): void => {
    if (groups.has(group)) return;
    const detachers: Array<() => void> = [];
    const guard = (register: () => unknown): void => {
      try {
        const detach = register();
        if (typeof detach === 'function') {
          const fn = detach as unknown as () => void;
          detachers.push(fn);
          disposers.push(fn);
        }
      } catch {
        // A Host without the hook simply does not get that intervention.
      }
    };

    if (group === 'frame') {
      // ── the turn frame, shared by every capability that acts inside a turn ──
      guard(() => ctx.on('agent/pre-step', (payload, next) => engine.preStep(payload, next)));
      guard(() =>
        ctx.on('agent/disposed', (payload) => {
          engine.forget(agentKeyOf(payload));
        })
      );
    } else if (group === 'pipeline') {
      // ── the result pipeline: stagnation evidence, pruning, failure evidence ─
      // Every capability reads this pipeline: stagnation needs the recorded
      // calls, pruning needs the payloads, the gate needs the failures, and the
      // closing check needs the failing evidence of the turn.
      guard(() => ctx.on('tools/pre-execute', (exec, next) => engine.toolCall(exec, next)));
      guard(() => ctx.on('tools/post-execute', (exec, result, next) => engine.toolResult(exec, result, next)));
    } else {
      // ── the closing check's own inputs and its turn boundary ────────────────
      guard(() => ctx.on('agent/turn-stopping', (payload) => engine.turnStopping(payload)));
      guard(() =>
        ctx.on('agent/assistant-stream', (payload) => {
          engine.observeAssistantStream(payload);
        })
      );
    }
    groups.set(group, detachers);
  };

  /**
   * Detach one group and drop its entries from the public detacher list.
   * @param group - the group to detach.
   */
  const detach = (group: 'frame' | 'pipeline' | 'closing'): void => {
    const detachers = groups.get(group);
    if (!detachers) return;
    groups.delete(group);
    for (const dispose of detachers.reverse()) {
      dispose();
      const index = disposers.lastIndexOf(dispose);
      if (index >= 0) disposers.splice(index, 1);
    }
  };

  /**
   * Reconcile the attached listeners with the effective capability modes.
   */
  const sync = (): void => {
    if (disposed) return;
    const wanted = new Set<'frame' | 'pipeline' | 'closing'>();
    if (engine.enabled) {
      wanted.add('frame');
      // The result pipeline feeds every capability; it is present whenever any
      // of them is, exactly as it was before the live path existed.
      wanted.add('pipeline');
      if (engine.serves('closing')) wanted.add('closing');
    }
    for (const group of ['closing', 'pipeline', 'frame'] as const) {
      if (!wanted.has(group)) detach(group);
    }
    for (const group of ['frame', 'pipeline', 'closing'] as const) {
      if (wanted.has(group)) attach(group);
    }
  };

  sync();

  return {
    disposers,
    engine,
    reconfigure(config: ResolvedInterventionsConfig, pruneThreshold: number, ownTools?: readonly string[]): void {
      if (disposed) return;
      engine.updatePolicy(config, pruneThreshold, ownTools);
      sync();
    },
    get listenerCount(): number {
      return disposers.length;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      detach('closing');
      detach('pipeline');
      detach('frame');
    }
  };
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


// Re-exported so a Host attaching the session log does not have to import the
// audit module directly.
export { appendInterventionRecord };
