import assert from 'node:assert/strict';
import test from 'node:test';

import { DecisionLedger, MockDecisionBackend, ReflexRouter, type CandidateItem, type RouteResponse } from './vendor/harness-reflex/index.js';

import { resolveConfig } from './config.js';
import {
  CURRENT_MODEL_NOTE,
  ReflexRoutingError,
  VirtualModelRouter,
  alignReasoningEffort,
  buildCacheAffinityInstruction,
  estimateContextTokens,
  formatTargetName,
  parseFallback,
  parseTargetName,
  type PhysicalTarget,
  type ReasoningSupport,
  type VirtualModelRouterOptions
} from './router.js';

/** Pools used by most tests: one fast generalist and one deep reasoner. */
const POOLS = {
  'reflex-auto': [
    { provider: 'deepseek', model: 'chat', description: 'fast general chat' },
    { provider: 'deepseek', model: 'reasoner', description: 'hard reasoning math' }
  ],
  'reflex-fast': [{ provider: 'local', model: 'small', description: 'cheap quick replies' }]
};

/**
 * Build a router backed by the real System One router and the mock backend, so
 * these unit tests exercise the production decision path.
 * @param overrides - router options to override.
 * @returns the router plus the ledger it writes to.
 */
function createRouter(
  overrides: Partial<VirtualModelRouterOptions> = {}
): { router: VirtualModelRouter; ledger: DecisionLedger } {
  const ledger = new DecisionLedger(null);
  const backend = new MockDecisionBackend();
  const service = new ReflexRouter(backend, ledger);
  const router = new VirtualModelRouter({
    virtualProvider: 'reflex',
    models: POOLS,
    ledger,
    backendName: backend.name,
    route: (goal, candidates, topK) => service.selectBest(goal, candidates, topK, { record: false }),
    ...overrides
  });
  return { router, ledger };
}

test('a task matching one candidate routes to it and audits the decision', async () => {
  const { router, ledger } = createRouter();

  const decision = await router.routeModel({
    provider: 'reflex',
    model: 'reflex-auto',
    task: 'solve hard reasoning math problem',
    agentId: 'session-main',
    role: 'main',
    turn: 2,
    step: 3
  });

  assert.equal(decision.target.provider, 'deepseek');
  assert.equal(decision.target.model, 'reasoner');
  assert.equal(decision.reason, 'matched');
  assert.equal(decision.degraded, false);
  assert.equal(decision.candidateCount, 2);
  assert.deepEqual(
    decision.candidates.map((candidate) => candidate.name),
    ['deepseek:reasoner', 'deepseek:chat']
  );
  assert.ok(decision.score > 3, `winner should outscore the neutral prior (got ${decision.score})`);
  assert.ok(decision.confidence > 0.9 && decision.confidence < 1, `confidence should be a share, got ${decision.confidence}`);
  assert.equal(decision.task, 'solve hard reasoning math problem');

  const entries = ledger.getEntries();
  assert.equal(entries.length, 1, 'exactly one audit entry is written per decision');
  assert.equal(entries[0].type, 'model-route');
  assert.equal(entries[0].backend, 'mock-heuristic-v1');
  assert.deepEqual(entries[0].details?.chosen, 'deepseek:reasoner');
  assert.deepEqual(entries[0].details?.virtual, 'reflex:reflex-auto');
  assert.deepEqual(entries[0].details?.candidateCount, 2);
  assert.deepEqual(entries[0].details?.candidates, ['deepseek:reasoner', 'deepseek:chat']);
  assert.deepEqual(entries[0].details?.agentId, 'session-main');
  assert.deepEqual(entries[0].details?.role, 'main');
  assert.deepEqual(entries[0].details?.turn, 2);
  assert.deepEqual(entries[0].details?.step, 3);
  assert.equal(entries[0].details?.degraded, false);
});

test('a task carrying no signal resolves to the first declared candidate', async () => {
  const { router } = createRouter();
  const decision = await router.routeModel({ provider: 'reflex', model: 'reflex-auto', task: 'zzz qqq' });
  assert.equal(formatTargetName(decision.target), 'deepseek:chat', 'ties keep configuration order');
  assert.equal(decision.candidates[0].score, decision.candidates[1].score);
});

