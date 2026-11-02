/**
 * The shared orchestration of one judged reduction.
 *
 * This module owns *when and in what order* a pruning decision is made; it does
 * not own any of the host facts that decision is made of. It was lifted verbatim
 * in behaviour from the DSH engine's private prune branch so that a second host
 * can reuse it, and it is written as a pure function over a port so that the
 * order — which is a safety property, not a style — is stated in exactly one
 * place:
 *
 * ```
 * refuse off / downstream-blocked / value-shaped
 * → refuse payloads that are not line-oriented output
 * → refuse payloads too large to retain
 * → refuse when no retention sink exists
 * → refuse when the turn's action allowance is spent
 * → buy a judgment (memo first), refuse when the judgment budget is spent
 * → compose the floored candidate, refuse when it is not smaller
 * → [observe: record the plan and stop]
 * → retain the original, refuse when no verifiable copy exists
 * → compose against the real locator, refuse when the result is not smaller
 * → ask the host to install it, refuse when there is no text block
 * → only now record the saving
 * ```
 *
 * Every "refuse" returns the downstream decision untouched and reports why. A
 * reduction that cannot be verified can therefore never be reported as applied.
 *
 * ## What is shared and what is not
 *
 * Shared here: the order above, every skip reason, the budget rules (which
 * counter moves when), the size arithmetic, the memo semantics, and the shape of
 * the audit detail. *Not* shared here: how a candidate is obtained (the host's
 * judge), how an original is retained (the host's sink, whose locator differs per
 * host), how text is installed into a host content type, and how the operator-
 * facing note is worded (that is a product decision per host).
 *
 * ## Why the port rather than callback arguments
 *
 * The DSH engine and the Claude hook disagree about nearly every *fact* and
 * about none of the *rules*. A port keeps the rules in one file and lets each
 * host answer only the questions it alone can answer. `HostPrunePort` is
 * deliberately total: there is no optional method, so a host that cannot retain
 * an original says so once, up front, instead of the shared layer guessing from
 * an absent callback.
 *
 * @module core/orchestrate
 */
import type { HostDecisionPort } from './orchestrate-host.js';
import { actionWithinBudget, bookAction, spendJudgment, type BudgetState, type PolicySnapshot } from './policy.js';
import { applyPruneFloor, type PruneFloorPlan } from './prune-plan.js';
import { digestOf, estimateTokens, type TextBlockLike } from './text.js';

/** Line breaks a payload needs before it is treated as line-oriented output. */
export const PRUNE_MIN_LINES = 4;

/**
 * Largest payload the shared layer is willing to see copied into a host log.
 *
 * Retention is what makes a reduction safe, so this is a *precondition* of
 * pruning rather than a fallback: above it the decision reports
 * `retention-too-large` and leaves the result untouched, so an oversized payload
 * can never be reported as saved on the strength of a copy that was never kept.
 */
export const MAX_RETAINED_CHARS = 100_000;

/** Characters of a reduction's explanatory note. */
export const PRUNE_FEEDBACK_CHARS = 600;

/** The floor options a reduction is composed with. */
export interface PruneFloorSettings {
  /** Lowest share of the original a reduction may keep. */
  readonly floorRatio: number;
  /** Default split of the context budget, taken from the head. */
  readonly headChars: number;
  /** Default split of the context budget, taken from the tail. */
  readonly tailChars: number;
}

/** The payload half of a prune decision's audit fields. */
export type PrunePayloadDetail = {
  /** Payload identity, absent for an empty payload. */
  readonly digest?: string;
  /** Size of the payload the decision is about. */
  readonly originalChars?: number;
};

/**
 * The payload half of a prune decision's audit fields.
 *
 * Taken before the service is asked, so a branch that refuses the payload early
 * still names the payload it refused.
 * @param text - the effective text the decision is about.
 * @returns the digest and size, or nothing for an empty payload.
 */
export function prunePayloadDetail(text: string): PrunePayloadDetail {
  return text.length === 0 ? {} : { digest: digestOf(text), originalChars: text.length };
}

