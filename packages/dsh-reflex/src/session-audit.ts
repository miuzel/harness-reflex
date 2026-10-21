/**
 * Session-log audit of the adaptive effort decisions.
 *
 * Criterion: the effort actually dispatched has to be recorded where a human can
 * audit it, **without** polluting what the model reads next. The Session log has
 * exactly one surface with that property: experimental plugin records are
 * committed events marked `ignorable`, they are retained by fork and resume, and
 * they never enter the model-visible surface (unlike a `user`/`system` message,
 * which would re-enter the prompt and could even be re-interpreted as
 * instructions by the model).
 *
 * So the audit trail lives here and nowhere else: one record per adaptive
 * decision, read back with {@link effortRecordsOf}. The record's owner validates
 * `data` on read, because a restored log carries whatever an earlier build wrote.
 */
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';

import type { ReflexEffortStatus } from './effort.js';

/** Session-log record type owned by this plugin. */
export const EFFORT_RECORD_TYPE = 'plugin:dsh-reflex/effort';

/**
 * Session-log record type of one automatic-intervention decision.
 *
 * The same channel as the effort audit, for the same reason: an intervention
 * that was *planned* must be auditable even when it was not applied (observe
 * mode), and neither case may add anything the model can read.
 */
export const INTERVENTION_RECORD_TYPE = 'plugin:dsh-reflex/intervention';

/**
 * Session-log record type of one retained pre-prune payload.
 *
 * A reduction is only installed after its original has been written here, so
 * "the full output is retrievable" is a fact about the log rather than a claim
 * about it: the installed text names the locator, and a reader resolves the
 * locator back to the exact bytes that were replaced. The same append-only,
 * ignorable, model-invisible channel as the audit trail — no new file, no new
 * permission, and the Session's own retention governs the copy's lifetime.
 */
export const PRUNED_ORIGINAL_RECORD_TYPE = 'plugin:dsh-reflex/pruned-original';

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** One adaptive reasoning-effort decision, as dispatched. */
    'plugin:dsh-reflex/effort': EffortAuditRecord;
    /** One planned or applied automatic intervention. */
    'plugin:dsh-reflex/intervention': InterventionAuditRecord;
    /** One pre-prune payload kept so a replacement stays verifiable. */
    'plugin:dsh-reflex/pruned-original': PrunedOriginalRecord;
  }
}

/**
 * One retained pre-prune payload.
 *
 * `text` is the payload *verbatim* — the exact text the reduction replaced — so
 * a reader compares bytes rather than reconstructing them. `digest` is the same
 * identity the judgment, the memo, and the replacement's locator use, which is
 * what makes the record findable without carrying a log offset: offsets shift
 * under fork and resume, a payload digest does not.
 */
export interface PrunedOriginalRecord {
  /** Locator the model-visible replacement publishes. */
  locator: string;
  /** Payload identity: `digestOf(text)`, the same key the prune decision used. */
  digest: string;
  /** Identity of the tool call whose result was replaced. */
  callId: string;
  /** Name of that tool. */
  tool: string;
  /** Turn and step the replacement happened in. */
  turn: number;
  step: number;
  /** Characters of `text`. */
  chars: number;
  /** The replaced payload, verbatim. */
  text: string;
  /** Unix epoch milliseconds of the retention. */
  at: number;
}

/**
 * The JSON payload of one intervention record.
 *
 * Only losslessly serializable scalars: the record is read back by hosts and
 * humans, never replayed into a prompt. `feedback` is the model-facing text the
 * active path delivers — bounded on write, because it is the one field a caller
 * controls and an audit sink must not become a content dump. The four token
 * counters are the accounting contract: `potentialSavedTokens` is what the
 * candidate would have saved, `actualSavedTokens` what the harness really
 * stopped carrying, and the two are equal only in active mode.
 */