test('candidate descriptions carry the pool note and tags into the decision', async () => {
  const seen: CandidateItem[][] = [];
  const { router } = createRouter({
    models: {
      'reflex-auto': [
        { provider: 'p', model: 'm', description: 'vision capable', tags: ['image', 'ocr'] },
        { provider: 'p', model: 'n' }
      ]
    },
    route: async (_goal, candidates): Promise<RouteResponse> => {
      seen.push([...candidates]);
      return { rankedCandidates: [{ name: 'p:m', score: 1 }], bestCandidate: 'p:m', latencyMs: 0 };
    }
  });

  await router.routeModel({ provider: 'reflex', model: 'reflex-auto', task: 'read a screenshot' });
  assert.equal(seen[0][0].description, 'vision capable · image · ocr');
  assert.equal(seen[0][1].description, '');
});

test('an empty pool degrades to the configured fallback and says why', async () => {
  const { router, ledger } = createRouter({
    models: { 'reflex-auto': [] },
    fallback: { provider: 'deepseek', model: 'chat' }
  });

  const decision = await router.routeModel({ provider: 'reflex', model: 'reflex-auto', task: 'anything' });

  assert.equal(decision.degraded, true);
  assert.equal(decision.reason, 'fallback-empty-pool');
  assert.equal(formatTargetName(decision.target), 'deepseek:chat');
  assert.equal(decision.score, 0);
  assert.equal(decision.confidence, 0);
  assert.equal(decision.candidateCount, 0);

  const entry = ledger.getEntries()[0];
  assert.equal(entry.type, 'model-route');
  assert.equal(entry.details?.degraded, true);
  assert.match(String(entry.details?.reason), /^fallback-empty-pool: .*empty candidate pool/);
});

test('an empty pool without a fallback fails closed', async () => {
  const { router, ledger } = createRouter({ models: { 'reflex-auto': [] } });

  await assert.rejects(
    () => router.routeModel({ provider: 'reflex', model: 'reflex-auto' }),
    (error: unknown) => {
      assert.ok(error instanceof ReflexRoutingError);
      assert.equal(error.code, 'EMPTY_POOL');
      assert.match(error.message, /routing\.fallback/);
      return true;
    }
  );
  assert.equal(ledger.getEntries().length, 0, 'a refused route is not recorded as a decision');
});

test('an unknown virtual model degrades to the fallback, or fails closed without one', async () => {
  const withFallback = createRouter({ fallback: { provider: 'deepseek', model: 'chat' } });
  const degraded = await withFallback.router.routeModel({ provider: 'reflex', model: 'reflex-typo' });
  assert.equal(degraded.reason, 'fallback-unknown-model');
  assert.equal(degraded.degraded, true);
  assert.match(String(withFallback.ledger.getEntries()[0].details?.reason), /not declared in routing\.models/);

  const withoutFallback = createRouter();
  await assert.rejects(
    () => withoutFallback.router.routeModel({ provider: 'reflex', model: 'reflex-typo' }),
    (error: unknown) => error instanceof ReflexRoutingError && error.code === 'UNKNOWN_MODEL'
  );
});

test('an empty virtual model id is refused with a dedicated code', async () => {
  const { router } = createRouter();
  await assert.rejects(
    () => router.routeModel({ provider: 'reflex', model: '  ' }),
    (error: unknown) => error instanceof ReflexRoutingError && error.code === 'INVALID_MODEL'
  );
});

test('a pool entry that routes back into the virtual provider is refused', async () => {
  const { router, ledger } = createRouter({
    // Bypasses config validation on purpose: the router must defend itself even
    // if a pool reached it from somewhere other than resolveConfig().
    models: { 'reflex-auto': [{ provider: 'reflex', model: 'reflex-auto' }] },
    fallback: { provider: 'deepseek', model: 'chat' },
    route: async (): Promise<RouteResponse> => ({
      rankedCandidates: [{ name: 'reflex:reflex-auto', score: 1 }],
      bestCandidate: 'reflex:reflex-auto',
      latencyMs: 0
    })
  });

  const decision = await router.routeModel({ provider: 'reflex', model: 'reflex-auto' });
  assert.equal(decision.degraded, true);
  assert.equal(decision.reason, 'fallback-illegal-target');
  assert.equal(formatTargetName(decision.target), 'deepseek:chat');
  assert.match(String(ledger.getEntries()[0].details?.reason), /routes back into the virtual provider/);

  const strict = createRouter({
    models: { 'reflex-auto': [{ provider: 'reflex', model: 'reflex-auto' }] },
    route: async (): Promise<RouteResponse> => ({
      rankedCandidates: [{ name: 'reflex:reflex-auto', score: 1 }],
      bestCandidate: 'reflex:reflex-auto',
      latencyMs: 0
    })
  });
  await assert.rejects(
    () => strict.router.routeModel({ provider: 'reflex', model: 'reflex-auto' }),
    (error: unknown) => error instanceof ReflexRoutingError && error.code === 'ILLEGAL_TARGET'
  );
});

