import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveConfig, resolveInterventionsConfig } from './config.js';

/**
 * `interventions.pruneJudgeMinChars` gates the per-segment System One judgment:
 * small payloads keep the deterministic local reduction and spend no judgment.
 * The threshold defaults to 10,000 characters and can never sit below the
 * runtime prune threshold it is layered on.
 */

test('pruneJudgeMinChars defaults to 10000', () => {
  const resolved = resolveConfig({ backend: 'mock' });
  assert.equal(resolved.interventions.pruneJudgeMinChars, 10000);
  assert.equal(resolveInterventionsConfig(undefined).pruneJudgeMinChars, 10000);
});

test('pruneJudgeMinChars below pruneThreshold is refused', () => {
  assert.throws(
    () => resolveConfig({ backend: 'mock', pruneThreshold: 12000 }),
    /pruneJudgeMinChars must be >= pruneThreshold/
  );
  assert.throws(
    () =>
      resolveConfig({
        backend: 'mock',
        pruneThreshold: 500,
        interventions: { pruneJudgeMinChars: 400 }
      }),
    /pruneJudgeMinChars must be >= pruneThreshold/
  );
});

test('an explicit pruneJudgeMinChars at or above pruneThreshold resolves verbatim', () => {
  const resolved = resolveConfig({
    backend: 'mock',
    pruneThreshold: 500,
    interventions: { pruneJudgeMinChars: 800 }
  });
  assert.equal(resolved.interventions.pruneJudgeMinChars, 800);
});
