import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm';
import { resolveAdaptiveIntent } from './adaptive-intent.js';

const owns = (provider: string) => provider === 'reflex';
const virtual = { provider: 'reflex', model: 'reflex-1', reasoningEffort: 'reflex' } as LlmCallConfig;
const physical = { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' } as LlmCallConfig;

/** Mirrors the installed Host's pending-selection/header equality reduction. */
function host() {
  let pending: LlmCallConfig | null = null;
  let header: LlmCallConfig | undefined;
  const events: { type: string; data: LlmCallConfig }[] = [];
  const same = (a: LlmCallConfig | null, b: LlmCallConfig) =>
    a?.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort;
  const session = {
    append(type: string, data: LlmCallConfig) {
      events.push({ type, data });
      if (type === 'model/selection') pending = data;
      if (type === 'request/header') {
        header = data;
        if (same(pending, data)) pending = null;
      }
    }
  };
  const agent = { session } as unknown as Agent;
  const ctx = {
    get: (name: string) => name === 'sessionProjections' ? {
      stateOf: (target: unknown, key: string) => {
        assert.equal(target, session);
        assert.equal(key, 'modelSelection');
        return { pending };
      }
    } : undefined
  } as unknown as Context;
  return {
    ctx, agent, events, session,
    get pending() { return pending; },
    // The Host with no explicit picked cache uses header before deployment default.
    config: () => pending ?? header ?? virtual,
    resolve: (config: LlmCallConfig) => resolveAdaptiveIntent(ctx, agent, config, owns)
  };
}

test('implicit virtual default remains durable across physical headers and plugin reload', () => {
  const h = host();
  assert.equal(h.resolve(h.config()), virtual);
  assert.equal(h.events.length, 1);
  assert.deepEqual(h.pending, virtual);
  h.session.append('request/header', physical);
  assert.deepEqual(h.pending, virtual, 'physical execution does not consume virtual intent');
  // Existing controller closure falls back to physical; a fresh plugin call
  // recovers only from the public projection, not from an in-memory cache.
  assert.deepEqual(h.resolve(physical), virtual);
  assert.deepEqual(resolveAdaptiveIntent(h.ctx, h.agent, physical, owns), virtual);
  assert.equal(h.events.filter(e => e.type === 'model/selection').length, 1);
});

test('an explicit physical fixed choice replaces then consumes adaptive intent', () => {
  const h = host();
  h.resolve(virtual);
  h.session.append('request/header', physical);
  const fixed = { ...physical, reasoningEffort: 'high' } as LlmCallConfig;
  h.session.append('model/selection', fixed);
  assert.equal(h.resolve(fixed), fixed);
  h.session.append('request/header', fixed);
  assert.equal(h.pending, null);
  assert.equal(h.resolve(fixed), fixed);
  assert.equal(h.events.filter(e => e.type === 'model/selection').length, 2);
});

test('physical concrete and provider-default configurations are not made adaptive', () => {
  for (const config of [physical, { provider: 'openai-codex', model: 'gpt-6.1-sol' } as LlmCallConfig]) {
    const h = host();
    assert.equal(h.resolve(config), config);
    assert.deepEqual(h.events, []);
  }
});

test('pending virtual provider-default intent clears previously applied physical effort', () => {
  const h = host();
  const unpinned = { provider: 'reflex', model: 'reflex-1' } as LlmCallConfig;
  h.session.append('model/selection', unpinned);
  assert.deepEqual(h.resolve(physical), unpinned);
  assert.equal('reasoningEffort' in h.resolve(physical), false);
});

test('an implicit physical adaptive effort persists without changing its provider', () => {
  const h = host();
  const adaptive = { ...physical, reasoningEffort: 'auto' } as LlmCallConfig;
  h.resolve(adaptive);
  h.session.append('request/header', physical);
  assert.deepEqual(h.resolve(physical), adaptive);
  assert.equal(h.events.filter(e => e.type === 'model/selection').length, 1);
});

test('older hosts and invalid pending selections are left untouched', () => {
  const h = host();
  for (const service of [undefined, { stateOf: () => undefined }, { stateOf: () => ({ pending: { provider: 'reflex' } }) }]) {
    const ctx = { get: () => service } as unknown as Context;
    assert.equal(resolveAdaptiveIntent(ctx, h.agent, physical, owns), physical);
  }
  assert.deepEqual(h.events, []);
});