/** What the judged candidate reports about its own path. */
export interface PruneDiagnostics {
  readonly judgePath?: 'segmented' | 'local' | 'fallback';
  readonly judgedSegments?: number;
  readonly unjudgedSegments?: number;
  readonly keptSegments?: number;
  readonly aggressiveChars?: number;
  readonly balancedChars?: number;
  readonly conservativeChars?: number;
  readonly scoredSegments?: number;
  readonly autoKeptSegments?: number;
  readonly unparsedScoreAnswers?: number;
  readonly fallbackReason?: string;
}

/**
 * The judgment half of a prune decision's audit fields.
 *
 * A pure pass-through of what the prune service computed, plus the two sizes
 * every record quotes.
 * @param response - the service's answer.
 * @param originalTokens - tokens of the raw payload.
 * @param candidateTokens - tokens of the composed candidate.
 * @returns the diagnostics plus sizes.
 */
export function pruneDiagnosticsOf(
  response: PruneDiagnostics,
  originalTokens: number,
  candidateTokens: number
): PruneDiagnostics & { readonly originalTokens: number; readonly candidateTokens: number } {
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
    ...(response.fallbackReason === undefined ? {} : { fallbackReason: response.fallbackReason }),
    originalTokens,
    candidateTokens
  };
}

/** One remembered reduction of one payload. */
export interface PruneMemoEntry {
  /** The real reduction, absent until a mode computed it. */
  readonly text?: string;
  readonly originalChars: number;
  readonly prunedChars: number;
  readonly tokensSaved: number;
  /** Whether the reduction was floored, so a memo hit reports the same plan. */
  readonly floored: boolean;
  /** Whether the reduction missed the floor's promised share, replayed on a hit. */
  readonly floorMissed?: boolean;
  /** Whether that miss installed without its locator marker, replayed on a hit. */
  readonly markerOmitted?: boolean;
  /** Locator of the retained original, once a retention for this payload succeeded. */
  readonly locator?: string;
  /** Diagnostics of the judgment that composed this form, replayed on a hit. */
  readonly diagnostics?: PruneDiagnostics;
}

/** What the shared layer asks a host to retain before it replaces a payload. */
export interface PruneRetentionRequest {
  /** Payload identity: `digestOf(text)`. */
  readonly digest: string;
  /** Identity of the call whose result is about to shrink. */
  readonly callId: string;
  /** Name of that call. */
  readonly tool: string;
  /** Turn and step of the replacement. */
  readonly turn: number;
  readonly step: number;
  /** The replaced payload, verbatim. */
  readonly text: string;
}

/** The controlled copy one retention produced. */
export interface PruneRetention {
  /** Locator the replacement publishes. */
  readonly locator: string;
  /** Committed log position, when the sink can report one. */
  readonly seq?: number;
}

/** A judged candidate, as the shared layer needs it. */
export interface PruneCandidate {
  /** The candidate text the floor composes from. */
  readonly processedOutput: string;
  /** Reduction share the service reported, recorded as the plan's confidence. */
  readonly reductionPercentage: number;
  /** Whether the service withheld the text (measured but not returned). */
  readonly shadow?: boolean;
  /** Service latency, used to split local from remote time. */
  readonly latencyMs: number;
  /** Path diagnostics, recorded only. */
  readonly diagnostics?: PruneDiagnostics;
}

/** The judgment cost of one decision. */
export interface PruneJudgmentCharge {
  readonly judgments: number;
  readonly memoHits: number;
  readonly localLatencyMs: number;
  readonly remoteLatencyMs: number;
  readonly judgeTokens: number;
}

/**
 * Everything the pruning decision cannot know by itself.
 *
 * {@link HostDecisionPort} answers the part every capability asks — policy,
 * counters, billing channels — but this port departs from the base in two ways,
 * and both are deliberate rather than pending:
 *
 * 1. **`skip` and `conclude` are wider here.** A pruning skip carries the
 *    payload diagnostics (`digest`, `floored`, the segment counts) that make
 *    "why was nothing pruned" answerable, and a pruning `conclude` carries the
 *    four size columns and the retained locator that make a saving verifiable.
 *    Narrowing either to the base signature would drop a field the audit trail
 *    is defined by, so this port overrides them with the wider shape.
 * 2. **`now()` replaces `clock()`.** The pruning decision only ever needs one
 *    number, taken at hook entry; handing it a port for one reading would be a
 *    ceremony. The signature is structurally compatible with `ClockPort`, so a
 *    host can satisfy either reading from the same source.
 *
 * The rest — `serves()`, `budget()`, `chargeJudgment()` — keeps the base
 * contract: `serves()` is answered from the effective mode, which this port
 * already exposes as `mode()`.
 */
