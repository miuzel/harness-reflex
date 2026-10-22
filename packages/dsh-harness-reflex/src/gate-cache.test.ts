import assert from 'node:assert/strict';
import test from 'node:test';

import { MockDecisionBackend } from './vendor/harness-reflex/backend/mock.js';
import type { GateRequest, GateResponse } from './vendor/harness-reflex/backend/types.js';
import { createReflexRuntime } from './bridge.js';
import { resolveConfig } from './config.js';
import { createReflexHost, resultValue } from './testing.js';

const assertions = [{ statement: 'All tests passed.' }];
const good = 'All tests: 10 passed, 0 failed';
const bad = 'All tests: 10 passed, 1 failed';

class CountingMock extends MockDecisionBackend {
  readonly requests: GateRequest[] = [];
  override async gate(request: GateRequest) {
    this.requests.push(request);
    return super.gate(request);
  }
}

function fixture() {
  const backend = new CountingMock();
  const runtime = createReflexRuntime(resolveConfig({ backend: 'mock' }), { backend });
  return { backend, service: runtime.gateService };
}

for (const order of [[good, bad], [bad, good]]) {
  test(`gate cache binds equal-length evidence in ${order[0] === good ? 'positive-negative' : 'negative-positive'} order`, async () => {
    const { service, backend } = fixture();
    assert.equal(good.length, bad.length);
    for (const evidence of order) {
      const result = await service.verify(assertions, evidence);
      assert.equal(result.passed, evidence === good);
      assert.equal(result.results[0].outcome, evidence === good ? 'verified' : 'contradicted');
    }
    assert.equal(backend.requests.length, 2);
    await service.verify(assertions, order[0]);
    assert.equal(backend.requests.length, 2, 'identical input is still cached');
    service.resetLatch();
    await service.verify(assertions, order[0]);
    assert.equal(backend.requests.length, 3, 'resetLatch still clears cached verdicts');
  });
}

test('gate cache separates assertion contents, boundaries and per-assertion criteria', async () => {
  const { service, backend } = fixture();
  const first = await service.verify([{ statement: 'alpha;beta' }], good);
  const split = await service.verify([{ statement: 'alpha' }, { statement: 'beta' }], good);
  assert.equal(first.results.length, 1);
  assert.equal(split.results.length, 2, 'joined statement delimiters cannot collide');
  const changed = await service.verify([{ statement: 'tests passed' }], good);
  const other = await service.verify([{ statement: 'tests broken' }], good);
  assert.equal(changed.results[0].statement.length, other.results[0].statement.length);
  assert.equal(other.results[0].statement, 'tests broken');
  const allow = await service.verify([{ statement: assertions[0].statement, criteria: 'allow' }], good);
  await service.verify([{ statement: assertions[0].statement, criteria: 'block' }], good);
  assert.equal(backend.requests.length, 6, 'changed criteria reaches the backend');
  const again = await service.verify([{ criteria: 'allow', statement: assertions[0].statement }], good);
  assert.strictEqual(again, allow, 'property insertion order does not alter identity');
  assert.equal(backend.requests.length, 6);
});

test('gate cache binds effective strictness, treating omitted and normal identically', async () => {
  const { service, backend } = fixture();
  const claims = [{ statement: 'Deployment finished.' }];
  const normal = await service.verify(claims, 'No useful evidence.');
  const high = await service.verify(claims, 'No useful evidence.', { strictness: 'high' });
  assert.equal(normal.passed, false);
  assert.equal(normal.needsEscalation, false);
  assert.equal(high.needsEscalation, true);
  assert.strictEqual(await service.verify(claims, 'No useful evidence.', { strictness: 'normal' }), normal);
  assert.equal(backend.requests.length, 2);
});

test('explicit latch namespace isolates callers without overriding verification identity', async () => {
  const { service, backend } = fixture();
  const options = { latchCacheKey: 'closing:turn:1' };
  const positive = await service.verify(assertions, good, options);
  const negative = await service.verify(assertions, bad, options);
  assert.equal(positive.passed, true);
  assert.equal(negative.passed, false);
  assert.strictEqual(await service.verify(assertions, good, options), positive);
  assert.strictEqual(await service.verify(assertions, bad, options), negative);
  assert.equal(backend.requests.length, 2);
  await service.verify(assertions, good, { latchCacheKey: 'closing:turn:2' });
  assert.equal(backend.requests.length, 3, 'distinct namespaces stay isolated');
});

test('gate cache retains fail-closed empty-input and backend-exception behavior', async () => {
  const { service, backend } = fixture();
  for (const result of [await service.verify([], good), await service.verify(assertions, '')]) {
    assert.equal(result.passed, false);
    assert.equal(result.needsEscalation, true);
  }
  assert.equal(backend.requests.length, 0);
  let calls = 0;
  backend.gate = async () => { calls++; throw new Error('offline'); };
  const result = await service.verify(assertions, good);
  assert.equal(result.passed, false);
  assert.equal(result.results[0].outcome, 'escalate');
  assert.strictEqual(await service.verify(assertions, good), result);
  assert.equal(calls, 1);
});

for (const order of [[good, bad], [bad, good]]) {
  test(`registered DSH gate isolates equal-length evidence in ${order[0] === good ? 'positive-negative' : 'negative-positive'} order`, async () => {
    const host = await createReflexHost({ backend: 'mock' });
    try {
      for (const evidence of [...order, order[0]]) {
        const result = resultValue<GateResponse>(await host.callTool('reflex_gate', { assertions, evidence }));
        assert.equal(result.passed, evidence === good);
        assert.equal(result.results[0].outcome, evidence === good ? 'verified' : 'contradicted');
      }
    } finally {
      await host.dispose();
    }
  });
}
