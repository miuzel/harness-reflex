/**
 * The prune parity harness: one input sequence, two engines, one comparison.
 *
 * ## Why this exists
 *
 * Moving the pruning decision out of the DSH engine and into the shared core is
 * a rewrite of a branch whose *order of operations* is a safety property: the
 * original is retained before anything is replaced, and a saving is recorded
 * only after the replacement is verified smaller. A refactor that silently
 * changes one skip reason, one budget movement, or one byte of accounting is a
 * regression that no single-branch unit test catches, because every unit test
 * still passes on the branch it was written for.
 *
 * So the oracle is the code itself. {@link ./baseline/interventions.js}
 * is a byte-exact copy of the engine as it stood before the refactor, kept out
 * of the plugin's tsconfig so it is not part of any shipped artifact. The
 * harness replays the same script through that snapshot and through the live
 * engine, normalizes both, and asserts the two are deeply equal.
 *
 * ## What is compared
 *
 * Everything that decides or describes a decision:
 *
 * - the returned `PostToolDecision` (kind, the installed content, any
 *   additional contexts) — this is the model-visible surface;
 * - every audit record the engine emitted, in order, with the clock and the
 *   subject agent normalized away;
 * - the skip histogram;
 * - the per-capability and per-mode cost buckets, field by field — this is the
 *   "budget consumption" half of the comparison, and it is why the corpus
 *   contains ceiling-reaching scripts;
 * - the retention locators, and the digest → retained text map, so a reduction
 *   is only "the same" if it publishes the same locator *and* the original it
 *   claims to have kept is really the same bytes;
 * - the per-agent counters (turn, step, steps retained, actions booked,
 *   judgments) after the run.
 *
 * ## What is normalized away, and why
 *
 * Only two families of field are dropped, and both are checked for the property
 * that makes dropping them safe (see the negative controls in the sibling test):
 *
 * | Dropped | Why |
 * |---|---|
 * | `at` timestamps | wall clock; two engines never run on the same instant |
 * | `localLatencyMs` / `remoteLatencyMs` | derived from the same clock |
 * | the response's `latencyMs` in the corpus | a *fake service's* answer, not a decision; the corpus zeroes it so that the latency columns above are the only clock-derived fields left, and {@link clockFreeView} then proves they carry nothing }
 *
 * Everything else — including `memoHit`, `judgeTokens`, `injectedTokens`,
 * `originalLocator`, `digest`, and the counts inside `feedback` — stays in the
 * comparison verbatim.
 *
 * @module prune-parity
 */

import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';

import { InterventionEngine, type InterventionEngineOptions } from './interventions.js';
import { InterventionEngine as BaselineEngine } from './baseline/interventions.js';
import type { InterventionAuditRecord } from './session-audit.js';
import { resolveConfig, type ResolvedInterventionsConfig } from './config.js';
import { pruneLocator } from './session-audit.js';
import type { ClosingShape, PruneScript, PruneStep, StagnationShape } from './prune-parity-scripts.js';
import type { PruneResponse } from './vendor/harness-reflex/index.js';

/** Clock reading every replayed engine sees, so nothing depends on wall time. */
const FIXED_NOW = 1_700_000_000_000;

/**
 * The first text block of a decision's content, for a readable installed-text
 * column. `undefined` when the decision carries no text block at all.
 * @param decision - what the engine returned.
 * @returns the installed text, or undefined.
 */
export function installedTextOf(decision: unknown): string | undefined {
  const content = (decision as { content?: readonly { type?: string; text?: string }[] }).content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find((entry) => entry !== null && typeof entry === 'object' && entry.type === 'text');
  return block?.text;
}

/** One content block, reduced to what a decision can say about it. */
function contentOf(decision: unknown): readonly unknown[] | undefined {
  const content = (decision as { content?: unknown }).content;
  return Array.isArray(content) ? content : undefined;
}

/**
 * Drop the clock-derived columns of one audit record.
 *
 * Only these three are clock-derived; everything else is a decision fact.
 * @param record - one audit record.
 * @returns the same record without its clock columns.
 */
