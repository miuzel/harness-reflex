/**
 * Per-call System One provenance (g-068).
 *
 * The bug this file pins: a session switched its active connection three times,
 * then to a model that does not exist, and every call still answered with a
 * payload that named neither the connection nor the model. The only honest
 * sentence a reader could write was "no model is shown", and the ledger recorded
 * a backend class name that is neither of the two things asked for.
 *
 * What must hold now, and is proven here with synthetic fixtures only (no
 * network, no real credential, no settings file):
 *
 * 1. every tool payload reports the connection name, the *requested* model and
 *    the source of the answer;
 * 2. the ledger records the same three facts on the entry the call produced;
 * 3. switching the connection does not restate an earlier call, and a call in
 *    flight keeps the identity it was dispatched under;
 * 4. a remote rejection that is absorbed locally is never rendered as a remote
 *    success, and a rejection is never rendered as an answer.
 *
 * Request ids are irrelevant to every assertion: nothing here infers an upstream
 * model, and no fixture makes the plugin observe one.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { DecisionBackend } from './vendor/harness-reflex/index.js';
import { createReflexRuntime } from './bridge.js';
import { resolveConfig } from './config.js';
import { formatLedgerReport } from './command.js';
import type { ReflexRuntime } from './bridge.js';

/**
 * A synthetic gateway stub: records what was asked and answers from a scripted
 * result, so a test can name the connection it reached without any network.
 */
interface Gateway {
  /** Every request this stub received, oldest first. */
  readonly calls: Array<{ baseUrl: string; model: string; authorization: string }>;
  /** When set, the next request rejects with this message. */
  failNext?: string;
  /** Resolves once the stub has received `count` requests. */
  waitFor(count: number): Promise<void>;
  restore(): void;
}

/**
 * What the stub's answer looks like on the wire.
 *
 * `probabilities` is the criterion→probability record the gateway really sends
 * (see the same envelope in `live-lifecycle.test.ts`), and the question ids are
 * the ones the Jev backend asks under: `choice`, then `assertion-<n>`.
 */
const ANSWER = {
  answers: {
    choice: { type: 'choice', choice: 'yes', confidence: 1, probabilities: { yes: 0.9, no: 0.1 } },
    'assertion-0': {
      type: 'choice',
      choice: 'verified',
      confidence: 1,
      probabilities: { verified: 0.99, contradicted: 0.005, not_addressed: 0.005 }
    }
  }
};

/**
 * Install a fetch stub that answers every System One request locally.
 *
 * `holdAfter` parks the Nth (1-based) request until the returned release is
 * called, which is how the in-flight test keeps one call open across a switch.
 * @param holdAfter - request number to park, if any.
 * @returns the gateway and the release handle.
 */
function stubGateway(holdAfter?: number): { gateway: Gateway; release: () => void } {
  const calls: Gateway['calls'] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  let gate: Promise<void> | undefined;
  let releaseGate: (() => void) | undefined;
  if (holdAfter !== undefined) {
    gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
  }
  const original = globalThis.fetch;
  const stub = (async (input: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    const body = JSON.parse(init?.body ?? '{}') as { model?: string; questions?: Record<string, { type: string }> };
    calls.push({
      baseUrl: url,
      model: body.model ?? '',
      authorization: init?.headers?.Authorization ?? ''
    });
    for (const waiter of waiters.filter((candidate) => candidate.count <= calls.length)) {
      waiter.resolve();
    }
    if (holdAfter !== undefined && calls.length === holdAfter && gate !== undefined) await gate;
    if (gateway.failNext !== undefined) {
      const reason = gateway.failNext;
      gateway.failNext = undefined;
      throw new TypeError(reason);
    }
    // A prune judgment asks one `prune-seg-<n>` question per segment, and a
    // segment keeps only when it scores `'1'`. Answering none of them would make
    // every prune take its own safety fallback and read as `local-fallback`
    // regardless of the gateway, which would hide the very distinction this file
    // tests.
    const asked = Object.keys((body.questions ?? {}) as Record<string, unknown>).filter((id) => id.startsWith('prune-seg-'));
    const answers = { ...ANSWER.answers } as Record<string, unknown>;
    for (const id of asked) answers[id] = { type: 'score', confidence: 0.9, probabilities: { '1': 0.9, '0': 0.1 } };
    return new Response(JSON.stringify({ answers }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  globalThis.fetch = stub;

  const gateway: Gateway = {
    calls,
    waitFor: (count: number) =>
      calls.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ count, resolve });
          }),
    restore: () => {
      globalThis.fetch = original;
    }
  };
  return { gateway, release: () => releaseGate?.() };
}