export interface HostPrunePort extends HostDecisionPort<BudgetState> {
  /** The effective mode of the `prune` capability. */
  mode(): 'off' | 'observe' | 'active';
  /** Whether the decision applies at all: the mode is not `off`. */
  serves(): boolean;
  /** Latest clock reading. Structurally the same reading `ClockPort` gives. */
  now(): number;
  /** Character count above which a payload is a pruning candidate. */
  threshold(): number;
  /** Floor settings in force. */
  floor(): PruneFloorSettings;
  /** Turn and step this decision belongs to, for the audit record. */
  position(): { turn: number; step: number };
  /** The memo namespace of this agent's session. */
  memoKey(): string;
  /** One memoized reduction, refreshed on hit; `undefined` when not remembered. */
  memoGet(key: string): PruneMemoEntry | undefined;
  /** Remember one reduction. */
  memoSet(key: string, entry: PruneMemoEntry): void;
  /**
   * The locator this host's sink *will* give a payload.
   *
   * The prediction exists so both modes account for the same form: the floor
   * composes against a locator, and if the sink then names the copy differently
   * the text has to be rebuilt and the plan no longer describes what is
   * installed. Only the host knows its own naming scheme — DSH prefixes the
   * plugin record type, the Claude store hashes into a path — so this is a host
   * fact, not a shared rule.
   */
  locatorOf(digest: string): string;
  /** Ask the pruning service for a candidate. */
  judge(text: string): Promise<PruneCandidate>;
  /**
   * Retain one original and prove the copy landed.
   *
   * Returns the locator of a *verifiable* copy, or `undefined` when nothing
   * verifiable was written. A host without a sink returns a function that always
   * answers `undefined`; the shared layer then reports `retention-unavailable`
   * before it spends anything.
   */
  retain(request: PruneRetentionRequest, session: unknown): PruneRetention | undefined;
  /** Whether this host has a retention sink at all. */
  hasRetention(): boolean;
  /** The session a retention request belongs to, for a session-scoped sink. */
  session(): unknown;
  /**
   * Install `text` into the host's effective content.
   *
   * @returns the replacement content, or `undefined` when there is no text block
   *   to replace.
   */
  install(text: string): unknown | undefined;
  /** Whether the effective content carries a text block at all. */
  hasTextBlock(): boolean;
  /** Word the operator-facing note of one reduction. */
  describe(facts: PruneFeedbackFacts): string;
  /**
   * Count one abandoned plan by reason, with the diagnostic detail it carried.
   *
   * An abandoned plan that got far enough to have a candidate is charged by the
   * host here (its judgment really ran); one refused before that is not charged
   * at all, because nothing was bought.
   */
  skip(reason: string, detail: Record<string, unknown>, judgment?: PruneJudgmentCharge): void;
  /**
   * Bill a judgment whose plan was abandoned after it was really made.
   *
   * A refusal before the service runs costs nothing and is never billed here. A
   * refusal *after* it did spend the judgment, so hiding it would understate what
   * the turn cost. `originalTokens` is the size the abandoned branch had already
   * measured, or zero when it had measured nothing.
   */
  chargeJudgment(judgment: PruneJudgmentCharge, originalTokens?: number): void;
  /**
   * Record one applied or observed plan, with the sizes it accounts for.
   *
   * This is the one place a plan is billed: `plans` +1, `applied` +1 when it
   * really took effect, and every size column from `costs`.
   */
  conclude(
    record: PrunePlanRecord,
    applied: boolean,
    costs: {
      readonly originalTokens: number;
      readonly candidateTokens: number;
      readonly potentialSavedTokens: number;
      readonly actualSavedTokens?: number;
    },
    judgment: PruneJudgmentCharge | undefined,
    originalLocator?: string
  ): void;
  /** Count one retained copy, once per payload per activation. */
  noteRetained(locator: string): void;
  /** The decision this reduction passes through when it does nothing. */
  passThrough(): unknown;
}

