import assert from 'node:assert/strict';
import test from 'node:test';

import { Context } from '@deepseek-ai/cordis';
import { markAgentLoopRequest, type GenerateOptions, type LlmCallConfig, type StreamChunk } from '@deepseek-ai/dsh-llm';

import { applyReflex, Config, ReflexVirtualAdapter } from './index.js';
import type { ReflexRuntime } from './bridge.js';
import type { ReflexConfig } from './config.js';
import {
  createReflexHost,
  createToolContext,
  dispatchAgentRequest,
  fakeAgent,
  registerPhysicalAdapter,
  userMessage,
  type FakePhysicalAdapter
} from './testing.js';

/**
 * Integration coverage for the virtual provider: real Cordis + real
 * `LlmRuntime` + real adapter registry + real agent-scoped waterfall dispatch.
 * Every assertion here observes a production seam (registry, dispatch, ledger),
 * never an internal of the router.
 */

/** Routing config used by most tests: two pools over two physical providers. */
const ROUTING: ReflexConfig['routing'] = {
  models: {
    'reflex-auto': [
      { provider: 'deepseek', model: 'chat', description: 'fast general chat' },
      { provider: 'deepseek', model: 'reasoner', description: 'hard reasoning math' }
    ],
    'reflex-fast': [{ provider: 'local', model: 'small', description: 'cheap quick replies' }]
  }
};

/**
 * Routing config whose first model has an empty pool while another model keeps
 * a usable one, so the virtual provider is registered and the empty pool can be
 * exercised at dispatch time.
 */
const EMPTY_AUTO: ReflexConfig['routing'] = {
  models: {
    'reflex-auto': [],
    'reflex-fast': [{ provider: 'local', model: 'small', description: 'cheap quick replies' }]
  }
};

const TASK_DEEP = 'solve hard reasoning math problem';
const TASK_CHEAP = 'cheap quick replies for a trivial rename';
const TASK_CHAT = 'fast general chat about the release notes';

/**
 * Spawn a real agent-scoped request through the registered waterfall.
 * @param value - effort text to brand.
 * @returns the branded effort.
 */
function effort(value: string): LlmCallConfig['reasoningEffort'] {
  return value as unknown as LlmCallConfig['reasoningEffort'];
}

/**
 * Drain one chunk stream.
 * @param stream - the stream to drain.
 * @returns every chunk, in order.
 */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/**
 * Dispatch one request through the LLM runtime without an agent scope.
 * @param ctx - host context.
 * @param options - the request naming the virtual route.
 * @returns every chunk the runtime produced.
 */
function stream(
  ctx: Context,
  options: Partial<GenerateOptions> & { provider: string; model: string }
): Promise<StreamChunk[]> {
  return collect(ctx.llm.stream({ messages: [userMessage('anything')], ...options } as GenerateOptions));
}

/**
 * Provider ids currently registered on the runtime.
 * @param ctx - host context.
 * @returns registered provider ids.
 */
function providerIds(ctx: Context): string[] {
  return ctx.llm.listProviders().map((provider) => provider.id);
}

test('a configured pool registers the virtual provider and advertises its models', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: ROUTING });
  try {
    const virtual = host.ctx.llm.listProviders().find((provider) => provider.id === 'reflex');
    assert.ok(virtual, `the virtual provider must be registered (got ${providerIds(host.ctx).join(', ')})`);
    assert.match(virtual.name, /Reflex/);

    const models = await host.ctx.llm.listModels('reflex');
    assert.deepEqual(
      models.map((model) => model.id),
      ['reflex-auto', 'reflex-fast']
    );
    assert.match(String(models[0].description), /deepseek:chat \(fast general chat\)/);
    assert.match(String(models[0].description), /deepseek:reasoner \(hard reasoning math\)/);

    const info = await host.ctx.llm.resolveModelInfo('reflex', 'reflex-fast');
    assert.equal(info.provider, 'reflex');
    assert.equal(info.id, 'reflex-fast');

    assert.equal(host.runtime.modelRouter.hasPools, true);
  } finally {
    await host.dispose();
  }
});

