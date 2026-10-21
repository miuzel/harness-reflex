import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import LlmRuntime, { type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';

import type { ReflexRuntime } from './bridge.js';
import { Config, type ReflexConfig } from './config.js';
import { applyReflex, inject, name } from './index.js';
import { buildPanelSnapshot } from './panel-api.js';
import { panelFacts } from './panel-mount.js';
import { dispatchAgentRequest, fakeAgent, registerPhysicalAdapter, userMessage } from './testing.js';

/**
 * Live lifecycle: backend, ledger sink, prune threshold and the virtual-provider
 * lifecycle of a *running* activation.
 *
 * The loader commits a config-only save into the running fiber's volatile
 * references and dispatches `loader/volatile-update` (no remount). This module
 * is the loader entry it mounts, so every test drives the real Cordis loader
 * commit path rather than a hand-rolled imitation of it.
 */

export { Config, inject, name };

/** Applies the loader performed on this module (real remounts). */
let loaderApplies = 0;
/** Runtime of the last loader-applied activation. */
let loaderRuntime: ReflexRuntime | undefined;

/**
 * Plugin callback the loader invokes.
 * @param ctx - the entry's context.
 * @param config - the loader-resolved (volatile) config.
 */
export function apply(ctx: Context, config?: ReflexConfig): void {
  loaderApplies += 1;
  loaderRuntime = applyReflex(ctx, config);
}

/** Reset the loader probe before a mount. */
function resetLoaderProbe(): void {
  loaderApplies = 0;
  loaderRuntime = undefined;
}

/** Commit one freshly resolved config block into the live volatile reference. */
function commitVolatile(live: unknown, next: { get: () => unknown }): void {
  const reference = live as Record<symbol, unknown> & { get?: unknown };
  const write = Object.getOwnPropertySymbols(reference).find((key) => typeof reference[key] === 'function');
  assert.ok(write, 'a schema-declared volatile block must expose its commit function');
  (reference[write] as (value: unknown) => void)(next.get());
}

/** A mounted activation with the same commit seam the loader uses. */
interface LiveHost {
  ctx: Context;
  runtime: ReflexRuntime;
  /** Commit a config-only save and deliver the event to this activation only. */
  commit(next: ReflexConfig): void;
  dispose(): Promise<void>;
}

/**
 * Mount this module through the real loader.
 * @param authored - deployment config for the mount.
 * @returns the mounted host and its commit seam.
 */
async function bootLoader(authored: ReflexConfig): Promise<LiveHost> {
  resetLoaderProbe();
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(CommandRuntime);
  await ctx.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href });

  const id = await ctx.loader.create({ name: './live-lifecycle.test.js', config: authored });
  await ctx.loader.await();
  const entry = ctx.loader.resolve(id);
  assert.ok(loaderRuntime, 'the loader applied the plugin and exposed its runtime');
  assert.equal(entry.fiber?.state, 2, 'the mounted plugin is active');

  return {
    ctx,
    runtime: loaderRuntime,
    commit(next: ReflexConfig): void {
      const resolved = Config(next) as unknown as Record<string, { get(): unknown }>;
      const live = entry.fiber!.config as unknown as Record<string, unknown>;
      for (const key of Object.keys(resolved)) commitVolatile(live[key], resolved[key]!);
      const self = Object.create(entry.fiber!.ctx) as Record<symbol, unknown>;
      self[Context.filter] = (owner: { fiber?: unknown }) => owner.fiber === entry.fiber;
      entry.fiber!.ctx.emit(self, 'loader/volatile-update', [Object.keys(next)] as never);
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

/** Provider ids currently registered on the runtime. */
function providerIds(ctx: Context): string[] {
  return ctx.llm.listProviders().map((provider) => provider.id);
}

/** A valid Jev choice answer envelope. */
function jevChoiceBody(): unknown {
  return { answers: { choice: { type: 'choice', choice: 'yes', confidence: 1, probabilities: { yes: 1, no: 0 } } } };
}

/** Swap `fetch` for one test, recording the URL/model of every gateway call. */
function stubGateway(options: { fail?: () => boolean } = {}): {
  calls: Array<{ url: string; model: string; authorization: string }>;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; model: string; authorization: string }> = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (options.fail?.()) throw new TypeError('fetch failed');
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), model: body.model ?? '', authorization: headers.Authorization ?? '' });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => jevChoiceBody(),
      text: async () => ''
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

