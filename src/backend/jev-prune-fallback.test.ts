import assert from 'node:assert/strict';
import test from 'node:test';

import { JevDecisionBackend, compressByTemplate, templateOfLine } from './jev.js';
import type { ChoiceRequest } from './types.js';

/**
 * The degraded pruning contract.
 *
 * When System One cannot judge a payload, pruning must still reduce it through
 * format-independent template compression instead of returning the raw blob,
 * must label the response `judgePath: 'fallback'` with the reason and the
 * strategy used, and must record the backend's health so the panel and
 * `/reflex-ledger` can tell a person that decisions are degraded.
 */

/** One recorded gateway request. */
interface StubCall {
  body: any;
}

/** Scripted gateway behaviour. */
type Reply = { status?: number; statusText?: string; json?: unknown; throw?: Error };

/** Swap in a scripted `fetch` for one test. */
function stubFetch(reply: (call: StubCall) => Reply): { calls: StubCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: StubCall[] = [];
  globalThis.fetch = (async (_url: string | URL, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as any;
    const call: StubCall = { body };
    calls.push(call);
    const scripted = reply(call);
    if (scripted.throw !== undefined) throw scripted.throw;
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

/** A backend that judges segments above `judgeMinChars`. */
function judgingBackend(judgeMinChars = 10000): JevDecisionBackend {
  return new JevDecisionBackend({ apiKey: 'test-key', model: 'jev-latest', timeoutMs: 500, pruneJudgeMinChars: judgeMinChars });
}

/** The 200-line progress-art payload of the production incident, at 14533 characters. */
function incidentFixture(): string {
  const lines = Array.from({ length: 200 }, (_, index) => `[===] progress ${String(index).padStart(3, '0')} ${'x'.repeat(52)}`);
  const deficit = 14533 - lines.join('\n').length;
  assert.ok(deficit >= 0, 'the fixture base is already longer than the incident payload');
  lines[0] = `${lines[0] as string}${'x'.repeat(deficit)}`;
  const raw = lines.join('\n');
  assert.equal(raw.length, 14533, 'the fixture no longer matches the reported payload size');
  return raw;
}

/** Reduction in percent, as pruning measures it. */
function reductionOf(raw: string, pruned: string): number {
  return ((raw.length - pruned.length) / raw.length) * 100;
}

/** The four formats whose templates must all compress. */
const FORMATS: Record<string, { raw: string; diagnostic: string }> = {
  'progress art': {
    raw: [
      'BUILD LOG BEGIN',
      ...Array.from({ length: 200 }, (_, index) => `[===] progress ${String(index).padStart(3, '0')} ${'x'.repeat(60)}`),
      'BUILD LOG END'
    ].join('\n'),
    diagnostic: 'BUILD LOG BEGIN'
  },
  'percentage progress': {
    raw: [
      'Installing dependencies',
      ...Array.from({ length: 150 }, (_, index) => `downloading ${String(index + 1)}/150 · ${String(Math.ceil(((index + 1) / 150) * 100))}% complete`),
      'dedupe done'
    ].join('\n'),
    diagnostic: 'Installing dependencies'
  },
  'numbered stack/table': {
    raw: [
      'Traceback (most recent call last):',
      ...Array.from({ length: 90 }, (_, index) => `  at frame${String(index)} (/app/src/mod${String(index % 7)}.ts:${String(100 + index)}:${String((index % 9) + 1)})`),
      'Error: the worker crashed'
    ].join('\n'),
    diagnostic: 'Error: the worker crashed'
  },
  'unstructured repetition': {
    raw: [
      '== batch report ==',
      ...Array.from({ length: 120 }, (_, index) => `worker ${String(index)} completed batch ${String(index * 3)} in ${String(index + 1)}ms`),
      '== end of report =='
    ].join('\n'),
    diagnostic: '== batch report =='
  }
};

test('template compression reduces four formats and keeps first/last/diagnostic lines verbatim', () => {
  for (const [name, format] of Object.entries(FORMATS)) {
    const compressed = compressByTemplate(format.raw);
    const lines = format.raw.split('\n');
    const reduction = reductionOf(format.raw, compressed);

    assert.ok(reduction >= 30, `${name}: template compression reduced only ${reduction.toFixed(1)}%`);
    assert.ok(lines[0] !== undefined && compressed.startsWith(lines[0] as string), `${name}: first line changed`);
    assert.ok(compressed.endsWith(lines[lines.length - 1] as string), `${name}: last line changed`);
    assert.ok(compressed.includes(format.diagnostic), `${name}: the diagnostic line was dropped`);
    assert.match(compressed, /… \[\d+ similar lines omitted\] …/, `${name}: no omission marker`);
  }
});

test('templates normalize numbers, percentages, ids and times instead of whole lines', () => {
  assert.equal(templateOfLine('progress 001'), templateOfLine('progress 999'));
  assert.equal(templateOfLine('chunk 1/9 · 12%'), templateOfLine('chunk 8/9 · 87%'));
  assert.equal(
    templateOfLine('job 5f1c2a3b-1111-2222-3333-444455556666 took 42ms'),
    templateOfLine('job 0a9b8c7d-aaaa-bbbb-cccc-ddddeeeeffff took 7ms')
  );
  assert.notEqual(templateOfLine('error: disk full'), templateOfLine('warning: disk quiet'));
});

test('the incident payload compresses even though the local filters produce nothing', async () => {
  const raw = incidentFixture();
  const stub = stubFetch(() => ({ throw: new TypeError('fetch failed') }));
  try {
    const backend = judgingBackend();
    const result = await backend.prune({ rawOutput: raw, intent: 'find the failure' });

    assert.ok((result.judgedSegments ?? 0) > 0, 'the payload was never cut into segments');
    assert.equal(result.judgePath, 'fallback');
    assert.equal(result.compression, 'template');
    assert.match(result.fallbackReason ?? '', /fetch failed/);
    assert.ok(result.prunedChars < result.originalChars, `no reduction: ${String(result.prunedChars)}/${String(result.originalChars)}`);
    const reduction = reductionOf(raw, result.processedOutput);
    assert.ok(reduction >= 30, `only ${reduction.toFixed(1)}% smaller`);
    assert.ok(stub.calls.length > 0, 'the backend never tried System One');

    const health = backend.health();
    assert.equal(health.available, false);
    assert.equal(health.consecutiveFailures, 1);
    assert.match(health.lastFailureReason ?? '', /fetch failed/);
    assert.match(health.lastFailureAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    stub.restore();
  }
});

test('health records consecutive failures and a single success resets it', async () => {
  let mode: 'fail' | 'ok' = 'fail';
  const stub = stubFetch(() =>
    mode === 'fail'
      ? { status: 503, statusText: 'Service Unavailable' }
      : { json: envelope({ choice: { type: 'choice', choice: 'yes', confidence: 1, probabilities: { yes: 1, no: 0 } } }) }
  );
  try {
    const backend = judgingBackend();
    const request: ChoiceRequest = { question: 'Ship it?', options: ['yes', 'no'] };

    await assert.rejects(backend.choice(request));
    await assert.rejects(backend.choice(request));
    const failed = backend.health();
    assert.equal(failed.available, false);
    assert.equal(failed.consecutiveFailures, 2, 'two failures must count twice');
    assert.match(failed.lastFailureReason ?? '', /503/);

    mode = 'ok';
    await backend.choice(request);
    const recovered = backend.health();
    assert.equal(recovered.available, true, 'a success must mark the backend available');
    assert.equal(recovered.consecutiveFailures, 0, 'a success must reset the run');
    assert.equal(recovered.lastFailureReason, undefined, 'a success must clear the stale reason');
    assert.equal(recovered.lastFailureAt, undefined, 'a success must clear the stale timestamp');
  } finally {
    stub.restore();
  }
});

test('a successful System One judgment still uses the segmented path, not template compression', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as any;
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions ?? {})) {
      answers[id] = { type: 'score', score: 0.9, probabilities: { '0': 0.1, '1': 0.9 } };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => envelope(answers),
      text: async () => ''
    } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    const backend = judgingBackend();
    const result = await backend.prune({ rawOutput: incidentFixture(), intent: 'find the failure' });
    assert.equal(result.judgePath, 'segmented');
    assert.equal(result.compression, undefined, 'the normal path must not report template compression');
    assert.doesNotMatch(result.processedOutput, /similar lines omitted/);
    assert.equal(backend.health().available, true);
  } finally {
    globalThis.fetch = original;
  }
});
