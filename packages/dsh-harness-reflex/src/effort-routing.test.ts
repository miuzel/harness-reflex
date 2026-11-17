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
/** An ordinary instruction, used as the "new task" baseline of the g-053 tests. */
const TASK_INSTRUCTION = 'implement the config endpoint';

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
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
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
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('auto') }
    });
    await dispatch(host.ctx, config, TASK_DEEP);

    assert.equal(config.reasoningEffort, 'high');
    assert.equal(physical.calls[0].reasoningEffort, 'high');
    assert.equal(host.runtime.ledger.getEntries().filter((entry) => entry.type === 'effort-decision').length, 1);
  } finally {
    await host.dispose();
  }
});

test('each turn of one agent gets its own decision, with the previous one as its prior', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', { models: ['reasoner'], reasoningEfforts: ['off', 'low', 'high'] });
    const agent = fakeAgent({ id: 'session-turns' });

    const deep = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      turn: 1,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    const trivial = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_TRIVIAL,
      turn: 2,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });

    assert.equal(deep.reasoningEffort, 'high', 'a hard turn buys thinking');
    // g-063: turn 2 is no longer graded as if it were turn 1 of a fresh session.
    // It is graded with turn 1's text and turn 1's level in front of it, and
    // "thanks" after a design task keeps the depth the session is working at —
    // the exact complaint the change is for ("thanks" is not a smaller task, the
    // session it closes is a hard one).
    assert.equal(trivial.reasoningEffort, 'high', 'a short turn continues the depth of the session it belongs to');
    assert.equal(host.runtime.effortStatus('session-turns')?.level, 'high', 'the status follows the latest turn');

    // What changed is the *evidence*, and the ledger has to show it: turn 2 saw
    // turn 1's text and the level turn 1 settled on.
    const entries = decisionsOf(host, 'session-turns');
    assert.equal(entries.length, 2);
    assert.equal(entries[1].details?.contextTurns, 1, 'turn 2 was graded with turn 1 in front of it');
    assert.equal(entries[1].details?.previousLevel, 'high', 'turn 2 was told the level turn 1 produced');
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
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('high') }
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
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
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
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
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
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });

    assert.equal(seen.length, 1, 'one event per decided turn');
    assert.equal(seen[0].agentId, 'session-status');
    assert.equal(host.runtime.effortStatusLine('session-status'), seen[0].line);
    assert.match(seen[0].line, /^reflex effort: high → high \(system-one \d\.\d\d, \d+ms\) deepseek:reasoner$/);
    assert.equal(host.runtime.effortStatus()?.line, seen[0].line, 'the newest status of any agent is readable');

    stop();
    await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_TRIVIAL,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
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
      selection: { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('reflex') }
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
      selection: { provider: 'reflex', model: 'reflex-auto' }
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
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
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

    const config = await dispatchAgentRequest(host.ctx, agent, { task: TASK_DEEP, selection: original });

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
      selection: { provider: 'antigravity', model: 'gemini-3.8-flash', reasoningEffort: effort('high') }
    });
    assert.equal(highConfig.provider, 'antigravity');
    assert.equal(highConfig.reasoningEffort, 'high', 'explicit High remains High and is never overridden');
    assert.equal(seen.length, 0, 'no reflex effort status emitted for explicit High');

    // Provider default (undefined): must NOT be adapted, zero events emitted
    const defaultConfig = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_TRIVIAL,
      selection: { provider: 'antigravity', model: 'gemini-3.8-flash' }
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
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    assert.equal(step1.reasoningEffort, 'high');
    assert.equal(seen.length, 1, 'step 1 produces exactly 1 effort event for the turn');
    assert.equal(seen[0].turn, 1);
    assert.equal(seen[0].step, 1);

    // Step 2 (tool call continuation): no new user message in turn 1
    const step2 = await dispatchAgentRequest(host.ctx, agent, {
      turn: 1,
      step: 2,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    assert.equal(step2.reasoningEffort, 'high', 'step 2 reuses step 1 effort');
    assert.equal(seen.length, 1, 'step 2 does NOT emit duplicate effort event');

    // Step 3 (tool call continuation): no new user message in turn 1
    const step3 = await dispatchAgentRequest(host.ctx, agent, {
      turn: 1,
      step: 3,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
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
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    assert.equal(decided.reasoningEffort, 'high');
    assert.ok(runtime.effortStatusLine('session-unload'));

    await ctx.fiber.dispose();
    assert.equal(runtime.disposed, true);
    assert.equal(runtime.effortStatusLine('session-unload'), undefined, 'a disposed activation publishes nothing');

    const after = await dispatchAgentRequest(ctx, agent, {
      task: TASK_DEEP,
      selection: { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('reflex') }
    });
    assert.equal(after.reasoningEffort, 'reflex', 'with the plugin unloaded nothing rewrites the effort any more');
  } finally {
    await ctx.fiber.dispose();
  }
});

// ---------------------------------------------------------------------------
// g-053: "deep turn, then 继续" through the real waterfall
// ---------------------------------------------------------------------------

/** Read the `effort-decision` entries for one agent, oldest first. */
function decisionsOf(host: { runtime: { ledger: { getEntries(): Array<Record<string, any>> } } }, agentId: string) {
  return host.runtime.ledger
    .getEntries()
    .filter((entry) => entry.type === 'effort-decision' && entry.details?.agentId === agentId);
}

/**
 * Count System One calls the way the effort layer makes them.
 *
 * The local mock backend is pure computation with no telemetry of its own, so the
 * seam is its `choice` method — the one place `EffortInterceptor` dispatches
 * through (`bridge.ts`: `decide: (request) => this.backend.choice(request)`).
 * Counting it, rather than a ledger entry, is what distinguishes "System 1 was
 * asked again and happened to answer the same" from "System 1 was never asked".
 *
 * @param host - the activation under test, which must be running `backend: 'mock'`.
 * @returns the running count, read on every call.
 */
function countSystemOneCalls(host: { runtime: { backend: { name: string; choice?: unknown } } }): () => number {
  const backend = host.runtime.backend as { name: string; choice: (...args: never[]) => unknown };
  assert.equal(backend.name, 'mock-heuristic-v1', 'the counter instruments the local mock backend');
  const original = backend.choice;
  let calls = 0;
  backend.choice = function patched(this: unknown, ...args: never[]): unknown {
    calls++;
    return original.apply(this, args);
  };
  return () => calls;
}

test('a continuation reply after a deep turn keeps the deep level and audits the context it used', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-continue' });

    const deep = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      turn: 1,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    assert.equal(deep.reasoningEffort, 'high');

    const continued = await dispatchAgentRequest(host.ctx, agent, {
      task: '继续',
      turn: 2,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    assert.notEqual(continued.reasoningEffort, 'off', 'the reply no longer collapses to off');
    assert.equal(continued.reasoningEffort, 'high', 'it follows the work being continued');

    const entries = decisionsOf(host, 'session-continue');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].details?.level, 'high');
    assert.equal(entries[0].details?.contextChars, undefined, 'the deep turn borrowed no context');
    assert.equal(entries[1].details?.level, 'high');
    assert.equal(entries[1].details?.contextChars, TASK_DEEP.length, 'the ledger shows the context actually used');
    assert.equal(entries[1].details?.contextTurns, 1);
  } finally {
    await host.dispose();
  }
});