test('a request naming the virtual model reaches the physical adapter System 1 chose', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: ROUTING });
  try {
    const physical = registerPhysicalAdapter(host.ctx, 'deepseek', { models: ['chat', 'reasoner'] });

    const chunks = await stream(host.ctx, {
      provider: 'reflex',
      model: 'reflex-auto',
      messages: [userMessage(TASK_DEEP)]
    });

    assert.equal(physical.calls.length, 1, 'exactly one physical dispatch');
    assert.equal(physical.calls[0].provider, 'deepseek');
    assert.equal(physical.calls[0].model, 'reasoner', 'the reasoning candidate wins the deep task');
    assert.equal(physical.calls[0].lastUserText, TASK_DEEP, 'the payload is forwarded unchanged');
    assert.equal(chunks[0].type, 'text-delta');
    assert.equal((chunks[0] as { text: string }).text, 'deepseek:reasoner');

    const entries = host.runtime.ledger.getEntries().filter((entry) => entry.type === 'model-route');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].details?.chosen, 'deepseek:reasoner');
    assert.equal(entries[0].details?.degraded, false);
    assert.equal(entries[0].backend, 'mock-heuristic-v1');
    assert.ok(typeof entries[0].latencyMs === 'number');
  } finally {
    await host.dispose();
  }
});

test('a request with no task signal still resolves deterministically at dispatch time', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: ROUTING });
  try {
    const physical = registerPhysicalAdapter(host.ctx, 'deepseek', { models: ['chat', 'reasoner'] });
    await stream(host.ctx, { provider: 'reflex', model: 'reflex-auto', messages: [userMessage('zzz qqq')] });
    assert.equal(physical.calls[0].model, 'chat', 'ties keep the configured candidate order');
  } finally {
    await host.dispose();
  }
});

test('an unroutable virtual model fails closed at the last mile instead of dispatching', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: EMPTY_AUTO });
  try {
    const physical = registerPhysicalAdapter(host.ctx, 'deepseek', { models: ['chat'] });
    const chunks = await stream(host.ctx, { provider: 'reflex', model: 'reflex-auto' });

    assert.equal(physical.calls.length, 0, 'nothing is dispatched when the pool cannot answer');
    const finish = chunks.at(-1);
    assert.equal(finish?.type, 'finish');
    assert.equal((finish as { reason: { kind: string } }).reason.kind, 'error');
    assert.match(JSON.stringify(finish), /empty candidate pool/);
  } finally {
    await host.dispose();
  }
});

test('a degraded route dispatches through the configured fallback', async () => {
  const host = await createReflexHost({
    backend: 'mock',
    routing: { ...EMPTY_AUTO, fallback: 'deepseek:chat' }
  });
  try {
    const physical = registerPhysicalAdapter(host.ctx, 'deepseek', { models: ['chat'] });
    const chunks = await stream(host.ctx, { provider: 'reflex', model: 'reflex-auto' });

    assert.equal(physical.calls.length, 1);
    assert.deepEqual([physical.calls[0].provider, physical.calls[0].model], ['deepseek', 'chat']);
    assert.equal((chunks[0] as { text: string }).text, 'deepseek:chat');
    const entry = host.runtime.ledger.getEntries().at(-1);
    assert.equal(entry?.details?.degraded, true);
    assert.match(String(entry?.details?.reason), /^fallback-empty-pool/);
  } finally {
    await host.dispose();
  }
});

test('a loop-owned request stays loop-owned after the adapter rewrites its route', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: ROUTING });
  try {
    const physical = registerPhysicalAdapter(host.ctx, 'deepseek', { models: ['chat', 'reasoner'] });
    const options = {
      provider: 'reflex',
      model: 'reflex-auto',
      messages: [userMessage(TASK_DEEP)]
    } as GenerateOptions;
    markAgentLoopRequest(options);

    await collect(host.ctx.llm.stream(options));

    assert.equal(physical.calls[0].loopOwned, true, 'downstream listeners must still see a loop request');
    assert.equal(options.provider, 'reflex', 'the caller-owned request object is never mutated');
  } finally {
    await host.dispose();
  }
});