export interface InterventionAuditRecord {
  /** Capability that planned this action. */
  capability: string;
  /** The planned action name. */
  action: string;
  /** Effective three-state mode at plan time. */
  mode: string;
  /** Whether active mode actually executed the plan. */
  applied: boolean;
  /** Why it was planned, or why it was declined. */
  reason: string;
  /** Model-facing text the active path delivers; empty when none. */
  feedback: string;
  /** Judgment cost paid on this process' CPU (deterministic triggers, floors). */
  localLatencyMs: number;
  /** Judgment cost paid waiting for System 1. */
  remoteLatencyMs: number;
  /** Tokens the judgment itself cost (payload sent to the decision backend). */
  judgeTokens: number;
  /** Tokens of the payload this decision was about. */
  originalTokens: number;
  /** Tokens of the candidate the decision would install. */
  candidateTokens: number;
  /** Tokens the candidate would save; never counted as actual unless applied. */
  potentialSavedTokens: number;
  /** Tokens the harness actually stopped carrying because of this decision. */
  actualSavedTokens: number;
  /** Tokens this decision added to the model-visible surface. */
  injectedTokens: number;
  at: number;
  pattern?: string;
  confidence?: number;
  repeats?: number;
  digest?: string;
  floorApplied?: boolean;
  memoHit?: boolean;
  agentId?: string;
  turn?: number;
  step?: number;
  /**
   * Why a plan was abandoned instead of planned, when it was.
   *
   * Present exactly on an `action: 'skip'` record: every branch that refuses to
   * plan writes one, so "why no intervention" is answerable from the session
   * log instead of a process-local counter. Equal to the record's `reason`,
   * kept as its own field so a reader can select skips without matching prose.
   */
  skip?: string;
  /** Which judging path produced the prune candidate. */
  judgePath?: 'segmented' | 'local' | 'fallback';
  /** Segments handed to System One by the prune judgment (0 when the local path ran). */
  judgedSegments?: number;
  /** Segments beyond the per-request limit, kept deterministically instead. */
  unjudgedSegments?: number;
  /** Segments the candidate the engine composed from kept whole. */
  keptSegments?: number;
  /** Characters of the aggressive-budget candidate the judgment built. */
  aggressiveChars?: number;
  /** Characters of the balanced-budget candidate the judgment built. */
  balancedChars?: number;
  /** Characters of the conservative-budget candidate the judgment built. */
  conservativeChars?: number;
  /** Segments System One really scored (`scores.size`); unreadable answers are absent. */
  scoredSegments?: number;
  /** Segments kept whole without a score: the unjudged safety margin. */
  autoKeptSegments?: number;
  /** Answers returned for a judged segment that carried no usable keep score. */
  unparsedScoreAnswers?: number;
  /** Characters of the payload this decision was about. */
  originalChars?: number;
  /** Characters of the candidate the decision would have installed. */
  candidateChars?: number;
  /** Why the segmented judge fell back to the local candidates, when it did. */
  fallbackReason?: string;
  /**
   * Locator of the controlled copy of the payload this decision replaced.
   *
   * Present exactly when a prune installed a replacement *and* the pre-prune
   * original was durably retained first; absent for every other decision and for
   * a prune that failed open. The locator resolves through
   * {@link readPrunedOriginal}, so the model-visible replacement can always be
   * checked against the bytes it stands in for.
   */
  originalLocator?: string;
}

/**
 * The JSON payload of one effort record. Deliberately narrower than
 * {@link ReflexEffortStatus}: only losslessly serializable fields, and `applied`
 * is `null` rather than absent when nothing was sent, so a reader never has to
 * tell "cleared" from "field dropped by the serializer".
 */
export interface EffortAuditRecord {
  /** Decided level. */
  level: string;
  /** Effort the rewritten request carried; `null` when the key was cleared. */
  applied: string | null;
  outcome: string;
  trigger: string;
  source: string;
  confidence: number;
  latencyMs: number;
  provider: string;
  model: string;
  /** Status-bar rendering of this decision. */
  line: string;
  /** Unix epoch milliseconds of the decision. */
  at: number;
  agentId?: string;
  role?: string;
  delegationDepth?: number;
  turn?: number;
  step?: number;
  basis?: string[];
  degradedReason?: string;
  task?: string;
  /** Provider the request named before routing. */
  requestedProvider?: string;
  /** Model the request named before routing. */
  requestedModel?: string;
  /** Whether routing moved the request onto another provider/model. */
  switched?: boolean;
  /** Whether the model was held to defend upstream prompt-cache affinity. */
  heldForCache?: boolean;
  /** Effort ids the routed model declared; `[]` when it declares none. */
  supportedEfforts?: string[];
}