/**
 * A runtime whose connection is authored per test.
 * @param profile - the active profile's facts (`modelIds`/`selectedModel`).
 * @returns the runtime, to be disposed by the caller.
 */
function runtimeFor(profile: Record<string, unknown>): ReflexRuntime {
  return createReflexRuntime(
    resolveConfig({
      backend: 'jev',
      systemOne: { active: 'gw', profiles: { gw: { baseUrl: 'http://gw.test/v1', apiKey: 'test-key', ...profile } } },
      routing: { enabled: false }
    })
  );
}

test('a tool payload names the connection and the model it requested, and says where the answer came from', async () => {
  const { gateway } = stubGateway();
  const runtime = runtimeFor({ modelIds: ['sys-one-a'], selectedModel: 'sys-one-a' });
  try {
    const result = await runtime.choice({ question: 'ship it?', options: ['yes', 'no'] });
    assert.equal(result.connectionName, 'gw', 'the payload must name the System One connection, not the backend class');
    assert.equal(result.requestedModel, 'sys-one-a', 'the payload must name the model this call requested');
    assert.equal(result.source, 'remote');
    assert.equal(result.detail, undefined, 'a remote answer carries no non-remote reason');
    assert.equal(result.bestOption, 'yes', 'the decision itself is unchanged');
    assert.equal(gateway.calls.at(-1)?.model, 'sys-one-a', 'the requested model is the one really sent');
  } finally {
    gateway.restore();
    runtime.dispose();
  }
});

test('the ledger records the connection, the requested model and the source on the entry the call produced', async () => {
  const { gateway } = stubGateway();
  const runtime = runtimeFor({ modelIds: ['sys-one-a'], selectedModel: 'sys-one-a' });
  try {
    await runtime.choice({ question: 'ship it?', options: ['yes', 'no'] });
    const entry = runtime.ledger.getEntries().at(-1);
    assert.equal(entry?.type, 'choice');
    assert.equal(entry?.details?.systemOneConnection, 'gw');
    assert.equal(entry?.details?.systemOneModel, 'sys-one-a');
    assert.equal(entry?.details?.systemOneSource, 'remote');
    // The ledger keeps the backend class beside the connection: they answer
    // different questions, and collapsing them is what made the payload opaque.
    assert.equal(entry?.backend, 'system-one-jev');
  } finally {
    gateway.restore();
    runtime.dispose();
  }
});

test('a gate ledger entry owned by the decision service carries the same provenance as its payload', async () => {
  const { gateway } = stubGateway();
  const runtime = runtimeFor({ modelIds: ['sys-one-a'], selectedModel: 'sys-one-a' });
  try {
    const verdict = await runtime.gate({ assertions: [{ statement: 'it works' }], evidence: 'the tests pass' });
    assert.equal(verdict.connectionName, 'gw');
    assert.equal(verdict.requestedModel, 'sys-one-a');
    assert.equal(verdict.source, 'remote');
    const entry = runtime.ledger.getEntries().at(-1);
    assert.equal(entry?.type, 'gate');
    assert.equal(entry?.details?.systemOneConnection, 'gw', 'the service-owned entry must carry the connection');
    assert.equal(entry?.details?.systemOneModel, 'sys-one-a');
    assert.equal(entry?.details?.systemOneSource, 'remote');
  } finally {
    gateway.restore();
    runtime.dispose();
  }
});