test('the agent/request waterfall rewrites the frozen call config of the main agent', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: ROUTING });
  try {
    const agent = fakeAgent({ id: 'session-main', provider: 'reflex', model: 'reflex-auto' });
    const config = await dispatchAgentRequest(host.ctx, agent, { task: TASK_DEEP, turn: 4, step: 2 });

    assert.deepEqual(config, { provider: 'deepseek', model: 'reasoner' });

    const entry = host.runtime.ledger.getEntries().at(-1);
    assert.equal(entry?.type, 'model-route');
    assert.equal(entry?.details?.chosen, 'deepseek:reasoner');
    assert.equal(entry?.details?.agentId, 'session-main');
    assert.equal(entry?.details?.role, 'main');
    assert.equal(entry?.details?.turn, 4);
    assert.equal(entry?.details?.step, 2);
  } finally {
    await host.dispose();
  }
});

test('a subagent inherits the virtual route and is routed on its own task', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: ROUTING });
  try {
    const main = fakeAgent({ id: 'session-main', provider: 'reflex', model: 'reflex-auto' });
    const child = fakeAgent({
      id: 'session-child',
      origin: 'subagent',
      delegationDepth: 1,
      provider: 'reflex',
      model: 'reflex-auto'
    });

    const mainConfig = await dispatchAgentRequest(host.ctx, main, {
      task: TASK_CHEAP,
      turn: 1,
      step: 1,
      config: { provider: 'reflex', model: 'reflex-fast' }
    });
    const childConfig = await dispatchAgentRequest(host.ctx, child, { task: TASK_DEEP, turn: 1, step: 1 });
    const childAgain = await dispatchAgentRequest(host.ctx, child, {
      task: TASK_CHEAP,
      turn: 1,
      step: 2,
      config: { provider: 'reflex', model: 'reflex-fast' }
    });

    assert.deepEqual(mainConfig, { provider: 'local', model: 'small' }, 'the parent routes on its own task');
    assert.deepEqual(childConfig, { provider: 'deepseek', model: 'reasoner' }, 'the child routes on its task');
    assert.deepEqual(childAgain, { provider: 'local', model: 'small' }, 'the child re-routes when its task changes');

    const entries = host.runtime.ledger.getEntries().filter((entry) => entry.type === 'model-route');
    assert.equal(entries.length, 3);
    assert.deepEqual(
      entries.map((entry) => entry.details?.role),
      ['main', 'subagent', 'subagent']
    );
    assert.equal(entries[1].details?.agentId, 'session-child');
    assert.equal(entries[1].details?.delegationDepth, 1);
  } finally {
    await host.dispose();
  }
});

test('a subagent with no captured task routes without crashing', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: ROUTING });
  try {
    const child = fakeAgent({ id: 'session-child', origin: 'subagent', provider: 'reflex', model: 'reflex-auto' });
    const config = await dispatchAgentRequest(host.ctx, child);
    assert.deepEqual(config, { provider: 'deepseek', model: 'chat' });
    assert.equal(host.runtime.ledger.getEntries().at(-1)?.details?.role, 'subagent');
  } finally {
    await host.dispose();
  }
});

test('a request that is already cancelled is not routed', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: ROUTING });
  try {
    const controller = new AbortController();
    controller.abort();
    const agent = fakeAgent({ id: 'session-main', provider: 'reflex', model: 'reflex-auto' });

    const config = await dispatchAgentRequest(host.ctx, agent, { task: TASK_DEEP, signal: controller.signal });

    assert.deepEqual(config, { provider: 'reflex', model: 'reflex-auto' }, 'a cancelled request keeps its config');
    assert.equal(
      host.runtime.ledger.getEntries().filter((entry) => entry.type === 'model-route').length,
      0,
      'a cancelled request must not spend a System 1 decision or audit one'
    );
  } finally {
    await host.dispose();
  }
});

