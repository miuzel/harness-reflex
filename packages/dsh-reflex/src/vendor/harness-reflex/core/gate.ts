import { DecisionBackend, GateRequest, GateResponse } from '../backend/types.js';
import { DecisionLedger } from './ledger.js';
import { Calibrator } from './calibrate.js';

export interface GateOptions {
  strictness?: 'high' | 'normal' | 'lenient';
  latchCacheKey?: string;
  calibrator?: Calibrator;
}

export class ReflexGateService {
  private backend: DecisionBackend;
  private ledger: DecisionLedger;
  private calibrator: Calibrator;
  private latchedResults: Map<string, GateResponse> = new Map();

  constructor(backend: DecisionBackend, ledger?: DecisionLedger, calibrator?: Calibrator) {
    this.backend = backend;
    this.ledger = ledger || DecisionLedger.getInstance();
    this.calibrator = calibrator || Calibrator.getInstance();
  }

  /**
   * Verify assertions against evidence.
   * Fail-Closed: If any error happens or evidence is ambiguous, status is escalated / rejected.
   */
  async verify(
    assertions: Array<{ statement: string; criteria?: string }>,
    evidence: string,
    options?: GateOptions
  ): Promise<GateResponse> {
    const latchKey = options?.latchCacheKey || (assertions.map((a) => a.statement).join(';') + '::' + evidence.length);
    if (this.latchedResults.has(latchKey)) {
      const cached = this.latchedResults.get(latchKey)!;
      this.ledger.record({
        type: 'gate',
        backend: this.backend.name,
        latencyMs: 0,
        passed: cached.passed,
        skipReason: 'Latched result hit in current step',
        details: { assertionCount: assertions.length, latched: true }
      });
      return cached;
    }

    if (!evidence || assertions.length === 0) {
      const resp: GateResponse = {
        passed: false,
        needsEscalation: true,
        results: assertions.map((a) => ({
          statement: a.statement,
          outcome: 'escalate',
          confidence: 0,
          explanation: 'Evidence is empty or no assertions provided. Fail-closed.'
        })),
        latencyMs: 0
      };
      this.latchedResults.set(latchKey, resp);
      return resp;
    }

    const req: GateRequest = {
      assertions,
      evidence,
      strictness: options?.strictness || 'normal'
    };

    let result: GateResponse;
    try {
      result = await this.backend.gate(req);
    } catch (err: any) {
      // Fail-closed guarantee
      result = {
        passed: false,
        needsEscalation: true,
        results: assertions.map((a) => ({
          statement: a.statement,
          outcome: 'escalate',
          confidence: 0,
          explanation: `Backend evaluation failure: ${err.message}. Enforcing fail-closed policy.`
        })),
        latencyMs: 0
      };
    }

    // Apply offline calibration curve if loaded
    if (this.calibrator.isLoaded()) {
      for (const item of result.results) {
        const { calibrated } = this.calibrator.calibrate(item.confidence);
        const rawPct = (item.confidence * 100).toFixed(1);
        const calPct = (calibrated * 100).toFixed(1);
        item.explanation += ` [Calibrated confidence: ${calPct}% (raw: ${rawPct}%)]`;

        // If raw was claimed 'verified' but empirical calibrated probability is below threshold, escalate!
        const minThreshold = options?.strictness === 'high' ? 0.85 : 0.65;
        if (item.outcome === 'verified' && calibrated < minThreshold && options?.strictness !== 'lenient') {
          item.outcome = 'escalate';
          item.explanation += ` [Auto-Escalated: empirical accuracy (${calPct}%) below safety threshold (${(minThreshold * 100).toFixed(0)}%)]`;
          result.passed = false;
          result.needsEscalation = true;
        }
      }
    }

    this.latchedResults.set(latchKey, result);

    this.ledger.record({
      type: 'gate',
      backend: this.backend.name,
      latencyMs: result.latencyMs,
      passed: result.passed,
      details: {
        assertionCount: assertions.length,
        passedItems: result.results.filter((r) => r.outcome === 'verified').length,
        failedItems: result.results.filter((r) => r.outcome !== 'verified').length
      }
    });

    return result;
  }

  resetLatch(): void {
    this.latchedResults.clear();
  }
}
