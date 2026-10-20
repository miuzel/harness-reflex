import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_SYSTEMONE_ENDPOINT,
  GATE_CONFIDENCE_FLOOR,
  JevDecisionBackend,
  STAGNATION_PATTERNS,
  STAGNATION_STUCK_FLOOR,
  buildPruneCandidates,
  detectStagnationLocally,
  normalizeSystemOneEndpoint,
  pickLocalPruneCandidate,
  uniqueCriteriaKeys
} from './jev.js';
import type { ActionStep, RouteRequest } from './types.js';

/**
 * Contract tests for the single-endpoint Jev adapter.
 *
 * Every case observes the adapter at the network seam (`fetch`), so the exact
 * request the real gateway receives is pinned: one `POST /v1/systemone`, a body
 * of `{ model, state, questions }`, and `questions.*` limited to the `choice`
 * and `score` types the gateway accepts. The legacy five-sub-path contract is
 * asserted *absent* by construction — a response in the old shape must make the
 * adapter fail rather than quietly return a fabricated distribution.
 */

/** One request the adapter sent. */
interface StubCall {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** One scripted gateway reply. */
interface ScriptedReply {
  status?: number;
  statusText?: string;
  json?: unknown;
}

/** Swap in a scripted `fetch` for the duration of one test. */
function stubFetch(reply: (call: StubCall) => ScriptedReply): { calls: StubCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: StubCall[] = [];
  globalThis.fetch = (async (url: string | URL, init?: { body?: string; headers?: Record<string, string> }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as any;
    const call: StubCall = { url: String(url), headers: init?.headers ?? {}, body };
    calls.push(call);
    const scripted = reply(call);
    const status = scripted.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: scripted.statusText ?? 'OK',
      json: async () => scripted.json ?? {},
      text: async () => JSON.stringify(scripted.json ?? { detail: 'Not Found' })
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** A gateway answer envelope. */
function envelope(answers: Record<string, unknown>): unknown {
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } };
}

/** A choice answer naming one criterion. */
function choiceAnswer(choice: string, probabilities: Record<string, number>): unknown {
  return { type: 'choice', choice, confidence: 0.5, probabilities };
}

/** Backend wired to a fake host, so the default endpoint resolution is exercised. */
function backend(): JevDecisionBackend {
  return new JevDecisionBackend({ apiKey: 'test-key', model: 'jev-latest', timeoutMs: 500 });
}

/** Question ids of one recorded request body. */
function questionIds(body: any): string[] {
  return Object.keys(body.questions ?? {}).sort();
}

const LOG = [
  '> build@1.0.0 test',
  '> node --test',
  '',
  'Downloading dependencies from the registry',
  ...Array.from({ length: 12 }, (_, index) => `  npm warn deprecated pkg-${String(index)}@1.0.0: no longer supported`),
  ...[...Array(6)].map(() => '  node_modules/left-pad/index.js:12:3  in internal frame'),
  'FAIL src/thing.test.js',
  '  AssertionError: expected 3 to equal 4',
  '    at TestContext.<anonymous> (file:///repo/src/thing.test.js:12:5)',
  '  expected: 4',
  '  actual: 3',
  'Progress: resolved 1, reused 0, downloaded 0, added 0',
  ...Array.from({ length: 8 }, (_, index) => `  ok ${String(index)} - unrelated passing case`),
  'ℹ tests 9',
  'ℹ fail 1'
].join('\n');

test('every accepted base spelling collapses onto the one endpoint', () => {
  assert.equal(normalizeSystemOneEndpoint(undefined), DEFAULT_SYSTEMONE_ENDPOINT);
  assert.equal(normalizeSystemOneEndpoint(''), DEFAULT_SYSTEMONE_ENDPOINT);
  assert.equal(normalizeSystemOneEndpoint('https://api.typesafe.ai/v1/systemone'), DEFAULT_SYSTEMONE_ENDPOINT);
  assert.equal(normalizeSystemOneEndpoint('https://api.typesafe.ai/v1/systemone/'), DEFAULT_SYSTEMONE_ENDPOINT);
  assert.equal(normalizeSystemOneEndpoint('https://api.typesafe.ai/v1'), DEFAULT_SYSTEMONE_ENDPOINT);
  assert.equal(normalizeSystemOneEndpoint('https://api.typesafe.ai'), DEFAULT_SYSTEMONE_ENDPOINT);
  assert.equal(normalizeSystemOneEndpoint('https://api.typesafe.ai/systemone'), DEFAULT_SYSTEMONE_ENDPOINT);
  assert.equal(normalizeSystemOneEndpoint('http://127.0.0.1:8080/v1/systemone'), 'http://127.0.0.1:8080/v1/systemone');
});

test('criteria keys are the option labels and stay unique', () => {
  assert.deepEqual(uniqueCriteriaKeys(['a', 'b']), ['a', 'b']);
  assert.deepEqual(uniqueCriteriaKeys(['x', 'x', 'x']), ['x', 'x (2)', 'x (3)']);
  assert.deepEqual(uniqueCriteriaKeys(['', 'b']), ['option 1', 'b']);
});

test('the compiled adapter carries no legacy sub-path', () => {
  let source: string;
  try {
    source = readFileSync(new URL('./jev.js', import.meta.url), 'utf8');
  } catch {
    return; // source-only runs have no compiled sibling; the seam tests still cover the contract
  }
  // Not even a comment may name a retired path: the shipped artifact is grepped.
  for (const legacy of ['/v1/choice', '/v1/gate', '/v1/prune', '/v1/stagnation-check', '/v1/route']) {
    assert.equal(source.includes(legacy), false, `legacy endpoint ${legacy} must not appear at all`);
  }
  assert.ok(source.includes('/v1/systemone'));
});

test('choice posts one systemone request whose criteria are the options', async () => {
  const stub = stubFetch(() => ({ json: envelope({ choice: choiceAnswer('beta', { alpha: 0.25, beta: 0.75 }) }) }));
  try {
    const result = await backend().choice({
      question: 'Which description fits?',
      options: ['alpha', 'beta'],
      context: 'the state of the world'
    });

    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(call.url, DEFAULT_SYSTEMONE_ENDPOINT);
    assert.deepEqual(Object.keys(call.body).sort(), ['model', 'questions', 'state']);
    assert.equal(call.body.model, 'jev-latest');
    assert.deepEqual(call.body.state, { context: 'the state of the world' });
    assert.deepEqual(questionIds(call.body), ['choice']);

    const question = call.body.questions.choice;
    assert.equal(question.type, 'choice');
    assert.equal(question.instructions, 'Which description fits?');
    assert.deepEqual(question.criteria, { alpha: 'alpha', beta: 'beta' });

    assert.deepEqual(result.options, [
      { label: 'beta', probability: 0.75 },
      { label: 'alpha', probability: 0.25 }
    ]);
    assert.equal(result.bestOption, 'beta');
    assert.equal(result.confidence, 0.75);
    assert.equal(result.uncalibrated, false);
    assert.ok(result.latencyMs >= 0);
  } finally {
    stub.restore();
  }
});

test('choice splits a tie in favour of the criterion the gateway named', async () => {
  const stub = stubFetch(() => ({ json: envelope({ choice: choiceAnswer('second', { first: 0.5, second: 0.5 }) }) }));
  try {
    const result = await backend().choice({ question: 'q', options: ['first', 'second'] });
    assert.equal(result.bestOption, 'second');
    assert.equal(result.confidence, 0.5);
  } finally {
    stub.restore();
  }
});

test('choice rebuilds a named answer without a distribution and marks it uncalibrated', async () => {
  const stub = stubFetch(() => ({
    json: envelope({ choice: { type: 'choice', choice: 'beta', confidence: 0.8 } })
  }));
  try {
    const result = await backend().choice({ question: 'q', options: ['alpha', 'beta'] });
    assert.equal(result.uncalibrated, true);
    assert.equal(result.bestOption, 'beta');
    assert.equal(result.confidence, 0.8);
    assert.equal(result.options.find((option) => option.label === 'alpha')?.probability, 0.2);
  } finally {
    stub.restore();
  }
});

test('choice keeps duplicate option labels as distinct options', async () => {
  const stub = stubFetch(() => ({
    json: envelope({ choice: choiceAnswer('same (2)', { same: 0.3, 'same (2)': 0.7 }) })
  }));
  try {
    const result = await backend().choice({ question: 'q', options: ['same', 'same'] });
    assert.equal(stub.calls[0].body.questions.choice.criteria['same (2)'], 'same');
    assert.deepEqual(result.options, [
      { label: 'same', probability: 0.7 },
      { label: 'same', probability: 0.3 }
    ]);
    assert.equal(result.confidence, 0.7);
  } finally {
    stub.restore();
  }
});

test('choice fails loudly when the answer carries no usable decision', async () => {
  const stub = stubFetch(() => ({ json: envelope({ choice: { type: 'choice' } }) }));
  try {
    await assert.rejects(
      () => backend().choice({ question: 'q', options: ['a', 'b'] }),
      /\[JevBackend\.choice\] Failed: .*neither a probability distribution nor a named criterion/
    );
  } finally {
    stub.restore();
  }
});

test('a legacy-shaped response cannot satisfy choice', async () => {
  // The old gateway answered `{ options: [{ label, probability }] }`; that body
  // has no `answers` envelope, so the adapter must reject it instead of parsing
  // it — this is the brake that fails if the old contract is restored.
  const stub = stubFetch(() => ({ json: { options: [{ label: 'a', probability: 1 }], bestOption: 'a' } }));
  try {
    await assert.rejects(() => backend().choice({ question: 'q', options: ['a', 'b'] }), /carries no answers object/);
  } finally {
    stub.restore();
  }
});

test('choice reports transport failures with their status', async () => {
  const stub = stubFetch(() => ({ status: 404, statusText: 'Not Found', json: { detail: 'Not Found' } }));
  try {
    await assert.rejects(
      () => backend().choice({ question: 'q', options: ['a', 'b'] }),
      /\[JevBackend\.choice\] Failed: Jev API error \(404 Not Found\)/
    );
    assert.equal(stub.calls[0].url, DEFAULT_SYSTEMONE_ENDPOINT);
  } finally {
    stub.restore();
  }
});

test('choice refuses an empty option list without calling the gateway', async () => {
  const stub = stubFetch(() => ({ json: envelope({}) }));
  try {
    await assert.rejects(() => backend().choice({ question: 'q', options: [] }), /at least one option is required/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('gate batches every assertion into one request and reads the verdict distribution', async () => {
  const stub = stubFetch(() => ({
    json: envelope({
      'assertion-0': choiceAnswer('verified', { verified: 0.9, contradicted: 0.05, not_addressed: 0.05 }),
      'assertion-1': choiceAnswer('contradicted', { verified: 0.1, contradicted: 0.8, not_addressed: 0.1 })
    })
  }));
  try {
    const result = await backend().gate({
      assertions: [{ statement: 'the suite passes' }, { statement: 'the diff is empty', criteria: 'count changed files' }],
      evidence: 'FAIL src/thing.test.js: expected 3 to equal 4',
      strictness: 'normal'
    });

    assert.equal(stub.calls.length, 1, 'one request carries both assertions');
    const [call] = stub.calls;
    assert.equal(call.url, DEFAULT_SYSTEMONE_ENDPOINT);
    assert.deepEqual(questionIds(call.body), ['assertion-0', 'assertion-1']);
    assert.equal(call.body.state.evidence, 'FAIL src/thing.test.js: expected 3 to equal 4');
    assert.equal(call.body.state.strictness, 'normal');
    assert.deepEqual(Object.keys(call.body.questions['assertion-0'].criteria).sort(), [
      'contradicted',
      'not_addressed',
      'verified'
    ]);
    assert.ok(String(call.body.questions['assertion-1'].instructions).includes('count changed files'));

    assert.deepEqual(
      result.results.map((item) => [item.outcome, item.confidence]),
      [
        ['verified', 0.9],
        ['contradicted', 0.8]
      ]
    );
    assert.equal(result.passed, false);
    assert.equal(result.needsEscalation, false);
  } finally {
    stub.restore();
  }
});

test('gate passes only when every assertion is verified', async () => {
  const stub = stubFetch(() => ({
    json: envelope({
      'assertion-0': choiceAnswer('verified', { verified: 0.95, contradicted: 0.03, not_addressed: 0.02 }),
      'assertion-1': choiceAnswer('verified', { verified: 0.8, contradicted: 0.1, not_addressed: 0.1 })
    })
  }));
  try {
    const result = await backend().gate({
      assertions: [{ statement: 'one' }, { statement: 'two' }],
      evidence: 'both statements are quoted verbatim in the output below'
    });
    assert.equal(result.passed, true);
    assert.equal(result.needsEscalation, false);
  } finally {
    stub.restore();
  }
});

test('gate escalates an undecided distribution instead of guessing', async () => {
  const stub = stubFetch(() => ({
    json: envelope({
      'assertion-0': choiceAnswer('verified', { verified: 0.4, contradicted: 0.3, not_addressed: 0.3 })
    })
  }));
  try {
    const [item] = (
      await backend().gate({ assertions: [{ statement: 'x' }], evidence: 'some evidence', strictness: 'high' })
    ).results;
    assert.equal(item.outcome, 'escalate');
    assert.equal(item.confidence, 0.4);
    assert.ok(item.explanation.includes(`${(GATE_CONFIDENCE_FLOOR.high * 100).toFixed(0)}%`));
  } finally {
    stub.restore();
  }
});

test('gate keeps a lenient distribution that is still decisive', async () => {
  const stub = stubFetch(() => ({
    json: envelope({ 'assertion-0': choiceAnswer('verified', { verified: 0.4, contradicted: 0.3, not_addressed: 0.3 }) })
  }));
  try {
    const result = await backend().gate({
      assertions: [{ statement: 'x' }],
      evidence: 'some evidence',
      strictness: 'lenient'
    });
    assert.equal(result.results[0].outcome, 'verified');
    assert.equal(result.passed, true);
  } finally {
    stub.restore();
  }
});

test('gate escalates a missing answer and stays fail-closed', async () => {
  const stub = stubFetch(() => ({
    json: envelope({ 'assertion-1': choiceAnswer('verified', { verified: 0.9, contradicted: 0.05, not_addressed: 0.05 }) })
  }));
  try {
    const result = await backend().gate({
      assertions: [{ statement: 'no answer for me' }, { statement: 'answered' }],
      evidence: 'evidence'
    });
    assert.deepEqual(
      result.results.map((item) => item.outcome),
      ['escalate', 'verified']
    );
    assert.equal(result.passed, false);
    assert.equal(result.needsEscalation, true);
  } finally {
    stub.restore();
  }
});

test('gate fails closed on a transport error', async () => {
  const stub = stubFetch(() => ({ status: 503, statusText: 'Service Unavailable' }));
  try {
    const result = await backend().gate({ assertions: [{ statement: 'a' }, { statement: 'b' }], evidence: 'e' });
    assert.deepEqual(
      result.results.map((item) => item.outcome),
      ['escalate', 'escalate']
    );
    assert.equal(result.passed, false);
    assert.equal(result.needsEscalation, true);
    assert.ok(result.results[0].explanation.includes('Fail-closed'));
  } finally {
    stub.restore();
  }
});

test('gate fails closed without calling the gateway when there is no evidence', async () => {
  const stub = stubFetch(() => ({ json: envelope({}) }));
  try {
    const result = await backend().gate({ assertions: [{ statement: 'a' }], evidence: '   ' });
    assert.equal(stub.calls.length, 0);
    assert.equal(result.needsEscalation, true);
    assert.equal(result.results[0].outcome, 'escalate');
  } finally {
    stub.restore();
  }
});

test('prune ranks its deterministic candidates with one score question', async () => {
  const stub = stubFetch(() => ({
    json: envelope({ prune: { type: 'score', score: 0.1, confidence: 0.9, legend: {}, probabilities: { 0: 0.9, 1: 0.05, 2: 0.05 } } })
  }));
  try {
    const result = await backend().prune({ rawOutput: LOG, intent: 'find the test failure' });

    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(call.url, DEFAULT_SYSTEMONE_ENDPOINT);
    assert.deepEqual(questionIds(call.body), ['prune']);
    const question = call.body.questions.prune;
    assert.equal(question.type, 'score');
    assert.ok(Array.isArray(question.criteria));
    assert.ok(question.criteria.length >= 2, 'the gateway must be given candidates to score');
    assert.equal(question.criteria.length, Object.keys(call.body.state.candidates).length);
    assert.equal(call.body.state.intent, 'find the test failure');

    // Candidate 0 is the aggressive filter: diagnostics kept, noise dropped.
    assert.ok(result.processedOutput.includes('AssertionError: expected 3 to equal 4'));
    assert.equal(result.processedOutput.includes('npm warn deprecated'), false);
    assert.equal(result.processedOutput.includes('node_modules/left-pad'), false);
    assert.ok(result.processedOutput.length < LOG.length);
    assert.ok(result.reductionPercentage > 0);
    assert.equal(result.estimatedTokensSaved > 0, true);
    assert.equal(result.shadow, false);
  } finally {
    stub.restore();
  }
});

test('prune honours shadowMode by returning the untouched raw output', async () => {
  const stub = stubFetch(() => ({
    json: envelope({ prune: { type: 'score', probabilities: { 0: 1, 1: 0, 2: 0 } } })
  }));
  try {
    const result = await backend().prune({ rawOutput: LOG, intent: 'failure', shadowMode: true });
    assert.equal(result.processedOutput, LOG);
    assert.equal(result.shadow, true);
    assert.ok(result.reductionPercentage > 0);
  } finally {
    stub.restore();
  }
});

test('prune falls back to the local candidate when the gateway fails', async () => {
  const stub = stubFetch(() => ({ status: 500, statusText: 'Internal Server Error' }));
  try {
    const result = await backend().prune({ rawOutput: LOG, intent: 'find the test failure' });
    const expected = pickLocalPruneCandidate(buildPruneCandidates(LOG, 'find the test failure'));
    assert.equal(result.processedOutput, expected?.text);
    assert.ok(result.processedOutput.includes('AssertionError: expected 3 to equal 4'));
    assert.ok(result.processedOutput.length < LOG.length);
    assert.equal(result.shadow, false);
  } finally {
    stub.restore();
  }
});

test('prune candidates are ordered from aggressive to conservative and all keep the diagnostic', () => {
  const candidates = buildPruneCandidates(LOG, 'find the test failure');
  assert.deepEqual(
    candidates.map((candidate) => candidate.id),
    ['aggressive', 'balanced', 'conservative']
  );
  const sizes = candidates.map((candidate) => candidate.text.length);
  assert.deepEqual([...sizes].sort((a, b) => a - b), sizes);
  for (const candidate of candidates) {
    assert.ok(candidate.text.includes('AssertionError: expected 3 to equal 4'), candidate.id);
    assert.ok(candidate.label.includes('smaller'));
  }
  assert.deepEqual(buildPruneCandidates('', 'x'), []);
});

test('prune skips the gateway when there is nothing to choose between', async () => {
  const stub = stubFetch(() => ({ json: envelope({}) }));
  try {
    const short = 'build ok\nno diagnostics here';
    const result = await backend().prune({ rawOutput: short, intent: 'errors' });
    assert.equal(stub.calls.length, 0);
    assert.equal(result.processedOutput, short);
    assert.equal(result.reductionPercentage, 0);
  } finally {
    stub.restore();
  }
});

test('stagnation classifies a window over the pattern criteria', async () => {
  const stub = stubFetch(() => ({
    json: envelope({
      stagnation: {
        type: 'choice',
        choice: 'repetition',
        confidence: 0.7,
        probabilities: { repetition: 0.72, oscillation: 0.1, failing_retry: 0.08, zero_progress: 0.05, none: 0.05 }
      }
    })
  }));
  try {
    const history: ActionStep[] = [
      { tool: 'bash', input: 'npm test' },
      { tool: 'bash', input: 'npm test', error: 'exit 1' },
      { tool: 'bash', input: 'npm test', error: 'exit 1' }
    ];
    const result = await backend().checkStagnation({ history, goal: 'make the suite green' });

    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(call.url, DEFAULT_SYSTEMONE_ENDPOINT);
    assert.equal(call.body.questions.stagnation.type, 'choice');
    assert.deepEqual(Object.keys(call.body.questions.stagnation.criteria), [...STAGNATION_PATTERNS]);
    assert.equal(call.body.state.goal, 'make the suite green');
    assert.equal(call.body.state.actions.length, 3);

    assert.equal(result.isStuck, true);
    assert.equal(result.patternType, 'repetition');
    assert.equal(result.confidence, 0.72);
    assert.ok(result.confidence >= STAGNATION_STUCK_FLOOR);
    assert.ok(result.recommendedIntervention);
    assert.ok(result.diagnosis?.includes('System One p=0.720'));
  } finally {
    stub.restore();
  }
});

test('stagnation reports progress when the gateway prefers the none criterion', async () => {
  const stub = stubFetch(() => ({
    json: envelope({
      stagnation: { type: 'choice', probabilities: { repetition: 0.1, oscillation: 0.05, failing_retry: 0.05, zero_progress: 0.1, none: 0.7 } }
    })
  }));
  try {
    const history: ActionStep[] = [
      { tool: 'bash', input: 'ls' },
      { tool: 'read', input: 'src/a.ts' },
      { tool: 'bash', input: 'npm test' }
    ];
    const result = await backend().checkStagnation({ history });
    assert.equal(result.isStuck, false);
    assert.equal(result.patternType, 'none');
    assert.equal(result.recommendedIntervention, undefined);
  } finally {
    stub.restore();
  }
});

test('stagnation reads the window locally when the gateway is unreachable', async () => {
  const stub = stubFetch(() => ({ status: 502, statusText: 'Bad Gateway' }));
  try {
    const history: ActionStep[] = [
      { tool: 'edit', input: 'a.ts:1' },
      { tool: 'edit', input: 'a.ts:1' },
      { tool: 'edit', input: 'a.ts:1' },
      { tool: 'edit', input: 'a.ts:1' }
    ];
    const result = await backend().checkStagnation({ history });
    assert.equal(result.isStuck, true);
    assert.equal(result.patternType, 'repetition');
    assert.ok(result.diagnosis?.includes('local heuristic'));
    assert.ok(result.diagnosis?.includes('System One unavailable'));
    assert.ok(result.recommendedIntervention);
  } finally {
    stub.restore();
  }
});

test('stagnation answers a short window without a request', async () => {
  const stub = stubFetch(() => ({ json: envelope({}) }));
  try {
    const result = await backend().checkStagnation({ history: [{ tool: 'bash', input: 'ls' }] });
    assert.equal(stub.calls.length, 0);
    assert.equal(result.isStuck, false);
    assert.ok(result.diagnosis?.includes('< 3'));
  } finally {
    stub.restore();
  }
});

test('the local stagnation detector distinguishes oscillation and failing retries', () => {
  const oscillating: ActionStep[] = [
    { tool: 'edit', input: 'a.ts' },
    { tool: 'bash', input: 'npm test', error: 'exit 1' },
    { tool: 'edit', input: 'a.ts' },
    { tool: 'bash', input: 'npm test', error: 'exit 1' }
  ];
  assert.equal(detectStagnationLocally(oscillating).patternType, 'oscillation');

  const failing: ActionStep[] = [
    { tool: 'bash', input: 'npm test', error: 'exit 1' },
    { tool: 'bash', input: 'npm run build', output: 'Error: cannot find module' },
    { tool: 'bash', input: 'npm run lint', output: 'FAIL lint' },
    { tool: 'bash', input: 'npm run pack', output: 'ok' }
  ];
  assert.equal(detectStagnationLocally(failing).patternType, 'failing_retry');

  const progressive: ActionStep[] = [
    { tool: 'read', input: 'a.ts' },
    { tool: 'edit', input: 'a.ts' },
    { tool: 'bash', input: 'npm test' }
  ];
  assert.deepEqual(
    [detectStagnationLocally(progressive).isStuck, detectStagnationLocally(progressive).patternType],
    [false, 'none']
  );
});

test('route asks one criteria question per candidate and ranks by the distribution', async () => {
  const request: RouteRequest = {
    goal: 'carry on with the migration plan',
    candidates: [
      { name: 'deepseek:chat', description: 'fast general chat', current: true },
      { name: 'deepseek:reasoner', description: 'hard reasoning math' },
      { name: 'deepseek:coder', description: 'writes code' }
    ],
    topK: 2,
    state: { currentModel: 'deepseek:chat', contextTokens: 2500, contextChars: 10000 },
    instructions: 'Prompt-cache affinity: keep the current model unless clearly outmatched.'
  };
  const stub = stubFetch(() => ({
    json: envelope({
      route: choiceAnswer('deepseek:chat', { 'deepseek:chat': 0.6, 'deepseek:reasoner': 0.3, 'deepseek:coder': 0.1 })
    })
  }));
  try {
    const result = await backend().route(request);

    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(call.url, DEFAULT_SYSTEMONE_ENDPOINT);
    assert.deepEqual(questionIds(call.body), ['route']);
    assert.equal(call.body.questions.route.type, 'choice');
    assert.deepEqual(Object.keys(call.body.questions.route.criteria), [
      'deepseek:chat',
      'deepseek:reasoner',
      'deepseek:coder'
    ]);
    // The affinity facts and policy still reach the model, as data and as prompt.
    assert.deepEqual(call.body.state.session, request.state);
    assert.equal(call.body.state.goal, request.goal);
    const instructions = String(call.body.questions.route.instructions);
    assert.ok(instructions.includes('[current model — keeping it preserves the prompt cache]'));
    assert.ok(instructions.includes('current physical model: deepseek:chat'));
    assert.ok(instructions.includes('about 2500 tokens (10000 characters)'));
    assert.ok(instructions.includes('keep the current model unless clearly outmatched.'));
    assert.ok(Object.values(call.body.questions.route.criteria).some((value) => String(value).includes('[current model')));

    assert.deepEqual(result.rankedCandidates, [
      { name: 'deepseek:chat', score: 0.6 },
      { name: 'deepseek:reasoner', score: 0.3 }
    ]);
    assert.equal(result.bestCandidate, 'deepseek:chat');
  } finally {
    stub.restore();
  }
});

test('route ranks every candidate even when topK is omitted', async () => {
  const stub = stubFetch(() => ({
    json: envelope({ route: { type: 'choice', probabilities: { a: 0.2, b: 0.8 } } })
  }));
  try {
    const result = await backend().route({
      goal: 'g',
      candidates: [
        { name: 'a', description: 'first' },
        { name: 'b', description: 'second' }
      ]
    });
    assert.deepEqual(
      result.rankedCandidates.map((candidate) => candidate.name),
      ['b', 'a']
    );
  } finally {
    stub.restore();
  }
});

test('route keeps routing with a labelled local ranking when the gateway fails', async () => {
  const stub = stubFetch(() => ({ status: 500, statusText: 'Internal Server Error' }));
  try {
    const result = await backend().route({
      goal: 'write the migration plan document',
      candidates: [
        { name: 'fast:chat', description: 'short replies' },
        { name: 'reason:plan', description: 'planning and documents' }
      ]
    });
    assert.equal(result.rankedCandidates.length, 2);
    assert.equal(result.bestCandidate, 'reason:plan');
    for (const candidate of result.rankedCandidates) {
      assert.match(String(candidate.reason), /local fallback \(Jev API error/);
    }
    const total = result.rankedCandidates.reduce((sum, candidate) => sum + candidate.score, 0);
    assert.ok(Math.abs(total - 1) < 0.001, `scores stay a distribution, got ${String(total)}`);
  } finally {
    stub.restore();
  }
});

test('route answers an empty pool without a request', async () => {
  const stub = stubFetch(() => ({ json: envelope({}) }));
  try {
    const result = await backend().route({ goal: 'g', candidates: [] });
    assert.equal(stub.calls.length, 0);
    assert.deepEqual(result.rankedCandidates, []);
    assert.equal(result.bestCandidate, undefined);
  } finally {
    stub.restore();
  }
});
