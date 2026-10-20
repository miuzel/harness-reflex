import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Config,
  plainConfig,
  resolveApiKey,
  resolveConfig,
  resolveEffortSetting,
  resolveSystemOneConfig,
  type ReflexConfig
} from './config.js';
import * as plugin from './index.js';
import { createReflexHost, resultValue } from './testing.js';
import { REFLEX_TOOL_SUFFIXES, reflexToolNames } from './tools.js';
import type { ReflexLedgerResult } from './bridge.js';

test('plugin module satisfies the Cordis Host plugin contract', () => {
  assert.equal(plugin.name, 'dsh-reflex');
  assert.deepEqual(plugin.inject, ['tools', 'llm'], 'routing needs the LLM runtime service');
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(typeof plugin.Config, 'function');
  assert.equal(typeof plugin.createReflexRuntime, 'function');
  assert.equal(typeof plugin.defineReflexTools, 'function');
});

test('Config is a schemastery schema that carries the deployment defaults', () => {
  const parsed = plainConfig(Config({}));
  assert.equal(parsed.backend, 'auto');
  assert.equal(parsed.toolPrefix, 'reflex_');
  assert.equal(parsed.pruneThreshold, 500);
  assert.equal(parsed.routing?.enabled, true, 'routing is on by default');
  assert.equal(parsed.routing?.virtualProvider, 'reflex');
  assert.deepEqual(parsed.routing?.models, {}, 'no pool is invented for the user');
  assert.equal(parsed.routing?.maxTaskChars, 400);

  const custom = plainConfig(Config({ backend: 'mock', toolPrefix: 'rv_', pruneThreshold: 12 }));
  assert.equal(custom.backend, 'mock');
  assert.equal(custom.toolPrefix, 'rv_');
  assert.equal(custom.pruneThreshold, 12);
});

test('Config accepts a virtual model pool and keeps an unset ledgerPath unset', () => {
  const parsed = plainConfig(Config({
    routing: {
      virtualProvider: 'router',
      fallback: 'deepseek:chat',
      models: { 'router-auto': [{ provider: 'deepseek', model: 'reasoner', description: 'deep work' }] }
    }
  }));
  assert.equal(parsed.routing?.virtualProvider, 'router');
  assert.equal(parsed.routing?.fallback, 'deepseek:chat');
  assert.deepEqual(parsed.routing?.models?.['router-auto'], [
    // schemastery normalizes an absent array field to an empty array.
    { provider: 'deepseek', model: 'reasoner', description: 'deep work', tags: [] }
  ]);
  assert.equal(parsed.ledgerPath, undefined, 'a schema default would make the path un-round-trippable');
});

test('Config rejects values the tools cannot honour', () => {
  assert.throws(() => Config({ backend: 'telepathy' } as unknown as ReflexConfig));
  assert.throws(() => Config({ pruneThreshold: -1 }));
});

test('resolveConfig validates and fills every field', () => {
  const resolved = resolveConfig({ backend: 'mock' });
  assert.deepEqual(Object.keys(resolved).sort(), [
    'backend',
    'calibrationPath',
    'effort',
    'interventions',
    'ledgerPath',
    'pruneThreshold',
    'routing',
    'systemOne',
    'toolPrefix',
    'tools'
  ]);
  assert.equal(resolved.routing.enabled, true);
  assert.equal(resolved.routing.virtualProvider, 'reflex');
  assert.equal(resolved.routing.fallback, undefined);
  assert.deepEqual(resolved.routing.models, {});
  assert.equal(resolved.backend, 'mock');
  assert.equal(resolved.toolPrefix, 'reflex_');
  assert.equal(resolved.pruneThreshold, 500);
  assert.equal(resolved.ledgerPath, undefined);
  assert.equal(resolved.calibrationPath, undefined);
  assert.deepEqual(
    resolved.effort,
    { enabled: true, fallback: 'medium', minConfidence: 0.3 },
    'no trigger, no pinned level, adaptive effort on by default'
  );
  assert.equal('setting' in resolved.effort, false, 'an unset marker must stay unset, not become a default level');
  assert.deepEqual(
    resolved.tools,
    { enabled: Object.fromEntries(REFLEX_TOOL_SUFFIXES.map((suffix) => [suffix, true])) },
    'every tool is on unless it was switched off'
  );
});

