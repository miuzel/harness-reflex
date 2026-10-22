import assert from 'node:assert/strict';
import test from 'node:test';

import * as vendor from './vendor/harness-reflex/backend/jev.js';

/**
 * Contract fence between the root harness-reflex source and the snapshot the
 * DSH plugin vendors.
 *
 * The plugin cannot import the root package at build time (its tsconfig owns
 * `src/`), so the vendored copy is a deliberate manual port. That makes drift a
 * real failure mode: a later change to `prune()` could land on one side only.
 * These assertions compare the two *compiled* modules on identical input, so the
 * port is verified instead of trusted. `npm run build:all` compiles both.
 */

/** The root module, loaded at runtime so the plugin build does not depend on it. */
type JevModule = typeof import('./vendor/harness-reflex/backend/jev.js');

async function loadRoot(): Promise<JevModule> {
  const url = new URL('../../../dist/backend/jev.js', import.meta.url);
  return (await import(url.href)) as JevModule;
}

/** One request the stubbed gateway received. */
interface StubCall {
  body: any;
}

/** Answer every segment question with the same keep score. */
function stubGateway(keep = 0.9): { calls: StubCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: StubCall[] = [];
  globalThis.fetch = (async (_url: string | URL, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as any;
    calls.push({ body });
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions ?? {})) {
      answers[id] = { type: 'score', score: keep, probabilities: { '0': 1 - keep, '1': keep } };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ model: 'jev-1.13.0', answers }),
      text: async () => ''
    };
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const INTENT = 'find the test failure';

const LOG = [
  '> build@1.0.0 test',
  '',
  'Downloading dependencies from the registry',
  ...Array.from({ length: 12 }, (_, index) => `  npm warn deprecated pkg-${String(index)}@1.0.0: no longer supported`),
  'FAIL src/thing.test.js',
  '  AssertionError: expected 3 to equal 4',
  'Progress: resolved 1, reused 0, downloaded 0, added 0',
  'ℹ tests 9',
  'ℹ fail 1'
].join('\n');

/** The bug-report format: 80 progress lines, no blank lines, ~12k characters. */
const PROGRESS = Array.from(
  { length: 80 },
  (_, index) => `[===] progress ${String(index).padStart(3, '0')} ${'x'.repeat(135)}`
).join('\n');

function backendOf(module: JevModule, pruneJudgeMinChars: number): InstanceType<JevModule['JevDecisionBackend']> {
  return new module.JevDecisionBackend({
    apiKey: 'test-key',
    model: 'jev-latest',
    timeoutMs: 500,
    pruneJudgeMinChars
  });
}

test('both copies build identical deterministic candidates', async () => {
  const root = await loadRoot();
  for (const raw of [LOG, PROGRESS]) {
    assert.deepEqual(vendor.buildPruneCandidates(raw, INTENT), root.buildPruneCandidates(raw, INTENT));
    assert.equal(vendor.compressByTemplate(raw), root.compressByTemplate(raw), 'template compression drifted');
  }
});

test('both copies fall back to the same template compression when the gateway is unreachable', async () => {
  const root = await loadRoot();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  try {
    const rootBackend = backendOf(root, 10000);
    const vendorBackend = backendOf(vendor, 10000);
    const [rootResult, vendorResult] = await Promise.all([
      rootBackend.prune({ rawOutput: PROGRESS, intent: INTENT }),
      vendorBackend.prune({ rawOutput: PROGRESS, intent: INTENT })
    ]);

    for (const result of [rootResult, vendorResult]) {
      assert.equal(result.judgePath, 'fallback');
      assert.equal(result.compression, 'template');
      assert.ok(result.prunedChars < result.originalChars, 'the degraded path returned the raw blob');
      assert.ok((result.judgedSegments ?? 0) > 0, 'the degraded path skipped segmentation');
      assert.match(result.fallbackReason ?? '', /fetch failed/);
    }
    assert.equal(rootResult.processedOutput, vendorResult.processedOutput, 'the two copies compress differently');
    assert.equal(rootResult.prunedChars, vendorResult.prunedChars);
    assert.equal(rootResult.reductionPercentage, vendorResult.reductionPercentage);
    assert.equal(rootBackend.health().available, false);
    assert.equal(vendorBackend.health().available, false);
    assert.equal(rootBackend.health().consecutiveFailures, vendorBackend.health().consecutiveFailures);
  } finally {
    globalThis.fetch = original;
  }
});

