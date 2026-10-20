import assert from 'node:assert/strict';
import test from 'node:test';

import type { GenerateOptions, LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm';
import { Session, type SessionId } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';

import { effortRecordsOf } from './index.js';
import type { ReflexConfig } from './config.js';
import type { ReflexEffortStatus } from './effort.js';
import {
  createReflexHost,
  dispatchAgentRequest,
  fakeAgent,
  registerPhysicalAdapter,
  userMessage
} from './testing.js';

/**
 * Integration coverage of the `effort.enabled` switch.
 *
 * The switch promises three things, and each one is asserted at a production
 * seam rather than at a private field: no adaptive judgment is taken (no ledger
 * entry, no status event, no session audit record), the plugin's own effort
 * option is revoked (the model selector stops offering it), and the marker is
 * never leaked — it is cleared so the provider's own default applies.
 */

const TASK_DEEP = 'design the migration protocol for the distributed store';

/** One virtual model over one physical target, so the route is deterministic. */
const POOLS: ReflexConfig['routing'] = {
  models: {
    'reflex-auto': [{ provider: 'deepseek', model: 'reasoner', description: 'hard reasoning math' }]
  }
};

/** Reasoning vocabulary of the fake physical route used below. */
const THINKING = { models: ['reasoner'], reasoningEfforts: ['low', 'high'], defaultEffort: 'low' };

/** The deployment under test: the marker is configured, the layer is off. */
const OFF: ReflexConfig = {
  backend: 'mock',
  routing: POOLS,
  effort: { reasoningEffort: 'reflex', enabled: false }
};

/** The same deployment with the switch left at its default. */
const ON: ReflexConfig = { backend: 'mock', routing: POOLS, effort: { reasoningEffort: 'reflex' } };

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
 * Reason the last chunk of a stream reports.
 * @param chunks - the drained stream.
 * @returns the finish kind, or `undefined` for an empty stream.
 */
function finishKind(chunks: readonly StreamChunk[]): string | undefined {
  const last = chunks.at(-1) as { type?: string; reason?: { kind?: string } } | undefined;
  return last?.reason?.kind;
}

/**
 * An agent whose session is a real Session, so the audit record can be read back.
 * @param id - session id.
 * @returns the agent and its session.
 */
function agentWithSession(id: string): { agent: Agent; session: Session } {
  const session = Session.create(id as unknown as SessionId);
  const agent = { ...fakeAgent({ id }), session } as unknown as Agent;
  return { agent, session };
}

test('a switched-off deployment takes no decision at all', async () => {
  const host = await createReflexHost(OFF);
  try {
    const physical = registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const published: ReflexEffortStatus[] = [];
    host.ctx.on('reflex/effort', (status: ReflexEffortStatus) => published.push(status));
    const { agent, session } = agentWithSession('switch-off');

    const config = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      turn: 3,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });

    assert.equal(config.provider, 'deepseek', 'routing still happens; only the effort layer is off');
    assert.equal(config.reasoningEffort, undefined, 'the configured marker is not turned into a decision');
    assert.equal(physical.calls.length, 0, 'nothing was dispatched yet');

    // The three audit seams of a decision, all silent.
    assert.deepEqual(published, [], 'a switched-off layer publishes no effort status');
    assert.equal(host.runtime.effortStatus('switch-off'), undefined, 'no status is remembered for the agent');
    assert.equal(
      host.runtime.ledger.getEntries().filter((entry) => entry.type === 'effort-decision').length,
      0,
      'no effort decision reaches the ledger'
    );
    assert.deepEqual(effortRecordsOf(session.ownEvents()), [], 'no effort audit record is written to the session');

    const chunks = await collect(host.ctx.llm.stream({ ...config, messages: [userMessage(TASK_DEEP)] } as GenerateOptions));
    assert.equal(finishKind(chunks), 'stop', 'the turn completes without an adaptive decision');
    assert.equal(physical.calls.length, 1, 'exactly one physical dispatch was made');
    assert.notEqual(physical.calls[0]?.reasoningEffort, 'reflex', 'the marker never reaches a provider');
  } finally {
    await host.dispose();
  }
});

test('the very same deployment decides once the switch is on', async () => {
  const host = await createReflexHost(ON);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const published: ReflexEffortStatus[] = [];
    host.ctx.on('reflex/effort', (status: ReflexEffortStatus) => published.push(status));
    const { agent, session } = agentWithSession('switch-on');

    const config = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      turn: 3,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('reflex') }
    });

    assert.equal(config.reasoningEffort, 'high', 'the positive control: the same request is decided when enabled');
    assert.equal(published.length, 1, 'the positive control publishes a status, so the silence above is a real observation');
    assert.equal(
      host.runtime.ledger.getEntries().filter((entry) => entry.type === 'effort-decision').length,
      1,
      'the decision is audited exactly when the switch is on'
    );
    assert.equal(effortRecordsOf(session.ownEvents()).length, 1, 'and the decision reaches the session log');
  } finally {
    await host.dispose();
  }
});

