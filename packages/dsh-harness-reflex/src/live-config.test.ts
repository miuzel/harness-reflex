import assert from 'node:assert/strict';
import test from 'node:test';

import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';

import type { ReflexRuntime } from './bridge.js';
import { Config, type ReflexConfig } from './config.js';
import { applyReflex, inject, name } from './index.js';
import { buildPanelSnapshot } from './panel-api.js';
import { panelFacts } from './panel-mount.js';
import {
  createToolContext,
  dispatchAgentRequest,
  fakeAgent,
  registerPhysicalAdapter,
  userMessage,
  type FakePhysicalAdapter
} from './testing.js';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';

/**
 * Live configuration: what happens when the settings panel saves a routing edit
 * into a *running* activation.
 *
 * The root cause of the "edited the member model, runtime keeps routing the old
 * one" bug is path B — not the reload ordering. Every routing field of the
 * plugin schema is declared `volatile`, so a config-only save through
 * `dsh-settings write → configEditor.edit → reconcileProfilePatches` never
 * remounts the plugin: the Cordis loader commits the new values into the
 * running fiber's volatile references and dispatches `loader/volatile-update`
 * to the owning fiber. The activation's resolved config — and therefore the
 * router and the panel — used to keep the values frozen at activation time.
 *
 * This file is both the coverage for the fix and, deliberately, the plugin entry
 * module the loader test mounts: a `node:test` module may export the plugin
 * fields, so the loader can import *this* module (already evaluated, same URL)
 * and the counters below observe real applies. That keeps the test on the real
 * Cordis loader path instead of a hand-rolled imitation of it.
 */

export { Config, inject, name };

/** Applies the loader performed on this module (real remounts). */
let loaderApplies = 0;
/** `loader/volatile-update` events the mounted activation received. */
let loaderVolatileEvents = 0;
/** Runtime of the last loader-applied activation. */
let loaderRuntime: ReflexRuntime | undefined;

/**
 * The plugin callback the loader invokes. Counts real remounts and keeps a
 * handle on the activation's runtime so the test can dispatch through it.
 * @param ctx - the entry's context.
 * @param config - the loader-resolved config.
 */
export function apply(ctx: Context, config?: ReflexConfig): void {
  loaderApplies += 1;
  ctx.on('loader/volatile-update', () => {
    loaderVolatileEvents += 1;
  });
  loaderRuntime = applyReflex(ctx, config);
}

/** Reset the loader probe counters before a mount. */
function resetLoaderProbe(): void {
  loaderApplies = 0;
  loaderVolatileEvents = 0;
  loaderRuntime = undefined;
}

/** Read the loader probe. */
function loaderProbe(): { applies: number; volatileEvents: number; runtime?: ReflexRuntime } {
  return { applies: loaderApplies, volatileEvents: loaderVolatileEvents, ...(loaderRuntime ? { runtime: loaderRuntime } : {}) };
}

/**
 * Commit one freshly resolved config block into the live volatile reference,
 * exactly as the loader's `updateVolatile` does: `target[write](source.get())`.
 * The write symbol is the only callable own symbol a schemastery volatile
 * reference carries, and calling it is what makes the new snapshot visible to
 * the running activation.
 * @param live - the reference currently held by the running fiber.
 * @param next - a reference resolved from the next authored config.
 */
function commitVolatile(live: unknown, next: { get: () => unknown }): void {
  const reference = live as Record<symbol, unknown> & { get?: unknown };
  const write = Object.getOwnPropertySymbols(reference).find((key) => typeof reference[key] === 'function');
  assert.ok(write, 'a schema-declared volatile block must expose its commit function');
  (reference[write] as (value: unknown) => void)(next.get());
}

/**
 * Build a runtime on a loader-shaped config (schemastery-resolved, so every
 * volatile block is a reference) and offer the same commit + event the loader
 * performs on a config-only save.
 * @param authored - the authored deployment config.
 */