/** A workspace-local scratch directory for ledger files. */
function scratchDir(): string {
  const dir = join(process.cwd(), 'tmp');
  mkdirSync(dir, { recursive: true });
  return mkdtempSync(join(dir, 'reflex-live-'));
}

// ── a. backend and systemOne.connection ─────────────────────────────────────

test('a backend/systemOne save swaps the transport, resets health, and never rebuilds on an unchanged commit', async () => {
  const gateway = stubGateway({ fail: () => failing });
  let failing = false;
  process.env.REFLEX_LIVE_KEY_OLD = 'old-key';
  process.env.REFLEX_LIVE_KEY_NEW = 'new-key';
  const authored: ReflexConfig = {
    backend: 'jev',
    systemOne: { baseUrl: 'http://old.gateway', model: 'old-model', apiKeyEnv: 'REFLEX_LIVE_KEY_OLD' },
    routing: { enabled: false }
  };
  const host = await bootLoader(authored);
  try {
    const runtime = host.runtime;
    await runtime.choice({ question: 'ship?', options: ['yes', 'no'] });
    assert.equal(gateway.calls.length, 1, 'the first decision reaches the gateway');
    assert.match(gateway.calls[0]!.url, /old\.gateway/, 'the configured old endpoint serves the decision');
    assert.equal(gateway.calls[0]!.model, 'old-model');
    assert.equal(gateway.calls[0]!.authorization, 'Bearer old-key', 'apiKeyEnv names the old credential variable');
    assert.equal(runtime.systemOneHealth()?.available, true);

    // One failing decision degrades the old backend's health.
    failing = true;
    await assert.rejects(runtime.choice({ question: 'ship?', options: ['yes', 'no'] }));
    assert.equal(runtime.systemOneHealth()?.available, false);
    failing = false;

    // backend → mock: the next decision is in-process, no gateway call, health
    // is absent (in-process backends are healthy by construction).
    host.commit({ ...authored, backend: 'mock' });
    const callsBefore = gateway.calls.length;
    await runtime.choice({ question: 'ship?', options: ['yes', 'no'] });
    assert.equal(gateway.calls.length, callsBefore, 'the old gateway is not called after the swap');
    assert.equal(runtime.backendName, 'mock-heuristic-v1');
    assert.equal(runtime.systemOneHealth(), undefined);
    assert.equal(runtime.backendRebuilds, 1);

    // back to jev with a new endpoint/model: the next decision uses them, and
    // the fresh backend starts healthy instead of inheriting the old failures.
    const newConfig: ReflexConfig = {
      backend: 'jev',
      systemOne: {
        baseUrl: 'http://new.gateway',
        model: 'new-model',
        apiKeyEnv: 'REFLEX_LIVE_KEY_NEW',
        timeoutMs: 1234
      },
      routing: { enabled: false }
    };
    host.commit(newConfig);
    await runtime.choice({ question: 'ship?', options: ['yes', 'no'] });
    assert.match(gateway.calls.at(-1)!.url, /new\.gateway/);
    assert.equal(gateway.calls.at(-1)!.model, 'new-model');
    assert.equal(gateway.calls.at(-1)!.authorization, 'Bearer new-key', 'apiKeyEnv names the new credential variable');
    assert.equal(runtime.effectiveConfig.systemOne.timeoutMs, 1234);
    assert.deepEqual(runtime.systemOneHealth(), { available: true, consecutiveFailures: 0 }, 'health is reset on the new backend');
    assert.equal(runtime.backendRebuilds, 2);

    // Idempotence: three identical commits rebuild nothing and reset nothing.
    host.commit(newConfig);
    host.commit(newConfig);
    host.commit(newConfig);
    assert.equal(runtime.backendRebuilds, 2, 'a same-value save does not rebuild the backend');

    // timeoutMs alone shapes the transport: it rebuilds once and then stays put.
    host.commit({
      ...newConfig,
      systemOne: { ...newConfig.systemOne!, timeoutMs: 4321 }
    });
    assert.equal(runtime.backendRebuilds, 3);
    host.commit({ ...newConfig, systemOne: { ...newConfig.systemOne!, timeoutMs: 4321 } });
    assert.equal(runtime.backendRebuilds, 3);
    assert.equal(runtime.effectiveConfig.systemOne.timeoutMs, 4321);

    const panel = buildPanelSnapshot(panelFacts(runtime));
    assert.equal(panel.systemOne.backend, 'jev');
    assert.equal(panel.systemOne.baseUrl, 'http://new.gateway');
    assert.equal(panel.systemOne.model, 'new-model');
  } finally {
    gateway.restore();
    delete process.env.REFLEX_LIVE_KEY_OLD;
    delete process.env.REFLEX_LIVE_KEY_NEW;
    await host.dispose();
  }
});