test('non-virtual requests pass through the waterfall untouched', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: ROUTING });
  try {
    const agent = fakeAgent({ id: 'session-main', provider: 'deepseek', model: 'reasoner' });
    const config = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      config: { provider: 'deepseek', model: 'reasoner', temperature: 0.2 }
    });

    assert.deepEqual(config, { provider: 'deepseek', model: 'reasoner', temperature: 0.2 });
    assert.equal(
      host.runtime.ledger.getEntries().filter((entry) => entry.type === 'model-route').length,
      0,
      'a request outside the virtual route is not a routing decision'
    );
  } finally {
    await host.dispose();
  }
});

test('a reasoning effort the physical target cannot honor is projected, not dropped blindly', async () => {
  const host = await createReflexHost({
    backend: 'mock',
    routing: {
      models: {
        'reflex-auto': [
          { provider: 'plain', model: 'basic', description: 'no reasoning support' },
          { provider: 'tuned', model: 'effortful', description: 'effortful tuned' }
        ]
      }
    }
  });
  try {
    registerPhysicalAdapter(host.ctx, 'plain', { models: ['basic'] });
    registerPhysicalAdapter(host.ctx, 'tuned', {
      models: ['effortful'],
      reasoningEfforts: ['low', 'high'],
      defaultEffort: 'low'
    });

    const dropped = await dispatchAgentRequest(host.ctx, fakeAgent({ id: 'a-plain' }), {
      task: 'nothing matches here',
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('high') }
    });
    assert.equal(dropped.provider, 'plain');
    assert.equal(dropped.reasoningEffort, undefined, 'a target with no reasoning vocabulary clears the effort');

    const kept = await dispatchAgentRequest(host.ctx, fakeAgent({ id: 'a-tuned' }), {
      task: 'effortful tuned',
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('high') }
    });
    assert.equal(kept.provider, 'tuned');
    assert.equal(kept.reasoningEffort, 'high', 'a supported effort survives routing');

    const projected = await dispatchAgentRequest(host.ctx, fakeAgent({ id: 'a-tuned-2' }), {
      task: 'effortful tuned',
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('medium') }
    });
    assert.equal(projected.reasoningEffort, 'low', 'an unsupported effort falls back to the declared default');
  } finally {
    await host.dispose();
  }
});

test('without a configured pool nothing is registered and physical dispatch is untouched', async () => {
  const host = await createReflexHost({ backend: 'mock' });
  try {
    assert.equal(providerIds(host.ctx).includes('reflex'), false, 'no virtual provider without a pool');
    assert.equal(host.runtime.modelRouter.hasPools, false);

    const physical = registerPhysicalAdapter(host.ctx, 'deepseek', { models: ['chat'] });
    await stream(host.ctx, { provider: 'deepseek', model: 'chat' });
    assert.equal(physical.calls.length, 1);

    const agent = fakeAgent({ id: 'session-main', provider: 'reflex', model: 'reflex-auto' });
    const config = await dispatchAgentRequest(host.ctx, agent, { task: TASK_DEEP });
    assert.deepEqual(config, { provider: 'reflex', model: 'reflex-auto' });
  } finally {
    await host.dispose();
  }
});

test('routing.enabled=false disables the virtual provider even with configured pools', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: { ...ROUTING, enabled: false } });
  try {
    assert.equal(providerIds(host.ctx).includes('reflex'), false);
    const agent = fakeAgent({ id: 'session-main', provider: 'reflex', model: 'reflex-auto' });
    assert.deepEqual(await dispatchAgentRequest(host.ctx, agent, { task: TASK_DEEP }), {
      provider: 'reflex',
      model: 'reflex-auto'
    });
  } finally {
    await host.dispose();
  }
});