async function liveHost(authored: ReflexConfig): Promise<{
  ctx: Context;
  runtime: ReflexRuntime;
  commit(next: ReflexConfig): void;
  dispose(): Promise<void>;
}> {
  const ctx = await createToolContext();
  const source = Config(authored) as unknown as Record<string, unknown> & { routing: { get(): unknown } };
  const runtime = applyReflex(ctx, source as unknown as ReflexConfig);
  return {
    ctx,
    runtime,
    commit(next: ReflexConfig): void {
      const resolved = Config(next) as unknown as Record<string, { get(): unknown }>;
      for (const key of Object.keys(resolved)) commitVolatile(source[key], resolved[key]!);
      // What the loader dispatches after committing: the owning fiber only.
      ctx.emit('loader/volatile-update', [Object.keys(next)]);
    },
    dispose: () => ctx.fiber.dispose()
  };
}

/** Drain one chunk stream. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** Dispatch one request through the virtual provider's adapter. */
function virtualStream(ctx: Context, model: string): Promise<StreamChunk[]> {
  return collect(
    ctx.llm.stream({
      provider: 'reflex',
      model,
      messages: [userMessage('route this request')]
    } as GenerateOptions)
  );
}

/** Provider ids currently registered on the runtime. */
function providerIds(ctx: Context): string[] {
  return ctx.llm.listProviders().map((provider) => provider.id);
}

const OLD_POOL: ReflexConfig = {
  backend: 'mock',
  routing: { models: { 'reflex-1': [{ provider: 'physical-old', model: 'old-model', description: 'the old member' }] } }
};

const NEW_POOL: ReflexConfig = {
  backend: 'mock',
  routing: { models: { 'reflex-1': [{ provider: 'physical-new', model: 'new-model', description: 'the new member' }] } }
};

test('the real loader commits a config-only save without remounting and the next request uses the new member', async () => {
  resetLoaderProbe();
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(CommandRuntime);
    await ctx.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href });

    const oldAdapter = registerPhysicalAdapter(ctx, 'physical-old', { models: ['old-model'] });
    const newAdapter = registerPhysicalAdapter(ctx, 'physical-new', { models: ['new-model'] });

    const id = await ctx.loader.create({
      name: './live-config.test.js',
      config: OLD_POOL
    });
    await ctx.loader.await();

    assert.equal(loaderProbe().applies, 1, 'the entry mounted the plugin once');
    const entry = ctx.loader.resolve(id);
    assert.equal(entry.fiber?.state, 2, 'the mounted plugin is active');

    // Watch the fiber: a remount would show up as status transitions.
    const transitions: string[] = [];
    ctx.on('internal/status', (fiber, oldState) => {
      if (fiber === entry.fiber) transitions.push(String(oldState));
    });

    const runtime = loaderProbe().runtime!;
    const agent = fakeAgent({ id: 'live-session', provider: 'reflex', model: 'reflex-1' });
    const request = { provider: 'reflex', model: 'reflex-1' };
    const before = await dispatchAgentRequest(ctx, agent, { task: 'route this request', turn: 1, config: request });
    assert.deepEqual([before.provider, before.model], ['physical-old', 'old-model']);
    await virtualStream(ctx, 'reflex-1');
    assert.equal(oldAdapter.calls.length, 1, 'the old member serves the request');
    assert.equal(newAdapter.calls.length, 0);

    // The settings save: a doc is written, the loader resolves it, then commits
    // the changed volatile references into the running entry.
    const resolvedNext = Config(NEW_POOL) as unknown as Record<string, { get(): unknown }>;
    const live = entry.fiber!.config as unknown as Record<string, unknown>;
    for (const key of Object.keys(resolvedNext)) commitVolatile(live[key], resolvedNext[key]!);
    const self = Object.create(entry.fiber!.ctx) as Record<symbol, unknown>;
    self[Context.filter] = (owner: { fiber?: unknown }) => owner.fiber === entry.fiber;
    entry.fiber!.ctx.emit(self, 'loader/volatile-update', [Object.keys(NEW_POOL)] as never);

    assert.equal(loaderProbe().applies, 1, 'path B reproduced: committing a volatile config does NOT re-apply the plugin');
    assert.deepEqual(transitions, [], 'the plugin fiber never restarts');
    assert.equal(loaderProbe().volatileEvents, 1, 'the activation receives the commit event');

    const after = await dispatchAgentRequest(ctx, agent, { task: 'route this request', turn: 2, config: request });
    assert.deepEqual([after.provider, after.model], ['physical-new', 'new-model'], 'the next request routes on the new member');

    await virtualStream(ctx, 'reflex-1');
    assert.equal(newAdapter.calls.length, 1, 'the dispatch-level route is the new member too');
    assert.equal(oldAdapter.calls.length, 1, 'the old member is no longer used');
    assert.equal(runtime.modelRouter.poolFor('reflex-1')?.[0]?.model, 'new-model', 'the activation router itself is live');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('a committed fallback change is the fallback the very next request degrades to', async () => {
  const authored: ReflexConfig = {
    backend: 'mock',
    routing: {
      models: { 'reflex-1': [{ provider: 'physical', model: 'model' }], 'reflex-dead': [] },
      fallback: 'backup-old:old-model'
    }
  };
  const host = await liveHost(authored);
  try {
    registerPhysicalAdapter(host.ctx, 'physical', { models: ['model'] });
    const agent = fakeAgent({ id: 'fallback-session', provider: 'reflex', model: 'reflex-dead' });

    const request = { provider: 'reflex', model: 'reflex-dead' };
    const before = await dispatchAgentRequest(host.ctx, agent, { task: 'fall back', turn: 1, config: request });
    assert.deepEqual([before.provider, before.model], ['backup-old', 'old-model']);

    host.commit({
      backend: 'mock',
      routing: {
        models: { 'reflex-1': [{ provider: 'physical', model: 'model' }], 'reflex-dead': [] },
        fallback: 'backup-new:new-model'
      }
    });

    const after = await dispatchAgentRequest(host.ctx, agent, { task: 'fall back', turn: 2, config: request });
    assert.deepEqual([after.provider, after.model], ['backup-new', 'new-model'], 'the old fallback is not used again');
    const degraded = host.runtime.ledger
      .getEntries()
      .filter((entry) => entry.type === 'model-route' && entry.details?.degraded === true);
    assert.equal(degraded.at(-1)?.details?.chosen, 'backup-new:new-model');
  } finally {
    await host.dispose();
  }
});