test('an unparsable target returned by the decision is never dispatched', async () => {
  const { router } = createRouter({
    route: async (): Promise<RouteResponse> => ({
      rankedCandidates: [{ name: 'garbage', score: 1 }],
      bestCandidate: 'garbage',
      latencyMs: 0
    })
  });

  await assert.rejects(
    () => router.routeModel({ provider: 'reflex', model: 'reflex-auto' }),
    (error: unknown) => error instanceof ReflexRoutingError && error.code === 'ILLEGAL_TARGET' && /unparsable/.test(error.message)
  );
});

test('a decision that ranks no candidate degrades instead of dispatching nothing', async () => {
  const { router } = createRouter({
    fallback: { provider: 'deepseek', model: 'chat' },
    route: async (): Promise<RouteResponse> => ({ rankedCandidates: [], latencyMs: 0 })
  });

  const decision = await router.routeModel({ provider: 'reflex', model: 'reflex-auto' });
  assert.equal(decision.reason, 'fallback-no-candidate');
  assert.equal(formatTargetName(decision.target), 'deepseek:chat');
});

test('a router refuses to route a provider it does not own', async () => {
  const { router } = createRouter();
  assert.equal(router.owns('reflex'), true);
  assert.equal(router.owns('deepseek'), false);
  await assert.rejects(
    () => router.routeModel({ provider: 'deepseek', model: 'chat' }),
    (error: unknown) => error instanceof ReflexRoutingError && error.code === 'ILLEGAL_TARGET'
  );
});

test('the router reports its configured surface', () => {
  const { router } = createRouter();
  assert.deepEqual(router.modelIds, ['reflex-auto', 'reflex-fast']);
  assert.equal(router.hasPools, true);
  assert.equal(router.poolFor('reflex-fast')?.length, 1);
  assert.equal(router.poolFor('nope'), undefined);
  assert.match(router.describe('reflex-fast'), /local:small \(cheap quick replies\)/);

  const empty = createRouter({ models: { 'reflex-auto': [] } });
  assert.equal(empty.router.hasPools, false);
  assert.match(empty.router.describe('reflex-auto'), /no physical candidates configured/);
});

test('routing latency comes from the injected clock', async () => {
  let ticks = 0;
  const { router, ledger } = createRouter({ now: () => (ticks += 7) });
  const decision = await router.routeModel({ provider: 'reflex', model: 'reflex-fast', task: 'quick' });
  assert.equal(decision.latencyMs, 7);
  assert.equal(ledger.getEntries()[0].latencyMs, 7);
});

test('a task longer than the audit budget is truncated in the ledger', async () => {
  const { router, ledger } = createRouter();
  await router.routeModel({ provider: 'reflex', model: 'reflex-fast', task: 'x'.repeat(500) });
  const goal = String(ledger.getEntries()[0].details?.goal);
  assert.equal(goal.length, 160);
});

test('alignReasoningEffort projects an effort onto the routed target', async () => {
  const target: PhysicalTarget = { provider: 'deepseek', model: 'chat' };
  const probe = (support: ReasoningSupport | Error) => async (): Promise<ReasoningSupport> => {
    if (support instanceof Error) throw support;
    return support;
  };

  assert.equal(await alignReasoningEffort(undefined, target, probe({ kind: 'none' })), undefined);
  assert.equal(await alignReasoningEffort('high', target, probe({ kind: 'declared', efforts: ['low', 'high'] })), 'high');
  assert.equal(
    await alignReasoningEffort('high', target, probe({ kind: 'declared', efforts: ['low'], defaultEffort: 'low' })),
    'low'
  );
  assert.equal(await alignReasoningEffort('high', target, probe({ kind: 'declared', efforts: ['low'] })), undefined);
  assert.equal(await alignReasoningEffort('high', target, probe({ kind: 'none' })), undefined);
  assert.equal(await alignReasoningEffort('high', target, probe({ kind: 'unknown' })), 'high');
  assert.equal(await alignReasoningEffort('high', target, probe(new Error('boom'))), 'high');
});

