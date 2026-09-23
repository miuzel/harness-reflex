import { DecisionBackend, GateRequest, GateResponse } from '../backend/types.js';
import { DecisionLedger } from './ledger.js';

export interface GateOptions {
  strictness?: 'high' | 'normal' | 'lenient';
  latchCacheKey?: string;
}

export class ReflexGateService {
  private backend: DecisionBackend;
  private ledger: DecisionLedger;
  private latchedResults: Map<string, GateResponse> = new Map();

  constructor(backend: DecisionBackend, ledger?: DecisionLedger) {
    this.backend = backend;
    this.ledger = ledger || DecisionLedger.getInstance();
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