test('a session whose first turn is a continuation borrows nothing', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-cold-continue' });

    await dispatchAgentRequest(host.ctx, agent, {
      task: '继续',
      turn: 1,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });

    const [entry] = decisionsOf(host, 'session-cold-continue');
    assert.equal(entry.details?.contextChars, undefined, 'no history is invented for a cold session');
    assert.equal(entry.details?.contextTurns, undefined);
  } finally {
    await host.dispose();
  }
});

test('a new instruction is graded with the earlier turns too (g-063)', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const withHistory = fakeAgent({ id: 'session-new-instruction' });
    const coldSession = fakeAgent({ id: 'session-cold-instruction' });

    const request = (agent: Agent, turn: number, task: string) =>
      dispatchAgentRequest(host.ctx, agent, {
        task,
        turn,
        selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
      });

    await request(withHistory, 1, TASK_DEEP);
    await request(withHistory, 2, TASK_INSTRUCTION);
    // The same task as the first turn of a session — what used to be the answer
    // this turn had to match. g-063 deliberately breaks that equivalence: a new
    // instruction inside a hard session is not the same turn as a cold one.
    const cold = await request(coldSession, 1, TASK_INSTRUCTION);
    assert.equal(cold.reasoningEffort, 'low', 'graded alone, a small instruction asks for little');

    const entries = decisionsOf(host, 'session-new-instruction');
    assert.equal(
      entries[1].details?.contextTurns,
      1,
      'the new instruction was graded with the earlier turn in front of it'
    );
    assert.equal(entries[1].details?.contextChars, TASK_DEEP.length, 'and the ledger shows how much text that was');
    assert.equal(entries[1].details?.previousLevel, 'high', 'and the level the previous turn produced');
  } finally {
    await host.dispose();
  }
});