test('parse helpers accept exactly one provider:model shape', () => {
  assert.deepEqual(parseTargetName('deepseek:deepseek-chat'), { provider: 'deepseek', model: 'deepseek-chat' });
  assert.deepEqual(parseTargetName('a:b:c'), { provider: 'a', model: 'b:c' });
  assert.equal(parseTargetName('deepseek'), undefined);
  assert.equal(parseTargetName(':chat'), undefined);
  assert.equal(parseTargetName('deepseek:'), undefined);
  assert.equal(parseTargetName('  :  '), undefined);
  assert.deepEqual(parseFallback(' deepseek:chat '), { provider: 'deepseek', model: 'chat' });
  assert.throws(() => parseFallback('deepseek'), /provider:model/);
});

test('resolveConfig validates the routing block instead of trusting it', () => {
  const resolved = resolveConfig({
    routing: {
      virtualProvider: 'reflex',
      fallback: 'deepseek:chat',
      models: { 'reflex-auto': [{ provider: 'deepseek', model: 'reasoner', tags: ['math', ' '] }] }
    }
  });
  assert.equal(resolved.routing.enabled, true);
  assert.deepEqual(resolved.routing.fallback, { provider: 'deepseek', model: 'chat' });
  assert.deepEqual(resolved.routing.models['reflex-auto'], [
    { provider: 'deepseek', model: 'reasoner', tags: ['math'] }
  ]);
  assert.equal(resolved.routing.maxTaskChars, 400);

  assert.throws(
    () => resolveConfig({ routing: { models: { 'reflex-auto': [{ provider: 'reflex', model: 'reflex-auto' }] } } }),
    /routes back into the virtual provider/
  );
  assert.throws(() => resolveConfig({ routing: { models: { m: [{ provider: 'p', model: '  ' }] } } }), /non-empty provider and model/);
  assert.throws(() => resolveConfig({ routing: { models: { m: [{ provider: 'p:q', model: 'm' }] } } }), /must not contain ":"/);
  assert.throws(() => resolveConfig({ routing: { fallback: 'reflex:reflex-auto' } }), /must not point back/);
  assert.throws(() => resolveConfig({ routing: { fallback: 'deepseek' } }), /provider:model/);
  assert.throws(() => resolveConfig({ routing: { virtualProvider: 'a:b' } }), /must not contain ":"/);
  assert.throws(() => resolveConfig({ routing: { virtualProvider: ' ' } }), /must be non-empty/);
});

/** One captured call of the System One seam. */
interface SeamCall {
  goal: string;
  candidates: CandidateItem[];
  topK: number;
  state?: { currentModel?: string; contextTokens?: number; contextChars?: number };
  instructions?: string;
}

/**
 * Build a router whose decision seam is scripted, so the *request* handed to
 * System 1 (not just the outcome) can be asserted on.
 * @param ranked - the ranking the seam returns.
 * @param overrides - router options to override.
 * @returns the router, its ledger, and the captured calls.
 */
function createScriptedRouter(
  ranked: RouteResponse,
  overrides: Partial<VirtualModelRouterOptions> = {}
): { router: VirtualModelRouter; ledger: DecisionLedger; calls: SeamCall[] } {
  const ledger = new DecisionLedger(null);
  const calls: SeamCall[] = [];
  const router = new VirtualModelRouter({
    virtualProvider: 'reflex',
    models: POOLS,
    ledger,
    backendName: 'scripted',
    route: (goal, candidates, topK, input) => {
      calls.push({
        goal,
        candidates,
        topK,
        ...(input?.state === undefined ? {} : { state: input.state }),
        ...(input?.instructions === undefined ? {} : { instructions: input.instructions })
      });
      return Promise.resolve(ranked);
    },
    ...overrides
  });
  return { router, ledger, calls };
}

/** A ranking that plays one candidate off against another. */
function ranking(entries: Array<[string, number]>): RouteResponse {
  return {
    rankedCandidates: entries.map(([name, score]) => ({ name, score })),
    bestCandidate: entries[0]?.[0],
    latencyMs: 1
  };
}

test('estimateContextTokens rounds characters up at the documented ratio', () => {
  assert.equal(estimateContextTokens(0), 0);
  assert.equal(estimateContextTokens(-10), 0);
  assert.equal(estimateContextTokens(Number.NaN), 0);
  assert.equal(estimateContextTokens(1), 1);
  assert.equal(estimateContextTokens(4), 1);
  assert.equal(estimateContextTokens(5), 2);
  assert.equal(estimateContextTokens(4000), 1000);
});