test('unloading the plugin releases the virtual route and its listeners', async () => {
  const ctx = await createToolContext();
  const runtimes: ReflexRuntime[] = [];
  const fiber = await ctx.plugin(
    {
      name: 'dsh-reflex',
      inject: ['tools', 'llm'],
      Config,
      apply: (inner: Context, innerConfig: ReflexConfig) => {
        runtimes.push(applyReflex(inner, innerConfig));
      }
    },
    { backend: 'mock', routing: ROUTING }
  );

  try {
    assert.ok(providerIds(ctx).includes('reflex'));
    const agent = fakeAgent({ id: 'session-main', provider: 'reflex', model: 'reflex-auto' });
    assert.equal((await dispatchAgentRequest(ctx, agent, { task: TASK_DEEP })).provider, 'deepseek');

    await fiber.dispose();

    assert.equal(providerIds(ctx).includes('reflex'), false, 'the route is released with the activation');
    assert.equal(runtimes[0]?.disposed, true);
    const after = await dispatchAgentRequest(ctx, agent, { task: TASK_DEEP });
    assert.deepEqual(after, { provider: 'reflex', model: 'reflex-auto' }, 'the interceptors are detached');

    const chunks = await stream(ctx, { provider: 'reflex', model: 'reflex-auto' });
    assert.equal((chunks.at(-1) as { reason: { kind: string } }).reason.kind, 'error', 'the route really is gone');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('a second activation reuses the process-wide route instead of colliding', async () => {
  const ctx = await createToolContext();
  const runtimes: ReflexRuntime[] = [];
  const load = (prefix: string) =>
    ctx.plugin(
      {
        name: 'dsh-reflex',
        inject: ['tools', 'llm'],
        Config,
        apply: (inner: Context, innerConfig: ReflexConfig) => {
          runtimes.push(applyReflex(inner, innerConfig));
        }
      },
      { backend: 'mock', toolPrefix: prefix, routing: ROUTING }
    );

  try {
    const first = await load('alpha_');
    const second = await load('beta_');

    assert.ok(ctx.tools.get('alpha_choice'));
    assert.ok(ctx.tools.get('beta_choice'));
    assert.equal(providerIds(ctx).filter((id) => id === 'reflex').length, 1, 'one process-wide route');

    const physical = registerPhysicalAdapter(ctx, 'deepseek', { models: ['chat', 'reasoner'] });
    const agent = fakeAgent({ id: 'session-main', provider: 'reflex', model: 'reflex-auto' });
    assert.deepEqual(await dispatchAgentRequest(ctx, agent, { task: TASK_DEEP }), {
      provider: 'deepseek',
      model: 'reasoner'
    });
    await stream(ctx, { provider: 'reflex', model: 'reflex-auto' });
    assert.equal(physical.calls.length, 1, 'the owner route is the one dispatching');

    // The second activation does not own the route, so releasing it must leave
    // both the route and the first activation's interception in place.
    await second.dispose();
    assert.ok(providerIds(ctx).includes('reflex'), 'the owning activation keeps the route');
    assert.deepEqual(await dispatchAgentRequest(ctx, agent, { task: TASK_DEEP }), {
      provider: 'deepseek',
      model: 'reasoner'
    });
    assert.equal(runtimes[1]?.disposed, true, 'the released activation is dropped whole');
    assert.equal(runtimes[0]?.disposed, false);

    await first.dispose();
    assert.equal(providerIds(ctx).includes('reflex'), false, 'releasing the owner withdraws the route');
    assert.equal(runtimes[0]?.disposed, true);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('a foreign adapter already owning the provider name is never hijacked', async () => {
  const ctx = await createToolContext();
  try {
    let foreign: FakePhysicalAdapter | undefined;
    const foreignFiber = await ctx.plugin({
      name: 'foreign-reflex-adapter',
      inject: ['llm'],
      apply: (inner: Context) => {
        foreign = registerPhysicalAdapter(inner, 'reflex', { models: ['their-model'] });
      }
    });

    const runtime = applyReflex(ctx, { backend: 'mock', routing: ROUTING });
    const agent = fakeAgent({ id: 'session-main', provider: 'reflex', model: 'reflex-auto' });
    const config = await dispatchAgentRequest(ctx, agent, { task: TASK_DEEP });
    assert.deepEqual(config, { provider: 'reflex', model: 'reflex-auto' }, 'no rewrite over a foreign route');

    await stream(ctx, { provider: 'reflex', model: 'reflex-auto' });
    assert.equal(foreign?.calls.length, 1, 'the foreign adapter still serves the route');
    assert.equal(runtime.modelRouter.hasPools, true, 'the router itself is still configured');

    await foreignFiber.dispose();
    assert.ok(ctx.llm, 'the runtime outlives the foreign adapter');
    assert.equal(providerIds(ctx).includes('reflex'), false, 'the foreign registration is released with its fiber');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('the adapter refuses an undeclared virtual model by name', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: ROUTING });
  try {
    await assert.rejects(
      () => host.ctx.llm.resolveModelInfo('reflex', 'reflex-nope'),
      (error: unknown) => /reflex-nope/.test(String((error as Error).message ?? error))
    );
  } finally {
    await host.dispose();
  }
});

test('the dispatch layer never invents a reasoningEffort the caller did not ask for', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: ROUTING });
  try {
    const dispatched: GenerateOptions[] = [];
    const adapter = new ReflexVirtualAdapter({
      provider: 'reflex',
      router: host.runtime.modelRouter,
      dispatch: (options) =>
        (async function* () {
          dispatched.push(options);
          yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk;
        })()
    });

    await collect(
      adapter.stream({
        provider: 'reflex',
        model: 'reflex-auto',
        messages: [userMessage(TASK_DEEP)]
      } as GenerateOptions)
    );

    assert.equal(dispatched.length, 1, 'the request must be dispatched exactly once');
    assert.deepEqual(
      [dispatched[0].provider, dispatched[0].model],
      ['deepseek', 'reasoner'],
      'the hand-built request is routed by System 1 like a loop request'
    );
    assert.equal(
      'reasoningEffort' in dispatched[0],
      false,
      'a caller that named no effort must not receive an effort key back'
    );
  } finally {
    await host.dispose();
  }
});

test('ReflexVirtualAdapter reports the pool it was built with', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: ROUTING });
  try {
    const adapter = new ReflexVirtualAdapter({
      provider: 'reflex',
      router: host.runtime.modelRouter,
      dispatch: () => (async function* () {})()
    });
    assert.equal(adapter.provider, 'reflex');
    assert.equal(adapter.describeFirstCandidate('reflex-auto'), 'deepseek:chat');
    assert.equal(adapter.describeFirstCandidate('nope'), '');
    assert.deepEqual(adapter.firstCandidate('reflex-fast'), { provider: 'local', model: 'small' });
  } finally {
    await host.dispose();
  }
});