test('the panel snapshot reports the pools and fallback currently in force, not the activation-time values', async () => {
  const authored: ReflexConfig = {
    backend: 'mock',
    routing: {
      models: {
        'reflex-1': [{ provider: 'physical-old', model: 'old-model', description: 'old', tags: ['legacy'] }],
        'reflex-2': [{ provider: 'physical-old', model: 'second' }]
      },
      fallback: 'backup-old:old-model'
    }
  };
  const host = await liveHost(authored);
  try {
    const before = buildPanelSnapshot(panelFacts(host.runtime, {}));
    assert.deepEqual(before.routing.pools.map((pool) => pool.model), ['reflex-1', 'reflex-2']);
    assert.equal(before.routing.pools[0]?.entries[0]?.model, 'old-model');
    assert.equal(before.routing.fallback, 'backup-old:old-model');

    host.commit({
      backend: 'mock',
      routing: {
        models: {
          'reflex-1': [{ provider: 'physical-new', model: 'new-model', description: 'new', tags: ['fresh'] }],
          'reflex-3': [{ provider: 'physical-new', model: 'third' }]
        },
        fallback: 'backup-new:new-model'
      }
    });

    // No request between the save and the read: the panel alone must see the
    // committed values.
    const after = buildPanelSnapshot(panelFacts(host.runtime, {}));
    assert.deepEqual(after.routing.pools.map((pool) => pool.model), ['reflex-1', 'reflex-3']);
    assert.deepEqual(after.routing.pools[0]?.entries, [
      { provider: 'physical-new', model: 'new-model', description: 'new', tags: ['fresh'] }
    ]);
    assert.equal(after.routing.pools[1]?.entries[0]?.model, 'third');
    assert.equal(after.routing.fallback, 'backup-new:new-model');
    assert.equal(after.routing.candidates, 2, 'the candidate count follows the live pools');

    // Removing the fallback is a change too: the panel must stop reporting it
    // instead of falling back to the activation-time value.
    host.commit({ backend: 'mock', routing: { models: { 'reflex-1': [{ provider: 'physical-new', model: 'new-model' }] } } });
    const cleared = buildPanelSnapshot(panelFacts(host.runtime, {}));
    assert.equal(cleared.routing.fallback, undefined, 'a removed fallback is not resurrected from the startup config');
  } finally {
    await host.dispose();
  }
});