// ── b. ledgerPath ───────────────────────────────────────────────────────────

test('a ledgerPath save switches the JSONL sink and migrates the entries recorded before it', async () => {
  const dir = scratchDir();
  const first = join(dir, 'first.jsonl');
  const second = join(dir, 'second.jsonl');
  const authored: ReflexConfig = { backend: 'mock', ledgerPath: first, routing: { enabled: false } };
  const host = await bootLoader(authored);
  try {
    const runtime = host.runtime;
    await runtime.choice({ question: 'one?', options: ['yes', 'no'] });
    const before = runtime.ledger.getEntries();
    assert.equal(before.length, 1);
    assert.equal(readFileSync(first, 'utf8').trim().length > 0, true, 'the first sink holds the entry');

    host.commit({ backend: 'mock', ledgerPath: second, routing: { enabled: false } });
    assert.equal(runtime.ledgerSwitches, 1);
    assert.equal(runtime.ledger.getLogPath(), second);
    assert.equal(runtime.effectiveConfig.ledgerPath, second);

    // The migration strategy is merge-and-rewrite: the new sink starts with the
    // entry recorded before the switch.
    const migrated = readFileSync(second, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: string });
    assert.deepEqual(migrated.map((entry) => entry.id), before.map((entry) => entry.id));

    // New entries land in the new file; the old one stops receiving writes.
    const firstContent = readFileSync(first, 'utf8');
    await runtime.choice({ question: 'two?', options: ['yes', 'no'] });
    const after = readFileSync(second, 'utf8').trim().split('\n');
    assert.equal(after.length, 2, 'the post-switch entry went to the new sink');
    assert.equal(readFileSync(first, 'utf8'), firstContent, 'the released sink receives no further writes');

    const panel = buildPanelSnapshot(panelFacts(runtime));
    assert.equal(panel.plugin.ledgerPath, second, 'the panel reports the sink currently in force');
  } finally {
    await host.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── c. pruneThreshold alone ────────────────────────────────────────────────

test('raising pruneThreshold on its own saves, lifts the judging floor, and skips the next below-threshold payload', async () => {
  const authored: ReflexConfig = { backend: 'mock', pruneThreshold: 500, routing: { enabled: false } };
  const host = await bootLoader(authored);
  try {
    const runtime = host.runtime;
    // No throw from the commit: the cross-field constraint is resolved by
    // lifting the judge floor, not by refusing the save.
    host.commit({ backend: 'mock', pruneThreshold: 20000, routing: { enabled: false } });
    assert.equal(runtime.effectiveConfig.pruneThreshold, 20000);
    assert.equal(runtime.effectiveConfig.interventions.pruneJudgeMinChars, 20000, 'the judge floor is lifted to the threshold');

    const payload = 'x'.repeat(1000);
    const result = await runtime.prune({ rawOutput: payload });
    assert.equal(result.processedOutput, payload, 'a below-threshold payload is byte-identical');
    assert.equal(result.tokensSaved, 0);

    const panel = buildPanelSnapshot(panelFacts(runtime));
    assert.equal(panel.plugin.pruneThreshold, 20000);
  } finally {
    await host.dispose();
  }
});

// ── d. routing.enabled ─────────────────────────────────────────────────────

test('routing.enabled false withdraws the virtual provider, true restores it, and a disabled route never rewrites', async () => {
  const authored: ReflexConfig = {
    backend: 'mock',
    routing: { enabled: true, models: { 'reflex-1': [{ provider: 'physical', model: 'm' }] } }
  };
  const host = await bootLoader(authored);
  try {
    const runtime = host.runtime;
    registerPhysicalAdapter(host.ctx, 'physical', { models: ['m'] });
    assert.ok(providerIds(host.ctx).includes('reflex'), 'the virtual provider starts registered');
    assert.equal(runtime.routingRegistrationEvents, 1);

    const agent = fakeAgent({ id: 'enabled-session', provider: 'reflex', model: 'reflex-1' });
    const request = { provider: 'reflex', model: 'reflex-1' } as const;
    assert.deepEqual(await dispatchAgentRequest(host.ctx, agent, { task: 'route', turn: 1, config: request }), {
      provider: 'physical',
      model: 'm'
    });

    host.commit({
      backend: 'mock',
      routing: { enabled: false, models: { 'reflex-1': [{ provider: 'physical', model: 'm' }] } }
    });
    assert.equal(providerIds(host.ctx).includes('reflex'), false, 'the provider is withdrawn');
    const untouched = await dispatchAgentRequest(host.ctx, agent, { task: 'route', turn: 2, config: request });
    assert.deepEqual(untouched, request, 'a disabled route does not rewrite the request');

    host.commit(authored);
    assert.equal(providerIds(host.ctx).includes('reflex'), true, 'the provider is registered again');
    assert.deepEqual(await dispatchAgentRequest(host.ctx, agent, { task: 'route', turn: 3, config: request }), {
      provider: 'physical',
      model: 'm'
    });
    assert.equal(runtime.routingRegistrationEvents, 2, 'disable/enable re-registered exactly once');
    // Idempotence: a same-value save keeps the provider and does not re-register.
    host.commit(authored);
    host.commit(authored);
    assert.equal(runtime.routingRegistrationEvents, 2, 'an unchanged save does not re-register the provider');
    assert.deepEqual(providerIds(host.ctx).filter((id) => id === 'reflex'), ['reflex']);
    const panel = buildPanelSnapshot(panelFacts(runtime));
    assert.equal(panel.routing.enabled, true);
    assert.equal(panel.routing.active, true);
  } finally {
    await host.dispose();
  }
});

// ── e. virtualProvider rename ──────────────────────────────────────────────

test('renaming the virtual provider unregisters the old name and leaves exactly one live adapter', async () => {
  const authored: ReflexConfig = {
    backend: 'mock',
    routing: { enabled: true, virtualProvider: 'reflex', models: { 'reflex-1': [{ provider: 'physical', model: 'm' }] } }
  };
  const host = await bootLoader(authored);
  const physical = registerPhysicalAdapter(host.ctx, 'physical', { models: ['m'] });
  try {
    const runtime = host.runtime;
    const llm = host.ctx.llm;
    assert.deepEqual(providerIds(host.ctx).filter((id) => id === 'reflex' || id === 'rx'), ['reflex']);

    host.commit({
      backend: 'mock',
      routing: { enabled: true, virtualProvider: 'rx', models: { 'reflex-1': [{ provider: 'physical', model: 'm' }] } }
    });

    const virtual = providerIds(host.ctx).filter((id) => id === 'reflex' || id === 'rx');
    assert.deepEqual(virtual, ['rx'], 'the old name is gone and the new one is live');
    assert.equal(runtime.modelRouter.virtualProvider, 'rx');

    const agent = fakeAgent({ id: 'rename-session', provider: 'rx', model: 'reflex-1' });
    assert.deepEqual(
      await dispatchAgentRequest(host.ctx, agent, { task: 'route on the new name', turn: 1, config: { provider: 'rx', model: 'reflex-1' } }),
      { provider: 'physical', model: 'm' }
    );

    // The old route is unknown now: no orphan adapter answers it. The stream
    // may surface the unknown provider as an error chunk or a rejection; either
    // way it must not reach a physical adapter.
    const callsBefore = physical.calls.length;
    await collect(
      host.ctx.llm.stream({
        provider: 'reflex',
        model: 'reflex-1',
        messages: [userMessage('old route')]
      } as GenerateOptions)
    ).catch(() => []);
    assert.equal(physical.calls.length, callsBefore, 'the withdrawn name reaches no adapter');

    const panel = buildPanelSnapshot(panelFacts(runtime));
    assert.equal(panel.routing.virtualProvider, 'rx');
    assert.equal(panel.routing.enabled, true);

    // Disposing the activation withdraws the route it still owns.
    await host.dispose();
    assert.equal(llm.listProviders().some((provider) => provider.id === 'rx'), false, 'dispose leaves no orphan adapter');
  } finally {
    await host.dispose();
  }
});

// ── e2. rename with two activations ────────────────────────────────────────

test('a rename is consistent across activations sharing the route and the owner count gates withdrawal', async () => {
  const authored: ReflexConfig = {
    backend: 'mock',
    toolPrefix: 'one_',
    routing: { enabled: true, virtualProvider: 'reflex', models: { 'reflex-1': [{ provider: 'physical', model: 'm' }] } }
  };
  const host = await bootLoader(authored);
  registerPhysicalAdapter(host.ctx, 'physical', { models: ['m'] });
  const second = await host.ctx.plugin(
    {
      name: 'dsh-reflex',
      inject: ['tools', 'llm'],
      Config,
      apply: (inner: Context, innerConfig: ReflexConfig) => {
        applyReflex(inner, innerConfig);
      }
    },
    { ...authored, toolPrefix: 'two_' }
  );
  try {
    // Two activations, one process-wide route.
    assert.equal(providerIds(host.ctx).filter((id) => id === 'reflex').length, 1);
    host.commit({
      backend: 'mock',
      toolPrefix: 'one_',
      routing: { enabled: true, virtualProvider: 'rx', models: { 'reflex-1': [{ provider: 'physical', model: 'm' }] } }
    });
    assert.deepEqual(providerIds(host.ctx).filter((id) => id === 'reflex' || id === 'rx'), ['rx']);
    const agent = fakeAgent({ id: 'shared-rename', provider: 'rx', model: 'reflex-1' });
    assert.deepEqual(
      await dispatchAgentRequest(host.ctx, agent, { task: 'route after rename', turn: 1, config: { provider: 'rx', model: 'reflex-1' } }),
      { provider: 'physical', model: 'm' }
    );

    // Releasing the second owner keeps the one shared route registered.
    await second.dispose();
    assert.equal(providerIds(host.ctx).includes('rx'), true, 'the surviving owner keeps the route');
  } finally {
    await host.dispose();
  }
});

// ── f. maxTaskChars ────────────────────────────────────────────────────────

test('a maxTaskChars save changes the task text captured on the very next step', async () => {
  const authored: ReflexConfig = {
    backend: 'mock',
    routing: { enabled: true, maxTaskChars: 400, models: { 'reflex-1': [{ provider: 'physical', model: 'm' }] } }
  };
  const host = await bootLoader(authored);
  try {
    const runtime = host.runtime;
    registerPhysicalAdapter(host.ctx, 'physical', { models: ['m'] });
    const agent = fakeAgent({ id: 'budget-session', provider: 'reflex', model: 'reflex-1' });

    // Watch the exact goal handed to System 1: the router truncates its ledger
    // copy to 160 chars, so the decision input is the honest observable.
    const goals: string[] = [];
    const service = runtime.routeService as unknown as {
      selectBest: (...args: unknown[]) => unknown;
    };
    const original = service.selectBest.bind(service);
    service.selectBest = (goal: unknown, ...rest: unknown[]) => {
      goals.push(String(goal));
      return original(goal, ...rest);
    };

    const firstTask = 'A'.repeat(800);
    await dispatchAgentRequest(host.ctx, agent, {
      task: firstTask,
      turn: 1,
      config: { provider: 'reflex', model: 'reflex-1' }
    });
    assert.equal(goals[0]?.length, 400, 'the 400-char budget truncates the captured task');

    host.commit({
      backend: 'mock',
      routing: { enabled: true, maxTaskChars: 4000, models: { 'reflex-1': [{ provider: 'physical', model: 'm' }] } }
    });
    assert.equal(runtime.effectiveConfig.routing.maxTaskChars, 4000);

    const secondTask = 'B'.repeat(800);
    await dispatchAgentRequest(host.ctx, agent, {
      task: secondTask,
      turn: 2,
      config: { provider: 'reflex', model: 'reflex-1' }
    });
    assert.equal(goals[1], secondTask, 'the next step captures up to the new 4000-char budget');

    const panel = buildPanelSnapshot(panelFacts(runtime));
    assert.equal(panel.routing.maxTaskChars, 4000);
  } finally {
    await host.dispose();
  }
});