test('a repeated continuation keeps one fixed context window instead of growing', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-repeat-continue' });

    await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      turn: 1,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    for (const turn of [2, 3, 4]) {
      await dispatchAgentRequest(host.ctx, agent, {
        task: '继续',
        turn,
        selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
      });
    }

    const entries = decisionsOf(host, 'session-repeat-continue');
    assert.equal(entries.length, 4);
    const sizes = entries.slice(1).map((entry) => entry.details?.contextChars);
    assert.deepEqual(sizes, [TASK_DEEP.length, TASK_DEEP.length, TASK_DEEP.length], 'the window does not grow with each reply');
  } finally {
    await host.dispose();
  }
});

test('a later step that carries text still reuses its turn decision (g-063)', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-steps-with-text' });

    // Turn 1, step 1 carries the instruction; the turn is decided here.
    const step1 = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      turn: 1,
      step: 1,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    assert.equal(step1.reasoningEffort, 'high');

    // Turn 1, step 2 arrives *with* text — the shape `agent/pre-step` reports
    // whenever a step is re-proposed with the same user message still in hand.
    // It used to re-ask System 1 (`stepHasText !== true` gated the reuse), buying
    // a second, possibly different, answer for a turn already decided. A turn is
    // the unit the user asked about; every later step of it replays the decision.
    const step2 = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      turn: 1,
      step: 2,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    assert.equal(step2.reasoningEffort, step1.reasoningEffort, 'the same turn keeps the level it decided');
    assert.equal(
      decisionsOf(host, 'session-steps-with-text').length,
      1,
      'one decision per turn, whether or not its later steps carry text'
    );

    // A different turn is still decided on its own: the reuse is same-turn only.
    const nextTurn = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_INSTRUCTION,
      turn: 2,
      step: 1,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    assert.equal(decisionsOf(host, 'session-steps-with-text').length, 2, 'a new turn is decided again');
    // ...with the previous turn as its prior, which the audit records.
    const entries = decisionsOf(host, 'session-steps-with-text');
    assert.equal(entries[1].details?.previousLevel, step1.reasoningEffort);
    assert.equal(nextTurn.reasoningEffort, 'high', 'and it is graded with that prior in front of it');
  } finally {
    await host.dispose();
  }
});

test('a later step of the continuation turn reuses its decision and re-asks nothing', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-continue-steps' });

    await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      turn: 1,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    const firstStep = await dispatchAgentRequest(host.ctx, agent, {
      task: '继续',
      turn: 2,
      step: 1,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    const laterStep = await dispatchAgentRequest(host.ctx, agent, {
      turn: 2,
      step: 2,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });

    assert.equal(laterStep.reasoningEffort, firstStep.reasoningEffort, 'the turn keeps its decided level');
    assert.equal(
      decisionsOf(host, 'session-continue-steps').length,
      2,
      'one decision per turn: the continuation turn is decided once and reused by its later steps'
    );
  } finally {
    await host.dispose();
  }
});

// ---------------------------------------------------------------------------
// g-063: the turn is the unit of decision — a later step carrying new user text
// is still the same turn and still reuses the turn's decision.
// ---------------------------------------------------------------------------