function clockFreeRecord(record: InterventionAuditRecord): Record<string, unknown> {
  const { localLatencyMs: _local, remoteLatencyMs: _remote, at: _at, ...rest } = record as unknown as Record<string, unknown> & {
    localLatencyMs?: number;
    remoteLatencyMs?: number;
    at?: number;
  };
  return rest;
}

/**
 * The clock-free view of an entire audit trail.
 *
 * Exported so a negative control can assert that dropping the clock removes
 * *only* clock-derived fields — i.e. that the normalization is not hiding a
 * decision.
 * @param records - every record the engine emitted.
 * @returns the records, in order, without clock columns.
 */
export function clockFreeView(records: readonly InterventionAuditRecord[]): readonly Record<string, unknown>[] {
  return records.map(clockFreeRecord);
}

/** A replayable agent identity: enough for the engine's `agentKeyOf` and `sessionOf`. */
function fakeAgent(id: string): unknown {
  return { id, options: {}, session: { header: { origin: 'user', delegationDepth: 0 } } };
}

/** A signal that is already aborted, for the call the engine must leave alone. */
const ABORTED = (() => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
})();

/**
 * A tool execution, shaped the way the Host hands one to a hook.
 * @param name - tool name.
 * @param args - the call's arguments.
 * @param agent - the calling agent.
 * @param aborted - whether the call's signal is already aborted.
 * @returns the execution.
 */
function execOf(
  name: string,
  args: unknown,
  agent: unknown,
  aborted = false,
  ordinal?: number
): ToolExecution {
  // The call identities are unique per execution, as the Host's are: a `callId`
  // is minted once per call, so two calls can never share one even when they are
  // the same command with the same arguments. An engine that keyed anything by
  // the call rather than by the *signature* would be caught by a corpus that
  // reused the identity, so the corpus deliberately does not.
  const identity = ordinal === undefined ? name : `${name}-${ordinal}`;
  return {
    callId: `call-${identity}`,
    token: `token-${identity}`,
    rootCallId: `root-${identity}`,
    name,
    arguments: args,
    signal: aborted ? ABORTED : new AbortController().signal,
    agent
  } as unknown as ToolExecution;
}

/**
 * The result of one call.
 *
 * `content` carries the payload; `value` is present only for a value-shaped
 * accept, because that is the shape the engine branches on.
 * @param step - the tool step.
 * @returns the result the Host would have produced.
 */
function resultOf(step: Extract<PruneStep, { ev: 'tool' }>): Readonly<ToolExecutionResult> {
  const content = step.out.length === 0 ? [] : [{ type: 'text', text: step.out }];
  return {
    isError: step.isError === true,
    ...(step.isError === true ? { error: { name: 'ToolError', message: step.out } } : { value: step.out }),
    content,
    meta: {}
  } as unknown as Readonly<ToolExecutionResult>;
}

/** The decision the rest of the waterfall produced, per step. */
function downstreamOf(step: Extract<PruneStep, { ev: 'tool' }>): PostToolDecision {
  const result = resultOf(step);
  switch (step.downstream) {
    case 'block':
      return { kind: 'block' } as unknown as PostToolDecision;
    case 'value':
      return { kind: 'accept', content: [...(result.content ?? [])], value: { custom: 'value' } } as unknown as PostToolDecision;
    default:
      return { kind: 'accept', content: [...(result.content ?? [])] } as unknown as PostToolDecision;
  }
}

/** The decision the rest of the pre-execute waterfall produced, per step. */
function preDecisionOf(step: Extract<PruneStep, { ev: 'tool' }>): unknown {
  switch (step.pre) {
    case 'deny':
      return { kind: 'deny', reason: 'policy' };
    case 'ask':
      return { kind: 'ask', reason: 'confirm' };
    case 'block':
      return { kind: 'block', reason: 'blocked' };
    default:
      return { kind: 'allow' };
  }
}

/**
 * A pre-execute decision, as the comparison reads it.
 *
 * The engine's one added decision is a `deny`, so the reason text is *kept*: it
 * is the model-facing refusal, and a refactor that changed its wording would be
 * a product change this harness must see. Everything else is reduced to its kind,
 * which is what "the downstream decision comes back untouched" means.
 * @param decision - what the hook returned.
 * @returns the comparable form.
 */
