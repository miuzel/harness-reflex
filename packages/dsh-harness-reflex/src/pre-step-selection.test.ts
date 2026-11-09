import assert from 'node:assert/strict';
import test from 'node:test';

import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent';
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm';

import type { ReflexConfig } from './config.js';
import type { ReflexEffortStatus } from './effort.js';
import { effortRecordsOf } from './index.js';
import {
  createReflexHost,
  dispatchAgentRequest,
  fakeAgent,
  preStepPayload,
  registerPhysicalAdapter,
  stepSelection,
  userMessage
} from './testing.js';

/**
 * g-056: the route and the adaptive level are decided in `agent/pre-step` and
 * written into `payload.modelSelection`, so `agent/request` never proposes a
 * value the step preparation has already fixed.
 *
 * Every test here reproduces `dsh-agent-loop`'s own order rather than the
 * waterfall in isolation: `const selection = this.model.current()` is captured
 * first, `agent/pre-step` runs with that object, then `agent/request` runs and
 * its proposal is compared against the *same* object. That comparison is the
 * two guards copied from `prepareRequest`, message for message, which is the
 * only way a test can prove the plugin will not throw on a real Host.
 */

const TASK_DEEP = 'design the migration protocol for the distributed store';
const TASK_TRIVIAL = 'thanks';

/** One virtual model over one physical target, so the route is deterministic. */
const POOLS: ReflexConfig['routing'] = {
  models: {
    'reflex-auto': [{ provider: 'deepseek', model: 'reasoner', description: 'hard reasoning math' }]
  }
};

/** The deployment that turns the marker into a decision. */
const ADAPTIVE: ReflexConfig = { backend: 'mock', routing: POOLS, effort: { reasoningEffort: 'reflex' } };

/** Reasoning vocabulary of the fake physical route. */
const THINKING = { models: ['reasoner'], reasoningEfforts: ['low', 'high'], defaultEffort: 'low' };

/**
 * Brand one effort text the way the loop's config carries it.
 * @param value - effort text to brand.
 * @returns the branded effort.
 */
function effort(value: string): LlmCallConfig['reasoningEffort'] {
  return value as unknown as LlmCallConfig['reasoningEffort'];
}

/**
 * Run one step the way `dsh-agent-loop` does, from `model.current()` to the
 * guards in `prepareRequest`.
 *
 * @param ctx - the host the plugin is loaded on.
 * @param agent - the stepping agent.
 * @param options - step identity and the selection the loop would capture.
 * @returns the configuration the loop would really use.
 * @throws Error from either guard when the request proposed a fixed value.
 */
async function runLoopStep(
  ctx: Parameters<typeof dispatchAgentRequest>[0],
  agent: Agent,
  options: {
    turn: number;
    step: number;
    task?: string;
    /** What `this.model.current()` returns for the step. */
    current?: { provider: string; model: string; reasoningEffort?: string };
    /** Freeze the captured selection, as a read-only embedder might. */
    freeze?: boolean;
    signal?: AbortSignal;
  }
): Promise<LlmCallConfig> {
  const events = agentEvents(ctx, agent);
  const signal = options.signal ?? new AbortController().signal;
  const captured = { ...(options.current ?? stepSelection(agent)) } as {
    provider: string;
    model: string;
    reasoningEffort?: unknown;
  };
  const selection = options.freeze === true ? Object.freeze(captured) : captured;
  const messages = options.task === undefined ? [] : [userMessage(options.task)];

  // `preStep`: the captured selection is passed *into* the waterfall.
  await events.waterfall(
    'agent/pre-step',
    preStepPayload(agent, options.turn, options.step, messages, signal, selection as never),
    async () => ({ kind: 'enter' as const, messages })
  );

  // `prepareRequest`: the loop freezes the config from the same selection, then
  // runs the request waterfall and holds the proposal against it.
  const proposed = await events.waterfall(
    'agent/request',
    { turn: options.turn, step: options.step, signal },
    async () => Object.freeze(structuredClone({ ...selection })) as unknown as LlmCallConfig
  );

  if (proposed.provider !== selection.provider || proposed.model !== selection.model) {
    throw new Error(
      `agent/request proposed "${proposed.provider}/${proposed.model}" after step preparation fixed "${selection.provider}/${selection.model}"`
    );
  }
  if (proposed.reasoningEffort !== selection.reasoningEffort) {
    throw new Error(
      `agent/request proposed reasoning effort "${String(proposed.reasoningEffort ?? 'adapter default')}" after step preparation fixed "${String(selection.reasoningEffort ?? 'adapter default')}"`
    );
  }
  return proposed;
}

