import assert from 'node:assert/strict';
import test from 'node:test';

import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

import {
  Config,
  plainConfig,
  resolveConfig,
  resolveToolsConfig,
  type ReflexConfig,
  type ReflexToolsConfig
} from './config.js';
import { createReflexHost, createToolContext, callTool } from './testing.js';
import { REFLEX_TOOL_DEFAULT_ENABLED, REFLEX_TOOL_SUFFIXES, enabledReflexToolSuffixes, reflexToolNames } from './tools.js';
import { applyReflex, type ReflexRuntime } from './index.js';

/**
 * Coverage of the per-tool capability switch (`tools.enabled`).
 *
 * The switch is keyed by tool *suffix*, never by the decorated name, so a
 * deployment that renames `toolPrefix` keeps its decisions. Closing a tool
 * unregisters it: the registry no longer answers for that name and the runtime
 * surface — the projection the panel and the automatic half read — drops it.
 *
 * @module dsh-reflex/tools-switch.test
 */

/** Every suffix mapped to one value. */
function all(value: boolean): Record<string, boolean> {
  return Object.fromEntries(REFLEX_TOOL_SUFFIXES.map((suffix) => [suffix, value]));
}

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
 * Load the plugin the way the Host loader does, so the activation can be
 * unloaded without tearing down the context it lives on.
 * @param ctx - context carrying `tools`, `llm`, and `commands`.
 * @param config - deployment config.
 * @returns the plugin fiber and its runtime.
 */