test('a reload that creates the new activation before releasing the old one still drives the new pools, and repeated reloads leave nothing behind', async () => {
  const ctx = await createToolContext();
  const runtimes: ReflexRuntime[] = [];
  let prefix = 0;
  const load = (config: ReflexConfig) =>
    ctx.plugin(
      {
        name: 'dsh-reflex',
        inject: ['tools', 'llm'],
        Config,
        apply: (inner: Context, innerConfig: ReflexConfig) => {
          runtimes.push(applyReflex(inner, innerConfig));
        }
      },
      { ...config, toolPrefix: `load${prefix++}_` }
    );

  try {
    const adapterA = registerPhysicalAdapter(ctx, 'physical-a', { models: ['a-model'] });
    const adapterB = registerPhysicalAdapter(ctx, 'physical-b', { models: ['b-model'] });

    const configA: ReflexConfig = {
      backend: 'mock',
      routing: { models: { 'reflex-1': [{ provider: 'physical-a', model: 'a-model' }] } }
    };
    const configB: ReflexConfig = {
      backend: 'mock',
      routing: { models: { 'reflex-1': [{ provider: 'physical-b', model: 'b-model' }] } }
    };

    const first = await load(configA);
    const second = await load(configB);

    // Ordering under test: the new activation exists while the old one is still
    // mounted. Pre-fix the new activation reused the old adapter's router, so it
    // routed on the old pools until the old activation was disposed — and then
    // lost the provider route entirely.
    assert.equal(providerIds(ctx).filter((id) => id === 'reflex').length, 1, 'one process-wide route');
    const agent = fakeAgent({ id: 'reload-session', provider: 'reflex', model: 'reflex-1' });
    const request = { provider: 'reflex', model: 'reflex-1' };
    assert.deepEqual(await dispatchAgentRequest(ctx, agent, { task: 'route', turn: 1, config: request }), {
      provider: 'physical-b',
      model: 'b-model'
    }, 'the newest activation drives its own pools');
    await virtualStream(ctx, 'reflex-1');
    assert.equal(adapterB.calls.length, 1, 'dispatch-level routing uses the new pools too');
    assert.equal(adapterA.calls.length, 0);

    await first.dispose();
    assert.equal(providerIds(ctx).filter((id) => id === 'reflex').length, 1, 'releasing the old owner keeps the shared route');
    assert.deepEqual(await dispatchAgentRequest(ctx, agent, { task: 'route', turn: 2, config: request }), {
      provider: 'physical-b',
      model: 'b-model'
    });
    assert.equal(runtimes[0]?.disposed, true, 'the released activation is dropped whole');
    assert.equal(runtimes[1]?.disposed, false);

    await second.dispose();
    assert.equal(providerIds(ctx).includes('reflex'), false, 'releasing the last owner withdraws the route');

    // Three sequential reloads: exactly one provider route every time, a fresh
    // adapter each time (a leaked OWNED_ROUTES entry would make the registration
    // silently reuse a dead adapter and drop the route), and nothing left after.
    for (let reload = 0; reload < 3; reload++) {
      const fiber = await load(configB);
      assert.equal(providerIds(ctx).filter((id) => id === 'reflex').length, 1, `reload ${reload}: one provider route`);
      const dispatched = await dispatchAgentRequest(ctx, agent, { task: 'route', turn: 3 + reload, config: { provider: 'reflex', model: 'reflex-1' } });
      assert.deepEqual([dispatched.provider, dispatched.model], ['physical-b', 'b-model'], `reload ${reload}: routes normally`);
      await fiber.dispose();
      assert.equal(providerIds(ctx).includes('reflex'), false, `reload ${reload}: route released`);
    }
    assert.equal(runtimes.every((runtime) => runtime.disposed), true, 'every activation was released');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('a programmatic activation without volatile references is unaffected by the refresh hook', async () => {
  const ctx = await createToolContext();
  try {
    const runtime = applyReflex(ctx, OLD_POOL);
    registerPhysicalAdapter(ctx, 'physical-old', { models: ['old-model'] });
    const before = runtime.modelRouter.poolFor('reflex-1');
    assert.equal(runtime.refreshIfChanged(), false, 'nothing to watch without volatile references');
    assert.equal(runtime.modelRouter.poolFor('reflex-1'), before);
  } finally {
    await ctx.fiber.dispose();
  }
});
