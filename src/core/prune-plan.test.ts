/**
 * The deterministic floor of a reduction.
 *
 * Lengths alone decide the plan; the composition then reports the size the text
 * really has. These tests pin the three outcomes a caller branches on: no floor,
 * a floored head/extract/tail form, and a floor miss that still installs a real
 * reduction.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPruneFloor, pruneFloorPlan, pruneMarker } from './prune-plan.js';

/** A payload of uniform lines, long enough to floor. */
function payload(lines: number, width = 6): string {
  return Array.from({ length: lines }, (_, index) => `${String(index).padStart(3, '0')}${'x'.repeat(Math.max(0, width - 3))}\n`).join('');
}

test('pruneFloorPlan leaves a candidate alone when it is already at the share', () => {
  // target = ceil(1000 * 0.5) = 500; the candidate is exactly at the promise.
  const plan = pruneFloorPlan(1000, 500, { floorRatio: 0.5, markerChars: 10 });
  assert.equal(plan.floored, false);
  assert.equal(plan.floorMissed, false);
  assert.equal(plan.resultChars, 500);
  assert.equal(plan.omittedChars, 500);
});

test('pruneFloorPlan widens a deep cut to the promised share', () => {
  const plan = pruneFloorPlan(1000, 100, { floorRatio: 0.5, markerChars: 10, headChars: 400, tailChars: 400 });
  assert.equal(plan.floored, true);
  assert.equal(plan.floorMissed, false);
  assert.equal(plan.resultChars, 500);
  assert.equal(plan.headChars, 190);
  assert.equal(plan.tailChars, 190);
  assert.equal(plan.markerChars, 20, 'the share paid for a marker on both sides');
});

test('pruneFloorPlan records a floor miss when the mandatory marker would eat the saving', () => {
  // A deep cut the share would widen, but the mandatory marker alone costs more
  // than the saving: the marker is omitted rather than the reduction.
  const plan = pruneFloorPlan(1000, 100, { floorRatio: 0.5, markerChars: 950 });
  assert.equal(plan.floored, false);
  assert.equal(plan.floorMissed, true);
  assert.equal(plan.markerOmitted, true);
  assert.equal(plan.resultChars, 100);
});

test('pruneFloorPlan treats a non-reduction as an idle plan', () => {
  const plan = pruneFloorPlan(100, 120, { floorRatio: 0.5 });
  assert.equal(plan.floored, false);
  assert.equal(plan.floorMissed, false);
  assert.equal(plan.resultChars, 100);
});

test('applyPruneFloor composes a smaller head/extract/tail form with the locator', () => {
  const original = payload(600);
  const result = applyPruneFloor(original, 'KEPT EXTRACT\n', { floorRatio: 0.5, locator: 'abc' });
  assert.equal(result.floored, true);
  assert.ok(result.text.length < original.length, 'the installed form is smaller than the original');
  assert.ok(result.text.includes(pruneMarker('abc')), 'the locator marker is published');
  assert.ok(result.text.startsWith(original.slice(0, 4)), 'the head keeps whole lines from the original');
  assert.equal(result.omittedChars, original.length - result.text.length);
});

test('applyPruneFloor refuses a candidate that would not shrink the payload', () => {
  const original = 'abc';
  const result = applyPruneFloor(original, 'abcdef', { floorRatio: 0.5, locator: 'x' });
  assert.equal(result.text, original);
  assert.equal(result.floored, false);
});

test('applyPruneFloor installs the bare candidate when the marker cannot fit', () => {
  const original = payload(10);
  const candidate = 'short\n';
  const result = applyPruneFloor(original, candidate, { floorRatio: 0.5, locator: 'locator-that-makes-a-long-marker' });
  assert.equal(result.floored, false);
  assert.equal(result.text, candidate);
  assert.equal(result.floorMissed, true);
  assert.equal(result.markerOmitted, true);
});

test('the marker names the locator and sits on its own line', () => {
  const marker = pruneMarker('deadbeef');
  assert.equal(marker, '\n… [reflex prune: full original retrievable as deadbeef] …\n');
});
