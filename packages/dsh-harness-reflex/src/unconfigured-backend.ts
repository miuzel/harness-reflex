/**
 * The backend an activation uses when no System One connection is configured.
 *
 * ## Why this exists (g-066)
 *
 * Before g-066 a document with no active profile still resolved *some*
 * connection: the flat block, or — with the plugin's `auto` selector — whichever
 * of `JEV_API_KEY` / `VLLM_BASE_URL` happened to be exported. Removing that
 * fallback leaves a third state the plugin must represent honestly: **no
 * connection at all**. There are three candidates for it, and only the third is
 * acceptable:
 *
 * 1. *Throwing out of the activation.* One missing profile would take every
 *    reflex tool down, including the deterministic local ones the tools promise
 *    to keep working when System One is unavailable.
 * 2. *Returning the mock backend.* The ledger, the panel and the audit trail
 *    would then report `mock-heuristic-v1` — the name a deployment gets when it
 *    deliberately chose the in-process implementation. "Unconfigured" would be
 *    indistinguishable from "configured to run locally", so a user who lost their
 *    activation would see a working page and no reason to look.
 * 3. *This backend.* It serves the same deterministic local heuristics as the
 *    mock — every decision still gets an answer — under a name that says what is
 *    wrong: {@link UNCONFIGURED_BACKEND_NAME}.
 *
 * It is deliberately **not** a wrapper that delegates to the mock: the two must
 * be able to diverge (the unconfigured one refuses to pretend, e.g. its
 * `health()` reports the missing activation instead of being absent).
 *
 * Nothing here performs I/O: an unconfigured activation must make no external
 * request of its own accord, and that is the property the tests pin.
 *
 * @module dsh-reflex/unconfigured-backend
 */

import { MockDecisionBackend } from './vendor/harness-reflex/backend/mock.js';
import type {
  BackendHealth,
  ChoiceRequest,
  ChoiceResponse,
  ClaimClassificationRequest,
  ClaimClassificationResponse,
  DecisionBackend,
  GateRequest,
  GateResponse,
  PruneRequest,
  PruneResponse,
  RouteRequest,
  RouteResponse,
  StagnationCheckRequest,
  StagnationCheckResponse
} from './vendor/harness-reflex/backend/types.js';

/** Name reported while no connection is configured. */
export const UNCONFIGURED_BACKEND_NAME = 'unconfigured';

/** Model id reported while no connection is configured. */
export const UNCONFIGURED_BACKEND_MODEL = 'no-active-profile';

/**
 * Serve every decision from the deterministic local heuristics, and say so.
 *
 * Composition, not subclassing: the heuristics themselves are owned by the
 * vendored mock (one copy, verified by `vendor-contract.test.ts`), while identity
 * and health are this class's own — which is the whole point of the type.
 *
 * @param reason - the resolution's {@link ResolvedSystemOneConfig.unconfigured}
 *   tag, carried into `health()` so the panel and any log can say *which* absence
 *   applies instead of a generic "not configured".
 */
export class UnconfiguredBackend implements DecisionBackend {
  readonly name = UNCONFIGURED_BACKEND_NAME;

  readonly model = UNCONFIGURED_BACKEND_MODEL;

  readonly #local = new MockDecisionBackend();

  readonly #reason: string;

  constructor(reason: string) {
    this.#reason = reason;
  }

  /**
   * Report the missing activation as a health fact.
   *
   * An in-process backend normally omits `health()` ("healthy by construction"),
   * and the panel reads absence that way. Here absence would be a false claim:
   * the connection is not healthy, it does not exist. `available: false` with a
   * reason is the vocabulary the panel already renders for "there is a backend,
   * and something about it is wrong".
   * @returns the unavailable health record, naming the reason.
   */
  health(): BackendHealth {
    return {
      available: false,
      consecutiveFailures: 0,
      lastFailureReason: `no active System One connection (${this.#reason}); decisions use local heuristics only`
    };
  }

  async choice(req: ChoiceRequest): Promise<ChoiceResponse> {
    return this.#local.choice(req);
  }

  async gate(req: GateRequest): Promise<GateResponse> {
    return this.#local.gate(req);
  }

  async prune(req: PruneRequest): Promise<PruneResponse> {
    return this.#local.prune(req);
  }

  async checkStagnation(req: StagnationCheckRequest): Promise<StagnationCheckResponse> {
    return this.#local.checkStagnation(req);
  }

  async route(req: RouteRequest): Promise<RouteResponse> {
    return this.#local.route(req);
  }

  async classifyClaims(req: ClaimClassificationRequest): Promise<ClaimClassificationResponse> {
    return this.#local.classifyClaims(req);
  }
}