function describePre(decision: unknown): unknown {
  const kind = (decision as { kind?: string } | undefined)?.kind;
  if (kind !== 'deny') return { kind };
  return { kind, reason: (decision as { reason?: unknown }).reason ?? null };
}

/**
 * A pre-step decision, as the comparison reads it.
 *
 * The message list is compared by the text each entry carries plus its source
 * kind, not by message id: the id is minted from a per-engine counter, and two
 * engines that emit the same correction at the same point must agree on what the
 * loop is told, not on which integer named it.
 * @param decision - what the hook returned.
 * @returns the comparable form.
 */
function describePreStep(decision: unknown): unknown {
  const value = decision as { kind?: string; messages?: readonly unknown[] } | undefined;
  if (value === undefined) return null;
  return {
    kind: value.kind ?? null,
    messages: Array.isArray(value.messages)
      ? value.messages.map((message) => {
          const entry = message as { role?: string; content?: readonly { type?: string; text?: string }[]; source?: { kind?: string } };
          return {
            role: entry.role ?? null,
            source: entry.source?.kind ?? null,
            text: entry.content?.map((block) => block.text ?? '').join('') ?? ''
          };
        })
      : null
  };
}

/**
 * The corrective text a post-execute decision carries, when it carries one.
 *
 * The correction path's model-facing surface is `kind: 'block'` plus a feedback
 * list — there is no `content` to compare and no refusal `reason` either. A
 * trace that recorded only the kind would therefore compare two engines on
 * *whether* a result was corrected and never on *what the model was told*, which
 * is exactly the half of this branch a wording refactor moves. Each entry is
 * reduced to its type and its text, byte for byte.
 * @param decision - what the hook returned.
 * @returns the feedback entries, or `null` when there are none.
 */
function describeFeedback(decision: unknown): readonly unknown[] | null {
  const feedback = (decision as { feedback?: unknown }).feedback;
  if (!Array.isArray(feedback)) return null;
  return feedback.map((entry) => {
    const block = entry as { type?: string; text?: string };
    return { type: block.type ?? null, text: block.text ?? null };
  });
}

/**
 * Replay one `agent/turn-stopping` boundary.
 *
 * The closing check steers a corrective message into the recipient; the replay
 * records what the engine returned and what it steered, so a stagnation change
 * that disturbed the closing state is visible.
 * @param engine - the engine under replay.
 * @param agent - the agent whose turn is closing.
 * @param step - the stop step.
 * @returns the comparable form.
 */
async function replayStop(
  engine: InterventionEngine,
  agent: unknown,
  step: Extract<PruneStep, { ev: 'turn-stop' }>
): Promise<unknown> {
  const steered: unknown[] = [];
  const recipient = {
    ...(agent as Record<string, unknown>),
    steer: (message: unknown) => {
      const entry = message as { content?: readonly { text?: string }[]; source?: { kind?: string } };
      steered.push({ source: entry.source?.kind ?? null, text: entry.content?.map((block) => block.text ?? '').join('') ?? '' });
    }
  };
  // The stream frame is the Host's shape, not a convenience: the closing check
  // only accumulates `text-delta` chunks, so anything else would silently leave
  // the turn with no claims and make the check unreachable in every script.
  engine.observeAssistantStream({ agent: recipient, frame: { type: 'chunk', chunk: { type: 'text-delta', text: step.claims } } });
  let outcome: unknown = 'returned';
  try {
    await engine.turnStopping({ agent: recipient, turn: step.turn });
  } catch (error) {
    // A closing check that throws would be a fail-open regression the comparison
    // has to see rather than a crash that stops the replay.
    outcome = { threw: (error as Error).message };
  }
  // The latch and the steering are the two model-facing consequences of this
  // hook, so both are recorded: an objection reported without the message it
  // steered would let a lift that decided but published nothing pass.
  return { steered, outcome, latched: engine.hasApplied(String((agent as { id?: string }).id ?? ''), `closing:turn:${step.turn}`) };
}

// ── the fakes ───────────────────────────────────────────────────────────────

/**
 * A pruning service whose candidate is derived from the payload shape, with a
 * zero latency so no clock value can enter the comparison through it.
 *
 * The mapping is deliberately crude — it is *not* the oracle; both engines see
 * the same candidate for the same payload, which is all that is required.
 * @param shape - the reduction policy of this activation.
 * @returns the service.
 */
