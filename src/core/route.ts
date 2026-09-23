import { DecisionBackend, RouteRequest, RouteResponse } from '../backend/types.js';
import { DecisionLedger } from './ledger.js';

export interface CandidateItem {
  name: string;
  description: string;
  type?: 'tool' | 'skill' | 'action';
}

export class ReflexRouter {
  private backend: DecisionBackend;
  private ledger: DecisionLedger;

  constructor(backend: DecisionBackend, ledger?: DecisionLedger) {
    this.backend = backend;
    this.ledger = ledger || DecisionLedger.getInstance();
  }

  async selectBest(goal: string, candidates: CandidateItem[], topK = 3): Promise<RouteResponse> {
    if (candidates.length === 0) {
      return {
        rankedCandidates: [],
        latencyMs: 0
      };
    }

    const req: RouteRequest = {
      goal,
      candidates,
      topK
    };

    const res = await this.backend.route(req);

    this.ledger.record({
      type: 'route',
      backend: this.backend.name,
      latencyMs: res.latencyMs,
      details: {
        goal,
        topCandidate: res.bestCandidate,
        candidateCount: candidates.length
      }
    });

    return res;
  }
}
