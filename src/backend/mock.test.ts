import assert from 'node:assert/strict';
import test from 'node:test';

import { MockDecisionBackend } from './mock.js';

// Exercise only the deterministic mock: real backends have their own semantics.
const zeroFailureEvidence = [
  'All tests passed: 10 passed, 0 failed',
  'Tests: 0 failed, 10 passed, 10 total',
  '=== 10 passed, 0 failed in 0.12s ===',
  'All tests passed with zero failures',
  'All tests passed; failures: 0',
  'All tests passed\n# fail 0',
  'All tests passed; failed=0; errors: 0',
  'All tests passed; 0 failures; 0 errors'
];
const failureEvidence = [
  'Tests: 1 failed, 9 passed, 10 total',
  '=== 2 failed, 8 passed in 0.12s ===',
  'All tests passed\n# fail 1',
  'All tests passed; failures: 2',
  'All tests passed; error: compiler crashed',
  'All tests passed; 0 failed; error: 0 is invalid',
  'All tests passed; 2 errors',
  'All tests passed; 0 failed; 2 failed',
  'All tests passed; 2 failed; 0 failed',
  'All tests passed; failures: 0; failures: 3',
  'All tests passed; 0 failed\nFAIL src/example.test.ts',
  'All tests passed; 0 failed\nFAILED test_example.py::test_example',
  'All tests passed; zero failures\nerror: build broke',
  'All tests passed; 10 failed',
  'All tests passed; 1.0 failed'
];

for (const evidence of zeroFailureEvidence) {
  test(`mock gate accepts explicit zero summary: ${JSON.stringify(evidence)}`, async () => {
    const result = await new MockDecisionBackend().gate({ assertions: [{ statement: 'All tests passed' }], evidence });
    assert.equal(result.passed, true);
    assert.equal(result.results[0].outcome, 'verified');
    assert.equal(result.needsEscalation, false);
  });
}

for (const evidence of failureEvidence) {
  test(`mock gate preserves contradiction: ${JSON.stringify(evidence)}`, async () => {
    const result = await new MockDecisionBackend().gate({ assertions: [{ statement: 'All tests passed' }], evidence });
    assert.equal(result.passed, false);
    assert.equal(result.results[0].outcome, 'contradicted');
  });
}

test('zero counters alone do not verify an unrelated assertion', async () => {
  const result = await new MockDecisionBackend().gate({
    assertions: [{ statement: 'Deployment finished successfully' }],
    evidence: '0 failed',
    strictness: 'high'
  });
  assert.equal(result.passed, false);
  assert.equal(result.results[0].outcome, 'not_addressed');
  assert.equal(result.needsEscalation, true);
});
