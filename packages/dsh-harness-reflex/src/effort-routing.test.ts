import assert from 'node:assert/strict';
import test from 'node:test';

import { Context } from '@deepseek-ai/cordis';
import { isSurfaceEligibleType, Session, type SessionId } from '@deepseek-ai/dsh-session';
import type { GenerateOptions, LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';

import { applyReflex, EFFORT_RECORD_TYPE, effortRecordsOf } from './index.js';
import type { ReflexConfig } from './config.js';
import type { ReflexEffortStatus } from './effort.js';
import {
  createReflexHost,
  createToolContext,
  dispatchAgentRequest,
  fakeAgent,
  registerPhysicalAdapter,
  userMessage
} from './testing.js';

/**
 * Integration coverage of the adaptive reasoning-effort interception: real
 * Cordis, real `LlmRuntime`, real adapter registry, real agent-scoped waterfall,
 * and a real Session log. Every assertion observes a production seam (the
 * rewritten call config, the physical dispatch, the session log, the ledger,
 * the published status), never an internal of the interceptor.
 */

const TASK_DEEP = 'design the migration protocol for the distributed store';
const TASK_TRIVIAL = 'thanks';

/**
 * Pool used by most tests: one virtual model over one physical target, so the
 * route is deterministic and every assertion below is about the effort layer.
 */
const POOLS: ReflexConfig['routing'] = {
  models: {
    'reflex-auto': [{ provider: 'deepseek', model: 'reasoner', description: 'hard reasoning math' }]
  }
};

/** The deployment that turns the marker into a decision. */
const ADAPTIVE: ReflexConfig = { backend: 'mock', routing: POOLS, effort: { reasoningEffort: 'reflex' } };

/** Reasoning vocabulary of the fake physical route used below. */
const THINKING = { models: ['reasoner'], reasoningEfforts: ['low', 'high'], defaultEffort: 'low' };

/**
 * Brand one effort text the way the loop's config carries it.
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
 * Dispatch one request the way the loop does *after* the waterfall: the
 * returned configuration, plus the user message, handed to the LLM runtime.
 * @param ctx - host context.
 * @param config - the configuration the waterfall produced.
 * @param task - user text carried by the request.
 * @returns every chunk the physical adapter produced.
 */
function dispatch(ctx: Context, config: LlmCallConfig, task: string): Promise<StreamChunk[]> {
  return collect(
    ctx.llm.stream({
      ...config,
      messages: [userMessage(task)]
    } as GenerateOptions)
  );
}

/**
 * An agent whose session is a real Session, so the audit record can be read back.
 * @param id - session id.
 * @param header - lineage facts the routing listeners read.
 * @returns the agent and its session.
 */
function agentWithSession(id: string, header: Record<string, unknown> = {}): { agent: Agent; session: Session } {
  const session = Session.create(id as unknown as SessionId);
  const agent = { ...fakeAgent({ id }), session, sessionHeader: header } as unknown as Agent;
  return { agent, session };
}

test('the reflex marker becomes a concrete effort on the dispatched request', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    const physical = registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-effort', provider: 'reflex', model: 'reflex-auto' });

    const config = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      turn: 4,
      step: 2,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });

    assert.equal(config.provider, 'deepseek', 'the route is still resolved by System 1');
    assert.equal(config.model, 'reasoner');
    assert.equal(config.reasoningEffort, 'high', 'the marker became the level the task needs');
    assert.notEqual(config.reasoningEffort, 'reflex', 'the marker must never reach a physical adapter');

    const chunks = await dispatch(host.ctx, config, TASK_DEEP);
    assert.equal(physical.calls.length, 1);
    assert.equal(physical.calls[0].reasoningEffort, 'high', 'the dispatched API params carry the decided effort');
    assert.equal((chunks[0] as { text: string }).text, 'deepseek:reasoner');

    const entries = host.runtime.ledger.getEntries().filter((entry) => entry.type === 'effort-decision');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].details?.level, 'high');
    assert.equal(entries[0].details?.applied, 'high');
    assert.equal(entries[0].details?.agentId, 'session-effort');
    assert.equal(entries[0].details?.turn, 4);
    assert.equal(entries[0].details?.step, 2);
  } finally {
    await host.dispose();
  }
});

