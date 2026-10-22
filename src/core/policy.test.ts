/**
 * The three-state policy and the shared budgets.
 *
 * These tests pin the *decision* semantics a host depends on: an off capability
 * is absent, observe/active are both enabled, and neither budget can be overrun
 * — while a refused judgment does not consume the other budget.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actionWithinBudget,
  bookAction,
  DECISION_CAPABILITIES,
  enabledCapability,
  modeOf,
  serves,
  spendJudgment,
  usefulVerdict,
  type BudgetState,
  type DecisionMode,
  type PolicySnapshot
} from './policy.js';

/** A policy helper with explicit per-capability modes. */
function policy(overrides: {
  enabled?: boolean;
  modes?: Partial<Record<(typeof DECISION_CAPABILITIES)[number], DecisionMode>>;
  maxInterventionsPerTurn?: number;
  maxJudgmentsPerTurn?: number;
  maxJudgmentsPerSession?: number;
  minConfidence?: number;
} = {}): PolicySnapshot {
  return {
    enabled: overrides.enabled ?? true,
    mode: 'observe',
    capabilities: {
      stagnation: overrides.modes?.stagnation ?? 'observe',
      prune: overrides.modes?.prune ?? 'observe',
      gate: overrides.modes?.gate ?? 'observe',
      closing: overrides.modes?.closing ?? 'observe'
    },
    maxInterventionsPerTurn: overrides.maxInterventionsPerTurn ?? 3,
    maxJudgmentsPerTurn: overrides.maxJudgmentsPerTurn ?? 3,
    maxJudgmentsPerSession: overrides.maxJudgmentsPerSession ?? 20,
    repeatThreshold: 3,
    minConfidence: overrides.minConfidence ?? 0.6
  };
}

/** Fresh counters. */
function state(overrides: Partial<BudgetState> = {}): BudgetState {
  return { interventions: 0, judgmentsCount: 0, judgmentsSession: 0, ...overrides };
}

test('modeOf reads the resolved per-capability mode', () => {
  assert.equal(modeOf(policy({ modes: { prune: 'active' } }), 'prune'), 'active');
  assert.equal(modeOf(policy({ modes: { gate: 'off' } }), 'gate'), 'off');
});

test('enabledCapability needs the master switch and a non-off mode', () => {
  assert.equal(enabledCapability(policy({ modes: { closing: 'off' } }), 'closing'), false);
  assert.equal(enabledCapability(policy({ enabled: false }), 'stagnation'), false);
  assert.equal(enabledCapability(policy({ modes: { stagnation: 'observe' } }), 'stagnation'), true);
});

test('serves accepts a hook when any of its capabilities is not off', () => {
  assert.equal(serves(policy({ modes: { closing: 'off' } }), 'closing', 'prune'), true);
  assert.equal(serves(policy({ modes: { closing: 'off', prune: 'off' } }), 'closing', 'prune'), false);
  assert.equal(serves(policy({ enabled: false, modes: { prune: 'active' } }), 'prune'), false);
});

test('the action ceiling admits exactly maxInterventionsPerTurn plans', () => {
  const p = policy({ maxInterventionsPerTurn: 2 });
  const s = state();
  assert.equal(actionWithinBudget(s, p), true);
  bookAction(s);
  assert.equal(actionWithinBudget(s, p), true);
  bookAction(s);
  assert.equal(actionWithinBudget(s, p), false);
  assert.equal(s.interventions, 2);
});

test('a spent judgment increments both the turn and session counters', () => {
  const s = state();
  assert.equal(spendJudgment(s, policy()), undefined);
  assert.equal(s.judgmentsCount, 1);
  assert.equal(s.judgmentsSession, 1);
});

test('the turn cap refuses without spending either counter', () => {
  const s = state({ judgmentsCount: 1 });
  assert.equal(spendJudgment(s, policy({ maxJudgmentsPerTurn: 1 })), 'judgment-turn-cap');
  assert.equal(s.judgmentsCount, 1);
  assert.equal(s.judgmentsSession, 0);
});

test('the session cap refuses even when the turn has room', () => {
  const s = state({ judgmentsSession: 2 });
  assert.equal(spendJudgment(s, policy({ maxJudgmentsPerSession: 2 })), 'judgment-session-cap');
  assert.equal(s.judgmentsCount, 0);
});

test('a verdict acts only when stuck, confident enough, and about a pattern', () => {
  const p = policy({ minConfidence: 0.6 });
  assert.equal(usefulVerdict({ isStuck: true, confidence: 0.9, patternType: 'repetition' }, p), true);
  assert.equal(usefulVerdict({ isStuck: false, confidence: 0.9, patternType: 'repetition' }, p), false);
  assert.equal(usefulVerdict({ isStuck: true, confidence: 0.5, patternType: 'repetition' }, p), false);
  assert.equal(usefulVerdict({ isStuck: true, confidence: 0.9, patternType: 'none' }, p), false);
  assert.equal(usefulVerdict({ isStuck: true, confidence: 0.9 }, p), false);
});