/**
 * Project one status onto the audit payload.
 * @param status - the published effort status.
 * @returns the record payload.
 */
export function toEffortAuditRecord(status: ReflexEffortStatus): EffortAuditRecord {
  return {
    level: status.level,
    applied: status.applied ?? null,
    outcome: status.outcome,
    trigger: status.trigger,
    source: status.source,
    confidence: status.confidence,
    latencyMs: status.latencyMs,
    provider: status.provider,
    model: status.model,
    line: status.line,
    at: status.at,
    ...(status.agentId === undefined ? {} : { agentId: status.agentId }),
    ...(status.role === undefined ? {} : { role: status.role }),
    ...(status.delegationDepth === undefined ? {} : { delegationDepth: status.delegationDepth }),
    ...(status.turn === undefined ? {} : { turn: status.turn }),
    ...(status.step === undefined ? {} : { step: status.step }),
    ...(status.basis === undefined ? {} : { basis: status.basis }),
    ...(status.degradedReason === undefined ? {} : { degradedReason: status.degradedReason }),
    ...(status.task === undefined ? {} : { task: status.task }),
    ...(status.requestedProvider === undefined ? {} : { requestedProvider: status.requestedProvider }),
    ...(status.requestedModel === undefined ? {} : { requestedModel: status.requestedModel }),
    ...(status.switched === undefined ? {} : { switched: status.switched }),
    ...(status.heldForCache === undefined ? {} : { heldForCache: status.heldForCache }),
    ...(status.supportedEfforts === undefined ? {} : { supportedEfforts: status.supportedEfforts })
  };
}

/**
 * Append one effort decision to a Session's log.
 *
 * Best-effort by contract: an audit record is never allowed to fail a turn, so a
 * missing session (synthetic agent), a re-entrant append, or a rejected payload
 * is swallowed and reported as `undefined`.
 *
 * @param session - the requesting agent's session, when it has one.
 * @param status - the decision to record.
 * @returns the committed sequence number, or `undefined` when nothing was written.
 */
export function appendEffortRecord(session: unknown, status: ReflexEffortStatus): number | undefined {
  const target = session as Session | undefined;
  if (!target || typeof appendPluginRecord !== 'function') return undefined;
  try {
    return appendPluginRecord(target, EFFORT_RECORD_TYPE, toEffortAuditRecord(status)) as unknown as number;
  } catch {
    return undefined;
  }
}

/**
 * Read back the effort decisions of one Session log.
 * @param events - the session log, or any slice of it.
 * @returns the validated records, oldest first; malformed payloads are dropped.
 */
export function effortRecordsOf(events: readonly SessionEvent[] | undefined): EffortAuditRecord[] {
  const records: EffortAuditRecord[] = [];
  for (const event of events ?? []) {
    let record;
    try {
      record = pluginRecordOf(event);
    } catch {
      continue;
    }
    if (!record || record.type !== EFFORT_RECORD_TYPE) continue;
    if (isEffortAuditRecord(record.data)) records.push(record.data);
  }
  return records;
}

/**
 * Validate one restored payload before a reader trusts it.
 * @param data - the payload committed by an earlier build.
 * @returns whether it carries the fields this plugin writes.
 */
export function isEffortAuditRecord(data: unknown): data is EffortAuditRecord {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Partial<EffortAuditRecord>;
  return (
    typeof record.level === 'string' &&
    typeof record.outcome === 'string' &&
    typeof record.trigger === 'string' &&
    typeof record.source === 'string' &&
    typeof record.confidence === 'number' &&
    typeof record.latencyMs === 'number' &&
    typeof record.provider === 'string' &&
    typeof record.model === 'string' &&
    typeof record.line === 'string' &&
    typeof record.at === 'number' &&
    (record.applied === null || typeof record.applied === 'string')
  );
}

/**
 * Append one intervention decision to a Session's log.
 *
 * Best-effort, exactly like the effort audit: a missing session (synthetic
 * agent) or a rejected payload must never fail a turn, so failures are
 * swallowed and reported as `undefined`.
 *
 * @param session - the deciding agent's session, when it has one.
 * @param record - the decision to record.
 * @returns the committed sequence number, or `undefined` when nothing was written.
 */
