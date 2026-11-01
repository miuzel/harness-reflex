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
import type { PruneScript, PruneStep } from './prune-parity-scripts.js';
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

/** A tool execution, shaped the way the Host hands one to a hook. */
function execOf(name: string, args: unknown, agent: unknown): ToolExecution {
  return {
    callId: `call-${name}`,
    token: `token-${name}`,
    rootCallId: `root-${name}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
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

/** A stagnation service that always confirms, so the corpus can occupy the shared action budget. */
function stagnationStub(): InterventionEngineOptions['stagnation'] {
  return {
    check: async () => ({
      isStuck: true,
      patternType: 'repetition',
      confidence: 0.9,
      diagnosis: 'stub',
      latencyMs: 0
    })
  } as InterventionEngineOptions['stagnation'];
}

/** A gate service that contradicts, so a repeated failure is corrected. */
function gateStub(): InterventionEngineOptions['gate'] {
  return {
    verify: async () => ({ passed: false, results: [], needsEscalation: false, latencyMs: 0 }),
    classifyClaims: async (request: { statements: string[] }) => ({
      results: request.statements.map((statement) => ({ statement, isClaim: true, confidence: 0.95 })),
      latencyMs: 0
    })
  } as unknown as InterventionEngineOptions['gate'];
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
  /** Every `tools/pre-execute` return value, in order (for the monotonicity check). */
  readonly preResults: readonly unknown[];
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
    stagnation: stagnationStub(),
    prune: pruneStub(options.shape ?? 'half', options.scratch === true, options.segmented === true),
    gate: gateStub(),
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
  const preResults: unknown[] = [];
  let enteredTurn = 0;
  let enteredStep = 0;

  for (const step of script.steps) {
    if (step.ev === 'pre-step') {
      await engine.preStep(
        { agent, messages: [], turn: step.turn, step: step.step },
        async () => ({ kind: 'enter' }) as never
      );
      enteredTurn = step.turn;
      enteredStep = step.step;
      continue;
    }
    const turn = step.turn ?? enteredTurn;
    const stepIndex = step.step ?? enteredStep;
    const exec = execOf(step.tool, step.args ?? {}, agent);
    preResults.push(await engine.toolCall(exec, async () => preDecisionOf(step) as never));
    // The pre-step carries the turn boundary, then the step the call is about.
    await engine.preStep({ agent, messages: [], turn, step: stepIndex }, async () => ({ kind: 'enter' }) as never);
    const result = resultOf(step);
    const downstream = downstreamOf(step);
    const decision = await engine.toolResult(exec, result, async () => downstream);
    decisions.push({
      kind: (decision as { kind?: string }).kind,
      content: contentOf(decision) ?? null,
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
      agents: engine.stateOf(`agent-${script.id}`) ?? null
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
