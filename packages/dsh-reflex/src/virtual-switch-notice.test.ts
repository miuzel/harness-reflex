import assert from 'node:assert/strict';
import test from 'node:test';

import { agentEvents } from '@deepseek-ai/dsh-agent';

import type { ReflexConfig } from './config.js';
import { filterVirtualSwitchNotices, isVirtualModelSwitchNotice } from './routing.js';
import { createReflexHost, fakeAgent, userMessage, type ReflexTestHost } from './testing.js';

/**
 * S2 coverage: the pseudo-switch notice the agent loop emits when it reports the
 * virtual route must not be repeated into every later step.
 *
 * The notice is produced *inside* the loop (`installModelSelection` appends it to
 * the pre-step decision), so the only seam that can remove it is an outer
 * `agent/pre-step` wrapper. These tests therefore check both halves:
 *  - the recognizer, on the exact message shape {@link modelSwitchNotice} builds;
 *  - the wrapper, driven through the real waterfall with a producer standing in
 *    for the loop's own selection layer.
 */

const POOLS: ReflexConfig['routing'] = {
  models: {
    'reflex-auto': [{ provider: 'deepseek', model: 'reasoner', description: 'hard reasoning math' }]
  }
};

/**
 * One notice message shaped like the loop's model-switch notice.
 * @param from - the route the session was on.
 * @param to - the route it continues with.
 * @returns the message.
 */
function notice(from: string, to: string): Record<string, unknown> {
  return {
    role: 'user',
    source: { kind: 'model-selection', form: 'notice', summary: `${from} → ${to}` },
    content: [{ type: 'text', text: `[model changed: ${from} → ${to}; the session continues with ${to}]` }]
  };
}

/** Text of one message, however the shape spells it. */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((block) => (typeof block === 'string' ? block : String((block as { text?: unknown })?.text ?? '')))
    .join(' ');
}

/** A pre-step payload with one user task and the loop's notice in front of it. */
function payload(turn: number, step: number, messages: unknown[]): Record<string, unknown> {
  return { turn, step, signal: new AbortController().signal, messages };
}

/**
 * Install a stand-in for the loop's own selection layer: it appends the notice
 * the loop writes when it reports the route the session continues with.
 * @param host - the booted host.
 */
function announceVirtualRoute(host: ReflexTestHost): void {
  host.ctx.on(
    'agent/pre-step',
    (async (step: { messages: unknown[] }, next: () => Promise<unknown>) => {
      const decision = (await next()) as { messages?: unknown[] };
      return {
        ...decision,
        messages: [...(decision.messages ?? step.messages), notice('deepseek-official/deepseek-flash', 'reflex/reflex-auto')]
      };
    }) as never,
    { prepend: true }
  );
}

/**
 * Run one `agent/pre-step` and return the messages the loop would send.
 * @param host - the booted host.
 * @param agent - the requesting agent.
 * @param turn - turn identity.
 * @param step - step identity.
 * @returns the decision's messages.
 */
async function preStep(
  host: ReflexTestHost,
  agent: ReturnType<typeof fakeAgent>,
  turn: number,
  step: number
): Promise<unknown[]> {
  const messages = [userMessage('design the migration protocol')];
  const decision = (await agentEvents(host.ctx, agent).waterfall(
    'agent/pre-step',
    payload(turn, step, messages) as never,
    async () => ({ kind: 'enter' as const, messages })
  )) as { messages: unknown[] };
  return decision.messages;
}

/** How many of these messages carry the given text. */
function countMatching(messages: readonly unknown[], needle: string): number {
  return messages.filter((message) => textOf(message).includes(needle)).length;
}

test('the recognizer accepts the virtual switch and refuses a physical one', () => {
  const virtual = ['reflex-auto'];

  // The summary is the primary carrier: `<from> → <to>`.
  assert.equal(isVirtualModelSwitchNotice(notice('deepseek-official/deepseek-flash', 'reflex/reflex-auto'), 'reflex', virtual), true);
  // A bare virtual model id is enough when the provider prefix is missing.
  assert.equal(isVirtualModelSwitchNotice(notice('deepseek-official/deepseek-flash', 'reflex-auto'), 'reflex', virtual), true);
  // …and a `reflex/…` route that is not a configured pool is still the virtual provider.
  assert.equal(isVirtualModelSwitchNotice(notice('deepseek-official/deepseek-flash', 'reflex/anything'), 'reflex', virtual), true);
  // A notice with no summary falls back to the sentence the loop writes, which
  // arrives as the text block of an ordinary message body.
  assert.equal(
    isVirtualModelSwitchNotice(
      {
        role: 'user',
        source: { kind: 'model-selection', form: 'notice' },
        content: [{ type: 'text', text: '[model changed: x → y; the session continues with reflex/reflex-auto]' }]
      },
      'reflex',
      virtual
    ),
    true
  );

  // A genuine physical switch must survive: suppressing it would hide a real move.
  assert.equal(
    isVirtualModelSwitchNotice(notice('deepseek-official/deepseek-flash', 'deepseek-official/deepseek-reasoner'), 'reflex', virtual),
    false
  );
  // A plain user message is never a notice, even when it quotes the wording.
  assert.equal(
    isVirtualModelSwitchNotice({ role: 'user', content: '[model changed: a → reflex/reflex-auto]' }, 'reflex', virtual),
    false
  );
  // Nor is an unfiltered notice that names nothing this layer owns.
  assert.equal(isVirtualModelSwitchNotice({ role: 'user', source: { kind: 'model-selection', form: 'notice' } }, 'reflex', virtual), false);
  // Only the notice form of that source counts; a user's own selection is not a switch report.
  assert.equal(
    isVirtualModelSwitchNotice(
      { role: 'user', source: { kind: 'model-selection', form: 'selection', summary: 'a → reflex/reflex-auto' } },
      'reflex',
      virtual
    ),
    false
  );
});

