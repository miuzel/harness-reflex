#!/usr/bin/env node
/**
 * The closing contract, checked against the compiled extension.
 *
 * pi's closing hook cannot be driven to a contradiction through a prompt (a
 * well-behaved model declines to state a false completion claim), so the event pi
 * actually fires is replayed instead, in pi's real shape. Three properties are
 * asserted, and they are exactly the ones the goal fixed:
 *
 * 1. a contradiction buys **one** continuation, carrying the correction;
 * 2. the second contradictory settle is **not** continued;
 * 3. the ledger records `closing-degraded-pass`, and never `closing-block`.
 */
import assert from 'node:assert/strict';
import { installPiReflex } from '../dist/packages/pi-reflex/src/index.js';
import { CLOSING_BLOCK, CLOSING_DEGRADED_PASS, PI_EVENTS } from '../dist/packages/pi-reflex/src/pi-adapter.js';

const handlers = new Map();
const api = {
  on(event, handler) {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
  registerTool() {}
};

const runtime = installPiReflex(api, { modes: { closing: 'active' } });
handlers.get(PI_EVENTS.turnStart)({ type: 'turn_start', turnIndex: 1, timestamp: Date.now() });

// One failing tool run: the evidence a completion claim has to answer to.
await handlers.get(PI_EVENTS.toolResult)({
  type: 'tool_result',
  toolCallId: 'call-1',
  toolName: 'bash',
  input: {},
  content: [{ type: 'text', text: 'FAILED 3 test(s)\n  ✗ expected 1 to equal 2' }],
  isError: false
});

/** A settle in pi's real shape: the assistant message lives in the preview. */
const settle = () => ({
  type: 'agent_before_settle',
  entries: [],
  continue: false,
  context: {
    canContinue: true,
    contextEntries: [],
    llmMessages: [],
    pendingMessages: [],
    contextMessages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'text', text: 'All tests pass and the build is clean.' }] }
    ]
  },
  outcome: {}
});

const first = await handlers.get(PI_EVENTS.beforeSettle)(settle());
assert.equal(first?.continue, true, 'the first contradictory settle asks for one more request');
const appended = first?.entries?.at(-1);
assert.equal(appended?.customType, 'reflex.closing', 'the continuation carries the correction');
assert.ok((appended?.content ?? '').length > 0, 'the correction is not empty');

const second = await handlers.get(PI_EVENTS.beforeSettle)(settle());
assert.equal(second, undefined, 'a second contradictory settle is not continued again');

const outcomes = runtime.ledger.map((line) => line.closingOutcome).filter(Boolean);
assert.deepEqual(outcomes, [CLOSING_DEGRADED_PASS], `ledger recorded ${JSON.stringify(outcomes)}`);
assert.ok(!outcomes.includes(CLOSING_BLOCK), 'pi never records closing-block: it has no veto');
assert.equal(runtime.closing.spent, 1, 'the continuation budget was spent exactly once');

console.log(`  ok   first settle continued once with a correction`);
console.log(`  ok   second settle not continued`);
console.log(`  ok   ledger recorded ${outcomes.join(', ')} (never ${CLOSING_BLOCK})`);
