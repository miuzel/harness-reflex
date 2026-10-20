import assert from 'node:assert/strict';
import test from 'node:test';

import type { Context, Fiber } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { applyReflex, Config } from './index.js';
import { createReflexRuntime, type ReflexLedgerResult, type ReflexRuntime } from './bridge.js';
import { resolveConfig, type ReflexConfig } from './config.js';
import { createReflexHost, createToolContext, callTool, resultValue, type ReflexTestHost } from './testing.js';
import { reflexToolNames } from './tools.js';

const TOOL_NAMES = reflexToolNames(resolveConfig({ backend: 'mock' }));

/** A harmless tool used to make the process-wide registry emit `tools/change`. */
function probeTool(name: string) {
  return defineTool({
    name,
    description: 'Test-only tool used to provoke a registry change event.',
    parameters: { text: { type: 'string', required: true } },
    output: {
      schema: { type: 'json' as const },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]
    },
    async execute(args: { text: string }) {
      return { echoed: args.text };
    }
  });
}

/**
 * Load the plugin the way the Host loader does, capturing the runtime `apply`
 * created so the test can observe disposal from the outside.
 * @param ctx - context carrying `systemPrompt` and `tools`.
 * @param config - deployment config.
 * @returns the plugin fiber and its runtime.
 */
async function loadReflexFiber(ctx: Context, config: ReflexConfig): Promise<{ fiber: Fiber; runtime: ReflexRuntime }> {
  let created: ReflexRuntime | undefined;
  const fiber = await ctx.plugin(
    {
      name: 'dsh-reflex',
      inject: ['tools', 'llm'],
      Config,
      apply: (inner: Context, innerConfig: ReflexConfig) => {
        created = applyReflex(inner, innerConfig);
      }
    },
    config
  );
  assert.ok(created, 'apply must run while the plugin loads');
  return { fiber, runtime: created };
}

/** Count how many times the runtime republished its tool surface. */
function countSurfacePublishes(runtime: ReflexRuntime): () => number {
  const original = runtime.noteToolSurface.bind(runtime);
  let calls = 0;
  runtime.noteToolSurface = (names: readonly string[]) => {
    calls += 1;
    original(names);
  };
  return () => calls;
}

test('disposing the context unregisters every tool and disposes the runtime', async () => {
  const host = await createReflexHost({ backend: 'mock' });
  const tools = host.ctx.tools;
  const choice = await host.callTool('reflex_choice', { question: 'Pick', options: ['a', 'b'] });
  assert.equal(choice.isError, false);

  await host.dispose();

  for (const name of TOOL_NAMES) assert.equal(tools.get(name), undefined, `${name} should be gone`);
  assert.equal(host.ctx.tools, undefined, 'the tool service itself was released with the context');
  assert.equal(host.runtime.disposed, true);
  assert.equal(host.runtime.ledger.getSummary().totalCalls, 0, 'the ledger is released with the runtime');
  await assert.rejects(() => host.runtime.choice({ question: 'Pick', options: ['a'] }), /disposed/);
});