test('the pre-step write satisfies both dsh-agent-loop guards when provider, model and effort all change', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-guard', provider: 'reflex', model: 'reflex-auto' });

    // Every field moves: reflex→deepseek, reflex-auto→reasoner, reflex→high.
    const config = await runLoopStep(host.ctx, agent, {
      turn: 1,
      step: 1,
      task: TASK_DEEP,
      current: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: 'reflex' }
    });

    assert.deepEqual(config, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' });
  } finally {
    await host.dispose();
  }
});

test('the guards also hold for a run of steps in one turn, each captured from the previous decision', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-guard-run', provider: 'reflex', model: 'reflex-auto' });

    // Step 2 and 3 start from what step 1 really dispatched — the physical
    // target — which is the case that broke when routing read the selection.
    const step1 = await runLoopStep(host.ctx, agent, {
      turn: 1,
      step: 1,
      task: TASK_DEEP,
      current: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: 'reflex' }
    });
    assert.deepEqual(step1, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' });

    for (const step of [2, 3]) {
      const next = await runLoopStep(host.ctx, agent, { turn: 1, step, current: step1 });
      assert.deepEqual(next, step1, `step ${step} keeps the turn's route and level`);
    }
  } finally {
    await host.dispose();
  }
});

test('a next() rejection is not swallowed by the decision path', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-guard-next', provider: 'reflex', model: 'reflex-auto' });
    const events = agentEvents(host.ctx, agent);

    // The rest of the waterfall refuses the step; the plugin must let that reach
    // the loop instead of turning it into an admitted step.
    await assert.rejects(
      events.waterfall(
        'agent/pre-step',
        preStepPayload(agent, 1, 1, [userMessage(TASK_DEEP)]),
        async () => {
          throw new Error('the rest of the waterfall refused this step');
        }
      ),
      /the rest of the waterfall refused this step/
    );

    const records = effortRecordsOf((agent.session as unknown as { ownEvents(): never[] }).ownEvents());
    assert.equal(records.length, 0, 'a refused step decides nothing');
  } finally {
    await host.dispose();
  }
});

test('a frozen modelSelection is left untouched and the step still proceeds', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-guard-frozen', provider: 'reflex', model: 'reflex-auto' });

    const config = await runLoopStep(host.ctx, agent, {
      turn: 1,
      step: 1,
      task: TASK_DEEP,
      current: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: 'reflex' },
      freeze: true
    });

    // The write raised TypeError inside the listener and was caught: the step
    // runs on exactly the selection the loop fixed, marker and all.
    assert.deepEqual(config, { provider: 'reflex', model: 'reflex-auto', reasoningEffort: 'reflex' });
  } finally {
    await host.dispose();
  }
});

test('a throwing decision leaves the selection untouched and the step admitted', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-guard-throw', provider: 'reflex', model: 'reflex-auto' });
    // A backend that fails the decision outright.
    (host.runtime.effort as unknown as { resolve: () => Promise<never> }).resolve = async () => {
      throw new Error('system one is down');
    };

    const config = await runLoopStep(host.ctx, agent, {
      turn: 1,
      step: 1,
      task: TASK_DEEP,
      current: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: 'reflex' }
    });

    assert.deepEqual(config, { provider: 'reflex', model: 'reflex-auto', reasoningEffort: 'reflex' });
  } finally {
    await host.dispose();
  }
});

test('one turn of three steps decides its effort exactly once', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-guard-once', provider: 'reflex', model: 'reflex-auto' });

    let decisions = 0;
    const original = host.runtime.effort.resolve.bind(host.runtime.effort);
    (host.runtime.effort as unknown as { resolve: unknown }).resolve = (context: never) => {
      decisions += 1;
      return original(context);
    };
    const seen: ReflexEffortStatus[] = [];
    host.ctx.on('reflex/effort', (status) => seen.push(status));

    const step1 = await runLoopStep(host.ctx, agent, {
      turn: 1,
      step: 1,
      task: TASK_DEEP,
      current: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: 'reflex' }
    });
    const step2 = await runLoopStep(host.ctx, agent, { turn: 1, step: 2, current: step1 });
    const step3 = await runLoopStep(host.ctx, agent, { turn: 1, step: 3, current: step2 });

    assert.equal(decisions, 1, 'System 1 is asked once for the whole turn');
    assert.equal(seen.length, 1, 'and the status is published once');
    assert.deepEqual([step2, step3], [step1, step1], 'both later steps replay step 1 exactly');
  } finally {
    await host.dispose();
  }
});

