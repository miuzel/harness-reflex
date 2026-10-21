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

test('raising pruneThreshold alone lifts the segment-judging floor instead of refusing the save', () => {
  // The panel exposes pruneThreshold and pruneJudgeMinChars independently. A
  // threshold raised on its own must remain saveable; the effective judging
  // floor is lifted to it, so the panel and runtime agree on what is in force.
  const lifted = resolveConfig({ backend: 'mock', pruneThreshold: 12000 });
  assert.equal(lifted.interventions.pruneJudgeMinChars, 12000);

  const explicitLow = resolveConfig({
    backend: 'mock',
    pruneThreshold: 500,
    interventions: { pruneJudgeMinChars: 400 }
  });
  assert.equal(explicitLow.interventions.pruneJudgeMinChars, 500, 'the floor never sits below the prune threshold');
  assert.equal(
    resolveInterventionsConfig({ pruneJudgeMinChars: 400 }, 500).pruneJudgeMinChars,
    500
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