test('switching the connection does not rewrite an earlier call, and the next call reports the new one', async () => {
  const { gateway } = stubGateway();
  let runtime = runtimeFor({ modelIds: ['sys-one-a'], selectedModel: 'sys-one-a' });
  try {
    const first = await runtime.choice({ question: 'ship it?', options: ['yes', 'no'] });
    assert.equal(first.connectionName, 'gw');
    assert.equal(first.requestedModel, 'sys-one-a');

    // A real connection switch: a different profile, a different model.
    runtime.dispose();
    runtime = createReflexRuntime(
      resolveConfig({
        backend: 'jev',
        systemOne: {
          active: 'second',
          profiles: { gw: { baseUrl: 'http://gw.test/v1', apiKey: 'test-key', modelIds: ['sys-one-a'], selectedModel: 'sys-one-a' },
            second: { baseUrl: 'http://second.test/v1', apiKey: 'test-key-2', modelIds: ['sys-one-b'], selectedModel: 'sys-one-b' } }
        },
        routing: { enabled: false }
      })
    );
    const second = await runtime.choice({ question: 'ship it?', options: ['yes', 'no'] });
    assert.equal(second.connectionName, 'second');
    assert.equal(second.requestedModel, 'sys-one-b');
    assert.match(gateway.calls.at(-1)?.baseUrl ?? '', /second\.test/, 'the second call really reached the new connection');

    // The first call's report is a value, not a view: it still reads as it did.
    assert.equal(first.connectionName, 'gw', 'a later switch must not restate the earlier call');
    assert.equal(first.requestedModel, 'sys-one-a');
  } finally {
    gateway.restore();
    runtime.dispose();
  }
});

test('a call in flight keeps the identity it was dispatched under while the live connection is switched', async () => {
  // One runtime, one config source. The first request is parked on the wire; the
  // connection is then switched *on that same runtime* (the real `refresh()`
  // path), and only afterwards is the parked call released. If the identity were
  // re-read when the answer arrived, the report would name the new connection —
  // which is precisely the "switch rewrites history" bug this test exists for.
  const { gateway, release } = stubGateway(1);
  const authored: Record<string, unknown> = {
    backend: 'jev',
    systemOne: { active: 'gw', profiles: { gw: { baseUrl: 'http://gw.test/v1', apiKey: 'test-key', modelIds: ['sys-one-a'], selectedModel: 'sys-one-a' } } },
    routing: { enabled: false }
  };
  const runtime = createReflexRuntime(resolveConfig(authored), { configSource: authored });
  try {
    const inFlight = runtime.choice({ question: 'slow?', options: ['yes', 'no'] });
    await gateway.waitFor(1);

    authored.systemOne = {
      active: 'second',
      profiles: {
        gw: { baseUrl: 'http://gw.test/v1', apiKey: 'test-key', modelIds: ['sys-one-a'], selectedModel: 'sys-one-a' },
        second: { baseUrl: 'http://second.test/v1', apiKey: 'test-key-2', modelIds: ['sys-one-b'], selectedModel: 'sys-one-b' }
      }
    };
    assert.equal(runtime.refresh(), true, 'the switch is a real live config change');
    assert.equal(runtime.currentCallIdentity().connectionName, 'second', 'the runtime now reports the new connection');

    release();
    const settled = await inFlight;
    assert.equal(settled.connectionName, 'gw', 'the in-flight call keeps the connection it was dispatched under');
    assert.equal(settled.requestedModel, 'sys-one-a');
    assert.equal(settled.source, 'remote');
    assert.match(gateway.calls[0]?.baseUrl ?? '', /gw\.test/, 'the in-flight call reached the old connection, as reported');

    // The next call is the new connection's, so the snapshot is per-dispatch
    // rather than frozen for the activation.
    const next = await runtime.choice({ question: 'fast?', options: ['yes', 'no'] });
    assert.equal(next.connectionName, 'second');
    assert.equal(next.requestedModel, 'sys-one-b');
  } finally {
    gateway.restore();
    runtime.dispose();
  }
});

