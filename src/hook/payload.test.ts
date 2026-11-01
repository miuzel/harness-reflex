/**
 * `hook/payload.ts` fixtures.
 *
 * The normalizer is the only place a host's stdin vocabulary reaches the
 * decision, so it is tested on its own terms: totality (nothing throws, nothing
 * is invented), the two aliases that actually differ between hosts, and the
 * guarantee that a payload already in the decision's vocabulary comes out
 * byte-identical — that last one is what makes it safe to run for every host.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeHookPayload } from './payload.js';

test('an already-canonical payload is returned field-for-field', () => {
  const payload = {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 't1',
    tool_response: { stdout: 'ok', stderr: '' },
    stop_hook_active: false,
    last_assistant_message: 'done'
  };
  assert.deepEqual(normalizeHookPayload(payload), payload);
});

test('subagent identity folds both spellings onto agent_id', () => {
  assert.equal(normalizeHookPayload({ subagent_id: 'a1' }).agent_id, 'a1');
  assert.equal(normalizeHookPayload({ agent_id: 'a2' }).agent_id, 'a2');
  // The explicit spelling wins when a host sends both.
  assert.equal(normalizeHookPayload({ agent_id: 'a2', subagent_id: 'a1' }).agent_id, 'a2');
});

test("Kimi's hook_event_name and turn_id survive as context, never as decisions", () => {
  const normalized = normalizeHookPayload({
    hook_event_name: 'PreToolUse',
    session_id: 'session_abc',
    session_title: 'Fix the login page',
    client_type: 'kimi_code_cli',
    cwd: '/path/to/project',
    turn_id: 'turn-7',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' }
  });
  assert.equal(normalized.hook_event_name, 'PreToolUse');
  assert.equal(normalized.session_title, 'Fix the login page');
  assert.equal(normalized.client_type, 'kimi_code_cli');
  assert.equal(normalized.cwd, '/path/to/project');
  assert.equal(normalized.turn_id, 'turn-7');
  // `turn_id` is context only: the decision counts turns from its own ledger,
  // so a host counter must not be promoted to a decision input.
  assert.equal(normalized.turnNo, undefined);
  assert.equal(normalized.session_id, 'session_abc');
});

test('tool_call_id folds onto tool_use_id, and an explicit one wins', () => {
  assert.equal(normalizeHookPayload({ tool_call_id: 'c1' }).tool_use_id, 'c1');
  assert.equal(normalizeHookPayload({ tool_use_id: 'u1' }).tool_use_id, 'u1');
  assert.equal(normalizeHookPayload({ tool_use_id: 'u1', tool_call_id: 'c1' }).tool_use_id, 'u1');
  // Two distinct calls of the same command must stay distinct, or the
  // stagnation count never advances.
  const first = normalizeHookPayload({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_call_id: 'c1' });
  const second = normalizeHookPayload({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_call_id: 'c2' });
  assert.notEqual(first.tool_use_id, second.tool_use_id);
});

test("Kimi's tool_output becomes tool_response; an explicit tool_response wins", () => {
  assert.equal(normalizeHookPayload({ tool_output: 'make: ok' }).tool_response, 'make: ok');
  const explicit = { stdout: 'x', stderr: '' };
  assert.deepEqual(normalizeHookPayload({ tool_response: explicit, tool_output: 'y' }).tool_response, explicit);
  // An empty tool_output is absent, not an empty replacement.
  assert.equal(normalizeHookPayload({ tool_output: '' }).tool_response, undefined);
});

test('nothing is invented and nothing throws on hostile input', () => {
  assert.deepEqual(normalizeHookPayload({}), {});
  // Wrong types are dropped rather than coerced.
  assert.deepEqual(normalizeHookPayload({ session_id: 42, tool_input: [], agent_id: null }), {});
  assert.deepEqual(normalizeHookPayload({ tool_input: null, tool_response: null }), {
    tool_response: null
  });
  // A tool_response of any shape is forwarded untouched; the decision layer
  // already understands the object and string forms.
  const response = { content: [{ type: 'text', text: 'x' }] };
  assert.deepEqual(normalizeHookPayload({ tool_response: response }).tool_response, response);
});

test('empty strings are treated as absent, so a host cannot blank a field', () => {
  const normalized = normalizeHookPayload({ session_id: '', tool_name: '', source: '' });
  assert.deepEqual(normalized, {});
});