async function loadReflex(ctx: Context, config: ReflexConfig): Promise<{ fiber: { dispose(): Promise<void> }; runtime: ReflexRuntime }> {
  let created: ReflexRuntime | undefined;
  const fiber = await ctx.plugin(
    {
      name: 'dsh-reflex',
      inject: ['tools', 'llm', 'commands'],
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

test('tools.enabled takes the per-suffix default and answers every suffix', () => {
  const bare = resolveConfig({ backend: 'mock' });
  assert.deepEqual(bare.tools, { enabled: { ...REFLEX_TOOL_DEFAULT_ENABLED } }, 'an omitted map means "the default", not "all on"');
  assert.equal(bare.tools.enabled.route, false, 'route is the documented exception');
  assert.deepEqual(
    enabledReflexToolSuffixes(bare),
    REFLEX_TOOL_SUFFIXES.filter((suffix) => suffix !== 'route'),
    'the default surface is the four recommended tools'
  );
  assert.deepEqual(
    reflexToolNames(bare),
    REFLEX_TOOL_SUFFIXES.filter((suffix) => suffix !== 'route').map((suffix) => `reflex_${suffix}`)
  );

  const partial = resolveConfig({ backend: 'mock', tools: { enabled: { route: true, score: false } } });
  assert.equal(partial.tools.enabled.route, true, 'the off-by-default suffix can be switched on');
  assert.equal(partial.tools.enabled.score, false, 'an on-by-default suffix can be switched off');
  assert.equal(partial.tools.enabled.choice, true, 'an unmentioned switch keeps its default');
  assert.deepEqual(enabledReflexToolSuffixes(partial), REFLEX_TOOL_SUFFIXES.filter((s) => s !== 'score'));
});

test('an unknown or malformed switch is refused instead of silently ignored', () => {
  assert.throws(
    () => resolveConfig({ backend: 'mock', tools: { enabled: { route: false, teleport: true } } } as unknown as ReflexConfig),
    /tools\.enabled has unknown tool switch "teleport"; legal suffixes are choice, score, route, screen, gate/,
    'a typo must not silently leave the tool registered'
  );
  assert.throws(
    () => resolveConfig({ backend: 'mock', tools: { enabled: { prune: false } } } as unknown as ReflexConfig),
    /tools\.enabled has unknown tool switch "prune"/,
    'a capability that is no longer a tool cannot be switched: pruning is an intervention, not a tool'
  );
  assert.throws(
    () => resolveConfig({ backend: 'mock', tools: { enabled: { status_ledger: false } } } as unknown as ReflexConfig),
    /tools\.enabled has unknown tool switch "status_ledger"/,
    'the ledger is the /reflex-ledger command now'
  );
  assert.throws(
    () => resolveConfig({ backend: 'mock', tools: { enabled: { teleport: true, hologram: false } } } as unknown as ReflexConfig),
    /tools\.enabled has unknown tool switches "teleport", "hologram"/,
    'every unknown key is named, not just the first'
  );
  assert.throws(
    () => resolveConfig({ backend: 'mock', tools: { enabled: { route: 'no' } } } as unknown as ReflexConfig),
    /tools\.enabled\.route expected boolean but got no/,
    'the loader schema is the first line of defence'
  );
  assert.throws(
    () => resolveToolsConfig({ enabled: { route: 'no' } } as unknown as ReflexToolsConfig),
    /tools\.enabled\.route must be a boolean \(got "no"\)/,
    'and the resolver repeats the check for programmatic callers'
  );
  assert.throws(
    () => resolveConfig({ backend: 'mock', tools: { enabled: [] } } as unknown as ReflexConfig),
    /tools\.enabled expected object/,
    'the loader schema refuses a list where the switch map belongs'
  );
  assert.throws(
    () => resolveToolsConfig({ enabled: [] } as unknown as ReflexToolsConfig),
    /tools\.enabled must be an object mapping tool suffixes to booleans/
  );
  assert.throws(
    () => resolveToolsConfig('off' as unknown as ReflexToolsConfig),
    /tools must be an object mapping tool suffixes to booleans \(got "off"\)/
  );
  assert.throws(
    () => resolveToolsConfig({ choice: true } as unknown as ReflexToolsConfig),
    /tools has unknown key "choice"; only "enabled" is supported/,
    'passing the switch map unwrapped must not read as "nothing authored"'
  );

  // The open dictionary is what makes the rejection above possible: a declared
  // literal would let schemastery drop the unknown key before we ever saw it.
  assert.deepEqual(plainConfig(Config({ tools: { enabled: { choice: false, teleport: true } } })).tools?.enabled, {
    choice: false,
    teleport: true
  });
});

test('a closed tool is unregistered while its siblings stay registered', async () => {
  // One switch in each direction: gate (on by default) closed, route (off by
  // default) opened.
  const host = await createReflexHost({ backend: 'mock', tools: { enabled: { gate: false, route: true } } });
  try {
    assert.deepEqual(
      [...host.runtime.toolSurface],
      REFLEX_TOOL_SUFFIXES.filter((suffix) => suffix !== 'gate').map((suffix) => `reflex_${suffix}`),
      'the runtime surface is the effective registration, in registration order'
    );
    assert.equal(host.ctx.tools.get('reflex_gate'), undefined, 'a closed tool is not in the registry at all');
    assert.ok(host.ctx.tools.get('reflex_route'), 'the opt-in tool is registered once switched on');
    for (const suffix of REFLEX_TOOL_SUFFIXES) {
      if (suffix === 'gate') continue;
      assert.ok(host.ctx.tools.get(`reflex_${suffix}`), `${suffix} must survive its sibling's switch`);
    }
    for (const gone of ['prune', 'detect_stagnation', 'status_ledger']) {
      assert.equal(host.ctx.tools.get(`reflex_${gone}`), undefined, `${gone} is not part of the vocabulary any more`);
    }

    const open = await host.callTool('reflex_choice', { question: 'Pick', options: ['a', 'b'] });
    assert.equal(open.isError, false, 'a surviving tool still runs end to end');
    const closed = await callTool(host.ctx, 'reflex_gate', { claim: 'x', criteria: ['y'] });
    assert.equal(closed.isError, true, 'a closed tool is unknown to the registry');
  } finally {
    await host.dispose();
  }
});

test('the switch survives a toolPrefix rename because it is keyed by suffix', async () => {
  const host = await createReflexHost({ backend: 'mock', toolPrefix: 'rx_', tools: { enabled: { score: false } } });
  try {
    assert.deepEqual(
      [...host.runtime.toolSurface],
      REFLEX_TOOL_SUFFIXES.filter((suffix) => suffix !== 'score' && suffix !== 'route').map((suffix) => `rx_${suffix}`),
      'the closed suffix and the opt-in suffix are both absent under the new prefix'
    );
    assert.equal(host.ctx.tools.get('rx_score'), undefined);
    assert.equal(host.ctx.tools.get('rx_route'), undefined, 'route still needs its explicit switch under a rename');
    assert.ok(host.ctx.tools.get('rx_choice'));
    assert.equal(host.ctx.tools.get('reflex_choice'), undefined, 'the default prefix is not registered as well');
  } finally {
    await host.dispose();
  }
});

test('closing every tool registers nothing and leaves an empty surface', async () => {
  const host = await createReflexHost({ backend: 'mock', tools: { enabled: all(false) } });
  try {
    assert.deepEqual([...host.runtime.toolSurface], []);
    for (const suffix of REFLEX_TOOL_SUFFIXES) {
      assert.equal(host.ctx.tools.get(`reflex_${suffix}`), undefined, `${suffix} must be gone`);
    }
    assert.equal(reflexToolNames(resolveConfig({ backend: 'mock', tools: { enabled: all(false) } })).length, 0);
    // The plugin still activates: the automatic half and the panel do not depend
    // on any tool being registered.
    assert.equal(host.runtime.disposed, false);
  } finally {
    await host.dispose();
  }
});

test('the published surface keeps tracking the registry after a tools/change', async () => {
  const ctx = await createToolContext();
  try {
    const runtime = applyReflex(ctx, { backend: 'mock', tools: { enabled: { score: false } } });
    const expected = REFLEX_TOOL_SUFFIXES.filter((suffix) => suffix !== 'score' && suffix !== 'route').map(
      (suffix) => `reflex_${suffix}`
    );
    assert.deepEqual([...runtime.toolSurface], expected);

    // A registry change re-derives the surface from what is really registered:
    // the closed tool never reappears just because something else changed.
    ctx.tools.register(probeTool('probe_tool'));
    assert.deepEqual([...runtime.toolSurface], expected);
    assert.equal(runtime.toolSurface.includes('probe_tool'), false, "the surface is this plugin's own tools only");
  } finally {
    await ctx.fiber.dispose();
  }
});

test('closing, unloading, and reopening a tool leaves no duplicate registration', async () => {
  const ctx = await createToolContext();
  try {
    const first = await loadReflex(ctx, { backend: 'mock', tools: { enabled: { gate: false } } });
    assert.equal(ctx.tools.get('reflex_gate'), undefined);
    assert.deepEqual(
      [...first.runtime.toolSurface],
      REFLEX_TOOL_SUFFIXES.filter((suffix) => suffix !== 'gate' && suffix !== 'route').map((suffix) => `reflex_${suffix}`)
    );

    await first.fiber.dispose();
    assert.equal(first.runtime.disposed, true);
    for (const suffix of REFLEX_TOOL_SUFFIXES) {
      assert.equal(ctx.tools.get(`reflex_${suffix}`), undefined, `${suffix} was released on unload`);
    }

    const second = await loadReflex(ctx, { backend: 'mock', tools: { enabled: { route: true } } });
    assert.deepEqual(
      [...second.runtime.toolSurface],
      REFLEX_TOOL_SUFFIXES.map((suffix) => `reflex_${suffix}`),
      'reopening honours the switches again and restores exactly the full surface'
    );
    const reopened = ctx.tools.get('reflex_gate');
    assert.ok(reopened, 'the reopened tool is registered again');
    assert.equal(typeof reopened.execute, 'function');
    const choice = await callTool(ctx, 'reflex_choice', { question: 'Pick', options: ['a', 'b'] });
    assert.equal(choice.isError, false, 'the reopened registration is the one the registry serves');

    await second.fiber.dispose();
    for (const suffix of REFLEX_TOOL_SUFFIXES) {
      assert.equal(ctx.tools.get(`reflex_${suffix}`), undefined, `${suffix} was released again`);
    }
  } finally {
    await ctx.fiber.dispose();
  }
});