test('a rejected remote call is reported as rejected and never as a remote answer', async () => {
  const { gateway } = stubGateway();
  gateway.failNext = 'fetch failed';
  const runtime = runtimeFor({ modelIds: ['sys-one-a'], selectedModel: 'sys-one-a' });
  try {
    await assert.rejects(runtime.choice({ question: 'ship it?', options: ['yes', 'no'] }), /fetch failed/);
    const entry = runtime.ledger.getEntries().at(-1);
    assert.equal(entry?.type, 'choice', 'the rejected attempt is still audited');
    assert.equal(entry?.details?.systemOneConnection, 'gw');
    assert.equal(entry?.details?.systemOneModel, 'sys-one-a');
    assert.equal(entry?.details?.systemOneSource, 'rejected', 'a rejection must not be recorded as a remote success');
    assert.match(String(entry?.details?.systemOneDetail ?? ''), /fetch failed/);
  } finally {
    gateway.restore();
    runtime.dispose();
  }
});

test('a gate rejection absorbed into a fail-closed verdict is reported as rejected, not as a System One judgement', async () => {
  const { gateway } = stubGateway();
  gateway.failNext = 'fetch failed';
  const runtime = runtimeFor({ modelIds: ['sys-one-a'], selectedModel: 'sys-one-a' });
  try {
    const verdict = await runtime.gate({ assertions: [{ statement: 'it works' }], evidence: 'the tests pass' });
    // The gate contract is unchanged: it still escalates rather than throwing.
    assert.equal(verdict.passed, false);
    assert.equal(verdict.needsEscalation, true);
    assert.equal(verdict.results[0]?.outcome, 'escalate');
    assert.equal(verdict.source, 'rejected', 'a locally produced escalation must not read as a remote verdict');
    assert.match(verdict.detail ?? '', /fetch failed/);
    assert.equal(runtime.ledger.getEntries().at(-1)?.details?.systemOneSource, 'rejected');
  } finally {
    gateway.restore();
    runtime.dispose();
  }
});

test('a pruning that falls back locally after a rejection says so, and one that never asked does too', async () => {
  const { gateway } = stubGateway();
  const runtime = runtimeFor({ modelIds: ['sys-one-a'], selectedModel: 'sys-one-a' });
  try {
    gateway.failNext = 'fetch failed';
    // Large enough to pass the judge threshold, so the segmented path really runs
    // and its failure really has to be absorbed.
    const bulky = Array.from({ length: 400 }, (_, index) => `line ${index} of a bulky payload`).join('\n');
    const fellBack = await runtime.prune({ rawOutput: bulky, intent: 'line 7' });
    assert.equal(fellBack.source, 'local-fallback', 'an absorbed rejection is a local fallback, never remote');
    assert.match(fellBack.detail ?? '', /fetch failed/);
    const entry = runtime.ledger.getEntries().at(-1);
    assert.equal(entry?.details?.systemOneSource, 'local-fallback');
    assert.equal(entry?.details?.systemOneConnection, 'gw');
    assert.equal(entry?.details?.systemOneModel, 'sys-one-a');
  } finally {
    gateway.restore();
    runtime.dispose();
  }
});

test('a connection that sends nothing answers locally, and says so instead of claiming a remote call', () => {
  const runtime = createReflexRuntime(resolveConfig({ backend: 'mock', routing: { enabled: false } }));
  try {
    return runtime.choice({ question: 'ship it?', options: ['yes', 'no'] }).then((result) => {
      assert.equal(result.connectionName, 'mock');
      assert.equal(result.requestedModel, null, 'an in-process connection requests no model');
      assert.equal(result.source, 'local');
      assert.equal(runtime.ledger.getEntries().at(-1)?.details?.systemOneSource, 'local');
    }).finally(() => runtime.dispose());
  } catch (error) {
    runtime.dispose();
    throw error;
  }
});

test('a connection that cannot send is named unconfigured, and no model is claimed for it', async () => {
  // A document with profiles but none activated. Config resolution already
  // refuses to build a transport for it (g-066), so no request can be made and
  // the identity must say "unconfigured" — not name the model a profile lists.
  const runtime = createReflexRuntime(
    resolveConfig({
      backend: 'jev',
      systemOne: { profiles: { gw: { baseUrl: 'http://gw.test/v1', apiKey: 'test-key', modelIds: ['sys-one-a'], selectedModel: 'sys-one-a' } } },
      routing: { enabled: false }
    })
  );
  try {
    const identity = runtime.currentCallIdentity();
    assert.equal(identity.connectionName, 'unconfigured');
    assert.equal(identity.requestedModel, null, 'no model was requested, so none may be named');
    const result = await runtime.choice({ question: 'ship it?', options: ['yes', 'no'] });
    assert.equal(result.connectionName, 'unconfigured');
    assert.equal(result.requestedModel, null);
    assert.equal(result.source, 'local', 'local heuristics answered; no connection was asked');
  } finally {
    runtime.dispose();
  }
});

