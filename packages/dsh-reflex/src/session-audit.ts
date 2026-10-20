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

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** One adaptive reasoning-effort decision, as dispatched. */
    'plugin:dsh-reflex/effort': EffortAuditRecord;
  }
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
