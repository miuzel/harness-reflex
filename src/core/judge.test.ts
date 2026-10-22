/**
 * The deterministic pre-trigger, the judgment memo, and the cost charge.
 *
 * The tests pin the cheap path (what is worth judging), the once-per-turn memo,
 * both budget boundaries, and the exactly-once charge — the invariants the
 * automatic interventions' cost accounting rests on.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { StagnationCheckResponse } from '../backend/types.js';
import {
  countTrailingFailures,
  countTrailingRepeats,
  detectOscillation,
  judgmentCharge,
  judgmentKey,
  runJudgment,
  suspicionOf,
  type JudgmentState,
  type ObservedStep
} from './judge.js';
import type { PolicySnapshot } from './policy.js';

/** One observed step with sane defaults. */
function step(overrides: Partial<ObservedStep> = {}): ObservedStep {
  return {
    signature: 'tool:aaaa',
    tool: 'tool',
    input: '{}',
    output: 'ok',
    error: '',
    failed: false,
    turn: 1,
    at: 1,
    ...overrides
  };
}

/** A resolved policy helper. */
function policy(overrides: Partial<PolicySnapshot> = {}): PolicySnapshot {
  return {
    enabled: true,
    mode: 'observe',
    capabilities: { stagnation: 'observe', prune: 'observe', gate: 'observe', closing: 'observe' },
    maxInterventionsPerTurn: 3,
    maxJudgmentsPerTurn: 3,
    maxJudgmentsPerSession: 20,
    repeatThreshold: 3,
    minConfidence: 0.6,
    ...overrides
  };
}

/** A judgment state helper. */
function state(overrides: Partial<JudgmentState> = {}): JudgmentState {
  return {
    turn: 1,
    interventions: 0,
    judgmentsCount: 0,
    judgmentsSession: 0,
    verdictTurn: 0,
    verdictKey: '',
    ...overrides
  };
}

/** A backend that counts calls and returns one verdict. */
function backend(response: Partial<StagnationCheckResponse> = {}) {
  const stateful = { calls: 0 };
  return {
    calls: () => stateful.calls,
    port: {
      async check(): Promise<StagnationCheckResponse> {
        stateful.calls += 1;
        return { isStuck: true, confidence: 0.9, patternType: 'repetition', latencyMs: 5, ...response };
      }
    }
  };
}

test('countTrailingRepeats measures only the trailing run of one signature', () => {
  const steps = [step({ signature: 'a' }), step({ signature: 'b' }), step({ signature: 'b' })];
  assert.equal(countTrailingRepeats(steps, 'b'), 2);
  assert.equal(countTrailingRepeats(steps, 'a'), 0);
});

test('countTrailingFailures measures the trailing failing run', () => {
  const steps = [step({ failed: false }), step({ failed: true }), step({ failed: true })];
  assert.equal(countTrailingFailures(steps), 2);
  assert.equal(countTrailingFailures([step()]), 0);
});

test('detectOscillation sees A-B-A-B but not three distinct identities', () => {
  const abab = [step({ signature: 'a' }), step({ signature: 'b' }), step({ signature: 'a' }), step({ signature: 'b' })];
  assert.equal(detectOscillation(abab, 6), true);
  const abc = [...abab.slice(0, 3), step({ signature: 'c' })];
  assert.equal(detectOscillation(abc, 6), false);
});

test('suspicionOf reports a repetition at the threshold', () => {
  const sig = 'tool:aaaa';
  const steps = [step({ signature: sig }), step({ signature: sig }), step({ signature: sig })];
  const suspicion = suspicionOf(steps, { repeatThreshold: 3, failureThreshold: 3, window: 6, signature: sig });
  assert.equal(suspicion.suspicious, true);
  assert.equal(suspicion.pattern, 'repetition');
  assert.equal(suspicion.repeats, 3);
});

test('suspicionOf reports a failing retry at the failure threshold', () => {
  const steps = [step({ failed: true }), step({ failed: true }), step({ failed: true })];
  const suspicion = suspicionOf(steps, { repeatThreshold: 3, failureThreshold: 3, window: 6, signature: 'fresh' });
  assert.equal(suspicion.pattern, 'failing_retry');
  assert.equal(suspicion.repeats, 3);
});