test('both copies segment an output identically', async () => {
  const root = await loadRoot();
  for (const raw of [LOG, PROGRESS]) {
    assert.deepEqual(vendor.segmentPruneOutput(raw, INTENT), root.segmentPruneOutput(raw, INTENT));
  }
});

test('both copies take the same judging path and produce the same reduction', async () => {
  const root = await loadRoot();
  const rootBackend = backendOf(root, 10000);
  const vendorBackend = backendOf(vendor, 10000);

  const stub = stubGateway();
  try {
    // At/above the threshold: both send exactly one segment-judging request.
    const rootLarge = await rootBackend.prune({ rawOutput: PROGRESS, intent: INTENT });
    const vendorLarge = await vendorBackend.prune({ rawOutput: PROGRESS, intent: INTENT });
    assert.equal(stub.calls.length, 2, 'one request per backend');
    const [rootCall, vendorCall] = stub.calls;
    assert.equal(
      Object.keys(rootCall!.body.questions).length,
      Object.keys(vendorCall!.body.questions).length,
      'same judged segment count'
    );

    assert.equal(rootLarge.judgePath, 'segmented');
    assert.equal(vendorLarge.judgePath, 'segmented');
    assert.equal(rootLarge.judgedSegments, vendorLarge.judgedSegments);
    assert.equal(rootLarge.unjudgedSegments, vendorLarge.unjudgedSegments);
    assert.equal(rootLarge.prunedChars, vendorLarge.prunedChars);
    assert.equal(rootLarge.reductionPercentage, vendorLarge.reductionPercentage);
    assert.equal(rootLarge.processedOutput, vendorLarge.processedOutput);

    // Below the threshold: neither calls the gateway, both label the local path.
    const rootSmall = await rootBackend.prune({ rawOutput: LOG, intent: INTENT });
    const vendorSmall = await vendorBackend.prune({ rawOutput: LOG, intent: INTENT });
    assert.equal(stub.calls.length, 2, 'a small payload sends no request');
    assert.equal(rootSmall.judgePath, 'local');
    assert.equal(vendorSmall.judgePath, 'local');
    assert.equal(rootSmall.processedOutput, vendorSmall.processedOutput);
    assert.equal(rootSmall.reductionPercentage, vendorSmall.reductionPercentage);
  } finally {
    stub.restore();
  }
});

test('both copies report the same candidate sizes and score counts, including a degraded judgment', async () => {
  const root = await loadRoot();
  const above = { type: 'score', score: 0.95, probabilities: { '0': 0.05, '1': 0.95 } };
  const shapes: { name: string; answerOf: (index: number) => unknown | undefined }[] = [
    { name: 'all scored', answerOf: () => above },
    { name: 'half unanswered', answerOf: (index) => (index % 2 === 0 ? above : undefined) },
    { name: 'unreadable keys', answerOf: () => ({ type: 'score', probabilities: { omit: 0.1, keep: 0.9 } }) }
  ];

  for (const shape of shapes) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as any;
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(body.questions ?? {})) {
        const index = Number(id.slice('prune-seg-'.length));
        const answer = shape.answerOf(index);
        if (answer !== undefined) answers[id] = answer;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ model: 'jev-1.13.0', answers }),
        text: async () => ''
      };
    }) as unknown as typeof fetch;
    try {
      const rootBackend = backendOf(root, 10000);
      const vendorBackend = backendOf(vendor, 10000);
      const [rootResult, vendorResult] = await Promise.all([
        rootBackend.prune({ rawOutput: PROGRESS, intent: INTENT }),
        vendorBackend.prune({ rawOutput: PROGRESS, intent: INTENT })
      ]);

      for (const key of [
        'judgePath',
        'compression',
        'fallbackReason',
        'prunedChars',
        'reductionPercentage',
        'judgedSegments',
        'unjudgedSegments',
        'keptSegments',
        'aggressiveChars',
        'balancedChars',
        'conservativeChars',
        'scoredSegments',
        'autoKeptSegments',
        'unparsedScoreAnswers'
      ] as const) {
        assert.deepEqual(rootResult[key], vendorResult[key], `${shape.name}: ${key} drifted between the copies`);
      }
      assert.equal(rootResult.processedOutput, vendorResult.processedOutput, `${shape.name}: the copies returned different text`);
    } finally {
      globalThis.fetch = original;
    }
  }
});