/** What one reduction installed, for the note. */
export interface PruneFeedbackFacts {
  readonly tool: string;
  readonly originalTokens: number;
  readonly candidateTokens: number;
  readonly floored: boolean;
  readonly floorMissed: boolean;
  readonly markerOmitted: boolean;
  readonly locator: string;
  readonly keptSegments?: number;
  readonly judgedSegments?: number;
}

/** One planned reduction, as the host records it. */
export interface PrunePlanRecord {
  readonly capability: 'prune';
  readonly action: 'prune-result';
  readonly reason: string;
  feedback: string;
  readonly detail: Record<string, unknown>;
}

/** The outcome of one orchestrated decision. */
export interface PruneOutcome {
  /** What the host should return to its caller. */
  readonly result: unknown;
  /** Whether a reduction was really installed. */
  readonly applied: boolean;
  /** The skip reason, when the decision refused to reduce. */
  readonly skip?: string;
}

/**
 * Run the one pruning decision.
 *
 * @param invocation - the call whose result is being considered, and the
 *   effective text of that result.
 * @param port - everything that is the host's to answer.
 * @returns the decision the host commits.
 */
export async function orchestratePrune(
  invocation: {
    readonly callId: string;
    readonly tool: string;
    /** The effective text of the result (downstream first). */
    readonly text: string;
    /** Whether the rest of the waterfall blocked the result outright. */
    readonly blockedByDownstream: boolean;
    /** Whether a value-shaped accept replaced the payload wholesale. */
    readonly valueShapedAccept: boolean;
    /** Clock reading at hook entry. */
    readonly started: number;
  },
  port: HostPrunePort
): Promise<PruneOutcome> {
  const mode = port.mode();
  if (mode === 'off') return { result: port.passThrough(), applied: false };
  // A blocked result is already not shown to the model; rewriting it is moot and
  // re-deriving its text would ignore the block.
  if (invocation.blockedByDownstream) return { result: port.passThrough(), applied: false };

  const text = invocation.text;
  const payloadDetail = prunePayloadDetail(text);

  if (invocation.valueShapedAccept) {
    // A value-shaped accept replaced the payload wholesale; nothing here knows
    // what its text is, so nothing here may touch it.
    port.skip('value-shaped-accept', {});
    return { result: port.passThrough(), applied: false, skip: 'value-shaped-accept' };
  }
  if (!port.hasTextBlock()) {
    // Nothing to replace, and nothing that could be reported as replaced. Asked
    // before the size checks: an image-only payload is not "small", it is out of
    // scope, and the skip reason should say so.
    port.skip('no-text-block', payloadDetail);
    return { result: port.passThrough(), applied: false, skip: 'no-text-block' };
  }
  if (text.length < port.threshold()) {
    port.skip('below-threshold', payloadDetail);
    return { result: port.passThrough(), applied: false, skip: 'below-threshold' };
  }
  if ((text.match(/\n/g)?.length ?? 0) < PRUNE_MIN_LINES) {
    // Not line-oriented output: the judge is asked to extract diagnostics, and a
    // payload with no lines does not have any to extract. Rewriting it would
    // destroy semantic data rather than compress a trace.
    port.skip('unsupported-payload', payloadDetail);
    return { result: port.passThrough(), applied: false, skip: 'unsupported-payload' };
  }
  if (text.length > MAX_RETAINED_CHARS) {
    // Retention is a precondition of replacing anything, so an oversized payload
    // is refused *before* it is judged or reported as a saving.
    port.skip('retention-too-large', payloadDetail);
    return { result: port.passThrough(), applied: false, skip: 'retention-too-large' };
  }
  if (!port.hasRetention()) {
    // Without a retention sink nothing may be replaced: the layer will not
    // destroy the only copy of a result it cannot give back.
    port.skip('retention-unavailable', payloadDetail);
    return { result: port.passThrough(), applied: false, skip: 'retention-unavailable' };
  }
  if (!actionWithinBudget(port.budget(), port.policy())) {
    // A reduction is an intervention like a refusal or a correction, so it draws
    // on the same per-turn allowance — and it is asked here, before a judgment is
    // bought, so a full turn costs nothing to refuse. Both modes are checked:
    // observe has to plan no more actions than active could take, including the
    // ones the memo would have answered for free.
    port.skip('intervention-cap', payloadDetail);
    return { result: port.passThrough(), applied: false, skip: 'intervention-cap' };
  }

  const floor = port.floor();
  const position = port.position();
  const digest = digestOf(text);
  // The locator is derived from the payload, and a sink that names its copy the
  // same way makes the plan's size the size of the form active will install, in
  // both modes.
  const locator = port.locatorOf(digest);
  const memo = port.memoGet(`${port.memoKey()}:${digest}`);
  // A memo hit answers the question the judgment already answered; only a mode
  // that needs the reduction's *text* has to ask for it again.
  const needsCandidate = mode === 'active' && memo?.text === undefined;
  if (!memo || needsCandidate) {
    const skip = spendJudgment(port.budget(), port.policy());
    if (skip !== undefined) {
      port.skip(skip, payloadDetail);
      return { result: port.passThrough(), applied: false, skip };
    }
  }

  const candidate: PruneCandidate =
    memo && !needsCandidate
      ? {
          processedOutput: memo.text ?? text,
          reductionPercentage: reductionPercentageOf(memo.originalChars, memo.prunedChars),
          latencyMs: 0,
          shadow: memo.text === undefined,
          ...(memo.diagnostics ?? {})
        }
      : // Both modes take the *real* candidate, and both ask for it measure-only.
        // `shadow` only decides whether the backend hands its text back, while
        // the candidate's size is that candidate's size either way; the text is
        // what the floor composes from, so a withheld measurement would not be
        // the same input at all. Whether the payload is installed is decided
        // here, by the floor, *after* the service has written its ledger entry —
        // so this path never lets the service declare a saving.
        await port.judge(text);

  const originalTokens = estimateTokens(text);
  // One composition, both modes: the floored text the plan describes is the text
  // active installs, byte for byte. Line alignment and duplicate removal move its
  // real size away from the modelled one, so the number both modes account for is
  // the length of the composed text — never a prediction about it.
  const composed: PruneFloorPlan & { text: string } = applyPruneFloor(text, candidate.processedOutput, {
    floorRatio: floor.floorRatio,
    headChars: floor.headChars,
    tailChars: floor.tailChars,
    locator
  });
  const candidateTokens = Math.ceil(composed.text.length / 4);
  const diagnostics = pruneDiagnosticsOf(
    // A memo hit replays the provenance of the judgment that composed the form,
    // so a reused reduction still says which path produced it.
    memo && !needsCandidate ? (memo.diagnostics ?? {}) : (candidate.diagnostics ?? {}),
    originalTokens,
    candidateTokens
  );
  // A memo hit hands back a form that was composed for this payload already. It is
  // its own fixed point — it carries the share, so the plan of the same lengths
  // stays "not floored" and gives that text straight back — but its provenance is
  // not readable from those lengths any more. The memo, which was written by the
  // composition, answers for it: without this the audit would report a floored
  // install as an unfloored one.
  const reusedFromMemo = !needsCandidate && memo?.text !== undefined ? memo : undefined;
  const floorApplied = reusedFromMemo ? reusedFromMemo.floored : composed.floored;
  const floorMissed = reusedFromMemo ? reusedFromMemo.floorMissed === true : composed.floorMissed;
  const markerOmitted = reusedFromMemo ? reusedFromMemo.markerOmitted === true : composed.markerOmitted;
  const measured = {
    ...payloadDetail,
    ...diagnostics,
    floored: floorApplied,
    floorMissed,
    markerOmitted,
    candidateChars: composed.text.length
  } as Record<string, unknown>;
  const judged = !memo || needsCandidate;
  const judgment: PruneJudgmentCharge = {
    judgments: judged ? 1 : 0,
    memoHits: judged ? 0 : 1,
    localLatencyMs: Math.max(0, port.now() - invocation.started - (judged ? candidate.latencyMs : 0)),
    remoteLatencyMs: judged ? candidate.latencyMs : 0,
    // The pre-prune payload is what the pruner reasoned about; a backend call is
    // a judgment even when it returns locally in under a millisecond.
    judgeTokens: judged ? originalTokens : 0
  };
  if (candidateTokens >= originalTokens) {
    // The judgment ran and the candidate it produced was not smaller, so it is
    // charged with the size it was asked about — nothing else about this payload
    // is billed.
    port.chargeJudgment(judgment, originalTokens);
    // The branch a real "prune: active but nothing happened" run lands in: the
    // judgment ran, and the candidate it produced was not smaller. The record
    // says so with the path that produced it and the sizes both sides had.
    port.skip('no-reduction', measured, judgment);
    return { result: port.passThrough(), applied: false, skip: 'no-reduction' };
  }

  const plan: PrunePlanRecord = {
    capability: 'prune',
    action: 'prune-result',
    reason: `${invocation.tool} returned ${originalTokens} tokens; the judged reduction carries ${candidateTokens}`,
    feedback: port.describe({
      tool: invocation.tool,
      originalTokens,
      candidateTokens,
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
      confidence: candidate.reductionPercentage,
      turn: position.turn,
      step: position.step,
      ...diagnostics,
      originalChars: text.length,
      candidateChars: composed.text.length
    }
  };
  const planCosts = {
    originalTokens,
    candidateTokens,
    potentialSavedTokens: originalTokens - candidateTokens
  };

  if (mode !== 'active') {
    // Observe: the plan is real and charged, the surface is untouched, and the
    // memo keeps the composed form — the same form active would install, from the
    // same candidate — so a later hit reports the reduction this mode really saw.
    // A plan this mode records is the action active would have taken, so it books
    // the slot active would have booked.
    bookAction(port.budget());
    port.conclude(plan, false, planCosts, judgment);
    if (!memo) {
      port.memoSet(`${port.memoKey()}:${digest}`, {
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
    return { result: port.passThrough(), applied: false };
  }

  // Active. The original is retained *before* anything is replaced, and only a
  // verified retention makes the replacement installable at all. A payload whose
  // copy is already retained keeps that copy instead of writing a second one.
  const alreadyRetained = memo?.locator;
  const retention: PruneRetention | undefined = alreadyRetained
    ? { locator: alreadyRetained }
    : port.retain(
        {
          digest,
          callId: invocation.callId,
          tool: invocation.tool,
          turn: position.turn,
          step: position.step,
          text
        },
        port.session()
      );
  if (retention === undefined || typeof retention.locator !== 'string' || retention.locator.length === 0) {
    // No controlled copy, no reduction. The result stays exactly as the rest of
    // the waterfall produced it, and no saving is recorded — but the judgment
    // that got this far was really made, so it is charged rather than hidden.
    port.chargeJudgment(judgment);
    port.skip('retention-failed', measured, judgment);
    return { result: port.passThrough(), applied: false, skip: 'retention-failed' };
  }

  // The form both modes accounted for is the form that gets installed: the locator
  // is derived from the payload and a sink that names its copy the same way makes
  // the composition already published reusable byte for byte — with the provenance
  // the plan gave it. Only a sink that named the copy differently forces a rebuild,
  // and then the real length and provenance of that rebuild are what gets
  // accounted for.
  const installed = retention.locator === locator
    ? { ...composed, floored: floorApplied, floorMissed, markerOmitted }
    : applyPruneFloor(text, candidate.processedOutput, {
        floorRatio: floor.floorRatio,
        headChars: floor.headChars,
        tailChars: floor.tailChars,
        locator: retention.locator
      });
  if (installed.text.length === 0 || installed.text.length >= text.length) {
    // The plan said the form is smaller; the form that was really built must be
    // too, or nothing is installed and nothing is saved.
    port.skip(
      'no-reduction',
      {
        ...measured,
        floored: installed.floored,
        floorMissed: installed.floorMissed,
        markerOmitted: installed.markerOmitted,
        candidateChars: installed.text.length,
        candidateTokens: Math.max(0, Math.ceil(installed.text.length / 4))
      },
      judgment
    );
    return { result: port.passThrough(), applied: false, skip: 'no-reduction' };
  }
  const replacement = port.install(installed.text);
  if (replacement === undefined) {
    port.skip(
      'no-text-block',
      {
        ...measured,
        floored: installed.floored,
        floorMissed: installed.floorMissed,
        markerOmitted: installed.markerOmitted,
        candidateChars: installed.text.length,
        candidateTokens: Math.max(0, Math.ceil(installed.text.length / 4))
      },
      judgment
    );
    return { result: port.passThrough(), applied: false, skip: 'no-text-block' };
  }

  // Only now is there a decision that really took effect, so only now is the
  // saving recorded — against the text that is really about to enter the context.
  const installedTokens = Math.max(0, Math.ceil(installed.text.length / 4));
  plan.detail.floorApplied = installed.floored;
  plan.detail.floorMissed = installed.floorMissed;
  plan.detail.markerOmitted = installed.markerOmitted;
  plan.detail.candidateChars = installed.text.length;
  plan.feedback = port.describe({
    tool: invocation.tool,
    originalTokens,
    candidateTokens: installedTokens,
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
  bookAction(port.budget());
  const installedCosts = {
    originalTokens,
    candidateTokens: installedTokens,
    potentialSavedTokens: originalTokens - installedTokens,
    actualSavedTokens: originalTokens - installedTokens
  };
  port.conclude(plan, true, installedCosts, judgment, retention.locator);
  // Retention is counted once per payload: a duplicate install reuses the copy
  // that is already in the log, and the locator naming it never changes.
  port.noteRetained(retention.locator);
  port.memoSet(`${port.memoKey()}:${digest}`, {
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
  return { result: replacement, applied: true };
}

/**
 * Percentage of a payload a reduction kept.
 * @param originalChars - size of the raw payload.
 * @param prunedChars - size of the reduction.
 * @returns the kept share, rounded to one decimal.
 */
export function reductionPercentageOf(originalChars: number, prunedChars: number): number {
  if (originalChars === 0) return 0;
  return Math.round(((originalChars - prunedChars) / originalChars) * 1000) / 10;
}

/**
 * The note of one reduction, in the default wording.
 *
 * It is meant for an operator, never for the model: a prune is supposed to remove
 * context, so sending an explanation of the removal would work against the thing
 * it accounts for. A host that shows it to a *person* may keep this wording
 * verbatim; that is why it lives here next to the facts it is built from.
 * @param facts - what the reduction did.
 * @returns the note, bounded.
 */
export function describeReduction(facts: PruneFeedbackFacts): string {
  const kept = facts.originalTokens === 0 ? 100 : Math.round((facts.candidateTokens / facts.originalTokens) * 100);
  const head = `Reduced ${facts.tool}: ${facts.originalTokens} → ${facts.candidateTokens} tokens (${kept}% kept). `;
  const segmentsShort =
    facts.keptSegments !== undefined && facts.judgedSegments !== undefined && facts.keptSegments < facts.judgedSegments;
  const segmentNote = segmentsShort
    ? `Kept ${facts.keptSegments}/${facts.judgedSegments} segments, omitted ${facts.judgedSegments! - facts.keptSegments!}. `
    : '';
  let body: string;
  if (facts.floored) {
    body = 'The head, the judged extract and the tail were kept; the full output was retained and is not in context.';
  } else if (facts.floorMissed) {
    const install = facts.markerOmitted
      ? 'no locator marker was added because it would not have kept the text smaller than the original'
      : 'the judged extract was installed as-is';
    body = `${segmentNote}The candidate fell short of the floor, so ${install}; the full output is retrievable as ${facts.locator}.`;
  } else if (segmentsShort) {
    body = `${segmentNote}The judged extract was installed as-is; the full output is retrievable as ${facts.locator}.`;
  } else {
    body = 'The judged extract was kept whole; the full output was retained and is not in context.';
  }
  const note = `${head}${body}`;
  return note.length <= PRUNE_FEEDBACK_CHARS ? note : `${note.slice(0, PRUNE_FEEDBACK_CHARS)}…`;
}

/** Re-exported so a host can name the same content shape the core reads. */
export type { TextBlockLike };
