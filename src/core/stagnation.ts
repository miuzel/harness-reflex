import {
  DecisionBackend,
  ActionStep,
  StagnationCheckRequest,
  StagnationCheckResponse
} from '../backend/types.js';
import { DecisionLedger } from './ledger.js';

export class StagnationDetector {
  private backend: DecisionBackend;
  private ledger: DecisionLedger;
  private history: ActionStep[] = [];
  private consecutiveAlerts = 0;

  constructor(backend: DecisionBackend, ledger?: DecisionLedger) {
    this.backend = backend;
    this.ledger = ledger || DecisionLedger.getInstance();
  }

  recordAction(step: ActionStep): void {
    this.history.push({
      ...step,
      timestamp: step.timestamp || Date.now()
    });
    // Keep max 30 recent steps
    if (this.history.length > 30) {
      this.history.shift();
    }
  }

  async check(goal?: string): Promise<StagnationCheckResponse> {
    if (this.history.length < 3) {
      return {
        isStuck: false,
        confidence: 1.0,
        diagnosis: 'Action count below stagnation threshold (< 3).',
        latencyMs: 0
      };
    }

    const req: StagnationCheckRequest = {
      history: this.history,
      goal,
      windowSize: 6
    };

    const res = await this.backend.checkStagnation(req);

    if (res.isStuck) {
      this.consecutiveAlerts++;
    } else {
      this.consecutiveAlerts = 0;
    }

    this.ledger.record({
      type: 'stagnation',
      backend: this.backend.name,
      latencyMs: res.latencyMs,
      isStuck: res.isStuck,
      details: {
        patternType: res.patternType,
        historyLength: this.history.length,
        consecutiveAlerts: this.consecutiveAlerts,
        diagnosis: res.diagnosis
      }
    });

    return res;
  }

  getHistory(): ActionStep[] {
    return [...this.history];
  }

  clear(): void {
    this.history = [];
    this.consecutiveAlerts = 0;
  }
}
