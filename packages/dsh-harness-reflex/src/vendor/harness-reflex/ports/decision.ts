/**
 * Decision-backend ports.
 *
 * The core asks questions; which transport answers them (a hosted gateway, an
 * in-process model, a mock) is chosen by the composition root. These interfaces
 * are intentionally *narrow*: they describe only the calls the intervention
 * decision surface makes, so a host adapter supplies a couple of methods rather
 * than the whole backend contract.
 *
 * @module ports/decision
 */
import type {
  ActionStep,
  GateResponse,
  PruneResponse,
  StagnationCheckResponse
} from '../backend/types.js';

/** One stagnation verdict request: the window, plus the question it is asked in. */
export interface StagnationBackendPort {
  /**
   * Judge one observed action window.
   * @param goal - why the run is judged, when the caller knows.
   * @param history - observed steps, oldest first.
   * @returns the verdict and its recommended intervention.
   */
  check(goal: string | undefined, history: readonly ActionStep[]): Promise<StagnationCheckResponse>;
}

/** One prune request, narrowed to what the intervention surface sends. */
export interface PruneBackendOptionsPort {
  intent?: string;
  measureOnly?: boolean;
  pruneJudgeMinChars?: number;
}

/** The reduction service, as the prune plan consumes it. */
export interface PruneBackendPort {
  /**
   * Ask for one reduction candidate.
   * @param output - the payload to reduce.
   * @param options - intent and measurement flags.
   * @returns the candidate plus its provenance and sizes.
   */
  prune(output: string, options?: PruneBackendOptionsPort): Promise<PruneResponse>;
}

/** One completion-claim sentence classification. */
export interface ClaimClassificationPort {
  statement: string;
  /** Whether the winning criterion says the sentence claims completion. */
  isClaim: boolean;
  /** Probability of the completion-claim criterion, in `[0, 1]`. */
  confidence: number;
}

/** The classification answer for one closing candidate batch. */
export interface ClaimClassificationResponsePort {
  results: ClaimClassificationPort[];
  latencyMs: number;
}

/** One batch of candidate sentences a closing check must classify. */
export interface ClaimClassificationRequestPort {
  statements: string[];
  intent: string;
  context?: string;
}

/** The verification half of a closing judgment. */
export interface ClosingBackendPort {
  /** Classify which candidate sentences really claim completion. */
  classifyClaims(request: ClaimClassificationRequestPort): Promise<ClaimClassificationResponsePort>;
  /** Verify completion claims against the assembled evidence. */
  verify(
    assertions: Array<{ statement: string; criteria?: string }>,
    evidence: string,
    options?: { latchCacheKey?: string }
  ): Promise<GateResponse>;
}

/** The whole decision surface of one composition, grouped for convenience. */
export interface DecisionBackendPort {
  stagnation: StagnationBackendPort;
  prune: PruneBackendPort;
  closing: ClosingBackendPort;
}
