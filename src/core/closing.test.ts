/**
 * Closing-claim candidates and the closing decision.
 *
 * Candidate selection is deliberately semantic-free; the classification and the
 * verification answer are the backend's job. These tests pin the slicing rules
 * and the reason a closing judgment reports when it does not object.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimCandidates,
  claimsOf,
  closingSkipReason,
  classificationTokens,
  contradictedOf,
  undecidedOf,
  verificationTokens,
  type ClosingVerdictLike
} from './closing.js';

test('claimCandidates splits sentences and drops fragments below the floor', () => {
  const candidates = claimCandidates('All tests passed. Done! ok.');
  assert.deepEqual(candidates, ['All tests passed.']);
});

test('claimCandidates de-duplicates identical sentences', () => {
  const candidates = claimCandidates('Everything is green. Everything is green.');
  assert.deepEqual(candidates, ['Everything is green.']);
});

test('claimCandidates keeps only the trailing few candidates', () => {
  const candidates = claimCandidates('First sentence here. Second sentence here. Third sentence here. Fourth sentence here.');
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0], 'Second sentence here.');
  assert.equal(candidates[2], 'Fourth sentence here.');
});

test('claimCandidates clips one very long sentence instead of dropping it', () => {
  const candidates = claimCandidates('done ' + 'x'.repeat(400));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.endsWith('…'), true);
});

test('claimsOf applies both the isClaim flag and the confidence floor', () => {
  const claims = claimsOf(
    {
      latencyMs: 1,
      results: [
        { statement: 'a', isClaim: true, confidence: 0.9 },
        { statement: 'b', isClaim: true, confidence: 0.2 },
        { statement: 'c', isClaim: false, confidence: 0.9 }
      ]
    },
    0.5
  );
  assert.deepEqual(claims, [{ statement: 'a' }]);
});

test('contradictedOf selects contradicted results and clips long statements', () => {
  const verdict: ClosingVerdictLike = {
    passed: false,
    results: [
      { statement: 'short claim', outcome: 'contradicted', confidence: 0.9 },
      { statement: 'y'.repeat(300), outcome: 'contradicted', confidence: 0.8 },
      { statement: 'other', outcome: 'verified', confidence: 0.9 }
    ]
  };
  const contradicted = contradictedOf(verdict);
  assert.equal(contradicted.length, 2);
  assert.equal(contradicted[0], 'short claim');
  assert.equal(contradicted[1]!.length, 161, 'clipped to 160 characters plus the ellipsis');
});

test('undecidedOf counts only escalate outcomes', () => {
  const verdict: ClosingVerdictLike = {
    passed: false,
    results: [
      { statement: 'a', outcome: 'escalate', confidence: 0 },
      { statement: 'b', outcome: 'contradicted', confidence: 0.9 },
      { statement: 'c', outcome: 'escalate', confidence: 0 }
    ]
  };
  assert.equal(undecidedOf(verdict), 2);
});

test('closingSkipReason distinguishes escalate from a clean non-objection', () => {
  assert.equal(closingSkipReason({ passed: false, results: [{ statement: 'a', outcome: 'escalate', confidence: 0 }] }, []), 'closing-undecided');
  assert.equal(closingSkipReason({ passed: true, results: [] }, []), 'closing-evidence-consistent');
  assert.equal(closingSkipReason({ passed: false, results: [] }, []), 'closing-unconfirmed');
  assert.equal(closingSkipReason({ passed: true, results: [] }, ['contradicted']), undefined);
});

test('classificationTokens and verificationTokens follow the shared token rate', () => {
  assert.equal(classificationTokens(['abcd']), 1);
  assert.equal(verificationTokens(10, [{ statement: 'abcd' }], 'abcdefgh'), 13);
});
