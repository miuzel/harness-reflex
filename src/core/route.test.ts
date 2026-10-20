import assert from 'node:assert/strict';
import test from 'node:test';

import { DecisionLedger } from './ledger.js';
import { ReflexRouter } from './route.js';
import type {
  ChoiceRequest,
  ChoiceResponse,
  DecisionBackend,
  GateRequest,
  GateResponse,
  PruneRequest,
  PruneResponse,
  RouteRequest,
  RouteResponse,
  StagnationCheckRequest,
  StagnationCheckResponse
} from '../backend/types.js';

/**
 * `ReflexRouter.selectBest` is the seam the virtual→physical model router calls,
 * so the cache-affinity facts have to survive exactly one hop: caller → options
 * → the backend's `RouteRequest`. A backend that never sees the new fields must
 * also see a byte-identical request, because the frozen MCP tool surface calls
 * the same method.
 */

/** A decision backend that records every route request it is asked to decide. */
class CapturingBackend implements DecisionBackend {
  readonly name = 'capturing';
  readonly model = 'capturing-v1';
  readonly seen: RouteRequest[] = [];

  choice(_req: ChoiceRequest): Promise<ChoiceResponse> {
    throw new Error('not used');
  }

  gate(_req: GateRequest): Promise<GateResponse> {
    throw new Error('not used');
  }

  prune(_req: PruneRequest): Promise<PruneResponse> {
    throw new Error('not used');
  }

  checkStagnation(_req: StagnationCheckRequest): Promise<StagnationCheckResponse> {
    throw new Error('not used');
  }

  route(req: RouteRequest): Promise<RouteResponse> {
    this.seen.push(req);
    return Promise.resolve({
      rankedCandidates: req.candidates.map((candidate, index) => ({ name: candidate.name, score: 1 - index / 10 })),
      bestCandidate: req.candidates[0]?.name,
      latencyMs: 1
    });
  }
}

const CANDIDATES = [
  { name: 'deepseek:chat', description: 'fast general chat' },
  { name: 'deepseek:reasoner', description: 'hard reasoning math' }
];

test('selectBest forwards the session facts and the policy to the backend', async () => {
  const backend = new CapturingBackend();
  const router = new ReflexRouter(backend, new DecisionLedger(null));

  const response = await router.selectBest('keep going', CANDIDATES, 2, {
    state: { currentModel: 'deepseek:chat', contextTokens: 2500, contextChars: 10000 },
    instructions: 'keep the current model unless clearly outmatched'
  });

  assert.equal(response.bestCandidate, 'deepseek:chat');
  assert.equal(backend.seen.length, 1);
  assert.deepEqual(backend.seen[0].state, {
    currentModel: 'deepseek:chat',
    contextTokens: 2500,
    contextChars: 10000
  });
  assert.equal(backend.seen[0].instructions, 'keep the current model unless clearly outmatched');
  assert.deepEqual(backend.seen[0].candidates, CANDIDATES);
});

test('a caller without affinity produces the request the frozen surface always produced', async () => {
  const backend = new CapturingBackend();
  const router = new ReflexRouter(backend, new DecisionLedger(null));

  await router.selectBest('goal', CANDIDATES, 3);

  assert.deepEqual(Object.keys(backend.seen[0]).sort(), ['candidates', 'goal', 'topK']);
  assert.deepEqual(backend.seen[0], { goal: 'goal', candidates: CANDIDATES, topK: 3 });
});

test('affinity does not disturb the ledger entry a route decision writes', async () => {
  const backend = new CapturingBackend();
  const ledger = new DecisionLedger(null);
  const router = new ReflexRouter(backend, ledger);

  await router.selectBest('goal', CANDIDATES, 2, {
    state: { currentModel: 'deepseek:chat', contextTokens: 10, contextChars: 40 },
    instructions: 'policy'
  });

  const entries = ledger.getEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'route');
  assert.equal(entries[0].details?.topCandidate, 'deepseek:chat');
  assert.equal(Object.keys(entries[0].details ?? {}).includes('instructions'), false, 'the policy is not audit state');
});