test('a second turn keeps the physical model the session already warmed', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: ROUTING });
  try {
    const agent = fakeAgent({ id: 'session-sticky', provider: 'reflex', model: 'reflex-auto' });

    // Turn 1: the task names the reasoner's capability, so System 1 picks it.
    const first = await dispatchAgentRequest(host.ctx, agent, { task: TASK_DEEP, turn: 1 });
    assert.deepEqual([first.provider, first.model], ['deepseek', 'reasoner']);

    // Turn 2: an unrelated short turn ranks both candidates equally. Without
    // affinity this would fall back to configuration order and move the
    // session off the model holding its cached prefix.
    const second = await dispatchAgentRequest(host.ctx, agent, { task: 'thanks', turn: 2 });
    assert.deepEqual([second.provider, second.model], ['deepseek', 'reasoner'], 'the warm model is kept');

    const entries = host.runtime.ledger.getEntries().filter((entry) => entry.type === 'model-route');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].details?.currentModel, null, 'the first decision has no incumbent');
    assert.equal(entries[0].details?.switched, false);
    assert.equal(entries[1].details?.currentModel, 'deepseek:reasoner');
    assert.equal(entries[1].details?.switched, false);
    assert.equal(entries[1].details?.reason, 'sticky-affinity');
    assert.ok(Number(entries[1].details?.contextTokens) > 0, 'the decision is told how much context it defends');
  } finally {
    await host.dispose();
  }
});