test('a switched-off deployment revokes the effort option it injected', async () => {
  const off = await createReflexHost(OFF);
  const on = await createReflexHost(ON);
  try {
    registerPhysicalAdapter(off.ctx, 'deepseek', THINKING);
    registerPhysicalAdapter(on.ctx, 'deepseek', THINKING);

    const offered = await on.ctx.llm.resolveModelInfo('deepseek', 'reasoner');
    const ids = (offered.reasoning?.efforts ?? []).map((entry) => String(entry.id));
    assert.equal(ids[0], 'reflex', 'the positive control offers the adaptive mode first');

    const revoked = await off.ctx.llm.resolveModelInfo('deepseek', 'reasoner');
    const keptIds = (revoked.reasoning?.efforts ?? []).map((entry) => String(entry.id));
    assert.deepEqual(keptIds, ['low', 'high'], `a switched-off host offers no adaptive mode (got ${keptIds.join(', ')})`);
    assert.equal(revoked.reasoning?.defaultEffort, 'low', 'the adapter-declared default is untouched');

    // The same revocation at the call-config seam: an unpinned request on the
    // plugin's own virtual route is no longer armed with the marker.
    const armed = await on.ctx.llm.resolveCallConfig({ provider: 'reflex', model: 'reflex-auto' });
    assert.equal(armed.reasoningEffort, 'reflex', 'the positive control arms the virtual route');
    const disarmed = await off.ctx.llm.resolveCallConfig({ provider: 'reflex', model: 'reflex-auto' });
    assert.equal(disarmed.reasoningEffort, undefined, 'a switched-off host arms nothing');
  } finally {
    await off.dispose();
    await on.dispose();
  }
});

test('a marker that survives to the adapter boundary falls back to the provider default', async () => {
  const host = await createReflexHost(OFF);
  try {
    const physical = registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);

    const resolved = await host.ctx.llm.resolveCallConfig({
      provider: 'deepseek',
      model: 'reasoner',
      reasoningEffort: effort('reflex')
    });
    assert.equal(resolved.reasoningEffort, undefined, 'the marker is stripped instead of accepted');

    // A bypass path (a hand-built call that never met the request waterfall) is
    // covered by the last gate, which deletes the marker rather than projecting
    // it onto a level: with the layer off there is no policy to project *to*.
    const prepared = await host.ctx.llm.prepareCall({
      provider: 'deepseek',
      model: 'reasoner',
      reasoningEffort: effort('reflex'),
      messages: [userMessage(TASK_DEEP)]
    } as unknown as GenerateOptions);
    assert.notEqual(prepared.config.reasoningEffort, 'reflex', 'the last gate deletes the marker');
    assert.equal(
      prepared.config.reasoningEffort,
      'low',
      'what a cleared marker degrades to is the provider default the adapter declared, never a decided level'
    );

    const chunks = await collect(prepared.stream(prepared.config as unknown as GenerateOptions));
    assert.equal(finishKind(chunks), 'stop', 'the prepared dispatch succeeds');
    assert.equal(physical.calls.length, 1, 'the physical adapter was reached exactly once');
    assert.notEqual(physical.calls[0]?.reasoningEffort, 'reflex', 'no path hands the marker to a provider');
    assert.equal(
      physical.calls[0]?.reasoningEffort,
      'low',
      'the provider default the adapter declared is what the marker degrades to'
    );
  } finally {
    await host.dispose();
  }
});

test('a concrete level is passed through untouched while the switch is off', async () => {
  const host = await createReflexHost(OFF);
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'switch-pinned' });

    // `max` is not in the routed model's vocabulary: the aligned level would be
    // `high`. A switched-off layer must not rewrite it either way.
    const config = await dispatchAgentRequest(host.ctx, agent, {
      task: TASK_DEEP,
      config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('max') }
    });
    assert.equal(config.reasoningEffort, 'max', 'a concrete level reaches the adapter exactly as it was written');

    // Positive control: with the layer on, the same level is aligned, not decided.
    const aligned = await createReflexHost(ON);
    try {
      registerPhysicalAdapter(aligned.ctx, 'deepseek', THINKING);
      const kept = await dispatchAgentRequest(aligned.ctx, fakeAgent({ id: 'switch-aligned' }), {
        task: TASK_DEEP,
        config: { provider: 'reflex', model: 'reflex-auto', reasoningEffort: effort('max') }
      });
      assert.equal(
        kept.reasoningEffort,
        'low',
        'the positive control snaps the unsupported level onto the routed vocabulary instead of forwarding it'
      );
      assert.equal(
        aligned.runtime.ledger.getEntries().filter((entry) => entry.type === 'effort-decision').length,
        0,
        'and that alignment is still not a decision'
      );
    } finally {
      await aligned.dispose();
    }
  } finally {
    await host.dispose();
  }
});