test('the decision request carries the session context size and current model', async () => {
  const { router, calls } = createScriptedRouter(ranking([['deepseek:chat', 0.9], ['deepseek:reasoner', 0.1]]), {
    models: POOLS
  });

  const decision = await router.routeModel({
    provider: 'reflex',
    model: 'reflex-auto',
    task: 'keep going',
    currentModel: { provider: 'deepseek', model: 'chat' },
    contextChars: 12000
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].state?.currentModel, 'deepseek:chat');
  assert.equal(calls[0].state?.contextChars, 12000, 'the raw character count reaches the decision');
  assert.equal(calls[0].state?.contextTokens, 3000, 'the token estimate is derived when the caller gave none');
  assert.match(String(calls[0].instructions), /prompt-cache affinity/i);
  assert.match(String(calls[0].instructions), /deepseek:chat/);
  assert.match(String(calls[0].instructions), /only when another candidate is clearly better/i);
  assert.equal(decision.currentModel, 'deepseek:chat');
  assert.equal(decision.contextTokens, 3000);
  assert.equal(decision.contextChars, 12000);
  assert.equal(decision.switched, false);
});

test('an explicit token count wins over the estimate from characters', async () => {
  const { router, calls } = createScriptedRouter(ranking([['deepseek:chat', 0.9]]));
  const decision = await router.routeModel({
    provider: 'reflex',
    model: 'reflex-auto',
    currentModel: { provider: 'deepseek', model: 'chat' },
    contextChars: 400,
    contextTokens: 9000
  });
  assert.equal(calls[0].state?.contextTokens, 9000);
  assert.equal(decision.contextTokens, 9000);
  assert.equal(decision.contextChars, 400);
});

test('the incumbent candidate is marked for the decision, in both readings', async () => {
  const { router, calls } = createScriptedRouter(ranking([['deepseek:chat', 0.9], ['deepseek:reasoner', 0.1]]));
  await router.routeModel({
    provider: 'reflex',
    model: 'reflex-auto',
    currentModel: { provider: 'deepseek', model: 'chat' },
    contextChars: 100
  });

  const candidates = calls[0].candidates;
  const incumbent = candidates.find((candidate) => candidate.name === 'deepseek:chat');
  const other = candidates.find((candidate) => candidate.name === 'deepseek:reasoner');
  assert.equal(incumbent?.current, true, 'the flag is the machine-readable marking');
  assert.match(String(incumbent?.description), new RegExp(CURRENT_MODEL_NOTE), 'the note is the text reading');
  assert.equal(other?.current, undefined, 'a non-incumbent is not marked');
  assert.equal(String(other?.description).includes(CURRENT_MODEL_NOTE), false);
});

test('a session is not switched for a marginal score difference', async () => {
  const { router, ledger } = createScriptedRouter(ranking([['deepseek:reasoner', 0.5], ['deepseek:chat', 0.45]]));

  const decision = await router.routeModel({
    provider: 'reflex',
    model: 'reflex-auto',
    task: 'carry on with the migration plan',
    agentId: 'session-warm',
    currentModel: { provider: 'deepseek', model: 'chat' },
    contextChars: 40000
  });

  assert.equal(formatTargetName(decision.target), 'deepseek:chat', 'the cached model holds');
  assert.equal(decision.reason, 'sticky-affinity', 'the ledger says why it held');
  assert.equal(decision.switched, false);
  assert.equal(decision.score, 0.45, 'the score recorded is the winner that was actually used');

  const entry = ledger.getEntries().at(-1);
  assert.equal(entry?.details?.currentModel, 'deepseek:chat');
  assert.equal(entry?.details?.switched, false);
  assert.equal(entry?.details?.contextTokens, 10000);
  assert.equal(entry?.details?.contextChars, 40000);
  assert.equal(entry?.details?.chosen, 'deepseek:chat');
  assert.equal(entry?.details?.reason, 'sticky-affinity');
});

test('a clearly better candidate still displaces the current model', async () => {
  const { router, ledger } = createScriptedRouter(ranking([['deepseek:reasoner', 0.95], ['deepseek:chat', 0.2]]));

  const decision = await router.routeModel({
    provider: 'reflex',
    model: 'reflex-auto',
    task: 'prove the invariant',
    currentModel: { provider: 'deepseek', model: 'chat' },
    contextChars: 400
  });

  assert.equal(formatTargetName(decision.target), 'deepseek:reasoner');
  assert.equal(decision.reason, 'matched');
  assert.equal(decision.switched, true);
  assert.equal(ledger.getEntries().at(-1)?.details?.switched, true);
  assert.equal(ledger.getEntries().at(-1)?.details?.currentModel, 'deepseek:chat');
});

