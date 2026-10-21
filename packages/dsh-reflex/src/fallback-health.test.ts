import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { UserMessage } from '@deepseek-ai/dsh-llm';

import { createReflexRuntime } from './bridge.js';
import { formatLedgerReport, systemOneHealthLine } from './command.js';
import { resolveConfig } from './config.js';
import { InterventionEngine } from './interventions.js';
import { buildPanelSnapshot } from './panel-api.js';
import { panelFacts } from './panel-mount.js';

/**
 * Degraded-mode visibility.
 *
 * When System One is unreachable the backend keeps pruning (template
 * compression) and records its health; the panel snapshot and `/reflex-ledger`
 * read that health so a person sees the degradation. None of it may reach the
 * model: the notice lives in the panel and the command text only.
 */

/** The payload of the reported incident: 200 progress-art lines, 14533 characters. */
function incidentFixture(): string {
  const lines = Array.from({ length: 200 }, (_, index) => `[===] progress ${String(index).padStart(3, '0')} ${'x'.repeat(52)}`);
  const deficit = 14533 - lines.join('\n').length;
  lines[0] = `${lines[0] as string}${'x'.repeat(Math.max(0, deficit))}`;
  return lines.join('\n');
}

/** Swap `fetch` for one test. */
function stubFetch(handler: () => { status?: number; body?: unknown; error?: Error }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const scripted = handler();
    if (scripted.error !== undefined) throw scripted.error;
    const status = scripted.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      json: async () => scripted.body ?? {},
      text: async () => ''
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** A gateway health record as the snapshot renders it. */
function health(overrides: Record<string, unknown> = {}): {
  available: boolean;
  lastFailureReason?: string;
  lastFailureAt?: string;
  consecutiveFailures: number;
} {
  return { available: false, lastFailureReason: 'fetch failed', lastFailureAt: '2024-03-04T05:06:07.000Z', consecutiveFailures: 2, ...overrides };
}

/** Facts sufficient for a panel snapshot, with the health block under test. */
function facts(systemOneHealth: ReturnType<typeof health> | undefined) {
  return {
    config: resolveConfig({ backend: 'jev' }),
    backendName: 'system-one-jev',
    pools: [],
    routingActive: false,
    toolSurface: [] as string[],
    ledger: { getSummary: () => ({ totalCalls: 0, callsByType: {}, totalTokensSaved: 0, avgLatencyMs: 0, estimatedCostSavedUsd: 0, stagnationAlerts: 0, gatePassedCount: 0, gateFailedCount: 0 }), getEntries: () => [], getLogPath: () => null },
    effort: undefined,
    apiKeyPresent: false,
    ...(systemOneHealth === undefined ? {} : { systemOneHealth }),
    now: 1_709_530_001_000
  };
}

test('the panel snapshot carries backend health and omits it for an in-process backend', () => {
  const degraded = buildPanelSnapshot(facts(health()) as never);
  assert.deepEqual(degraded.systemOne.health, health(), 'the health block is not projected');

  const recovered = buildPanelSnapshot(facts(health({ available: true, lastFailureReason: undefined, lastFailureAt: undefined, consecutiveFailures: 0 })) as never);
  assert.equal(recovered.systemOne.health?.available, true);

  const mock = buildPanelSnapshot(facts(undefined) as never);
  assert.equal('health' in mock.systemOne, false, 'an absent health block must not read as an outage');
});

test('a degraded backend is readable through the runtime and the panel after a real failure', async () => {
  const runtime = createReflexRuntime(
    resolveConfig({ backend: 'jev', systemOne: { baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'REFLEX_HEALTH_TEST_KEY' } })
  );
  const restore = stubFetch(() => ({ error: new TypeError('fetch failed') }));
  try {
    await assert.rejects(runtime.choice({ question: 'Ship it?', options: ['yes', 'no'] }));
    const failed = runtime.systemOneHealth();
    assert.equal(failed?.available, false);
    assert.equal(failed?.consecutiveFailures, 1);
    assert.match(failed?.lastFailureReason ?? '', /fetch failed/);

    const snapshot = buildPanelSnapshot(panelFacts(runtime, {}));
    assert.equal(snapshot.systemOne.health?.available, false, 'the panel cannot see the degradation');
    assert.match(snapshot.systemOne.health?.lastFailureReason ?? '', /fetch failed/);

    const ledger = runtime.statusLedger();
    assert.equal(ledger.systemOneHealth?.available, false, 'the ledger read lost the health record');
  } finally {
    restore();
    runtime.dispose();
  }
});

test('a single success clears the degradation in the snapshot', async () => {
  const runtime = createReflexRuntime(
    resolveConfig({ backend: 'jev', systemOne: { baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'REFLEX_HEALTH_TEST_KEY' } })
  );
  let failing = true;
  const restore = stubFetch(() =>
    failing
      ? { error: new TypeError('fetch failed') }
      : { body: { answers: { choice: { type: 'choice', choice: 'yes', confidence: 1, probabilities: { yes: 1, no: 0 } } } } }
  );
  try {
    await assert.rejects(runtime.choice({ question: 'Ship it?', options: ['yes', 'no'] }));
    assert.equal(buildPanelSnapshot(panelFacts(runtime, {})).systemOne.health?.available, false);

    failing = false;
    await runtime.choice({ question: 'Ship it?', options: ['yes', 'no'] });
    const recovered = buildPanelSnapshot(panelFacts(runtime, {})).systemOne.health;
    assert.equal(recovered?.available, true);
    assert.equal(recovered?.consecutiveFailures, 0);
  } finally {
    restore();
    runtime.dispose();
  }
});

test('/reflex-ledger prints a bilingual health line while degraded and drops it when recovered', () => {
  const summary = { totalCalls: 1, callsByType: { prune: 1 }, totalTokensSaved: 10, avgLatencyMs: 1, estimatedCostSavedUsd: 0, stagnationAlerts: 0, gatePassedCount: 0, gateFailedCount: 0 };
  const degraded = formatLedgerReport({ summary, systemOneHealth: health() });
  assert.match(degraded, /System One 后端不可用/, 'the degraded notice is missing');
  assert.match(degraded, /fetch failed/, 'the notice does not name the reason');
  assert.match(degraded, /降级/, 'the notice does not say decisions degraded');
  assert.match(degraded, /System One backend unavailable/, 'the notice is not bilingual');

  const healthy = formatLedgerReport({ summary, systemOneHealth: health({ available: true, consecutiveFailures: 0 }) });
  assert.equal(healthy.includes('System One 后端不可用'), false, 'a healthy backend still printed the notice');

  const unknown = formatLedgerReport({ summary });
  assert.equal(unknown.includes('System One 后端不可用'), false, 'a backend without health printed a notice');

  assert.equal(systemOneHealthLine(undefined), undefined);
  assert.equal(systemOneHealthLine(health({ available: true, consecutiveFailures: 0 })), undefined);
});

test('the degraded notice never reaches model-facing payloads or request messages', async () => {
  const raw = incidentFixture();
  const runtime = createReflexRuntime(
    resolveConfig({ backend: 'jev', systemOne: { baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'REFLEX_HEALTH_TEST_KEY' } })
  );
  const restore = stubFetch(() => ({ error: new TypeError('fetch failed') }));
  try {
    // The host-side pruning response carries the fallback facts, the tool-facing
    // payload stays the four documented fields.
    const detailed = await runtime.pruneService.prune(raw);
    assert.equal(detailed.judgePath, 'fallback');
    assert.equal(detailed.compression, 'template');
    assert.match(detailed.fallbackReason ?? '', /fetch failed/);
    assert.ok(detailed.prunedChars < raw.length, 'the plugin path returned the raw blob');
    assert.ok(
      ((raw.length - detailed.prunedChars) / raw.length) * 100 >= 30,
      `the plugin path reduced only ${String(detailed.reductionPercentage)}%`
    );
    const toolPayload = await runtime.prune({ rawOutput: raw, intent: 'find the failure' });
    assert.deepEqual(Object.keys(toolPayload).sort(), ['processedOutput', 'reductionPercentage', 'shadow', 'tokensSaved']);
    const noticePattern = /System One 后端不可用|decisions degraded|降级为本地压缩/;
    assert.doesNotMatch(JSON.stringify(detailed), noticePattern, 'the health notice leaked into the prune response');
    assert.doesNotMatch(JSON.stringify(toolPayload), noticePattern, 'the health notice leaked into the tool payload');
    for (const entry of runtime.ledger.getEntries()) {
      assert.doesNotMatch(JSON.stringify(entry), noticePattern, 'the health notice leaked into the ledger');
    }

    // The automatic-intervention half passes the turn's messages through: a
    // degraded backend must not turn its notice into a message the model reads.
    const resolved = resolveConfig({ backend: 'mock' });
    const engine = new InterventionEngine({
      config: resolved.interventions,
      pruneThreshold: 500,
      stagnation: { check: async () => ({ isStuck: false, patternType: 'none', confidence: 0.6, latencyMs: 0 }) },
      prune: runtime.pruneService,
      gate: {
        verify: async () => ({ passed: true, results: [], needsEscalation: false, latencyMs: 0 }),
        classifyClaims: async () => ({ results: [], latencyMs: 0 })
      }
    } as never);
    const messages = [
      { id: 'm-degraded', role: 'user', content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } } as unknown as UserMessage
    ];
    const decision = (await engine.preStep(
      { agent: { id: 'degraded-agent' }, messages, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages })
    )) as { kind: string; messages?: unknown[] };
    assert.equal(decision.kind, 'enter', 'the degraded backend changed the turn decision');
    for (const message of decision.messages ?? []) {
      assert.doesNotMatch(JSON.stringify(message), noticePattern, 'the health notice entered the request messages');
    }

    // The notice text exists only in the command/panel copies. Every module that
    // builds something the model reads must be clean of it.
    for (const module of ['tools.js', 'bridge.js', 'interventions.js', 'panel-api.js']) {
      const source = readFileSync(new URL(`./${module}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /System One 后端不可用/u, `${module} carries the degraded notice into the model path`);
    }
  } finally {
    restore();
    runtime.dispose();
  }
});