export function appendInterventionRecord(session: unknown, record: InterventionAuditRecord): number | undefined {
  const target = session as Session | undefined;
  if (!target || typeof appendPluginRecord !== 'function') return undefined;
  try {
    return appendPluginRecord(target, INTERVENTION_RECORD_TYPE, boundRecord(record)) as unknown as number;
  } catch {
    return undefined;
  }
}

/** Longest `feedback` text one audit record may carry, in characters. */
export const INTERVENTION_FEEDBACK_MAX_CHARS = 600;

/**
 * Bound the one caller-controlled field before it reaches the durable log.
 * @param record - the freshly built record.
 * @returns a copy whose `feedback` fits the audit budget.
 */
function boundRecord(record: InterventionAuditRecord): InterventionAuditRecord {
  if (record.feedback.length <= INTERVENTION_FEEDBACK_MAX_CHARS) return record;
  return { ...record, feedback: `${record.feedback.slice(0, INTERVENTION_FEEDBACK_MAX_CHARS)}…` };
}

/**
 * Read back the intervention decisions of one Session log.
 * @param events - the session log, or any slice of it.
 * @returns the validated records, oldest first; malformed payloads are dropped.
 */
export function interventionRecordsOf(events: readonly SessionEvent[] | undefined): InterventionAuditRecord[] {
  const records: InterventionAuditRecord[] = [];
  for (const event of events ?? []) {
    let record;
    try {
      record = pluginRecordOf(event);
    } catch {
      continue;
    }
    if (!record || record.type !== INTERVENTION_RECORD_TYPE) continue;
    if (isInterventionAuditRecord(record.data)) records.push(record.data);
  }
  return records;
}

/**
 * Validate one restored intervention payload before a reader trusts it.
 * @param data - the payload committed by an earlier build.
 * @returns whether it carries the fields this plugin writes.
 */
export function isInterventionAuditRecord(data: unknown): data is InterventionAuditRecord {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Partial<InterventionAuditRecord>;
  return (
    typeof record.capability === 'string' &&
    typeof record.action === 'string' &&
    typeof record.mode === 'string' &&
    typeof record.applied === 'boolean' &&
    typeof record.reason === 'string' &&
    typeof record.feedback === 'string' &&
    typeof record.originalTokens === 'number' &&
    typeof record.candidateTokens === 'number' &&
    typeof record.potentialSavedTokens === 'number' &&
    typeof record.actualSavedTokens === 'number' &&
    typeof record.injectedTokens === 'number' &&
    typeof record.at === 'number'
  );
}

// ── controlled retention of a pre-prune payload ─────────────────────────────

/**
 * The locator of one payload's retained copy.
 *
 * Derived from the payload's own digest, never from a log offset: a session that
 * is forked, resumed, or re-opened under a new store keeps the same locator for
 * the same payload, while an offset would silently point at another event. The
 * length is fixed, so a replacement can publish the locator without changing
 * size between the observation and the application of the same plan.
 * @param digest - the payload's {@link digestOf} identity.
 * @returns the locator string the replacement carries.
 */
export function pruneLocator(digest: string): string {
  return `${PRUNED_ORIGINAL_RECORD_TYPE}#${digest}`;
}

/** What the engine asks the log to retain before it replaces a payload. */
export interface PrunedOriginalRequest {
  /** Payload identity, as the prune decision computed it. */
  digest: string;
  /** Identity and name of the call whose result is about to shrink. */
  callId: string;
  tool: string;
  /** Turn and step of the replacement. */
  turn: number;
  step: number;
  /** The payload verbatim, as the reduction is about to replace it. */
  text: string;
  /** Clock seam; defaults to `Date.now()`. */
  at?: number;
}

/**
 * Retain one pre-prune payload in a Session's log, and prove that it landed.
 *
 * The read-back is the point of this function. An append that throws, a Session
 * that is not there, and a log that acknowledged a record it did not commit all
 * end the same way for the caller: `undefined`, meaning *the original is not
 * retrievable*, which the engine treats as a reason not to replace anything. A
 * reduction that cannot be checked against its original is worse than no
 * reduction, so this is deliberately fail-closed for the caller while remaining
 * best-effort towards the log.
 *
 * @param session - the deciding agent's session, when it has one.
 * @param request - the payload and its identity.
 * @returns the locator and the committed sequence, or `undefined` when nothing verifiable was written.
 */