test('/reflex-ledger prints the provenance of each recorded call, and nothing for an entry that predates it', () => {
  const summary = { totalCalls: 2, callsByType: { choice: 2 }, totalTokensSaved: 0, avgLatencyMs: 1, estimatedCostSavedUsd: 0, stagnationAlerts: 0, gatePassedCount: 0, gateFailedCount: 0 };
  const stamped = {
    id: 'ref_1',
    timestamp: '2026-11-21T12:00:00.000Z',
    type: 'choice' as const,
    backend: 'system-one-jev',
    latencyMs: 3,
    details: { systemOneConnection: 'gw', systemOneModel: 'sys-one-a', systemOneSource: 'remote' }
  };
  const rejected = {
    id: 'ref_2',
    timestamp: '2026-11-21T12:00:01.000Z',
    type: 'choice' as const,
    backend: 'system-one-jev',
    latencyMs: 0,
    details: { systemOneConnection: 'gw', systemOneModel: 'sys-one-a', systemOneSource: 'rejected', systemOneDetail: 'fetch failed' }
  };
  const report = formatLedgerReport({ summary, recentEntries: [stamped, rejected] });
  assert.match(report, /gw · 请求模型 sys-one-a/, 'the connection and the requested model are printed');
  assert.match(report, /拒绝 rejected/, 'a rejection is printed as a rejection');
  assert.match(report, /fetch failed/, 'the rejection reason is printed');

  // An entry written before g-068 has no provenance, and none is invented for it
  // from the settings in force today.
  const legacy = formatLedgerReport({
    summary,
    recentEntries: [{ id: 'ref_0', timestamp: '2026-11-21T11:00:00.000Z', type: 'choice', backend: 'system-one-jev', latencyMs: 2 } as never]
  });
  assert.doesNotMatch(legacy, /请求模型/, 'a legacy entry must not be given a connection it never recorded');
});

test('the JSONL ledger file records the same provenance the in-memory entry does', async () => {
  // `ReflexGateService` writes its line *before* the answer settles, so the file
  // could otherwise carry the identity but never the source. A reader of the file
  // — the `/reflex-ledger` command after a restart, or a human with `jq` — must
  // not see a rejection as a remote success.
  const dir = mkdtempSync(join(tmpdir(), 'reflex-g068-'));
  const ledgerPath = join(dir, 'ledger.jsonl');
  const { gateway } = stubGateway();
  const runtime = createReflexRuntime(
    resolveConfig({
      backend: 'jev',
      ledgerPath,
      systemOne: { active: 'gw', profiles: { gw: { baseUrl: 'http://gw.test/v1', apiKey: 'test-key', modelIds: ['sys-one-a'], selectedModel: 'sys-one-a' } } },
      routing: { enabled: false }
    })
  );
  try {
    gateway.failNext = 'fetch failed';
    await runtime.gate({ assertions: [{ statement: 'it works' }], evidence: 'the tests pass' });
    const persisted = readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; details?: Record<string, unknown> });
    const gate = persisted.filter((entry) => entry.type === 'gate').pop();
    assert.ok(gate, 'the gate call was persisted');
    assert.equal(gate.details?.systemOneConnection, 'gw');
    assert.equal(gate.details?.systemOneModel, 'sys-one-a');
    assert.equal(gate.details?.systemOneSource, 'rejected', 'the file must not record a local verdict as remote');
    assert.match(String(gate.details?.systemOneDetail ?? ''), /fetch failed/);
    assert.doesNotMatch(readFileSync(ledgerPath, 'utf8'), /test-key/, 'the file must never carry the key');
  } finally {
    gateway.restore();
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the backend a call reports is never the main model, and no payload ever carries a credential', async () => {
  const { gateway } = stubGateway();
  const runtime = runtimeFor({ modelIds: ['sys-one-a'], selectedModel: 'sys-one-a' });
  try {
    const result = await runtime.choice({ question: 'ship it?', options: ['yes', 'no'] });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /test-key/, 'the payload must never carry the API key');
    assert.doesNotMatch(serialized, /Bearer/, 'the payload must never carry an authorization header');
    // The session's own model is whatever the Host runs; nothing here knows it,
    // and the connection/model reported are the System One ones.
    assert.equal(result.requestedModel, 'sys-one-a');
    assert.notEqual(result.connectionName, result.requestedModel);
    const ledger = JSON.stringify(runtime.ledger.getEntries());
    assert.doesNotMatch(ledger, /test-key/, 'the ledger must never carry the API key');
  } finally {
    gateway.restore();
    runtime.dispose();
  }
});