test('Config accepts the reflex/auto marker and every effort level', () => {
  assert.equal(plainConfig(Config({})).effort?.reasoningEffort, undefined);
  assert.deepEqual(plainConfig(Config({ effort: {} })).effort, { enabled: true, fallback: 'medium', minConfidence: 0.3 });
  assert.equal(plainConfig(Config({ effort: { reasoningEffort: 'reflex' } })).effort?.reasoningEffort, 'reflex');
  assert.equal(plainConfig(Config({ effort: { reasoningEffort: 'auto' } })).effort?.reasoningEffort, 'auto');
  assert.equal(plainConfig(Config({ effort: { reasoningEffort: 'low' } })).effort?.reasoningEffort, 'low');
  assert.equal(plainConfig(Config({ effort: { reasoningEffort: 'medium' } })).effort?.reasoningEffort, 'medium');
  assert.equal(plainConfig(Config({ effort: { reasoningEffort: 'high' } })).effort?.reasoningEffort, 'high');
  assert.equal(plainConfig(Config({ effort: { reasoningEffort: 'off' } })).effort?.reasoningEffort, 'off');
  assert.equal(plainConfig(Config({ effort: { fallback: 'low', minConfidence: 0.5 } })).effort?.fallback, 'low');

  assert.throws(() => Config({ effort: { reasoningEffort: 'turbo' } } as unknown as ReflexConfig), 'an unknown level is refused');
  assert.throws(() => Config({ effort: { fallback: 'max' } } as unknown as ReflexConfig), 'the fallback stays adaptive');
  assert.throws(() => Config({ effort: { minConfidence: 2 } } as unknown as ReflexConfig), 'confidence is a fraction');
});

test('resolveConfig normalizes the effort marker and refuses a broken block', () => {
  assert.deepEqual(resolveConfig({ effort: { reasoningEffort: 'auto' } }).effort, {
    enabled: true,
    setting: 'auto',
    fallback: 'medium',
    minConfidence: 0.3
  });
  assert.deepEqual(resolveConfig({ effort: { reasoningEffort: 'high', fallback: 'low', minConfidence: 0 } }).effort, {
    enabled: true,
    setting: 'high',
    fallback: 'low',
    minConfidence: 0
  });
  assert.equal(resolveEffortSetting('  REFLEX '), 'reflex', 'the programmatic seam normalizes what the schema rejects');
  assert.equal(resolveEffortSetting(undefined), undefined);
  assert.throws(() => Config({ effort: { reasoningEffort: 'AUTO' } } as unknown as ReflexConfig), 'the YAML schema is exact');
  assert.throws(() => resolveEffortSetting('turbo'), /effort\.reasoningEffort must be one of/);

  assert.throws(
    () => resolveConfig({ effort: { reasoningEffort: 'turbo' } } as unknown as ReflexConfig),
    /effort\.reasoningEffort expected/
  );
  assert.throws(
    () => resolveConfig({ effort: { fallback: 'max' } } as unknown as ReflexConfig),
    /effort\.fallback expected/
  );
  assert.throws(
    () => resolveConfig({ effort: { minConfidence: 1.5 } } as unknown as ReflexConfig),
    /effort\.minConfidence/
  );
});

test('the eight reflexive capabilities use the MCP-compatible names', () => {
  assert.deepEqual(
    reflexToolNames(resolveConfig({ backend: 'mock' })).sort(),
    [
      'reflex_choice',
      'reflex_detect_stagnation',
      'reflex_gate',
      'reflex_prune',
      'reflex_route',
      'reflex_score',
      'reflex_screen',
      'reflex_status_ledger'
    ].sort()
  );
  assert.equal(REFLEX_TOOL_SUFFIXES.length, 8);
  assert.deepEqual(
    reflexToolNames(resolveConfig({ backend: 'mock', toolPrefix: 'rv_' })),
    REFLEX_TOOL_SUFFIXES.map((suffix) => `rv_${suffix}`)
  );
});

