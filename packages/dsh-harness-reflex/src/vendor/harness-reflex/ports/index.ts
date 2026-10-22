/**
 * The ports of the intervention decision core.
 *
 * Interfaces and pure types only: nothing here reads a file, holds a socket, or
 * knows what a host is. Composition roots implement these and inject them into
 * the core.
 *
 * @module ports
 */
export type { ClockPort } from './clock.js';
export type {
  ClaimClassificationPort,
  ClaimClassificationRequestPort,
  ClaimClassificationResponsePort,
  ClosingBackendPort,
  DecisionBackendPort,
  PruneBackendOptionsPort,
  PruneBackendPort,
  StagnationBackendPort
} from './decision.js';
export type { BudgetSnapshot, BudgetStorePort, StateStorePort } from './state.js';
export type { AuditSinkPort } from './audit.js';
export type { LoggerPort, LogLevel } from './log.js';