test('a later step of the same turn reuses the decision even when it carries user text', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-same-turn-text' });
    const systemOneCalls = countSystemOneCalls(host);

    const firstStep = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      turn: 7,
      step: 1,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    assert.equal(systemOneCalls(), 1, 'the turn decides once, on its first step');

    // The step that used to break the reuse: a real user instruction, not an
    // empty continuation. Under g-063 its text is part of the same turn.
    const laterStep = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_INSTRUCTION,
      turn: 7,
      step: 2,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });

    assert.equal(systemOneCalls(), 1, 'System 1 is not asked a second time inside the turn');
    assert.equal(laterStep.reasoningEffort, firstStep.reasoningEffort, 'the later step keeps the turn level');
    const entries = decisionsOf(host, 'session-same-turn-text');
    assert.equal(entries.length, 1, 'one effort ledger entry for the whole turn');
    assert.equal(entries[0].details?.turn, 7, 'and it is the turn’s first step that recorded it');
  } finally {
    await host.dispose();
  }
});

test('a new turn decides again, so the same-turn reuse is not "never re-decide"', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-new-turn-decides' });
    const systemOneCalls = countSystemOneCalls(host);

    const request = (turn: number, step: number, task: string) =>
      dispatchAgentRequest(host.ctx, agent, {
        task,
        turn,
        step,
        selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
      });

    const firstStep = await request(7, 1, TASK_DEEP);
    assert.equal(systemOneCalls(), 1);

    // Negative control: identical messages, identical step, only the turn moved.
    const nextTurn = await request(8, 1, TASK_DEEP);

    assert.equal(systemOneCalls(), 2, 'a new turn asks System 1 again');
    assert.equal(
      decisionsOf(host, 'session-new-turn-decides').length,
      2,
      'and records a decision of its own instead of replaying the earlier turn'
    );
    assert.equal(nextTurn.reasoningEffort, firstStep.reasoningEffort, 'the same task still lands on the same level');
  } finally {
    await host.dispose();
  }
});

// ---------------------------------------------------------------------------
// g-063 part B: the previous level is *in the text System 1 is sent*, through
// the real waterfall — not merely a field carried alongside it.
// ---------------------------------------------------------------------------

/**
 * Capture the `ChoiceRequest` objects the mounted plugin really builds.
 *
 * The unit tests assert on the `decide` seam, which proves the composer produced
 * the prefix; this one takes the request object at the last edge before the
 * backend and asserts on `question`/`context` as the backend would see them, so
 * a prefix that was composed and then dropped on the way cannot pass.
 *
 * @param host - the activation under test, running `backend: 'mock'`.
 * @returns the captured requests, in dispatch order.
 */
function captureSystemOneRequests(host: { runtime: { backend: { choice: (...args: never[]) => unknown } } }): Array<{
  question?: string;
  context?: string;
}> {
  const backend = host.runtime.backend as { choice: (...args: never[]) => unknown };
  const sent: Array<{ question?: string; context?: string }> = [];
  const original = backend.choice;
  backend.choice = function patched(this: unknown, request: { question?: string; context?: string }): unknown {
    sent.push({ question: request.question, context: request.context });
    return original.call(this, request as never);
  };
  return sent;
}

test('the previous level is inside the text System 1 is sent, across the real waterfall', async () => {
  const host = await createReflexHost(ADAPTIVE);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'session-prior-in-prompt' });
    const sent = captureSystemOneRequests(host);

    // Turn 1: a deep task, decided on its own text — no prior exists yet.
    const deep = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      turn: 1,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    assert.equal(sent.length, 1);
    assert.doesNotMatch(String(sent[0]!.question), /previous level/u, 'the first decision has no prior to be told about');

    // Turn 2: a bare "继续". The level turn 1 produced must be in the question.
    await dispatchAgentRequest(host.ctx, agent, {
      task: '继续',
      turn: 2,
      selection: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });
    assert.equal(sent.length, 2);
    const question = String(sent[1]!.question);
    assert.equal(deep.reasoningEffort, 'high', 'turn 1 landed on high, so that is the prior turn 2 must see');
    assert.ok(
      question.startsWith('[previous level: high]'),
      `the prior is not in the question the backend is asked: ${question}`
    );
    assert.ok(question.includes(TASK_DEEP), 'the work being continued is in the question too');
    assert.match(String(sent[1]!.context), /\[previous level: …\]/u, 'and the prompt explains that the line is a hint, not the answer');
  } finally {
    await host.dispose();
  }
});