test('the non-adaptive alignment runs in the pre-step, not in the request', async () => {
  // `high` is not in this target's vocabulary, so alignment has to move it.
  const host = await createReflexHost({ backend: 'mock', routing: POOLS });
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', { models: ['reasoner'], reasoningEfforts: ['low'], defaultEffort: 'low' });
    const agent = fakeAgent({ id: 'session-guard-align', provider: 'reflex', model: 'reflex-auto' });

    const config = await runLoopStep(host.ctx, agent, {
      turn: 1,
      step: 1,
      task: TASK_DEEP,
      current: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: 'high' }
    });

    // Both the route and the aligned level were written before the request, so
    // the request proposal (built from the same selection) already matches.
    assert.deepEqual(config, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'low' });
  } finally {
    await host.dispose();
  }
});

test('a delegated agent keeps the effort its own selection fixed', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const child = fakeAgent({
      id: 'session-guard-child',
      origin: 'subagent',
      delegationDepth: 1,
      provider: 'reflex',
      model: 'reflex-auto'
    });

    // `effort-delegation.ts` has already replaced the marker with a concrete
    // level on the child's selection; this layer must route but not re-decide.
    const config = await runLoopStep(host.ctx, child, {
      turn: 1,
      step: 1,
      task: TASK_TRIVIAL,
      current: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: 'high' }
    });

    assert.deepEqual(config, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' });
  } finally {
    await host.dispose();
  }
});

test('a cancelled step is neither routed nor decided', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-guard-aborted', provider: 'reflex', model: 'reflex-auto' });
    const controller = new AbortController();
    controller.abort();

    const config = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      turn: 1,
      step: 1,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') },
      signal: controller.signal
    });

    assert.deepEqual(config, { provider: 'reflex', model: 'reflex-auto', reasoningEffort: 'reflex' });
    assert.equal(host.runtime.ledger.getEntries().filter((entry) => entry.type === 'model-route').length, 0);
  } finally {
    await host.dispose();
  }
});

test('a decision that outruns its budget leaves the selection untouched', async () => {
  const host = await createReflexHost(ADAPTIVE);
  const previous = process.env.REFLEX_STEP_DECISION_TIMEOUT_MS;
  process.env.REFLEX_STEP_DECISION_TIMEOUT_MS = '25';
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-guard-slow', provider: 'reflex', model: 'reflex-auto' });
    // A backend that answers long after the step had to be admitted.
    (host.runtime.effort as unknown as { resolve: unknown }).resolve = () =>
      new Promise((resolve) => setTimeout(() => resolve({ changed: true, effort: 'high', outcome: 'supported' }), 3000));

    const started = Date.now();
    const config = await runLoopStep(host.ctx, agent, {
      turn: 1,
      step: 1,
      task: TASK_DEEP,
      current: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: 'reflex' }
    });

    assert.ok(Date.now() - started < 2000, 'the step is not held open for the full budget');
    assert.deepEqual(config, { provider: 'reflex', model: 'reflex-auto', reasoningEffort: 'reflex' });
  } finally {
    if (previous === undefined) delete process.env.REFLEX_STEP_DECISION_TIMEOUT_MS;
    else process.env.REFLEX_STEP_DECISION_TIMEOUT_MS = previous;
    await host.dispose();
  }
});

test('routing keeps working after a step records a physical provider', async () => {
  // The loop records the routed request as the session selection, so a later
  // step's `current()` already names the physical provider. Routing must still
  // find the virtual pool from the caller's own intent.
  const host = await createReflexHost({
    backend: 'mock',
    routing: {
      models: {
        'reflex-auto': [
          { provider: 'deepseek', model: 'chat', description: 'fast general chat' },
          { provider: 'deepseek', model: 'reasoner', description: 'hard reasoning math' }
        ]
      }
    }
  });
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', { models: ['chat', 'reasoner'] });
    const agent = fakeAgent({ id: 'session-guard-survive', provider: 'reflex', model: 'reflex-auto' });

    const turn1 = await runLoopStep(host.ctx, agent, {
      turn: 1,
      step: 1,
      task: TASK_DEEP,
      current: { provider: 'reflex', model: 'reflex-auto' }
    });
    assert.equal(turn1.provider, 'deepseek');

    // A new turn whose `model.current()` is already the physical target the
    // previous turn recorded — the real case once a routed request is logged.
    const physical = { provider: turn1.provider, model: turn1.model };
    const turn2 = await runLoopStep(host.ctx, agent, { turn: 2, step: 1, task: TASK_DEEP, current: physical });
    assert.deepEqual(turn2, turn1, 'the second turn is routed again, on the same warm target');

    const routes = host.runtime.ledger.getEntries().filter((entry) => entry.type === 'model-route');
    assert.equal(routes.length, 2, 'both turns took a real routing decision');
  } finally {
    await host.dispose();
  }
});
