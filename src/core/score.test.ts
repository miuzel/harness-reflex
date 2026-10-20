import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DecisionBackend, ChoiceRequest, ChoiceResponse } from '../backend/types.js';
import { MockDecisionBackend } from '../backend/mock.js';
import { DEFAULT_SCORE_CRITERIA, SCORE_OPTIONS, buildScoreQuestion, scoreStatement } from './score.js';

/** Deterministic backend that reports the bucket probabilities handed to it. */
class StubChoiceBackend implements DecisionBackend {
  readonly name = 'stub';
  readonly model = 'stub';
  lastRequest?: ChoiceRequest;

  constructor(private readonly probabilities: number[]) {}

  async choice(req: ChoiceRequest): Promise<ChoiceResponse> {
    this.lastRequest = req;
    const options = req.options.map((label, index) => ({
      label,
      probability: this.probabilities[index] ?? 0
    }));
    return {
      options,
      bestOption: options[0].label,
      confidence: options[0].probability,
      latencyMs: 4
    };
  }

  async gate(): Promise<never> {
    throw new Error('not used');
  }

  async prune(): Promise<never> {
    throw new Error('not used');
  }

  async checkStagnation(): Promise<never> {
    throw new Error('not used');
  }

  async route(): Promise<never> {
    throw new Error('not used');
  }
}

test('scoreStatement projects the bucket distribution into one 0..1 score', async () => {
  const backend = new StubChoiceBackend([0.8, 0.1, 0.1]);

  const result = await scoreStatement(backend, { statement: 'tests pass', criteria: 'reliability' });

  assert.equal(result.statement, 'tests pass');
  assert.deepEqual(result.distribution, { high: 0.8, medium: 0.1, low: 0.1 });
  assert.equal(result.score, 0.78);
  assert.equal(result.latencyMs, 4);

  assert.equal(backend.lastRequest?.options.length, 3);
  assert.equal(backend.lastRequest?.question, buildScoreQuestion('reliability'));
  assert.equal(backend.lastRequest?.context, 'Statement: tests pass\nContext: None');
});

test('missing buckets contribute nothing and the default rubric is applied', async () => {
  const backend = new StubChoiceBackend([0, 0, 0]);

  const result = await scoreStatement(backend, { statement: '' });

  assert.equal(result.score, 0);
  assert.deepEqual(result.distribution, { high: 0, medium: 0, low: 0 });
  assert.equal(backend.lastRequest?.question, buildScoreQuestion(DEFAULT_SCORE_CRITERIA));
  assert.deepEqual(backend.lastRequest?.options, [...SCORE_OPTIONS]);
});

test('the local mock backend produces an in-range score', async () => {
  const result = await scoreStatement(new MockDecisionBackend(), {
    statement: 'the build succeeded and every unit test passed',
    criteria: 'verification quality'
  });

  assert.ok(result.score >= 0 && result.score <= 1, `score out of range: ${result.score}`);
  const total = result.distribution.high + result.distribution.medium + result.distribution.low;
  assert.ok(Math.abs(total - 1) < 0.01, `distribution does not sum to 1: ${total}`);
});
