import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';

import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';

import type { ReflexRuntime } from './bridge.js';
import { Config, resolveConfig, type ReflexConfig } from './config.js';
import { applyReflex, inject, name } from './index.js';
import { buildPanelSnapshot } from './panel-api.js';
import { panelFacts } from './panel-mount.js';
import { callTool } from './testing.js';
import { REFLEX_TOOL_SUFFIXES, reflexToolNames } from './tools.js';

/**
 * Live tool surface: `tools.enabled` and `toolPrefix` edited through a *real*
 * loader config-only commit.
 *
 * The loader marks both blocks `volatile`, so a settings save commits the new
 * values into the running fiber and dispatches `loader/volatile-update` without
 * remounting the plugin. These tests mount through the real loader (this module
 * is the entry the loader imports), commit the way the loader does, and assert
 * at production seams: the process-wide registry, the runtime surface the panel
 * reads, and the registration counters that make idempotence provable.
 */

export { Config, inject, name };

/** Real remounts of this module (the loader calls {@link apply}). */
let loaderApplies = 0;
/** Runtime of the last loader-applied activation. */
let loaderRuntime: ReflexRuntime | undefined;

/**
 * The plugin callback the loader invokes; counts real applies so every test can
 * prove a config-only save did *not* restart the plugin.
 * @param ctx - the entry's context.
 * @param config - the loader-resolved config (volatile references included).
 */
export function apply(ctx: Context, config?: ReflexConfig): void {
  loaderApplies += 1;
  loaderRuntime = applyReflex(ctx, config);
}

/**
 * Commit one freshly resolved config block into the live volatile reference,
 * exactly as the loader's `updateVolatile` does: `target[write](source.get())`.
 * @param live - the reference currently held by the running fiber.
 * @param next - a reference resolved from the next authored config.
 */
function commitVolatile(live: unknown, next: { get: () => unknown }): void {
  const reference = live as Record<symbol, unknown> & { get?: unknown };
  const write = Object.getOwnPropertySymbols(reference).find((key) => typeof reference[key] === 'function');
  assert.ok(write, 'a schema-declared volatile block must expose its commit function');
  (reference[write] as (value: unknown) => void)(next.get());
}

/** One loader-mounted activation under test. */
interface LiveHost {
  ctx: Context;
  runtime: ReflexRuntime;
  /** Commit an authored config the way a real config-only save does. */
  commit(next: ReflexConfig): void;
  dispose(): Promise<void>;
}

/**
 * Boot the real Host services and mount this module through the real Cordis
 * loader, then expose the exact commit path a settings save takes.
 * @param authored - the authored deployment config.
 * @returns the mounted activation.
 */
