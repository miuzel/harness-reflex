/**
 * Audit-sink port.
 *
 * A decision that was *planned* must be auditable even when it was not applied,
 * and a host's audit channel may be its session log, a file, or a test spy. The
 * core produces the record; writing it somewhere durable is the host's job.
 *
 * @module ports/audit
 */

/** A sink for one decision record, scoped to the session it belongs to. */
export interface AuditSinkPort<Record> {
  /**
   * Append one record, best-effort.
   * @param record - the decision to retain.
   * @param session - the session it belongs to, when one is visible.
   */
  write(record: Record, session: unknown): void;
}