test('a turn that clearly belongs elsewhere still moves the session', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: ROUTING });
  try {
    const agent = fakeAgent({ id: 'session-switch', provider: 'reflex', model: 'reflex-auto' });

    const first = await dispatchAgentRequest(host.ctx, agent, { task: TASK_DEEP, turn: 1 });
    assert.equal(first.model, 'reasoner');

    // The task matches the other candidate's description and nothing of the
    // incumbent's, so the challenger is clearly ahead of the margin.
    const second = await dispatchAgentRequest(host.ctx, agent, { task: TASK_CHAT, turn: 2 });
    assert.deepEqual([second.provider, second.model], ['deepseek', 'chat'], 'a clear winner still displaces the incumbent');

    const entries = host.runtime.ledger.getEntries().filter((entry) => entry.type === 'model-route');
    assert.equal(entries[1].details?.currentModel, 'deepseek:reasoner');
    assert.equal(entries[1].details?.switched, true);
    assert.equal(entries[1].details?.reason, 'matched');
  } finally {
    await host.dispose();
  }
});

test('each session defends its own model and its own context size', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: ROUTING });
  try {
    const deep = fakeAgent({ id: 'session-a', provider: 'reflex', model: 'reflex-auto' });
    const cheap = fakeAgent({ id: 'session-b', provider: 'reflex', model: 'reflex-auto' });

    // Session A accumulates visibly more input than B, so the size each
    // decision reports can be told apart.
    const longTask = `${TASK_DEEP} ${'context '.repeat(30)}`;
    await dispatchAgentRequest(host.ctx, deep, { task: longTask, turn: 1 });
    await dispatchAgentRequest(host.ctx, cheap, { task: TASK_CHEAP, turn: 1 });

    // Both sessions now ask for the same neutral task: each must hold its own.
    const heldA = await dispatchAgentRequest(host.ctx, deep, { task: 'thanks', turn: 2 });
    const heldB = await dispatchAgentRequest(host.ctx, cheap, { task: 'thanks', turn: 2 });
    assert.equal(heldA.model, 'reasoner');
    assert.equal(heldB.model, 'chat');

    const entries = host.runtime.ledger.getEntries().filter((entry) => entry.type === 'model-route');
    const agentOf = (index: number): unknown => entries[index].details?.agentId;
    assert.deepEqual(
      entries.map((entry) => entry.details?.currentModel),
      [null, null, 'deepseek:reasoner', 'deepseek:chat']
    );
    assert.deepEqual([agentOf(2), agentOf(3)], ['session-a', 'session-b'], 'affinity is per agent, not per process');

    const long = Number(entries[2].details?.contextChars);
    const short = Number(entries[3].details?.contextChars);
    assert.ok(long > short, `a session with more input reports more context (${String(long)} vs ${String(short)})`);
    assert.equal(entries[2].details?.contextTokens, Math.ceil(long / 4), 'tokens are derived from the observed characters');
  } finally {
    await host.dispose();
  }
});

test('a session that never routed carries no affinity into its next pool', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: ROUTING });
  try {
    const agent = fakeAgent({ id: 'session-fresh', provider: 'reflex', model: 'reflex-auto' });

    // A virtual model that does not own the routed model: the pool for
    // reflex-fast cannot serve the incumbent, so nothing is defended.
    const fast = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_CHEAP,
      turn: 1,
      config: { provider: 'reflex', model: 'reflex-fast' }
    });
    assert.deepEqual([fast.provider, fast.model], ['local', 'small']);

    const auto = await dispatchAgentRequest(host.ctx, agent, { task: 'thanks', turn: 2 });
    assert.deepEqual([auto.provider, auto.model], ['deepseek', 'chat'], 'the new pool decides on its own');

    const entries = host.runtime.ledger.getEntries().filter((entry) => entry.type === 'model-route');
    assert.equal(entries[1].details?.currentModel, 'local:small', 'the session model is still reported');
    assert.equal(entries[1].details?.switched, true);
    assert.equal(entries[1].details?.reason, 'matched');
  } finally {
    await host.dispose();
  }
});
