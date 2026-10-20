import assert from 'node:assert/strict';
import test from 'node:test';
import { createReflexRuntime } from './bridge.js';
import { resolveConfig } from './config.js';
import { ReflexVirtualAdapter } from './virtual-adapter.js';

test('virtual context is conservative exact candidate metadata, never invented or first-candidate-only', async () => {
  const runtime = createReflexRuntime(resolveConfig({ backend: 'mock', routing: { models: {
    'reflex-1': [{ provider: 'physical', model: 'large' }, { provider: 'physical', model: 'small' }]
  } } }));
  try {
    for (const [windows, expected] of [
      [[1_000_000, 128_000], 128_000], [[128_000, 1_000_000], 128_000],
      [[undefined, 128_000], undefined], [[1_000_000, undefined], undefined],
      [[Number.NaN, 128_000], undefined], [[Infinity, 128_000], undefined], [[0, 128_000], undefined]
    ] as [Array<number | undefined>, number | undefined][]) {
      const adapter = new ReflexVirtualAdapter({ provider: 'reflex', router: runtime.modelRouter,
        dispatch: async function* () {}, resolveContextWindow: async (_provider, model) => windows[model === 'large' ? 0 : 1] });
      const info = await adapter.resolveModel('reflex', 'reflex-1');
      assert.equal(info.context?.contextWindow, expected);
    }
    const adapter = new ReflexVirtualAdapter({ provider: 'reflex', router: runtime.modelRouter, dispatch: async function* () {} });
    assert.equal((await adapter.resolveModel('reflex', 'reflex-1')).context, undefined);
  } finally { runtime.dispose(); }
});