test('apply registers every tool with a model-visible description', async () => {
  const host = await createReflexHost({ backend: 'mock' });
  try {
    const names = reflexToolNames(resolveConfig({ backend: 'mock' }));
    assert.deepEqual([...host.runtime.toolSurface], names);
    assert.equal(host.runtime.ledger.getLogPath(), null, 'the ledger stays in memory unless a path is configured');

    for (const name of names) {
      const definition = host.ctx.tools.get(name);
      assert.ok(definition, `${name} should be registered`);
      assert.ok(definition.description.length > 60, `${name} needs a usable description`);
      assert.equal(definition.parameters.type, 'object', `${name} exposes an object parameter root`);
      assert.equal(typeof definition.output.render, 'function', `${name} declares a renderer`);
      assert.deepEqual(definition.output.schema, {}, `${name} declares the any-JSON canonical value`);
    }
  } finally {
    await host.dispose();
  }
});

test('a custom prefix renames the surface and leaves the defaults unregistered', async () => {
  const host = await createReflexHost({ backend: 'mock', toolPrefix: 'rv_' });
  try {
    for (const suffix of REFLEX_TOOL_SUFFIXES) {
      assert.ok(host.ctx.tools.get(`rv_${suffix}`), `rv_${suffix} should be registered`);
      assert.equal(host.ctx.tools.get(`reflex_${suffix}`), undefined);
    }
  } finally {
    await host.dispose();
  }
});

test('an explicit ledgerPath is honoured by the activation', async () => {
  const host = await createReflexHost({ backend: 'mock', ledgerPath: 'unused.jsonl' });
  try {
    const result = resultValue<ReflexLedgerResult>(await host.callTool('reflex_status_ledger', {}));
    assert.equal(result.summary.totalCalls, 0);
    assert.equal(host.runtime.ledger.getLogPath(), 'unused.jsonl');
  } finally {
    await host.dispose();
  }
});

test('the System One connection block fills defaults and refuses unusable values', () => {
  assert.deepEqual(resolveSystemOneConfig(undefined, undefined), { backend: 'auto' });
  assert.deepEqual(
    resolveSystemOneConfig('vllm', { baseUrl: ' http://127.0.0.1:8000/v1 ', model: 'jev-small', apiKeyEnv: 'REFLEX_KEY', timeoutMs: 2500 }),
    { backend: 'vllm', baseUrl: 'http://127.0.0.1:8000/v1', model: 'jev-small', apiKeyEnv: 'REFLEX_KEY', timeoutMs: 2500 },
    'authored text is trimmed, not trusted'
  );
  // An empty string is "unset", not "the empty base url".
  assert.deepEqual(resolveSystemOneConfig('mock', { baseUrl: '   ', model: '' }), { backend: 'mock' });
  for (const timeoutMs of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => resolveSystemOneConfig('auto', { timeoutMs }), /timeoutMs must be a positive integer/);
  }
  assert.throws(() => resolveSystemOneConfig('telepathy' as 'auto', undefined), /backend must be one of/);
});

test('an api key is read from the environment by name and never from the document', () => {
  const config = resolveSystemOneConfig('vllm', { apiKeyEnv: 'REFLEX_TEST_KEY' });
  assert.equal(resolveApiKey(config, { REFLEX_TEST_KEY: 'sk-live-1234' }), 'sk-live-1234');
  assert.equal(resolveApiKey(config, { REFLEX_TEST_KEY: '' }), undefined, 'an empty variable is not a key');
  assert.equal(resolveApiKey(config, {}), undefined);
  assert.equal(resolveApiKey({}, { REFLEX_TEST_KEY: 'sk-live-1234' }), undefined, 'no name, no lookup');
  // The resolved block carries the variable *name*: a settings document written by
  // the panel can never round-trip a credential back to a client.
  assert.deepEqual(config, { backend: 'vllm', apiKeyEnv: 'REFLEX_TEST_KEY' });
  assert.equal(JSON.stringify(resolveConfig({ backend: 'vllm', systemOne: { apiKeyEnv: 'REFLEX_TEST_KEY' } })).includes('sk-live'), false);
});