test('suspicionOf reports oscillation only when no consecutive run qualifies', () => {
  const steps = [
    step({ signature: 'a' }),
    step({ signature: 'b' }),
    step({ signature: 'a' }),
    step({ signature: 'b' })
  ];
  const suspicion = suspicionOf(steps, { repeatThreshold: 3, failureThreshold: 3, window: 6, signature: 'a' });
  assert.equal(suspicion.pattern, 'oscillation');
});

test('suspicionOf stays quiet on an ordinary window', () => {
  const suspicion = suspicionOf([step({ signature: 'a' }), step({ signature: 'b' })], {
    repeatThreshold: 3,
    failureThreshold: 3,
    window: 6,
    signature: 'c'
  });
  assert.equal(suspicion.suspicious, false);
  assert.equal(suspicion.repeats, 0);
});

test('judgmentKey is stable for the same goal/window and changes with either', () => {
  const steps = [step({ signature: 'a' }), step({ signature: 'b' })];
  assert.equal(judgmentKey(undefined, steps, 3), judgmentKey(undefined, steps, 3));
  assert.notEqual(judgmentKey('wait', steps, 3), judgmentKey(undefined, steps, 3));
  assert.notEqual(judgmentKey(undefined, [...steps, step({ signature: 'c' })], 3), judgmentKey(undefined, steps, 3));
});

test('runJudgment buys one call and reuses it for the same window and turn', async () => {
  const fake = backend();
  const s = state();
  const steps = [step({ signature: 'a' })];
  const first = await runJudgment({ state: s, policy: policy(), backend: fake.port, clock: { now: () => 100 }, steps });
  const second = await runJudgment({ state: s, policy: policy(), backend: fake.port, clock: { now: () => 200 }, steps });
  assert.equal(first.paid, true);
  assert.equal(first.useful, true);
  assert.equal(second.paid, false);
  assert.equal(second.reused, true);
  assert.equal(fake.calls(), 1);
  assert.equal(s.judgmentsCount, 1);
  assert.equal(s.judgmentsSession, 1);
});

test('runJudgment refuses at the turn cap without calling the backend', async () => {
  const fake = backend();
  const s = state({ judgmentsCount: 1 });
  const outcome = await runJudgment({
    state: s,
    policy: policy({ maxJudgmentsPerTurn: 1 }),
    backend: fake.port,
    clock: { now: () => 100 },
    steps: [step()]
  });
  assert.equal(outcome.paid, false);
  assert.equal(outcome.skip, 'judgment-turn-cap');
  assert.equal(fake.calls(), 0);
  assert.equal(outcome.response.isStuck, false);
});

test('runJudgment reports an aborted call instead of judging it', async () => {
  const fake = backend();
  const controller = new AbortController();
  controller.abort();
  const outcome = await runJudgment({
    state: state(),
    policy: policy(),
    backend: fake.port,
    clock: { now: () => 100 },
    steps: [step()],
    signal: controller.signal
  });
  assert.equal(outcome.skip, 'aborted');
  assert.equal(fake.calls(), 0);
});

test('judgmentCharge bills a paid call once and a memo hit as a hit', () => {
  const paid = judgmentCharge(
    { paid: true, reused: false, judgeTokens: 12, localLatencyMs: 3, remoteLatencyMs: 20 },
    1000,
    1030
  );
  assert.equal(paid.judgments, 1);
  assert.equal(paid.judgeTokens, 12);
  assert.equal(paid.remoteLatencyMs, 20);
  assert.equal(paid.localLatencyMs, Math.max(3, 30 - 20));
  const reused = judgmentCharge(
    { paid: false, reused: true, judgeTokens: 0, localLatencyMs: 0, remoteLatencyMs: 0 },
    1000,
    1010
  );
  assert.equal(reused.judgments, 0);
  assert.equal(reused.memoHits, 1);
});