export function appendPrunedOriginal(
  session: unknown,
  request: PrunedOriginalRequest
): { locator: string; seq?: number } | undefined {
  const target = session as Session | undefined;
  if (!target || typeof appendPluginRecord !== 'function') return undefined;
  const locator = pruneLocator(request.digest);
  try {
    const record: PrunedOriginalRecord = {
      locator,
      digest: request.digest,
      callId: request.callId,
      tool: request.tool,
      turn: request.turn,
      step: request.step,
      chars: request.text.length,
      text: request.text,
      at: request.at ?? Date.now()
    };
    const seq = appendPluginRecord(target, PRUNED_ORIGINAL_RECORD_TYPE, record) as unknown as number;
    if (!verifiedRetention(target, seq, record)) return undefined;
    return { locator, seq };
  } catch {
    // An unretainable payload is never replaced; the caller fails open.
    return undefined;
  }
}

/**
 * Whether the committed log really carries the record we just appended.
 * @param session - the session that acknowledged the append.
 * @param seq - the acknowledged sequence number.
 * @param record - the record to find there.
 * @returns whether the log returns it verbatim.
 */
function verifiedRetention(session: Session, seq: number, record: PrunedOriginalRecord): boolean {
  const reader = session as unknown as { eventAt?: (seq: unknown) => SessionEvent | undefined };
  const eventAt = reader.eventAt;
  if (typeof eventAt !== 'function' || !Number.isFinite(seq)) return false;
  const event = eventAt.call(session, seq);
  if (!event) return false;
  const committed = pluginRecordOf(event);
  if (!committed || committed.type !== PRUNED_ORIGINAL_RECORD_TYPE) return false;
  const data = committed.data as Partial<PrunedOriginalRecord> | undefined;
  return data?.digest === record.digest && data.text === record.text && data.chars === record.chars;
}

/**
 * Read back the retained payloads of one Session log.
 * @param events - the session log, or any slice of it.
 * @returns the validated records, oldest first; malformed payloads are dropped.
 */
export function prunedOriginalsOf(events: readonly SessionEvent[] | undefined): PrunedOriginalRecord[] {
  const records: PrunedOriginalRecord[] = [];
  for (const event of events ?? []) {
    let record;
    try {
      record = pluginRecordOf(event);
    } catch {
      continue;
    }
    if (!record || record.type !== PRUNED_ORIGINAL_RECORD_TYPE) continue;
    if (isPrunedOriginalRecord(record.data)) records.push(record.data);
  }
  return records;
}

/**
 * Resolve one locator against a Session log.
 *
 * A locator names a payload, not a position, so the same payload pruned twice in
 * one session has two records under one locator: the most recent one is returned,
 * which is the copy the live replacement was built beside.
 * @param events - the session log, or any slice of it.
 * @param locator - the locator the replacement published.
 * @returns the retained payload, or `undefined` when this log does not carry it.
 */
export function readPrunedOriginal(
  events: readonly SessionEvent[] | undefined,
  locator: string
): PrunedOriginalRecord | undefined {
  let found: PrunedOriginalRecord | undefined;
  for (const record of prunedOriginalsOf(events)) {
    if (record.locator === locator) found = record;
  }
  return found;
}

/**
 * Validate one restored retention payload before a reader trusts it.
 * @param data - the payload committed by an earlier build.
 * @returns whether it carries the fields this plugin writes.
 */
export function isPrunedOriginalRecord(data: unknown): data is PrunedOriginalRecord {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Partial<PrunedOriginalRecord>;
  return (
    typeof record.locator === 'string' &&
    typeof record.digest === 'string' &&
    typeof record.callId === 'string' &&
    typeof record.tool === 'string' &&
    typeof record.turn === 'number' &&
    typeof record.step === 'number' &&
    typeof record.chars === 'number' &&
    typeof record.text === 'string' &&
    record.text.length === record.chars &&
    typeof record.at === 'number'
  );
}