test('the auto alias decides exactly like reflex', async () => {
  const host = await createReflexHost({ ...ADAPTIVE, effort: { reasoningEffort: 'auto' } });
  try {
    const physical = registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-auto' });

    const config = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('auto') }
    });
    await dispatch(host.ctx, config, TASK_DEEP);

    assert.equal(config.reasoningEffort, 'high');
    assert.equal(physical.calls[0].reasoningEffort, 'high');
    assert.equal(host.runtime.ledger.getEntries().filter((entry) => entry.type === 'effort-decision').length, 1);
  } finally {
    await host.dispose();
  }
});

test('two turns of one agent are decided independently', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', { models: ['reasoner'], reasoningEfforts: ['off', 'low', 'high'] });
    const agent = fakeAgent({ id: 'session-turns' });

    const deep = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      turn: 1,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    const trivial = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_TRIVIAL,
      turn: 2,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });

    assert.equal(deep.reasoningEffort, 'high', 'a hard turn buys thinking');
    assert.equal(trivial.reasoningEffort, 'off', 'a turn that asks nothing stops buying it');
    assert.equal(host.runtime.effortStatus('session-turns')?.level, 'off', 'the status follows the latest turn');
  } finally {
    await host.dispose();
  }
});

test('a request that fixed its own effort is never overridden', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const { agent, session } = agentWithSession('session-pinned');

    const config = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_TRIVIAL,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('high') }
    });

    assert.equal(config.reasoningEffort, 'high', 'an explicit concrete effort wins over the deployment marker');
    assert.equal(
      host.runtime.ledger.getEntries().filter((entry) => entry.type === 'effort-decision').length,
      0,
      'a transparent pass-through is not an effort decision'
    );
    assert.equal(host.runtime.effortStatus('session-pinned'), undefined);
    assert.deepEqual(effortRecordsOf(session.ownEvents()), [], 'nothing to audit means no record');
  } finally {
    await host.dispose();
  }
});

test('a physical model without thinking gets the key cleared, not a crash', async () => {
  const host = await createReflexHost({
    backend: 'mock',
    routing: { models: { 'reflex-auto': [{ provider: 'plain', model: 'basic', description: 'no reasoning support' }] } },
    effort: { reasoningEffort: 'reflex' }
  });
  try {
    const physical = registerPhysicalAdapter(host.ctx, 'plain', { models: ['basic'] });
    const agent = fakeAgent({ id: 'session-plain' });

    const config = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });

    assert.equal(config.provider, 'plain');
    assert.equal(config.reasoningEffort, undefined, 'a non-thinking target is asked exactly what it can answer');
    assert.equal('reasoningEffort' in config, false, 'the key is cleared, not set to undefined');

    const chunks = await dispatch(host.ctx, config, TASK_DEEP);
    assert.equal(physical.calls.length, 1, 'the turn still dispatches');
    assert.equal(physical.calls[0].reasoningEffort, undefined);
    assert.ok(chunks.length > 0, 'the stream still produces output');

    const status = host.runtime.effortStatus('session-plain');
    assert.equal(status?.level, 'high', 'the decision is still audited');
    assert.equal(status?.outcome, 'cleared');
    assert.match(String(status?.line), /→ none \(/);
  } finally {
    await host.dispose();
  }
});

test('the decision reaches the session log without entering the model surface', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const { agent, session } = agentWithSession('session-audit');

    const nodesBefore = session.surface.nodes.length;
    await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      turn: 2,
      step: 1,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });

    const records = effortRecordsOf(session.ownEvents());
    assert.equal(records.length, 1, 'exactly one record per decided turn');
    assert.equal(records[0].level, 'high');
    assert.equal(records[0].applied, 'high');
    assert.equal(records[0].trigger, 'request');
    assert.equal(records[0].provider, 'deepseek');
    assert.equal(records[0].model, 'reasoner');
    assert.equal(records[0].turn, 2);
    assert.equal(records[0].agentId, 'session-audit');
    assert.ok(records[0].at > 0);
    assert.match(records[0].line, /^reflex effort: high → high/);

    assert.equal(session.surface.nodes.length, nodesBefore, 'the audit record adds nothing the model can read');
    assert.deepEqual(session.deriveMessages(), [], 'the model-visible messages stay empty');
    assert.equal(isSurfaceEligibleType(EFFORT_RECORD_TYPE), false, 'the record type is ignorable by construction');
    assert.equal(EFFORT_RECORD_TYPE, 'plugin:dsh-reflex/effort');
  } finally {
    await host.dispose();
  }
});

