/**
 * The pi adapter: event mapping, payload normalization, and the closing rule.
 *
 * This suite is deliberately about *the seam* — what pi hands over and what the
 * shared decision receives — because that seam is the only thing a pi 1.x
 * breaking change can move. The decision's own behaviour is covered by the root
 * package's suite.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOSING_CLEAN,
  CLOSING_DEGRADED_PASS,
  ClosingDegradeState,
  closingCorrectionText,
  continuationPossible,
  replaceBlocks,
  resultEventFor,
  stopPayload,
  textOfBlocks,
  toolCallPayload,
  toolResultPayload
} from './pi-adapter.js';
import { toolResponseText } from '../../../src/hook/decision.js';

test('a pi tool_call normalizes to the hook payload the decision reads', () => {
  const payload = toolCallPayload(
    { toolCallId: 'call-1', toolName: 'bash', input: { command: 'ls -la' } },
    'sess-9'
  );
  assert.equal(payload.session_id, 'sess-9');
  assert.equal(payload.tool_use_id, 'call-1');
  assert.equal(payload.tool_name, 'bash');
  assert.deepEqual(payload.tool_input, { command: 'ls -la' });
  // The hook contract keys on these four names; a rename here silently disables
  // stagnation detection rather than failing loudly, so they are asserted.
  assert.deepEqual(Object.keys(payload).sort(), ['session_id', 'tool_input', 'tool_name', 'tool_use_id']);
});

test('a missing tool input becomes an empty object, never undefined', () => {
  const payload = toolCallPayload({ toolCallId: 'c', toolName: 'ls' } as never, 's');
  assert.deepEqual(payload.tool_input, {});
});

test('a pi tool_result becomes a tool_response the shared text reader already understands', () => {
  const payload = toolResultPayload(
    {
      toolCallId: 'call-2',
      toolName: 'grep',
      input: { pattern: 'x' },
      content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }],
      isError: false
    },
    'sess-1'
  );
  // Round-trip through the shared reader: this is what the prune decision sees.
  assert.equal(toolResponseText(payload.tool_response), 'line one\nline two');
  assert.equal(payload.error, undefined, 'a successful result carries no error text');
});

test('a failed pi result carries its error text for the correction path', () => {
  const payload = toolResultPayload(
    {
      toolCallId: 'call-3',
      toolName: 'bash',
      input: {},
      content: [{ type: 'text', text: 'ENOENT: no such file' }],
      isError: true
    },
    's'
  );
  assert.equal(payload.error, 'ENOENT: no such file');
});

test('an image-only result normalizes to empty text without throwing', () => {
  const payload = toolResultPayload(
    {
      toolCallId: 'c',
      toolName: 'read',
      input: {},
      content: [{ type: 'image' }],
      isError: true
    },
    's'
  );
  assert.equal(textOfBlocks([{ type: 'image' }]), '');
  // The failure path still needs a non-empty reason; it falls back to a literal.
  assert.equal(payload.error, 'tool call failed');
});

test('a pi result dispatches to the failure path only when pi marked it failed', () => {
  assert.equal(resultEventFor(true), 'postfailure');
  assert.equal(resultEventFor(false), 'posttooluse');
});

test('textOfBlocks joins text blocks and skips images', () => {
  const text = textOfBlocks([
    { type: 'text', text: 'a' },
    { type: 'image' },
    { type: 'text', text: 'b' }
  ]);
  assert.equal(text, 'a\nb');
  assert.equal(textOfBlocks([]), '');
  assert.equal(textOfBlocks(undefined), '');
});

test('a pruned result goes back as one text block', () => {
  const blocks = replaceBlocks('pruned');
  assert.deepEqual(blocks, [{ type: 'text', text: 'pruned' }]);
});

test('the closing check asks for exactly one continuation per turn', () => {
  const state = new ClosingDegradeState(1);
  state.beginTurn(0);

  const first = state.decide(['tests pass'], 'fix it');
  assert.equal(first.action, 'continue');
  assert.equal(first.outcome, null, 'the shared decision already has a ledger line for a judgment');
  assert.equal(state.spent, 1);

  // Second contradictory settle: pass, and say so.
  const second = state.decide(['tests pass'], 'fix it');
  assert.equal(second.action, 'skip');
  assert.equal(second.outcome, CLOSING_DEGRADED_PASS);
  assert.equal(second.text, '', 'a degraded pass carries no corrective text to append');
  assert.equal(state.spent, 1, 'a refused continuation does not consume budget');
});

test('a degraded closing pass never claims to be a block', () => {
  const state = new ClosingDegradeState(1);
  state.beginTurn(0);
  state.decide(['a'], 'x');
  const degraded = state.decide(['a'], 'x');
  // The whole point of the goal's degradation rule: pi records a *pass*.
  assert.equal(degraded.outcome, CLOSING_DEGRADED_PASS);
  assert.notEqual(degraded.action, 'block');
  assert.ok(!String(degraded.outcome).includes('block'));
});

test('a clean settle records nothing and spends nothing', () => {
  const state = new ClosingDegradeState(1);
  state.beginTurn(3);
  const clean = state.decide([], 'x');
  assert.equal(clean.action, 'clean');
  assert.equal(clean.outcome, null);
  assert.equal(state.spent, 0);
  // A clean verdict must not be spelled as an outcome the ledger could confuse
  // with the degraded pass.
  assert.equal(CLOSING_CLEAN, 'closing-clean');
});

test('a new turn refills the continuation allowance', () => {
  const state = new ClosingDegradeState(1);
  state.beginTurn(0);
  state.decide(['a'], 'x');
  assert.equal(state.decide(['a'], 'x').action, 'skip');
  state.beginTurn(1);
  assert.equal(state.spent, 0);
  assert.equal(state.decide(['a'], 'x').action, 'continue');
});

test('a repeated beginTurn for the same turn cannot refill the allowance', () => {
  const state = new ClosingDegradeState(1);
  state.beginTurn(0);
  state.decide(['a'], 'x');
  // A re-entrant settle reports the same turn index; it must not look like a new turn.
  state.beginTurn(0);
  assert.equal(state.spent, 1);
  assert.equal(state.decide(['a'], 'x').action, 'skip');
});

test('maxContinues is validated rather than silently coerced', () => {
  assert.throws(() => new ClosingDegradeState(-1), /non-negative integer/);
  assert.throws(() => new ClosingDegradeState(1.5), /non-negative integer/);
  const zero = new ClosingDegradeState(0);
  zero.beginTurn(0);
  assert.equal(zero.decide(['a'], 'x').action, 'skip', 'zero allowance degrades immediately');
});

test('continuation is only requested when pi can actually run it', () => {
  assert.equal(continuationPossible(true), true);
  assert.equal(continuationPossible(undefined), true, 'an absent flag is not a refusal');
  assert.equal(continuationPossible(false), false);
});

test('the corrective text states the contradiction and admits it cannot refuse', () => {
  const text = closingCorrectionText(['tests pass', 'build clean']);
  assert.match(text, /tests pass; build clean/);
  assert.match(text, /closing-degraded-pass/);
  assert.ok(!/refused|blocked the turn/i.test(text), 'the text must not pretend a veto happened');
});

test('stop payload carries the spent-continuation flag as stop_hook_active', () => {
  const idle = stopPayload({ sessionId: 's', lastAssistantMessage: 'done', stopHookActive: false });
  assert.equal(idle.stop_hook_active, false);
  const after = stopPayload({ sessionId: 's', lastAssistantMessage: 'done', stopHookActive: true });
  assert.equal(after.stop_hook_active, true);
  assert.equal(after.last_assistant_message, 'done');
});