function pruneStub(
  shape: 'half' | 'tiny' | 'grow' | 'keep' | 'short-lines',
  scratch: boolean,
  segmented: boolean
): InterventionEngineOptions['prune'] {
  return {
    prune: async (raw: string) => {
      const text =
        shape === 'grow'
          ? `${raw}\n${raw}`
          : shape === 'keep'
            ? raw
            : shape === 'tiny'
              ? raw.slice(0, 7)
              : shape === 'short-lines'
                ? // Keep only the short lines: a real reduction that the floor then
                  // cannot widen to its promised share without rewriting lines.
                  raw.split('\n').filter((line) => line.length < 40).join('\n')
                : raw.slice(0, Math.max(0, Math.floor(raw.length / 2)));
      return {
        processedOutput: text,
        originalChars: raw.length,
        prunedChars: text.length,
        estimatedTokensSaved: Math.max(0, Math.ceil((raw.length - text.length) / 4)),
        reductionPercentage: raw.length === 0 ? 0 : Math.round(((raw.length - text.length) / raw.length) * 1000) / 10,
        // `scratch` models the service that hands its candidate's text back even
        // when the mode only observes; without it the text is withheld and the
        // memo written by observe cannot be reused.
        shadow: scratch,
        latencyMs: 0,
        ...(segmented
          ? { judgePath: 'segmented' as const, judgedSegments: 4, unjudgedSegments: 0, keptSegments: 2, fallbackReason: undefined }
          : { judgePath: 'local' as const, judgedSegments: 2, keptSegments: 1 })
      } as PruneResponse;
    }
  } as InterventionEngineOptions['prune'];
}

/**
 * A stagnation service, answering in one of the shapes the corpus needs.
 *
 * Every answer is zero-latency so no clock value can enter through it. The
 * *shape* is the point: the refusal branch, the paid-but-unconfirmed branch, the
 * confidence floor and the fail-open path are four different positions in the
 * pre-execute order, and a corpus that only says "stuck" never reaches three of
 * them.
 * @param shape - how this activation's service answers.
 * @returns the service.
 */
function stagnationStub(shape: StagnationShape): InterventionEngineOptions['stagnation'] {
  let asked = 0;
  return {
    check: async () => {
      asked += 1;
      if (shape === 'throw') throw new Error('System One unavailable');
      const unconfirmed = shape === 'not-stuck' || shape === 'low-confidence' || (shape === 'stuck-then-not' && asked > 1);
      return unconfirmed
        ? {
            isStuck: false,
            patternType: 'none',
            // Under the 0.6 floor the engine runs with: a verdict, but not one
            // that justifies an action.
            confidence: shape === 'low-confidence' ? 0.2 : 0.95,
            diagnosis: 'stub: not stuck',
            latencyMs: 0
          }
        : { isStuck: true, patternType: 'repetition', confidence: 0.9, diagnosis: 'stub', latencyMs: 0 };
    }
  } as InterventionEngineOptions['stagnation'];
}

/**
 * A gate service whose two answers are chosen by the script.
 *
 * The closing decision buys a classification and then a verification, and each
 * of the two can fail in its own way — the classifier's throw is handled inside
 * the decision while the verifier's throw lands in the outer fail-open. One
 * fixed stub could only ever exercise the contradiction, so the shape is a
 * script property rather than a harness constant.
 * @param shape - how this script's closing service answers.
 * @returns the service.
 */
