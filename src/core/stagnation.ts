import {
  DecisionBackend,
  ActionStep,
  StagnationCheckRequest,
  StagnationCheckResponse
} from '../backend/types.js';
import { DecisionLedger } from './ledger.js';

/** Cap on the steps one verdict may look at. */
const MAX_HISTORY = 30;

/**
 * Merge caller-supplied steps in front of the steps this detector recorded.
 *
 * The result is chronological, capped to the last {@link MAX_HISTORY} entries,
 * and copy-safe: the detector never retains the caller's array or objects.
 *
 * @param external - steps the caller observed, oldest first, when supplied.
 * @param own - steps this detector recorded in this activation.
 * @returns the merged, capped history.
 */
function mergeHistory(external: readonly ActionStep[] | undefined, own: readonly ActionStep[]): ActionStep[] {
  if (external === undefined || external.length === 0) return [...own];
  const merged = [...external.map((step) => ({ ...step })), ...own];
  return merged.length > MAX_HISTORY ? merged.slice(merged.length - MAX_HISTORY) : merged;
}

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
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }
  }

  /**
   * Judge the merged action history for a stagnation pattern.
   *
   * @param goal - current overall goal, when the caller knows it.
   * @param history - steps the caller observed that this detector never
   *   recorded itself (a resumed session, a foreign agent, a run this
   *   activation did not live through). They are treated as *earlier* than the
   *   steps recorded here, so the merged tail is what the window sees.
   * @returns the stagnation verdict and corrective suggestion.
   */
  async check(goal?: string, history?: readonly ActionStep[]): Promise<StagnationCheckResponse> {
    const merged = mergeHistory(history, this.history);
    if (merged.length < 3) {
      return {
        isStuck: false,
        confidence: 1.0,
        diagnosis: 'Action count below stagnation threshold (< 3).',
        latencyMs: 0
      };
    }

    const req: StagnationCheckRequest = {
      history: merged,
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
