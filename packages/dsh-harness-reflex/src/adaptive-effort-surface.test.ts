import assert from 'node:assert/strict';
import test from 'node:test';

import type { GenerateOptions, LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm';
import { Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session';

import type { ReflexConfig } from './config.js';
import {
  createReflexHost,
  createToolContext,
  registerPhysicalAdapter,
  userMessage,
  type ReflexTestHost
} from './testing.js';

/**
 * Integration coverage of the S4 model-selector surface.
 *
 * `installAdaptiveEffortSurface` wraps three methods of the *real* `LlmRuntime`
 * so the Host-built selector offers "Reflex (Auto)" and the selection round trip
 * through `resolveCallConfig` carries the marker. Everything asserted here is
 * observed at a production seam — the resolved model info, the resolved call
 * config, the prepared call, and the physical dispatch — never at a private
 * field of the surface.
 */

const TASK_DEEP = 'design the migration protocol for the distributed store';

/** Reasoning vocabulary of the fake physical DeepSeek-ish route. */
const THINKING = { models: ['reasoner'], reasoningEfforts: ['off', 'low', 'high', 'max'], defaultEffort: 'low' };

/** One non-thinking physical route, the model a selector must offer nothing for. */
const PLAIN = { models: ['basic'] };

/**
 * Pool used where the test must prove that a *concrete* route is left alone even
 * though a virtual route is registered on the same runtime.
 */
const POOLS: ReflexConfig['routing'] = {
  models: { 'reflex-auto': [{ provider: 'deepseek', model: 'reasoner', description: 'hard reasoning math' }] }
};

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
 * Emit the session event the model selector emits when the user picks a route or
 * an effort. This is the only public way a test can move the surface's mode.
 * @param host - the booted host.
 * @param session - a real Session, as the event contract requires.
 * @param data - the selection payload.
 */
function select(
  host: ReflexTestHost,
  session: Session,
  data: { provider: string; model: string; reasoningEffort?: string }
): void {
  host.ctx.emit('session/event', session, { type: 'model/selection', data } as unknown as SessionEvent);
}

/** A real session, so the typed `session/event` contract is satisfied. */
function sessionNamed(id: string): Session {
  return Session.create(id as unknown as SessionId);
}

/** Reason the last chunk of a stream reports, or `undefined` for an empty stream. */
function finishKind(chunks: readonly StreamChunk[]): string | undefined {
  const last = chunks.at(-1) as { type?: string; reason?: { kind?: string; failure?: { code?: string } } } | undefined;
  return last?.reason?.kind;
}

/** Provider ids currently registered on the runtime. */
function providerIds(host: ReflexTestHost): string[] {
  return host.ctx.llm.listProviders().map((provider) => provider.id);
}

test('a thinking route offers Reflex (Auto) first and keeps its own efforts and default', async () => {
  const host = await createReflexHost({ backend: 'mock' });
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);

    const info = await host.ctx.llm.resolveModelInfo('deepseek', 'reasoner');
    const reasoning = info.reasoning;
    assert.ok(reasoning, 'a route that declares reasoning efforts must resolve with reasoning metadata');

    const ids = reasoning.efforts.map((entry) => String(entry.id));
    assert.equal(ids[0], 'reflex', `the adaptive marker must lead the effort list (got ${ids.join(', ')})`);
    assert.equal(reasoning.efforts[0]?.name, 'Reflex (Auto)', 'the leading choice is the labelled adaptive mode');
    for (const level of ['off', 'low', 'high', 'max']) {
      assert.ok(ids.includes(level), `the model's own effort "${level}" must survive the wrap`);
    }
    assert.equal(
      reasoning.defaultEffort,
      'low',
      'the declared default belongs to the adapter and must not be rewritten to the marker'
    );
  } finally {
    await host.dispose();
  }
});

test('a route that declares no reasoning offers no effort at all', async () => {
  const host = await createReflexHost({ backend: 'mock' });
  try {
    registerPhysicalAdapter(host.ctx, 'plain', PLAIN);

    const info = await host.ctx.llm.resolveModelInfo('plain', 'basic');
    assert.equal(
      info.reasoning,
      undefined,
      'a non-thinking model must not advertise a "Reflex (Auto)" choice that cannot do anything'
    );
  } finally {
    await host.dispose();
  }
});

test('an inactive adaptive surface invents no effort on a resolved call config', async () => {
  const host = await createReflexHost({ backend: 'mock' });
  try {
    // No `defaultEffort`, so the only way `reasoningEffort` can appear is if the
    // surface invents it: the runtime materializes a default only when declared.
    registerPhysicalAdapter(host.ctx, 'deepseek', { models: ['reasoner'], reasoningEfforts: ['low', 'high'] });

    const resolved = await host.ctx.llm.resolveCallConfig({ provider: 'deepseek', model: 'reasoner' });
    assert.equal(
      'reasoningEffort' in resolved,
      false,
      `a caller that named no effort must not be given one (got ${JSON.stringify(resolved.reasoningEffort)})`
    );
    assert.equal(resolved.reasoningEffort, undefined, 'the resolved config carries no effort at all');
  } finally {
    await host.dispose();
  }
});

test('the runtime, not the adaptive surface, materializes a declared default effort', async () => {
  const host = await createReflexHost({ backend: 'mock' });
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);

    // `LlmRuntime.resolveCallWithInfo` copies `reasoning.defaultEffort` into the
    // config when the caller named nothing. That is upstream behaviour, so the
    // "no invented effort" assertion above needs an adapter without a default.
    const resolved = await host.ctx.llm.resolveCallConfig({ provider: 'deepseek', model: 'reasoner' });
    assert.equal(resolved.reasoningEffort, 'low', 'the adapter-declared default is materialized by the runtime itself');
  } finally {
    await host.dispose();
  }
});