test('filtering one decision touches only the pseudo notices and keeps the rest', () => {
  const original = {
    kind: 'enter',
    messages: [
      notice('deepseek-official/deepseek-flash', 'reflex/reflex-auto'),
      notice('deepseek-official/deepseek-flash', 'deepseek-official/deepseek-reasoner'),
      { role: 'user', content: 'do the thing' }
    ]
  };
  const filtered = filterVirtualSwitchNotices(original, 'reflex', ['reflex-auto']);
  assert.notEqual(filtered, original, 'a decision that carried a pseudo notice must be replaced');
  assert.equal(filtered.messages?.length, 2, 'exactly the pseudo notice is dropped');
  assert.ok(
    filtered.messages?.every((message) => !textOf(message).includes('reflex/reflex-auto')),
    'no virtual notice text survives'
  );
  assert.ok(
    filtered.messages?.some((message) => textOf(message).includes('deepseek-reasoner')),
    'the physical switch notice is preserved verbatim'
  );
  assert.equal(original.messages?.length, 3, 'the decision object is never mutated in place');

  // A decision without pseudo notices is returned untouched, identity included:
  // the loop compares decisions, so a needless copy would be a behaviour change.
  const clean = { kind: 'enter', messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(filterVirtualSwitchNotices(clean, 'reflex', ['reflex-auto']), clean);
  assert.equal(filterVirtualSwitchNotices({ kind: 'enter', messages: [] }, 'reflex', ['reflex-auto']).kind, 'enter');
});

test('the installed layer drops the notice from the second step on, and only then', async () => {
  const host = await createReflexHost({
    backend: 'mock',
    routing: POOLS,
    effort: { reasoningEffort: 'reflex' }
  });
  try {
    const agent = fakeAgent({ id: 'session-notice' });
    // The loop hands the plugin the agent's own live context; this is the field
    // `ensureVirtualSwitchFilter` installs on. The test host has no scoped child
    // context to hand over, so it passes the real root context: an untagged
    // listener is admitted for every dispatch, which is the same admission the
    // loop's per-agent context grants for its own agent. Scope isolation itself
    // belongs to the scope carrier upstream, not to this filter.
    const live = agent as unknown as { ctx?: unknown };
    live.ctx = host.ctx;

    // Stand in for the loop's own selection layer, then run the turns.
    announceVirtualRoute(host);

    // Step 1: the wrapper is not installed yet, so the loop's notice is delivered
    // — the reader learns where the request went exactly once per turn.
    const first = await preStep(host, agent, 1, 1);
    assert.equal(
      countMatching(first, 'reflex/reflex-auto'),
      1,
      'the first step of a turn still reports the virtual route'
    );

    // Step 2: the same notice would repeat on every remaining step of the turn.
    const second = await preStep(host, agent, 1, 2);
    assert.equal(countMatching(second, 'reflex/reflex-auto'), 0, 'a later step must not repeat the pseudo-switch notice');
    assert.equal(second.length, 1, 'the turn task itself survives the filter');

    // The wrapper is installed for good once the first step ran, so every later
    // step is covered — including the opening step of the next turn. Nothing is
    // lost by that: the loop appends this notice only when it believes the route
    // changed, and a real turn's opening step carries no notice at all.
    const secondTurn = await preStep(host, agent, 2, 1);
    assert.equal(
      countMatching(secondTurn, 'reflex/reflex-auto'),
      0,
      'every step after installation is covered, and no turn needs the false notice'
    );
    assert.equal(secondTurn.length, 1, 'the new turn task survives');

    // A *physical* switch is still announced on later steps: the filter is
    // specific to the virtual route, not a blanket silence.
    host.ctx.on(
      'agent/pre-step',
      (async (payloadIn: { messages: unknown[] }, next: () => Promise<unknown>) => {
        const decision = (await next()) as { messages?: unknown[] };
        return {
          ...decision,
          messages: [
            ...(decision.messages ?? payloadIn.messages),
            notice('deepseek-official/deepseek-flash', 'deepseek-official/deepseek-reasoner')
          ]
        };
      }) as never,
      { prepend: true }
    );
    const third = await preStep(host, agent, 2, 2);
    assert.equal(
      countMatching(third, 'deepseek-reasoner'),
      1,
      'a genuine physical switch notice must not be filtered away'
    );
    assert.equal(countMatching(third, 'reflex/reflex-auto'), 0, 'the virtual notice stays suppressed alongside it');
  } finally {
    await host.dispose();
  }
});

test('an agent the loop never gave a context is left alone rather than broken', async () => {
  const host = await createReflexHost({ backend: 'mock', routing: POOLS, effort: { reasoningEffort: 'reflex' } });
  try {
    // No `ctx` field at all: the installer must decline to wrap and the step
    // must still complete, notice included. A routing layer that threw here
    // would break every step of a host whose agents carry no context.
    announceVirtualRoute(host);
    const messages = await preStep(host, fakeAgent({ id: 'session-contextless' }), 1, 1);
    assert.equal(messages.length, 2, 'the notice passes through untouched and the task survives');
    assert.equal(countMatching(messages, 'reflex/reflex-auto'), 1, 'nothing was filtered without a context to wrap');
  } finally {
    await host.dispose();
  }
});