/**
 * The att-001 review's BLOCK-1 and BLOCK-2: overlapping calls, and an
 * append-only ledger.
 *
 * The first attempt kept one shared "current stamp" and rewrote the last JSONL
 * line when the answer settled. Two overlapping prunes then destroyed each
 * other's attribution — the fast call's `clearStamp()` wiped the slow call's
 * stamp, so the slow call's ledger entry had *no* connection and *no* source
 * while its payload said `local-fallback` — and a rewrite could relabel a line
 * that belonged to another call. These tests pin the fix: per-call rings, one
 * append per call, and a payload that always agrees with its own entry.
 */
test('two overlapping calls — one slow and failing, one fast and succeeding — each keep their own provenance', async () => {
  // The slow call parks on the wire and then fails; the fast one runs to
  // completion *while* the slow one is still in flight. With a shared stamp the
  // fast call would erase the slow call's attribution mid-flight.
  const { gateway, release } = stubGateway(1);
  const runtime = runtimeFor({ modelIds: ['sys-one-a'], selectedModel: 'sys-one-a' });
  try {
    const bulky = Array.from({ length: 400 }, (_, index) => `line ${index} of a bulky payload`).join('\n');
    const slow = runtime.prune({ rawOutput: bulky, intent: 'line 7' });
    await gateway.waitFor(1);
    const fast = await runtime.prune({ rawOutput: bulky, intent: 'line 7' });
    assert.equal(fast.source, 'remote', 'the fast call answered from the gateway');
    // Only now is the parked call released *into a failure*, so the slow call is
    // the one that lands as an absorbed rejection while the fast one already
    // succeeded — the exact ordering the review reproduced the bug with.
    gateway.failNext = 'fetch failed';
    release();
    const slowResult = await slow;
    assert.equal(slowResult.source, 'local-fallback', 'the slow call had its failure absorbed locally');

    // Three entries: two prunes and nothing else. Each must carry its own
    // connection and its own source — the slow one included.
    const entries = runtime.ledger.getEntries();
    assert.equal(entries.length, 2, `expected one entry per call, got ${entries.length}`);
    for (const entry of entries) {
      assert.equal(entry.details?.systemOneConnection, 'gw', `entry ${entry.id} lost its connection`);
      assert.equal(entry.details?.systemOneModel, 'sys-one-a');
      assert.ok(
        entry.details?.systemOneSource === 'remote' || entry.details?.systemOneSource === 'local-fallback',
        `entry ${entry.id} lost its source`
      );
    }
    const sources = entries.map((entry) => entry.details?.systemOneSource).sort();
    assert.deepEqual(sources, ['local-fallback', 'remote'], 'each call keeps the source its own answer earned');
    // The payloads and the entries tell one story, not two.
    assert.equal(sources.filter((source) => source === slowResult.source).length >= 1, true);
  } finally {
    gateway.restore();
    runtime.dispose();
  }
});

