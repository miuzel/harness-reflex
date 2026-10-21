import { DecisionBackend, PruneRequest, PruneResponse } from '../backend/types.js';
import { DecisionLedger } from './ledger.js';

export interface PruneOptions {
  intent?: string;
  maxTokens?: number;
  shadowMode?: boolean;
  /**
   * Hand the real candidate back, but do not book it as a saving.
   *
   * A caller that is still deciding needs the candidate's *text*, which `shadowMode`
   * withholds; a caller that has installed nothing must not be reported as having
   * saved tokens. `measureOnly` is both at once: `processedOutput` carries the
   * candidate, while the ledger keeps `tokensSaved` at 0 and the candidate's size in
   * `details.potentialTokensSaved`, exactly as it does for a shadow measurement.
   */
  measureOnly?: boolean;
  minCharsThreshold?: number;
  /**
   * Character count from which the backend judges segments through System One.
   * Resolved from `interventions.pruneJudgeMinChars`; forwarded as-is.
   */
  pruneJudgeMinChars?: number;
}

export class ToolResultPruner {
  private backend: DecisionBackend;
  private ledger: DecisionLedger;
  private minCharsThreshold: number;

  constructor(backend: DecisionBackend, ledger?: DecisionLedger, minCharsThreshold = 500) {
    this.backend = backend;
    this.ledger = ledger || DecisionLedger.getInstance();
    this.minCharsThreshold = minCharsThreshold;
  }

  async prune(output: string, options?: PruneOptions): Promise<PruneResponse> {
    const threshold = options?.minCharsThreshold ?? this.minCharsThreshold;

    // Small outputs: skip pruning, zero overhead
    if (!output || output.length < threshold) {
      return {
        processedOutput: output,
        originalChars: output ? output.length : 0,
        prunedChars: output ? output.length : 0,
        estimatedTokensSaved: 0,
        reductionPercentage: 0,
        shadow: !!options?.shadowMode,
        latencyMs: 0
      };
    }

    const req: PruneRequest = {
      rawOutput: output,
      intent: options?.intent || 'extract diagnostics, relevant results and errors',
      maxTokens: options?.maxTokens,
      shadowMode: options?.shadowMode,
      ...(options?.pruneJudgeMinChars === undefined ? {} : { pruneJudgeMinChars: options.pruneJudgeMinChars })
    };

    let result: PruneResponse;
    try {
      result = await this.backend.prune(req);
    } catch (err: any) {
      // FAIL-OPEN: On error, always retain raw output so harness never breaks
      result = {
        processedOutput: output,
        originalChars: output.length,
        prunedChars: output.length,
        estimatedTokensSaved: 0,
        reductionPercentage: 0,
        shadow: !!options?.shadowMode,
        latencyMs: 0
      };
    }

    // A measure-only caller gets the candidate's text but has installed nothing, so
    // the measurement is recorded as what it is: not a saving. Marking it here keeps
    // the ledger's own rule — a shadowed measurement never claims one — and leaves
    // `processedOutput` untouched.
    if (options?.measureOnly) result = { ...result, shadow: true };

    this.ledger.record({
      type: 'prune',
      backend: this.backend.name,
      latencyMs: result.latencyMs,
      // A measurement removed nothing from the context, so it must not claim a
      // saving: `tokensSaved` means "what the harness stopped carrying". The
      // candidate's size stays readable in `details.potentialTokensSaved`.
      tokensSaved: result.shadow ? 0 : result.estimatedTokensSaved,
      originalTokens: Math.ceil(result.originalChars / 4),
      prunedTokens: Math.ceil(result.prunedChars / 4),
      shadow: result.shadow,
      details: {
        reductionPercentage: result.reductionPercentage,
        ...(result.shadow ? { potentialTokensSaved: result.estimatedTokensSaved } : {})
      }
    });

    return result;
  }
}