test('a challenger that only ties the incumbent never displaces it', async () => {
  const { router } = createScriptedRouter(ranking([['deepseek:reasoner', 0.4], ['deepseek:chat', 0.4]]));
  const decision = await router.routeModel({
    provider: 'reflex',
    model: 'reflex-auto',
    currentModel: { provider: 'deepseek', model: 'chat' },
    contextChars: 10
  });
  assert.equal(formatTargetName(decision.target), 'deepseek:chat');
  assert.equal(decision.switched, false);
});

test('stickyMargin=0 switches on any strict improvement', async () => {
  const { router } = createScriptedRouter(ranking([['deepseek:reasoner', 0.5], ['deepseek:chat', 0.45]]), {
    stickyMargin: 0
  });
  const decision = await router.routeModel({
    provider: 'reflex',
    model: 'reflex-auto',
    currentModel: { provider: 'deepseek', model: 'chat' },
    contextChars: 10
  });
  assert.equal(formatTargetName(decision.target), 'deepseek:reasoner');
  assert.equal(decision.switched, true);
});

test('a current model outside the pool is reported but cannot be defended', async () => {
  const { router, calls } = createScriptedRouter(ranking([['deepseek:reasoner', 0.4], ['deepseek:chat', 0.4]]));

  const decision = await router.routeModel({
    provider: 'reflex',
    model: 'reflex-auto',
    task: 'anything',
    currentModel: { provider: 'local', model: 'small' },
    contextChars: 800
  });

  assert.equal(calls[0].state?.currentModel, 'local:small', 'the session model is still reported to the decision');
  assert.match(String(calls[0].instructions), /not a candidate here/i);
  assert.equal(calls[0].candidates.some((candidate) => candidate.current === true), false, 'nothing in the pool is current');
  assert.equal(formatTargetName(decision.target), 'deepseek:reasoner', 'the pool decision stands on its own');
  assert.equal(decision.switched, true, 'moving off a model the pool cannot serve is still a switch');
  assert.equal(decision.currentModel, 'local:small');
});

test('a first decision has no incumbent and no switch to report', async () => {
  const { router, calls, ledger } = createScriptedRouter(ranking([['deepseek:reasoner', 0.9]]));
  const decision = await router.routeModel({ provider: 'reflex', model: 'reflex-auto', task: 'first turn' });

  assert.equal(decision.currentModel, undefined);
  assert.equal(decision.switched, false);
  assert.equal(decision.contextTokens, 0);
  assert.equal(ledger.getEntries().at(-1)?.details?.currentModel, null, 'the audit field is always present');
  assert.match(String(calls[0].instructions), /No physical model is in use yet/);
});

test('a degraded decision still reports the session facts and the switch it caused', async () => {
  const { router, ledger } = createScriptedRouter(ranking([]), {
    models: { 'reflex-auto': [] },
    fallback: { provider: 'deepseek', model: 'chat' }
  });

  const decision = await router.routeModel({
    provider: 'reflex',
    model: 'reflex-auto',
    currentModel: { provider: 'local', model: 'small' },
    contextChars: 4000
  });

  assert.equal(decision.degraded, true);
  assert.equal(decision.switched, true);
  assert.equal(decision.contextTokens, 1000);
  const entry = ledger.getEntries().at(-1);
  assert.equal(entry?.details?.currentModel, 'local:small');
  assert.equal(entry?.details?.switched, true);
  assert.equal(entry?.details?.contextTokens, 1000);
});

test('buildCacheAffinityInstruction states the policy, not a verdict', () => {
  const held = buildCacheAffinityInstruction({
    currentModel: 'deepseek:chat',
    incumbentInPool: true,
    contextTokens: 2500,
    contextChars: 10000
  });
  assert.match(held, /2500 tokens \(10000 characters\)/);
  assert.match(held, /prefer deepseek:chat/);

  const small = buildCacheAffinityInstruction({
    currentModel: 'deepseek:chat',
    incumbentInPool: true,
    contextTokens: 0,
    contextChars: 0
  });
  assert.match(small, /some of context/);

  const foreign = buildCacheAffinityInstruction({
    currentModel: 'local:small',
    incumbentInPool: false,
    contextTokens: 10,
    contextChars: 40
  });
  assert.match(foreign, /cache miss/);
});