test('the status bar line and the emitted event agree with the decided turn', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const seen: ReflexEffortStatus[] = [];
    const stop = host.ctx.on('reflex/effort', (status) => {
      seen.push(status);
    });
    const agent = fakeAgent({ id: 'session-status' });

    await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });

    assert.equal(seen.length, 1, 'one event per decided turn');
    assert.equal(seen[0].agentId, 'session-status');
    assert.equal(host.runtime.effortStatusLine('session-status'), seen[0].line);
    assert.match(seen[0].line, /^reflex effort: high → high \(system-one \d\.\d\d, \d+ms\) deepseek:reasoner$/);
    assert.equal(host.runtime.effortStatus()?.line, seen[0].line, 'the newest status of any agent is readable');

    stop();
    await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_TRIVIAL,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    assert.equal(seen.length, 1, 'an unsubscribed host hears nothing further');
  } finally {
    await host.dispose();
  }
});

test('the marker is honoured without any virtual route', async () => {
  const host = await createReflexHost({ backend: 'mock', effort: { reasoningEffort: 'reflex' } });
  try {
    const physical = registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-direct', provider: 'deepseek', model: 'reasoner' });

    const config = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      config: { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('reflex') }
    });

    assert.equal(config.provider, 'deepseek', 'a deployment without pools routes nothing');
    assert.equal(config.reasoningEffort, 'high', 'the effort layer is independent of the routing layer');
    await dispatch(host.ctx, config, TASK_DEEP);
    assert.equal(physical.calls[0].reasoningEffort, 'high');

    assert.equal(host.ctx.llm.listProviders().some((provider) => provider.id === 'reflex'), false);
    assert.equal(
      host.runtime.ledger.getEntries().filter((entry) => entry.type === 'model-route').length,
      0,
      'no pool, no routing decision'
    );
    assert.equal(host.runtime.ledger.getEntries().filter((entry) => entry.type === 'effort-decision').length, 1);
  } finally {
    await host.dispose();
  }
});

test('the configured marker decides a request that carries none', async () => {
  const host = await createReflexHost({
    backend: 'mock',
    routing: { ...POOLS, enabled: false },
    effort: { reasoningEffort: 'reflex' }
  });
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-config' });

    const config = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      config: { provider: 'reflex', model: 'reflex-auto' }
    });

    assert.equal(
      host.ctx.llm.listProviders().some((provider) => provider.id === 'reflex'),
      false,
      'routing.enabled=false still registers nothing'
    );
    assert.equal(config.provider, 'reflex', 'the request is not rerouted');
    assert.equal(config.reasoningEffort, 'high', 'but the deployment marker still decides the effort');
    assert.equal(host.runtime.ledger.getEntries()[0]?.type, 'effort-decision');
    assert.equal(host.runtime.ledger.getEntries()[0]?.details?.trigger, 'config');
  } finally {
    await host.dispose();
  }
});

test('an aborted request spends no decision and writes no record', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const controller = new AbortController();
    controller.abort();
    const { agent, session } = agentWithSession('session-aborted');

    const config = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      signal: controller.signal,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });

    assert.deepEqual(config, { provider: 'reflex', model: 'reflex-auto', reasoningEffort: 'reflex' });
    assert.equal(host.runtime.ledger.getEntries().length, 0, 'a cancelled request must not spend System 1');
    assert.deepEqual(effortRecordsOf(session.ownEvents()), []);
  } finally {
    await host.dispose();
  }
});

test('a deployment with no adaptive policy leaves a bare request byte-identical', async () => {
  // No `effort` block at all: the plugin must behave exactly as if this feature
  // were not installed. A physical target keeps routing out of the comparison.
  const host = await createReflexHost({ backend: 'mock' });
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const seen: ReflexEffortStatus[] = [];
    host.ctx.on('reflex/effort', (status) => seen.push(status));
    const { agent, session } = agentWithSession('session-unset');
    const original: LlmCallConfig = { provider: 'deepseek', model: 'reasoner' };

    const config = await dispatchAgentRequest(host.ctx, agent, { task: TASK_DEEP, config: original });

    assert.deepEqual(config, original, 'a request that named no effort must come back unchanged');
    assert.equal('reasoningEffort' in config, false, 'the plugin must not invent an effort');
    assert.equal(
      host.runtime.ledger.getEntries().filter((entry) => entry.type === 'effort-decision').length,
      0,
      'no adaptive decision may be taken without a configured policy'
    );
    assert.deepEqual(effortRecordsOf(session.ownEvents()), [], 'no audit record may be written');
    assert.equal(seen.length, 0, 'no effort status may be published');
    assert.equal(host.runtime.effortStatus('session-unset'), undefined, 'the status feed must stay empty');
  } finally {
    await host.dispose();
  }
});