test('unloading the plugin fiber releases tools, the observer, and the runtime', async () => {
  const ctx = await createToolContext();
  try {
    const { fiber, runtime } = await loadReflexFiber(ctx, { backend: 'mock' });
    const publishes = countSurfacePublishes(runtime);

    for (const name of TOOL_NAMES) assert.ok(ctx.tools.get(name), `${name} should be registered`);

    const probe = probeTool('lifecycle_probe');
    const unregisterProbe = ctx.tools.register(probe);
    assert.equal(publishes(), 1, 'the observer republishes the surface on a registry change');

    await fiber.dispose();

    for (const name of TOOL_NAMES) assert.equal(ctx.tools.get(name), undefined, `${name} should be released`);
    assert.ok(ctx.tools.get('lifecycle_probe'), 'foreign tools survive the plugin unload');
    assert.equal(runtime.disposed, true);

    unregisterProbe();
    assert.equal(publishes(), 1, 'the tools/change observer was detached on unload');
    await assert.rejects(() => runtime.choice({ question: 'Pick', options: ['a'] }), /disposed/);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('the runtime a Host receives is disposable exactly once and fully', () => {
  const runtime = createReflexRuntime(resolveConfig({ backend: 'mock' }));
  assert.equal(runtime.disposed, false);
  runtime.dispose();
  runtime.dispose();
  assert.equal(runtime.disposed, true);
  runtime.noteToolSurface(['reflex_choice']);
  assert.deepEqual(runtime.toolSurface, ['reflex_choice']);
});

test('a second activation after a full unload rebuilds a working surface', async () => {
  const ctx = await createToolContext();
  try {
    const first = await loadReflexFiber(ctx, { backend: 'mock' });
    await first.fiber.dispose();

    const second = await loadReflexFiber(ctx, { backend: 'mock' });
    const choice = await callTool(ctx, 'reflex_choice', { question: 'Pick', options: ['a', 'b'] });
    assert.equal(choice.isError, false);

    const ledger = resultValue<ReflexLedgerResult>(await callTool(ctx, 'reflex_status_ledger', {}));
    assert.equal(ledger.summary.totalCalls, 1, 'the second activation starts from a clean ledger');

    await second.fiber.dispose();
    assert.equal(ctx.tools.get('reflex_choice'), undefined);
    assert.equal(second.runtime.disposed, true);
    assert.equal(first.runtime.disposed, true);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('two activations on one context own disjoint surfaces and release in any order', async () => {
  const ctx = await createToolContext();
  try {
    const alpha = await loadReflexFiber(ctx, { backend: 'mock', toolPrefix: 'alpha_' });
    const beta = await loadReflexFiber(ctx, { backend: 'mock', toolPrefix: 'beta_' });

    assert.ok(ctx.tools.get('alpha_choice'));
    assert.ok(ctx.tools.get('beta_choice'));
    assert.deepEqual([...alpha.runtime.toolSurface], reflexToolNames(resolveConfig({ backend: 'mock', toolPrefix: 'alpha_' })));

    await alpha.fiber.dispose();
    assert.equal(ctx.tools.get('alpha_choice'), undefined);
    assert.ok(ctx.tools.get('beta_choice'), 'the surviving activation keeps its tools');
    assert.equal(alpha.runtime.disposed, true);
    assert.equal(beta.runtime.disposed, false);

    await beta.fiber.dispose();
    assert.equal(ctx.tools.get('beta_choice'), undefined);
    assert.equal(beta.runtime.disposed, true);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('the virtual route is released with its owner and rebuilt by the next activation', async () => {
  const ctx = await createToolContext();
  const routing: ReflexConfig['routing'] = { models: { 'reflex-auto': [{ provider: 'deepseek', model: 'chat' }] } };
  const hasRoute = () => ctx.llm.listProviders().some((provider) => provider.id === 'reflex');
  try {
    const first = await loadReflexFiber(ctx, { backend: 'mock', routing });
    assert.equal(hasRoute(), true, 'a configured activation registers the virtual route');

    await first.fiber.dispose();
    assert.equal(hasRoute(), false, 'the route is withdrawn together with its owner');
    assert.ok(ctx.llm, 'the LLM runtime itself survives its route being released');

    const second = await loadReflexFiber(ctx, { backend: 'mock', routing });
    assert.equal(hasRoute(), true, 'a fresh activation rebuilds the route from a clean slate');
    assert.ok(ctx.tools.get('reflex_choice'));

    await second.fiber.dispose();
    assert.equal(hasRoute(), false);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('an activation without pools never touches an existing virtual route', async () => {
  const ctx = await createToolContext();
  const hasRoute = () => ctx.llm.listProviders().some((provider) => provider.id === 'reflex');
  try {
    const owner = await loadReflexFiber(ctx, {
      backend: 'mock',
      routing: { models: { 'reflex-auto': [{ provider: 'deepseek', model: 'chat' }] } }
    });
    const bystander = await loadReflexFiber(ctx, { backend: 'mock', toolPrefix: 'beta_' });

    await bystander.fiber.dispose();
    assert.equal(hasRoute(), true, 'an activation that registered nothing withdraws nothing');

    await owner.fiber.dispose();
    assert.equal(hasRoute(), false);
  } finally {
    await ctx.fiber.dispose();
  }
});