function gateStub(shape: ClosingShape = 'contradicted'): InterventionEngineOptions['gate'] {
  const classifyClaims = async (request: { statements: string[] }) => {
    if (shape === 'classify-throws') throw new Error('stub: classifier unavailable');
    const results =
      shape === 'no-claim'
        ? request.statements.map((statement) => ({ statement, isClaim: false, confidence: 0.9 }))
        : shape === 'low-confidence-claim'
          ? request.statements.map((statement) => ({ statement, isClaim: true, confidence: 0.2 }))
          : request.statements.map((statement) => ({ statement, isClaim: true, confidence: 0.95 }));
    return { results, latencyMs: 0 };
  };
  const verify = async (claims: { statement: string }[]) => {
    if (shape === 'verify-throws') throw new Error('stub: verifier unavailable');
    const results = claims.map((claim, index) => ({
      statement: claim.statement,
      outcome:
        shape === 'consistent'
          ? 'verified'
          : shape === 'escalate'
            ? 'escalate'
            : shape === 'unconfirmed'
              ? 'unconfirmed'
              : shape === 'last-contradicted' && index !== claims.length - 1
                ? 'verified'
                : 'contradicted',
      confidence: 0.9
    }));
    return { passed: shape === 'consistent', results, needsEscalation: shape === 'escalate', latencyMs: 0 };
  };
  return { verify, classifyClaims } as unknown as InterventionEngineOptions['gate'];
}

// ── the replay ──────────────────────────────────────────────────────────────

/** Everything one replay observed, in comparable form. */
export interface ReplayOutput {
  /** One entry per `toolResult` call, in order. */
  readonly decisions: readonly unknown[];
  /** Every audit record, in order, without clock columns. */
  readonly audit: readonly unknown[];
  /** The skip histogram. */
  readonly skips: unknown;
  /** The cost buckets, one entry per mode and capability. */
  readonly costs: unknown;
  /** The retained-original locators the engine published. */
  readonly locators: readonly string[];
  /** The retained originals, keyed by locator. */
  readonly originals: Readonly<Record<string, string>>;
  /** The per-agent counters after the run. */
  readonly agents: unknown;
  /**
   * The engine-level evidence counters.
   *
   * These are *not* per-agent: the closing check adds the retained and the
   * truncated character counts to one counter for the whole activation, and a
   * lift that moved the assembly without moving this accounting would leave the
   * panel reporting a number no run produced.
   */
  readonly evidence: { readonly retainedChars: number; readonly truncatedChars: number };
}

/** An engine constructor of either vintage, over the same option surface. */
type EngineFactory = new (options: InterventionEngineOptions) => InterventionEngine;

/** One replay activation: which mode, which candidate shape. */
export interface ReplayOptions {
  /** Master mode; `capabilities` can override it per capability. */
  readonly mode: 'off' | 'observe' | 'active';
  /** Per-capability overrides. */
  readonly capabilities?: Partial<Record<'stagnation' | 'prune' | 'gate' | 'closing', 'off' | 'observe' | 'active' | 'inherit'>>;
  /** Which candidate the pruning service answers with. */
  readonly shape?: 'half' | 'tiny' | 'grow' | 'keep' | 'short-lines';
  /**
   * Write the plan's text into the memo even when the mode only observes.
   *
   * The production service computes the real candidate in both modes, so a memo
   * written by observe already carries its text and a later active run reuses it.
   * A *shadow* service withholds that text, which is the other half of the same
   * branch. This knob picks which service the activation is wired to.
   */
  readonly scratch?: boolean;
  /** Whether the service reports per-segment diagnostics (they land in the audit). */
  readonly segmented?: boolean;
  /** Whether the retention sink can retain at all. */
  readonly retention?: 'ok' | 'fail' | 'absent' | 'renamed';
  /** Ceilings and thresholds this activation runs with. */
  readonly policy?: Partial<ResolvedInterventionsConfig>;
  /** Which engines to use: the frozen snapshot, the live one (default: live). */
  readonly engines?: readonly EngineFactory[];
}

/** What one replay produced for one engine. */
export interface ReplayTrace {
  readonly output: ReplayOutput;
  /**
   * Every `tools/pre-execute` and `agent/pre-step` return value, in dispatch
   * order (for the monotonicity and correction checks).
   */
  readonly preResults: readonly unknown[];
  /** Every `agent/turn-stopping` boundary, and what was steered into it. */
  readonly stopResults: readonly unknown[];
}

/**
 * Replay one script through one engine and collect a normalized trace.
 *
 * The dispatch order mirrors the Host: pre-execute, then the pre-step that
 * carries the turn boundary, then post-execute. A `pre-step` therefore sees the
 * *previous* step's observation, exactly as it does in a real turn.
 *
 * @param script - the input sequence.
 * @param factory - the engine constructor.
 * @param options - the activation being replayed.
 * @returns the normalized trace.
 */
