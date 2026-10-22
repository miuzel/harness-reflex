/**
 * Logger port.
 *
 * The decision core is deliberately quiet — it reports through the audit record
 * rather than through free-form logging — but a composition root may still want
 * its own diagnostics. This interface is the only logging surface the core could
 * ever call, and it is optional.
 *
 * @module ports/log
 */

/** The severity vocabulary of the diagnostic sink. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A structured diagnostic sink. */
export interface LoggerPort {
  /**
   * Emit one diagnostic line.
   * @param level - severity.
   * @param message - human-readable text.
   * @param fields - structured context, when the host can retain it.
   */
  log(level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void;
}
