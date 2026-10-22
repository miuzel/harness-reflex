import assert from 'node:assert/strict';
import test from 'node:test';
import { actualProjection as projection } from './actual-projection.js';

const route = { provider: 'codex', model: 'sol', reasoningEffort: 'medium' };
const decision = { type: 'plugin:dsh-reflex/effort', data: { ...route, applied: 'medium', requestedProvider: 'reflex' } };
const header = { type: 'request/header', data: { header: { config: route } } };

test('session actual projection requires corroborated local logged evidence and survives physical header intent folding', () => {
  let state = projection.init();
  state = projection.apply(state, { type: 'model/selection', data: { provider: 'reflex', model: 'reflex-1', reasoningEffort: 'reflex' } });
  assert.equal(state.actual, null);
  state = projection.apply(state, decision);
  assert.equal(state.actual, null, 'decision before dispatch is not a request header');
  state = projection.apply(state, header);
  assert.deepEqual(state.actual, route);
  assert.equal(state.adaptive, true, 'physical header does not erase adaptive intent');
  assert.equal(projection.apply(state, { type: 'turn/end', data: {} }), state);
  assert.deepEqual(projection.wire.viewSchema.parse(projection.wire.view(state)), state);
  const otherSession = projection.apply(projection.init(), header);
  assert.equal(otherSession.actual, null, 'another session header cannot reuse this decision');
  state = projection.apply(state, { type: 'model/selection', data: route });
  assert.equal(state.adaptive, false);
  assert.equal(state.actual, null, 'fixed selection clears previous adaptive evidence even for identical actual route');
});

test('new adaptive selection, missing decision and unintercepted virtual header never reuse older actual data', () => {
  const executed = projection.apply(projection.apply(projection.init(), decision), header);
  const selected = projection.apply(executed, { type: 'model/selection', data: { provider: 'other', model: 'new', reasoningEffort: 'reflex' } });
  assert.equal(selected.actual, null);
  const missing = projection.apply(executed, { type: 'request/header', data: { header: { config: { provider: 'reflex', model: 'reflex-1', reasoningEffort: 'reflex' } } } });
  assert.equal(missing.actual, null);
  assert.equal(missing.actual, null);
  assert.equal(projection.apply(executed, { type: decision.type, data: { provider: 12 } }), executed);
});


test('virtual model with fixed effort uses physical header without inventing adaptive effort decisions', () => {
  let state = projection.apply(projection.init(), { type: 'model/selection', data: { provider: 'reflex', model: 'reflex-1', reasoningEffort: 'medium' } });
  state = projection.apply(state, header);
  assert.equal(state.adaptive, true);
  assert.deepEqual(state.actual, route);
  assert.equal(state.decision, null);
});

test('fixed intent cannot be resurrected by late adaptive audit and header', () => {
  let state = projection.apply(projection.init(), { type: 'model/selection', data: route });
  state = projection.apply(state, decision);
  state = projection.apply(state, header);
  assert.equal(state.adaptive, false);
  assert.equal(state.actual, null);
});