export async function replay(
  script: PruneScript,
  factory: EngineFactory,
  options: ReplayOptions
): Promise<ReplayTrace> {
  const agent = fakeAgent(`agent-${script.id}`);
  const originals: Record<string, string> = {};
  const audit: InterventionAuditRecord[] = [];
  // Resolved through the production resolver, so `inherit` really means
  // "follow the master mode" and `enabled` means what the engine expects. A
  // hand-built literal would let a script run under a mode the real loader
  // could never produce.
  const policy: ResolvedInterventionsConfig = {
    ...resolveConfig({
      backend: 'mock',
      ...(options.policy === undefined ? {} : { interventions: { ...options.policy } }),
      interventions: {
        ...(options.policy ?? {}),
        mode: options.mode,
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities })
      }
    }).interventions
  };

  const retention = options.retention ?? 'ok';
  const engine = new factory({
    config: policy,
    pruneThreshold: 100,
    stagnation: stagnationStub(script.stagnation ?? 'stuck'),
    prune: pruneStub(options.shape ?? 'half', options.scratch === true, options.segmented === true),
    gate: gateStub(script.closing ?? 'contradicted'),
    ...(retention === 'absent'
      ? {}
      : {
          retain: (_session: unknown, request: { digest: string; text: string }) => {
            if (retention === 'fail') return undefined;
            // A sink that names its copy differently from the plan forces the
            // engine to rebuild against the real locator.
            const locator = retention === 'renamed' ? `${pruneLocator(request.digest)}-renamed` : pruneLocator(request.digest);
            originals[locator] = request.text;
            return { locator, seq: Object.keys(originals).length };
          }
        }),
    now: () => FIXED_NOW,
    audit: (record: InterventionAuditRecord) => {
      audit.push(record);
    },
    ownTools: ['reflex_choice', 'reflex_score', 'reflex_route', 'reflex_screen', 'reflex_gate']
  }) as unknown as InterventionEngine;

  const decisions: unknown[] = [];
  /**
   * Every pre-execute and pre-step return value, in dispatch order.
   *
   * The pre-step decisions are kept too: the stagnation batch owns half of that
   * hook, and a correction that changed the message list without changing the
   * model-visible text would be invisible to a comparison of decisions alone.
   */
  const preResults: unknown[] = [];
  /** The closing check's answer, per `turn-stop` step. */
  const stopResults: unknown[] = [];
  let enteredTurn = 0;
  let enteredStep = 0;
  /** Monotone identity counter, mirroring the Host's per-call ids. */
  let callOrdinal = 0;

  for (const step of script.steps) {
    if (step.ev === 'pre-step') {
      const entered = await engine.preStep(
        {
          agent,
          messages: [],
          turn: step.turn,
          step: step.step,
          ...(step.aborted === true ? { signal: ABORTED } : {})
        },
        // `enter` carries the admitted message list; a correction is *appended*
        // to it, so the fake has to have one for the branch to be reachable.
        async () => (step.downstream === 'reject' ? { kind: 'reject' } : { kind: 'enter', messages: [] }) as never
      );
      preResults.push(describePreStep(entered));
      enteredTurn = step.turn;
      enteredStep = step.step;
      continue;
    }
    if (step.ev === 'result') {
      // A result with no proposal in front of it: `tools/post-execute` only.
      callOrdinal += 1;
      const exec = execOf(step.tool, step.args ?? {}, agent, false, callOrdinal);
      const result = resultOf({ ev: 'tool', tool: step.tool, out: step.out, ...(step.isError === true ? { isError: true } : {}) });
      decisions.push(await engine.toolResult(exec, result, async () => downstreamOf({ ev: 'tool', tool: step.tool, out: step.out })));
      continue;
    }
    if (step.ev === 'turn-stop') {
      stopResults.push(await replayStop(engine, agent, step));
      enteredTurn = step.turn;
      enteredStep = step.step;
      continue;
    }
    const turn = step.turn ?? enteredTurn;
    const stepIndex = step.step ?? enteredStep;
    // A monotone ordinal, not the step number: two steps of one script can share
    // a step index after a turn boundary, and their call identities must not.
    callOrdinal += 1;
    const exec = execOf(step.tool, step.args ?? {}, agent, script.abortedCall === true, callOrdinal);
    preResults.push(describePre(await engine.toolCall(exec, async () => preDecisionOf(step) as never)));
    // The pre-step carries the turn boundary, then the step the call is about.
    await engine.preStep({ agent, messages: [], turn, step: stepIndex }, async () => ({ kind: 'enter' }) as never);
    const result = resultOf(step);
    const downstream = downstreamOf(step);
    const decision = await engine.toolResult(exec, result, async () => downstream);
    decisions.push({
      kind: (decision as { kind?: string }).kind,
      content: contentOf(decision) ?? null,
      // The failure-correction branch answers with a `block` whose payload is the
      // feedback list, not `content`; leaving it out would compare the two
      // engines on whether a correction happened and not on what it said.
      feedback: describeFeedback(decision),
      additionalContexts: (decision as { additionalContexts?: unknown }).additionalContexts ?? null,
      // The identity of the downstream object matters: a pass-through must hand
      // the very object it was given back, not an equal copy.
      passedThrough: decision === downstream
    });
    enteredTurn = turn;
    enteredStep = stepIndex;
    if (step.switchModeTo !== undefined) {
      // A live policy commit, exactly as a config-only save applies it: the
      // per-agent state and the memo survive, only the mode each hook reads
      // changes. This is what makes an observe-written memo reachable by a
      // later active decision in the same run.
      // Resolved from the *authored* shape, so `mode` decides every capability
      // that has no explicit override — exactly what a config-only save does.
      // Passing the already-resolved `capabilities` object instead would pin
      // every capability to its old mode and the switch would be a no-op.
      const switched = resolveConfig({
        backend: 'mock',
        interventions: {
          ...(options.policy ?? {}),
          mode: step.switchModeTo,
          ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities })
        } as never
      }).interventions;
      engine.updatePolicy(switched, 100);
    }
  }

  const report = engine.report();
  const bucket = (source: Record<string, unknown>): unknown => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = source[key];
    return out;
  };

  return {
    preResults,
    stopResults,
    output: {
      decisions,
      audit: clockFreeView(audit),
      skips: report.skips,
      costs: {
        observe: bucket(report.observe as unknown as Record<string, unknown>),
        active: bucket(report.active as unknown as Record<string, unknown>),
        byCapability: {
          stagnation: bucket(report.byCapability.stagnation as unknown as Record<string, unknown>),
          prune: bucket(report.byCapability.prune as unknown as Record<string, unknown>),
          gate: bucket(report.byCapability.gate as unknown as Record<string, unknown>),
          closing: bucket(report.byCapability.closing as unknown as Record<string, unknown>)
        },
        baseline: report.baseline
      },
      locators: report.retained.locators,
      originals,
      agents: engine.stateOf(`agent-${script.id}`) ?? null,
      evidence: { retainedChars: report.evidence.retainedChars, truncatedChars: report.evidence.truncatedChars }
    }
  };
}

/**
 * Replay one script through the live engine and the frozen snapshot and compare.
 *
 * @param script - the input sequence.
 * @param options - the activation being replayed.
 * @returns both traces, and the structural equality verdict.
 */
export async function replayBoth(
  script: PruneScript,
  options: ReplayOptions
): Promise<{ shared: ReplayTrace; legacy: ReplayTrace }> {
  const shared = await replay(script, InterventionEngine as unknown as EngineFactory, options);
  const legacy = await replay(script, BaselineEngine as unknown as EngineFactory, options);
  return { shared, legacy };
}

/**
 * A one-line, human-readable digest of a trace: what the engine decided, in
 * order. Used in mismatch messages, so a failure names the scenario and the
 * decision instead of dumping two object graphs.
 * @param trace - one replay.
 * @returns the digest.
 */
export function digestOfTrace(trace: ReplayTrace): string[] {
  return trace.output.audit.map((record) => {
    const entry = record as Record<string, unknown>;
    const outcome = entry.action === 'skip' ? `skip:${String(entry.skip ?? entry.reason)}` : `${String(entry.action)}/${entry.applied === true ? 'applied' : 'planned'}`;
    return `${String(entry.capability)}:${outcome}`;
  });
}
