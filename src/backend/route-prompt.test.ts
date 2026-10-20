import assert from 'node:assert/strict';
import test from 'node:test';

import { JevDecisionBackend } from './jev.js';
import { LogitsSystemOneBackend } from './simple-jev.js';
import {
  CURRENT_MODEL_MARK,
  buildRouteContext,
  renderCandidateLine,
  renderRouteStateLines
} from './route-prompt.js';
import type { RouteRequest } from './types.js';

/**
 * The cache-affinity facts of a routing decision are part of the decision
 * *prompt*. These tests observe the two prompt-building backends at the network
 * seam (`fetch`) and the shared renderer directly, so what the model reads is
 * pinned without a live endpoint.
 */

/** Swap in a scripted `fetch` for the duration of one test. */
function stubFetch(reply: (url: string, body: any) => unknown): { calls: Array<{ url: string; body: any }>; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: string | URL, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as any;
    calls.push({ url: String(url), body });
    return { ok: true, status: 200, statusText: 'OK', json: async () => reply(String(url), body) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** One route request with the session facts a warm session supplies. */
const REQUEST: RouteRequest = {
  goal: 'carry on with the migration plan',
  candidates: [
    { name: 'deepseek:chat', description: 'fast general chat', current: true },
    { name: 'deepseek:reasoner', description: 'hard reasoning math' }
  ],
  topK: 2,
  state: { currentModel: 'deepseek:chat', contextTokens: 2500, contextChars: 10000 },
  instructions: 'Prompt-cache affinity: keep the current model unless clearly outmatched.'
};

test('a request without affinity renders exactly the historical context block', () => {
  const context = buildRouteContext({
    goal: 'g',
    candidates: [
      { name: 'a:one', description: 'first' },
      { name: 'b:two', description: '' }
    ]
  });
  assert.equal(context, 'a:one: first\nb:two: ');
  assert.deepEqual(renderRouteStateLines(undefined, undefined), []);
});

test('the incumbent candidate is marked and the session facts are rendered', () => {
  const context = buildRouteContext(REQUEST);
  assert.ok(context.includes(`${CURRENT_MODEL_MARK}`), 'the incumbent carries the mark');
  assert.ok(context.includes('current physical model: deepseek:chat'));
  assert.ok(context.includes('about 2500 tokens (10000 characters)'));
  assert.ok(context.includes('keep the current model unless clearly outmatched'));
  assert.equal(context.split('\n')[0], `deepseek:chat: fast general chat ${CURRENT_MODEL_MARK}`);
  assert.equal(context.split('\n')[1], 'deepseek:reasoner: hard reasoning math');
});

test('candidate rendering never invents a mark for a non-incumbent', () => {
  assert.equal(renderCandidateLine({ name: 'a:one', description: 'x' }), 'a:one: x');
  assert.equal(renderCandidateLine({ name: 'a:one', description: 'x', current: false }), 'a:one: x');
  assert.ok(renderCandidateLine({ name: 'a:one', description: 'x', current: true }).endsWith(CURRENT_MODEL_MARK));
});

test('the logits backend puts the affinity facts and policy in the prompt it scores', async () => {
  const stub = stubFetch(() => ({
    choices: [{ logprobs: { top_logprobs: [{ A: -0.1, B: -2.0 }] } }]
  }));
  try {
    const backend = new LogitsSystemOneBackend({ vllmBaseUrl: 'http://logits.test' });
    const response = await backend.route(REQUEST);

    assert.equal(stub.calls.length, 1);
    const prompt = String(stub.calls[0].body.prompt);
    assert.ok(prompt.startsWith(`Context: deepseek:chat: fast general chat ${CURRENT_MODEL_MARK}`), prompt);
    assert.ok(prompt.includes('current physical model: deepseek:chat'));
    assert.ok(prompt.includes('about 2500 tokens (10000 characters)'));
    assert.ok(prompt.includes('Prompt-cache affinity: keep the current model unless clearly outmatched.'));
    assert.equal(response.bestCandidate, 'deepseek:chat');
  } finally {
    stub.restore();
  }
});

test('the Jev gateway is handed the same facts as rendered context and session state', async () => {
  const stub = stubFetch(() => ({
    model: 'jev-1.13.0',
    answers: {
      route: {
        type: 'choice',
        choice: 'deepseek:chat',
        probabilities: { 'deepseek:chat': 0.9, 'deepseek:reasoner': 0.1 }
      }
    }
  }));
  try {
    const backend = new JevDecisionBackend({ baseUrl: 'http://jev.test/v1/systemone', apiKey: 'k' });
    const response = await backend.route(REQUEST);

    assert.equal(stub.calls[0].url, 'http://jev.test/v1/systemone');
    const body = stub.calls[0].body;
    assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
    assert.deepEqual(body.state.session, REQUEST.state);
    assert.equal(body.state.goal, REQUEST.goal);

    const question = body.questions.route;
    assert.deepEqual(Object.keys(question.criteria), ['deepseek:chat', 'deepseek:reasoner']);
    assert.ok(String(question.criteria['deepseek:chat']).endsWith(CURRENT_MODEL_MARK));
    const instructions = String(question.instructions);
    assert.ok(instructions.includes(CURRENT_MODEL_MARK));
    assert.ok(instructions.includes('current physical model: deepseek:chat'));
    assert.ok(instructions.includes('about 2500 tokens (10000 characters)'));
    assert.ok(instructions.includes('keep the current model unless clearly outmatched'));

    assert.deepEqual(response.rankedCandidates, [
      { name: 'deepseek:chat', score: 0.9 },
      { name: 'deepseek:reasoner', score: 0.1 }
    ]);
  } finally {
    stub.restore();
  }
});

test('a request without affinity posts no session facts and no mark', async () => {
  const stub = stubFetch(() => ({
    model: 'jev-1.13.0',
    answers: { route: { type: 'choice', choice: 'a:one', probabilities: { 'a:one': 1 } } }
  }));
  try {
    const backend = new JevDecisionBackend({ baseUrl: 'http://jev.test/v1/systemone', apiKey: 'k', model: 'm' });
    await backend.route({ goal: 'g', candidates: [{ name: 'a:one', description: 'd' }], topK: 2 });

    const body = stub.calls[0].body;
    assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
    assert.deepEqual(body.state, { goal: 'g', topK: 2 });
    assert.deepEqual(body.questions.route.criteria, { 'a:one': 'd' });
    assert.equal(String(body.questions.route.instructions).includes(CURRENT_MODEL_MARK), false);
    assert.ok(String(body.questions.route.instructions).startsWith('a:one: d'));
  } finally {
    stub.restore();
  }
});