test('session selections cannot arm or disarm unrelated physical calls', async () => {
  const host = await createReflexHost({ backend: 'mock', effort: { reasoningEffort: 'reflex' } });
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const sessionA = sessionNamed('surface-A');
    const sessionB = sessionNamed('surface-B');
    for (const marker of ['reflex', 'high', 'auto', undefined]) {
      select(host, sessionA, { provider: 'deepseek', model: 'reasoner', reasoningEffort: marker });
      const implicit = await host.ctx.llm.resolveCallConfig({ provider: 'deepseek', model: 'reasoner' });
      assert.equal(implicit.reasoningEffort, 'low', 'physical provider default is never globally armed');
      select(host, sessionB, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' });
      const explicit = await host.ctx.llm.resolveCallConfig({ provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('reflex') });
      assert.equal(explicit.reasoningEffort, 'reflex', 'another session cannot disarm explicit adaptive intent');
      const pinned = await host.ctx.llm.resolveCallConfig({ provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('high') });
      assert.equal(pinned.reasoningEffort, 'high');
    }
  } finally {
    await host.dispose();
  }
});

test('a concrete physical route is dispatched as selected, with only the effort adapted', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: POOLS, effort: { reasoningEffort: 'reflex' } });
  try {
    const physical = registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    assert.ok(providerIds(host).includes('reflex'), 'this test only means something with the virtual route registered');

    const armed = await host.ctx.llm.resolveCallConfig({ provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('reflex') });
    assert.equal(armed.reasoningEffort, 'reflex', 'explicit physical adaptive intent survives resolution');

    const chunks = await collect(
      host.ctx.llm.stream({
        provider: 'deepseek',
        model: 'reasoner',
        messages: [userMessage(TASK_DEEP)]
      } as unknown as GenerateOptions)
    );
    assert.equal(finishKind(chunks), 'stop', 'a concrete physical dispatch must not fail');
    assert.equal(physical.calls.length, 1, 'exactly one physical dispatch was expected');
    const call = physical.calls[0];
    assert.deepEqual(
      [call?.provider, call?.model],
      ['deepseek', 'reasoner'],
      'a fixed physical route is never re-routed by the adaptive surface'
    );
    assert.notEqual(call?.reasoningEffort, 'reflex', 'the marker is an intent, never an effort a provider sees');

    // The last gate (`prepareCall`) is what turns a surviving marker into a level
    // the adapter declared, so no code path can hand "reflex" to a provider.
    const prepared = await host.ctx.llm.prepareCall({
      ...armed,
      messages: [userMessage(TASK_DEEP)]
    } as unknown as GenerateOptions);
    assert.equal(prepared.config.reasoningEffort, 'low', 'the marker is projected onto a declared level at the last gate');
    const preparedChunks = await collect(prepared.stream(prepared.config as unknown as GenerateOptions));
    assert.equal(finishKind(preparedChunks), 'stop', 'the prepared dispatch must succeed');
    assert.equal(physical.calls[1]?.reasoningEffort, 'low', 'the physical adapter observes the projected level, not the marker');
  } finally {
    await host.dispose();
  }
});

test('a non-thinking route clears the marker instead of rejecting it', async () => {
  const host = await createReflexHost({ backend: 'mock', effort: { reasoningEffort: 'reflex' } });
  try {
    const plain = registerPhysicalAdapter(host.ctx, 'plain', PLAIN);
    const session = sessionNamed('surface-plain');
    select(host, session, { provider: 'plain', model: 'basic', reasoningEffort: 'reflex' });

    const resolved = await host.ctx.llm.resolveCallConfig({
      provider: 'plain',
      model: 'basic',
      reasoningEffort: effort('reflex')
    });
    assert.equal(
      resolved.reasoningEffort,
      undefined,
      'a model that cannot think has no adaptive mode: the marker is dropped, not forwarded'
    );

    const prepared = await host.ctx.llm.prepareCall({
      provider: 'plain',
      model: 'basic',
      reasoningEffort: effort('reflex'),
      messages: [userMessage('thanks')]
    } as unknown as GenerateOptions);
    assert.equal(
      'reasoningEffort' in prepared.config,
      false,
      'the last gate deletes the marker for a route that declares no reasoning'
    );

    const chunks = await collect(
      host.ctx.llm.stream({
        provider: 'plain',
        model: 'basic',
        messages: [userMessage('thanks')]
      } as unknown as GenerateOptions)
    );
    assert.equal(finishKind(chunks), 'stop', 'a non-thinking route must finish, not stream an UNSUPPORTED_REASONING_EFFORT failure');
    assert.equal(plain.calls.length, 1, 'the plain adapter was reached exactly once');
    assert.equal(plain.calls[0]?.reasoningEffort, undefined, 'no reasoning key is invented for a model that has none');

    // Positive control: without the surface the very same call rejects, which is
    // what the guard above exists to prevent.
    const bare = await createToolContext();
    try {
      registerPhysicalAdapter(bare, 'plain', PLAIN);
      await assert.rejects(
        () => bare.llm.resolveCallConfig({ provider: 'plain', model: 'basic', reasoningEffort: effort('reflex') }),
        (error: unknown) => (error as { code?: string }).code === 'UNSUPPORTED_REASONING_EFFORT',
        'the raw runtime rejects an unknown effort, so clearing it is a real guard'
      );
    } finally {
      await bare.fiber.dispose();
    }
  } finally {
    await host.dispose();
  }
});