test('selecting High or default on a physical model passes through untouched without adjusting effort or emitting events', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'antigravity', {
      models: ['gemini-3.8-flash'],
      reasoningEfforts: ['low', 'medium', 'high']
    });
    const seen: ReflexEffortStatus[] = [];
    host.ctx.on('reflex/effort', (status) => {
      seen.push(status);
    });
    const agent = fakeAgent({ id: 'session-explicit-high' });

    // Explicit 'high' effort: must NOT be adapted by reflex, must stay 'high', zero events emitted
    const highConfig = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_TRIVIAL,
      config: { provider: 'antigravity', model: 'gemini-3.8-flash', reasoningEffort: effort('high') }
    });
    assert.equal(highConfig.provider, 'antigravity');
    assert.equal(highConfig.reasoningEffort, 'high', 'explicit High remains High and is never overridden');
    assert.equal(seen.length, 0, 'no reflex effort status emitted for explicit High');

    // Provider default (undefined): must NOT be adapted, zero events emitted
    const defaultConfig = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_TRIVIAL,
      config: { provider: 'antigravity', model: 'gemini-3.8-flash' }
    });
    assert.equal(defaultConfig.provider, 'antigravity');
    assert.equal(defaultConfig.reasoningEffort, undefined, 'provider default remains untouched');
    assert.equal(seen.length, 0, 'no reflex effort status emitted for provider default');
  } finally {
    await host.dispose();
  }
});

test('a multi-step turn with reflex effort only decides and records once on step 1, reusing effort on later steps with 0ms and no duplicate events', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const seen: ReflexEffortStatus[] = [];
    host.ctx.on('reflex/effort', (status) => {
      seen.push(status);
    });
    const agent = fakeAgent({ id: 'session-multistep' });

    // Step 1: user task arrives, reflex decides effort for turn 1
    const step1 = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      turn: 1,
      step: 1,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    assert.equal(step1.reasoningEffort, 'high');
    assert.equal(seen.length, 1, 'step 1 produces exactly 1 effort event for the turn');
    assert.equal(seen[0].turn, 1);
    assert.equal(seen[0].step, 1);

    // Step 2 (tool call continuation): no new user message in turn 1
    const step2 = await dispatchAgentRequest(host.ctx, agent, {
      turn: 1,
      step: 2,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    assert.equal(step2.reasoningEffort, 'high', 'step 2 reuses step 1 effort');
    assert.equal(seen.length, 1, 'step 2 does NOT emit duplicate effort event');

    // Step 3 (tool call continuation): no new user message in turn 1
    const step3 = await dispatchAgentRequest(host.ctx, agent, {
      turn: 1,
      step: 3,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    assert.equal(step3.reasoningEffort, 'high', 'step 3 reuses step 1 effort');
    assert.equal(seen.length, 1, 'step 3 does NOT emit duplicate effort event');
  } finally {
    await host.dispose();
  }
});

test('unloading the plugin detaches the interception and forgets the status', async () => {
  const ctx = await createToolContext();
  try {
    const runtime = applyReflex(ctx, ADAPTIVE);
    registerPhysicalAdapter(ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-unload' });

    const decided = await dispatchAgentRequest(ctx, agent, {
      task: TASK_DEEP,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    assert.equal(decided.reasoningEffort, 'high');
    assert.ok(runtime.effortStatusLine('session-unload'));

    await ctx.fiber.dispose();
    assert.equal(runtime.disposed, true);
    assert.equal(runtime.effortStatusLine('session-unload'), undefined, 'a disposed activation publishes nothing');

    const after = await dispatchAgentRequest(ctx, agent, {
      task: TASK_DEEP,
      config: { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('reflex') }
    });
    assert.equal(after.reasoningEffort, 'reflex', 'with the plugin unloaded nothing rewrites the effort any more');
  } finally {
    await ctx.fiber.dispose();
  }
});