async function bootLoader(authored: ReflexConfig): Promise<LiveHost> {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(CommandRuntime);
  await ctx.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href });

  loaderApplies = 0;
  loaderRuntime = undefined;
  const id = await ctx.loader.create({ name: './live-tools.test.js', config: authored });
  await ctx.loader.await();

  const entry = ctx.loader.resolve(id);
  const runtime = loaderRuntime;
  assert.ok(runtime, 'the loader applied the plugin and exposed its runtime');
  assert.equal(entry.fiber?.state, 2, 'the mounted plugin is active');

  return {
    ctx,
    runtime,
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

/** Every suffix mapped to one value. */
function all(value: boolean): Record<string, boolean> {
  return Object.fromEntries(REFLEX_TOOL_SUFFIXES.map((suffix) => [suffix, value]));
}

/** The names a config enables, in vocabulary order. */
function namesOf(authored: ReflexConfig): string[] {
  return reflexToolNames(resolveConfig({ backend: 'mock', ...authored }));
}

/**
 * Assert the published surface is exactly what the registry answers for.
 *
 * The panel reads the surface, not the config: a surface that disagreed with
 * the registry would depict tools the model cannot call (or hide ones it can).
 * @param host - the mounted activation.
 * @param expected - the names the edited config enables.
 */
function assertSurface(host: LiveHost, expected: readonly string[]): void {
  assert.deepEqual([...host.runtime.toolSurface], [...expected], 'the runtime surface follows the live registry');
  for (const suffix of REFLEX_TOOL_SUFFIXES) {
    const name = expected.find((candidate) => candidate.endsWith(suffix));
    for (const prefix of ['reflex_', 'rx_', 'rv_']) {
      const candidate = `${prefix}${suffix}`;
      assert.equal(host.ctx.tools.get(candidate) !== undefined, candidate === name, `${candidate} registration is exact`);
    }
  }
}

test('closing and reopening one tool changes the registry on the very next query', async () => {
  const host = await bootLoader({ backend: 'mock' });
  try {
    const defaultNames = namesOf({ backend: 'mock' });
    assert.deepEqual([...host.runtime.toolSurface], defaultNames);
    assert.ok(host.ctx.tools.get('reflex_choice'), 'the positive control: choice starts registered');

    // Save `tools.enabled.choice: false` — no remount.
    host.commit({ backend: 'mock', tools: { enabled: { choice: false } } });
    assert.equal(loaderApplies, 1, 'the plugin fiber never restarts');
    assert.equal(host.ctx.tools.get('reflex_choice'), undefined, 'the closed tool is gone from the registry');
    assert.ok(host.ctx.tools.get('reflex_score'), 'its siblings survive');
    assertSurface(host, namesOf({ backend: 'mock', tools: { enabled: { choice: false } } }));
    const closed = await callTool(host.ctx, 'reflex_choice', { question: 'Pick', options: ['a', 'b'] });
    assert.equal(closed.isError, true, 'a call by the old name is an unknown tool, not a stale body');

    // Save it back on: the same registration comes back, with its schema intact.
    host.commit({ backend: 'mock', tools: { enabled: { choice: true } } });
    assert.equal(loaderApplies, 1, 'still no remount');
    const reopened = host.ctx.tools.get('reflex_choice');
    assert.ok(reopened, 'the reopened tool is registered again');
    assert.equal(reopened.parameters.type, 'object', 'its parameter schema is rebuilt');
    assertSurface(host, defaultNames);
    const open = await callTool(host.ctx, 'reflex_choice', { question: 'Pick', options: ['a', 'b'] });
    assert.equal(open.isError, false, 'the reopened registration runs end to end');
    const undeclared = await callTool(host.ctx, 'reflex_choice', { question: 'Pick', options: ['a'], teleport: true });
    assert.equal(undeclared.isError, true, 'argument validation survives the re-registration');
  } finally {
    await host.dispose();
  }
});

test('the off-by-default route tool appears and disappears with its switch', async () => {
  const host = await bootLoader({ backend: 'mock' });
  try {
    assert.equal(host.ctx.tools.get('reflex_route'), undefined, 'route starts off');

    host.commit({ backend: 'mock', tools: { enabled: { route: true } } });
    assert.equal(loaderApplies, 1, 'the tool switch is live, not a remount');
    assert.ok(host.ctx.tools.get('reflex_route'), 'turning the opt-in tool on registers it');
    const routed = await callTool(host.ctx, 'reflex_route', {
      goal: 'pick a tool',
      candidates: [{ name: 'one', description: 'first candidate' }]
    });
    assert.equal(routed.isError, false, 'the newly registered tool runs');
    assertSurface(host, namesOf({ backend: 'mock', tools: { enabled: { route: true } } }));

    host.commit({ backend: 'mock', tools: { enabled: { route: false } } });
    assert.equal(host.ctx.tools.get('reflex_route'), undefined, 'turning it off unregisters it again');
    assertSurface(host, namesOf({ backend: 'mock' }));
  } finally {
    await host.dispose();
  }
});

test('a toolPrefix edit replaces the whole surface without leaving a mixed or orphaned state', async () => {
  const host = await bootLoader({ backend: 'mock' });
  try {
    const before = namesOf({ backend: 'mock' });
    assertSurface(host, before);

    host.commit({ backend: 'mock', toolPrefix: 'rx_' });
    assert.equal(loaderApplies, 1, 'a prefix edit is live too');
    const after = namesOf({ backend: 'mock', toolPrefix: 'rx_' });
    assertSurface(host, after);
    assert.deepEqual(
      after.map((name) => name.replace(/^rx_/, '')),
      before.map((name) => name.replace(/^reflex_/, '')),
      'the same suffixes are registered under the new prefix'
    );
    for (const name of before) assert.equal(host.ctx.tools.get(name), undefined, `${name} was unregistered`);
    for (const name of after) {
      assert.ok(host.ctx.tools.get(name), `${name} was registered`);
      // Exactly one registration per name: a leftover old one would make the
      // registry refuse the new name (or shadow it), and a duplicate would
      // make the registry throw above.
      assert.equal(host.ctx.tools.get(name)?.name, name);
    }
    assert.equal(host.runtime.effectiveConfig.toolPrefix, 'rx_', 'the runtime reports the live prefix');

    const oldCall = await callTool(host.ctx, 'reflex_choice', { question: 'Pick', options: ['a', 'b'] });
    assert.equal(oldCall.isError, true, 'the model holding the old name gets a clear unknown tool');
    const newCall = await callTool(host.ctx, 'rx_choice', { question: 'Pick', options: ['a', 'b'] });
    assert.equal(newCall.isError, false, 'the renamed tool answers');
    assert.equal(
      (await callTool(host.ctx, 'rx_choice', { question: 'Pick', options: ['a'], teleport: true })).isError,
      true,
      'the renamed registration validates arguments like the original'
    );

    // The plugin's own tools are exempt from its own pruning. A frozen
    // own-tool set would stop recognising the renamed surface.
    assert.ok(host.runtime.interventions, 'the intervention engine is installed');
    assert.deepEqual([...host.runtime.interventions!.ownTools].sort(), [...after].sort(), 'own tools follow the rename');

    host.commit({ backend: 'mock', toolPrefix: 'reflex_' });
    assertSurface(host, before);
    assert.deepEqual([...host.runtime.interventions!.ownTools].sort(), [...before].sort(), 'and follow it back');
  } finally {
    await host.dispose();
  }
});

test('every tool off registers nothing, and disposing leaves no residue', async () => {
  const host = await bootLoader({ backend: 'mock', tools: { enabled: all(false) } });
  const tools = host.ctx.tools;
  try {
    assert.deepEqual([...host.runtime.toolSurface], [], 'an all-off deployment publishes an empty surface');
    assert.equal(host.runtime.toolRegistrationCount, 0, 'and registers nothing at all');
    assert.equal(host.runtime.toolRegistrationEvents, 0, 'no registration ever happened');
    for (const suffix of REFLEX_TOOL_SUFFIXES) {
      assert.equal(tools.get(`reflex_${suffix}`), undefined, `${suffix} is absent`);
    }

    // Turn one back on: exactly one registration, then all off again empties it.
    host.commit({ backend: 'mock', tools: { enabled: { ...all(false), choice: true } } });
    assert.equal(host.runtime.toolRegistrationEvents, 1, 'opening one tool is one registration');
    assert.equal(host.runtime.toolRegistrationCount, 1);
    host.commit({ backend: 'mock', tools: { enabled: all(false) } });
    assert.equal(host.runtime.toolRegistrationCount, 0, 'closing it unregisters it');
    assert.equal(host.runtime.toolRegistrationEvents, 1, 'closing never registers');
    assert.deepEqual([...host.runtime.toolSurface], []);

    host.commit({ backend: 'mock', tools: { enabled: { ...all(false), choice: true, route: true } } });
    assert.equal(host.runtime.toolRegistrationCount, 2);
  } finally {
    await host.dispose();
  }
  assert.equal(host.runtime.toolRegistrationCount, 0, 'dispose emptied the owned set');
  for (const suffix of REFLEX_TOOL_SUFFIXES) {
    assert.equal(tools.get(`reflex_${suffix}`), undefined, `${suffix} has no residual registration`);
  }
});

test('committing the same tool config twice does not re-register anything', async () => {
  const host = await bootLoader({ backend: 'mock' });
  try {
    const names = [...host.runtime.toolSurface];
    const events = host.runtime.toolRegistrationEvents;
    const count = host.runtime.toolRegistrationCount;
    assert.equal(events, names.length, 'the initial surface is one registration per tool');
    assert.equal(count, names.length);

    const same: ReflexConfig = { backend: 'mock', tools: { enabled: { choice: true, route: false } } };
    host.commit(same);
    host.commit(same);
    host.commit(same);
    assert.equal(loaderApplies, 1, 'three commits, zero remounts');
    assert.equal(host.runtime.toolRegistrationEvents, events, 'an unchanged save touches no registration');
    assert.equal(host.runtime.toolRegistrationCount, count);
    assert.deepEqual([...host.runtime.toolSurface], names);

    // A real change still applies: closing `choice` only removes, opening
    // `route` adds exactly one registration.
    host.commit({ backend: 'mock', tools: { enabled: { choice: false, route: true } } });
    assert.equal(host.runtime.toolRegistrationEvents, events + 1, 'one removal and one addition, no churn');
    assert.equal(host.runtime.toolRegistrationCount, names.length, 'the surface size stays the same');
    assert.equal(host.ctx.tools.get('reflex_choice'), undefined);
    assert.ok(host.ctx.tools.get('reflex_route'));
  } finally {
    await host.dispose();
  }
});

test('the unchanged step hot path compares snapshots and never re-registers tools', async (t) => {
  const host = await bootLoader({ backend: 'mock', tools: { enabled: { route: true } } });
  try {
    const events = host.runtime.toolRegistrationEvents;
    const resolves = host.runtime.configResolveCount;

    for (let index = 0; index < 50; index += 1) assert.equal(host.runtime.refreshIfChanged(), false);
    const started = performance.now();
    for (let index = 0; index < 2000; index += 1) host.runtime.refreshIfChanged();
    const checkUs = ((performance.now() - started) * 1000) / 2000;

    assert.equal(host.runtime.toolRegistrationEvents, events, 'no registration is touched without a commit');
    assert.equal(host.runtime.configResolveCount, resolves, 'and the schema does not run again');
    assert.deepEqual(
      [...host.runtime.toolSurface],
      namesOf({ backend: 'mock', tools: { enabled: { route: true } } }),
      'the surface is unchanged'
    );
    t.diagnostic(`refreshIfChanged with the tool surface attached: ${checkUs.toFixed(3)} µs/call; registrations: ${events}`);
    assert.ok(checkUs < 50, `the snapshot check must stay cheap (got ${checkUs.toFixed(3)} µs)`);
  } finally {
    await host.dispose();
  }
});

test('the panel snapshot shows the tool switches and names currently in force', async () => {
  const host = await bootLoader({ backend: 'mock' });
  try {
    const before = buildPanelSnapshot(panelFacts(host.runtime, {}));
    assert.equal(before.plugin.toolPrefix, 'reflex_');
    assert.equal(before.tools.enabled.choice, true);
    assert.equal(before.tools.enabled.route, false);
    assert.deepEqual([...before.tools.active], namesOf({ backend: 'mock' }));

    host.commit({ backend: 'mock', tools: { enabled: { choice: false, route: true } } });
    // No request and no page reload between the save and the read.
    const after = buildPanelSnapshot(panelFacts(host.runtime, {}));
    assert.equal(after.tools.enabled.choice, false, 'the panel reports the saved switch');
    assert.equal(after.tools.enabled.route, true);
    assert.deepEqual(
      [...after.tools.active],
      namesOf({ backend: 'mock', tools: { enabled: { choice: false, route: true } } }),
      'the panel lists exactly the registered names'
    );

    host.commit({ backend: 'mock', toolPrefix: 'rv_', tools: { enabled: { route: true } } });
    const renamed = buildPanelSnapshot(panelFacts(host.runtime, {}));
    assert.equal(renamed.plugin.toolPrefix, 'rv_', 'the prefix field follows the edit');
    assert.deepEqual([...renamed.tools.active], namesOf({ backend: 'mock', toolPrefix: 'rv_', tools: { enabled: { route: true } } }));
    assert.equal(renamed.tools.active.some((name) => name.startsWith('reflex_')), false, 'no stale name is shown');
  } finally {
    await host.dispose();
  }
});
