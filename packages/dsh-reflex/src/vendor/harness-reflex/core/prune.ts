import { DecisionBackend, PruneRequest, PruneResponse } from '../backend/types.js';
import { DecisionLedger } from './ledger.js';

export interface PruneOptions {
  intent?: string;
  maxTokens?: number;
  shadowMode?: boolean;
  minCharsThreshold?: number;
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
      shadowMode: options?.shadowMode
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

    this.ledger.record({
      type: 'prune',
      backend: this.backend.name,
      latencyMs: result.latencyMs,
      // A shadow measurement removed nothing from the context, so it must not
      // claim a saving: `tokensSaved` means "what the harness stopped carrying".
      // The candidate's size stays readable in `details.potentialTokensSaved`.
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