test('the JSONL ledger is only appended to: an earlier line is byte-identical after a later call settles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reflex-g068-append-'));
  const ledgerPath = join(dir, 'ledger.jsonl');
  const { gateway } = stubGateway();
  const runtime = createReflexRuntime(
    resolveConfig({
      backend: 'jev',
      ledgerPath,
      systemOne: { active: 'gw', profiles: { gw: { baseUrl: 'http://gw.test/v1', apiKey: 'test-key', modelIds: ['sys-one-a'], selectedModel: 'sys-one-a' } } },
      routing: { enabled: false }
    })
  );
  try {
    await runtime.choice({ question: 'first?', options: ['yes', 'no'] });
    const afterFirst = readFileSync(ledgerPath, 'utf8');
    assert.equal(afterFirst.trim().split('\n').length, 1, 'one call appends one line');
    const firstLine = afterFirst.trim();

    gateway.failNext = 'fetch failed';
    await assert.rejects(runtime.choice({ question: 'second?', options: ['yes', 'no'] }), /fetch failed/);
    const afterSecond = readFileSync(ledgerPath, 'utf8');
    // The first line is untouched — not re-serialised, not re-ordered, not
    // relabelled. A rejection settling later must not restate an earlier call.
    assert.equal(afterSecond.split('\n')[0], firstLine, 'an earlier line must never be rewritten');
    const lines = afterSecond.trim().split('\n').map((line) => JSON.parse(line) as { details?: Record<string, unknown> });
    assert.equal(lines.length, 2, 'the second call appended exactly one line');
    assert.equal(lines[1]?.details?.systemOneSource, 'rejected', 'the appended line already carries its final source');
  } finally {
    gateway.restore();
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a vLLM connection that exposes no failure record reports unknown rather than claiming a remote answer', async () => {
  // BLOCK-4. `LogitsSystemOneBackend` has no `health()`, so when the gate absorbs
  // a gateway rejection into a fail-closed verdict nothing proves the request was
  // ever answered. Claiming `remote` there is the falsehood g-068 forbids; the
  // verdict itself is unchanged, only the provenance claim is withdrawn.
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('boom', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof fetch;
  const runtime = createReflexRuntime(
    resolveConfig({
      backend: 'vllm',
      systemOne: {
        active: 'vl',
        profiles: { vl: { baseUrl: 'http://vllm.test/v1', backend: 'vllm', apiKey: 'test-key', modelIds: ['qwen'], selectedModel: 'qwen' } }
      },
      routing: { enabled: false }
    })
  );
  try {
    const verdict = await runtime.gate({ assertions: [{ statement: 'it works' }], evidence: 'the tests pass' });
    // The fail-closed contract is untouched.
    assert.equal(verdict.passed, false);
    assert.equal(verdict.needsEscalation, true);
    assert.equal(verdict.connectionName, 'vl');
    assert.equal(verdict.requestedModel, 'qwen');
    assert.equal(verdict.source, 'unknown', 'no evidence proves the request was answered');
    assert.match(verdict.detail ?? '', /exposes no failure record/);
    const entry = runtime.ledger.getEntries().at(-1);
    assert.equal(entry?.details?.systemOneSource, 'unknown', 'the ledger must agree with the payload');
    assert.equal(entry?.details?.systemOneConnection, 'vl');
    const serialized = JSON.stringify(runtime.ledger.getEntries());
    assert.doesNotMatch(serialized, /test-key/, 'no credential reaches the ledger');
  } finally {
    globalThis.fetch = original;
    runtime.dispose();
  }
});

test('a JEV rejection is still provable, so the same gate reports rejected rather than unknown', async () => {
  // The positive control for the test above: with a failure record available,
  // the absorbed rejection *is* provable and must not be downgraded to unknown.
  const { gateway } = stubGateway();
  gateway.failNext = 'fetch failed';
  const runtime = runtimeFor({ modelIds: ['sys-one-a'], selectedModel: 'sys-one-a' });
  try {
    const verdict = await runtime.gate({ assertions: [{ statement: 'it works' }], evidence: 'the tests pass' });
    assert.equal(verdict.source, 'rejected');
    assert.match(verdict.detail ?? '', /fetch failed/);
    assert.equal(runtime.ledger.getEntries().at(-1)?.details?.systemOneSource, 'rejected');
  } finally {
    gateway.restore();
    runtime.dispose();
  }
});
