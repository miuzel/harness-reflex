import assert from 'node:assert/strict';
import test from 'node:test';
import { createReflexRuntime } from './bridge.js';
import { resolveConfig } from './config.js';
import { installModelRouting } from './routing.js';
import { effortRecordsOf } from './session-audit.js';
import { createToolContext, dispatchAgentRequest, fakeAgent, registerPhysicalAdapter } from './testing.js';
import { Session, type SessionId } from '@deepseek-ai/dsh-session';
import { installModelSelection, type Agent } from '@deepseek-ai/dsh-agent';
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm';

// Host model selection awaits next() and then applies its durable selection.
// A plugin loaded/reloaded after that listener must still be the outer wrapper.
test('routing after host model selection and after reload applies final physical route and audit', async () => {
  const ctx = await createToolContext();
  const runtime = createReflexRuntime(resolveConfig({ backend: 'mock', effort: { reasoningEffort: 'reflex' }, routing: {
    models: { 'reflex-1': [{ provider: 'physical', model: 'sol', description: 'general' }] }
  } }));
  registerPhysicalAdapter(ctx, 'physical', { models: ['sol'], reasoningEfforts: ['low', 'medium', 'high'] });
  let selection: LlmCallConfig = { provider: 'reflex', model: 'reflex-1', reasoningEffort: 'reflex' as any };
  const selected = { current: selection, assembled: selection };
  installModelSelection(ctx, selected);
  let installation = installModelRouting(ctx, { llm: ctx.llm, router: runtime.modelRouter, effort: runtime.effort, maxTaskChars: 10000 });
  const session = Session.create('reload-routing' as SessionId);
  const agent = { ...fakeAgent({ id: 'reload-routing' }), session } as unknown as Agent;
  let events = 0;
  ctx.on('reflex/effort', () => { events++; });
  try {
    for (let turn = 1; turn <= 2; turn++) {
      const config = await dispatchAgentRequest(ctx, agent, { turn, task: 'design migration protocol', config: { provider: 'physical', model: 'sol', reasoningEffort: 'medium' as any } });
      assert.equal(config.provider, 'physical');
      assert.equal(config.model, 'sol');
      assert.notEqual(config.reasoningEffort, 'reflex');
      assert.equal(events, turn);
      installation.dispose();
      installation = installModelRouting(ctx, { llm: ctx.llm, router: runtime.modelRouter, effort: runtime.effort, maxTaskChars: 10000 });
    }
    assert.equal(effortRecordsOf(session.ownEvents()).length, 2);
    selection = { provider: 'physical', model: 'sol', reasoningEffort: 'medium' as any };
    selected.current = selected.assembled = selection;
    const before = runtime.ledger.getEntries().length;
    const pinned = await dispatchAgentRequest(ctx, agent, { turn: 3, task: 'design migration protocol', config: selection });
    assert.deepEqual(pinned, selection);
    assert.equal(events, 2, 'fixed physical effort emits no current Reflex decision');
    assert.equal(runtime.ledger.getEntries().length, before, 'fixed physical effort does not run either decision');
    selection = { ...selection, reasoningEffort: 'reflex' as any };
    selected.current = selected.assembled = selection;
    await dispatchAgentRequest(ctx, agent, { turn: 4, task: 'design migration protocol', config: selection });
    assert.equal(events, 3, 'explicit adaptive effort on physical route retains the feature');
  } finally {
    installation.dispose();
    runtime.dispose();
    await ctx.fiber.dispose();
  }
});
