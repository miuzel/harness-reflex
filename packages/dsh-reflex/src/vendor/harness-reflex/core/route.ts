import { DecisionBackend, RouteCandidateItem, RouteRequest, RouteRequestState, RouteResponse } from '../backend/types.js';
import { DecisionLedger } from './ledger.js';

/**
 * One candidate {@link ReflexRouter.selectBest} may rank. Alias of the wire
 * shape the backends accept, so a caller can mark the candidate the session is
 * already using (`current`) without a second type.
 */
export type CandidateItem = RouteCandidateItem;

/** Optional per-call behavior of {@link ReflexRouter.selectBest}. */
export interface RouteOptions {
  /**
   * Whether this selection appends its own `route` ledger entry. Defaults to
   * `true`; callers that record a richer, purpose-specific entry (the
   * virtual→physical model router writes one `model-route` record per
   * decision) pass `false` to avoid auditing the same decision twice.
   */
  record?: boolean;
  /**
   * Cache-affinity facts of the requesting session (current physical model and
   * accumulated context size), forwarded to the decision backend. Omitted by
   * callers that have no session (one-shot tool calls).
   */
  state?: RouteRequestState;
  /**
   * Decision instructions forwarded to the backend prompt — the cache-affinity
   * policy. Omitted by callers with no session affinity to defend.
   */
  instructions?: string;
}

export class ReflexRouter {
  private backend: DecisionBackend;
  private ledger: DecisionLedger;

  constructor(backend: DecisionBackend, ledger?: DecisionLedger) {
    this.backend = backend;
    this.ledger = ledger || DecisionLedger.getInstance();
  }

  async selectBest(goal: string, candidates: CandidateItem[], topK = 3, options: RouteOptions = {}): Promise<RouteResponse> {
    if (candidates.length === 0) {
      return {
        rankedCandidates: [],
        latencyMs: 0
      };
    }

    const req: RouteRequest = {
      goal,
      candidates,
      topK,
      ...(options.state === undefined ? {} : { state: options.state }),
      ...(options.instructions === undefined ? {} : { instructions: options.instructions })
    };

    const res = await this.backend.route(req);

    if (options.record !== false) {
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
    }

    return res;
  }
}
