/**
 * The Codex adapter's contract, tested without a Codex binary.
 *
 * Every expectation here is pinned to a fact measured from `codex-cli 0.163.0`
 * rather than to its documentation, which does not cover hooks yet:
 *
 * - there are **twelve** events (the twelve in `command_runner.rs`), not ten;
 * - handler `args` are **not** forwarded, so the event must live in `command`;
 * - Codex **clamps the SessionEnd timeout to 3 s**, which the timeout table must
 *   stay inside;
 * - the tool matcher must cover shell tools, not just MCP tools.
 *
 * A change to any of those should fail here rather than silently drift away from
 * the host.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CODEX_HOOK_EVENTS,
  CODEX_SESSION_END_TIMEOUT_SEC,
  buildCodexHooksConfig,
  codexOnlyEvents,
  codexSpecForCanonical,
  parseCodexHookEvent,
  renderCodexHookCommand,
  renderCodexMcpToml
} from './codex.js';
import { postToolUseMcpReplace, postToolUseReplace, preToolUseDeny, stopBlock } from '../hook/contract.js';
import { normalizeHookPayload } from '../hook/payload.js';

/** The twelve events the binary really has, in its order. */
const EXPECTED_PASCAL = [
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt'
];

test('codex: the table has the twelve real events and no invented ones', () => {
  assert.equal(CODEX_HOOK_EVENTS.length, 12);
  assert.deepEqual(CODEX_HOOK_EVENTS.map((spec) => spec.pascal), EXPECTED_PASCAL);
  // Every event has exactly one identity: canonical XOR codex-only.
  for (const spec of CODEX_HOOK_EVENTS) {
    assert.equal(
      (spec.canonical === null) !== (spec.codexOnly === null),
      true,
      `${spec.pascal} must be either canonical or codex-only`
    );
  }
});

test('codex: six events map to a capability, six are recognized no-ops', () => {
  const canonical = CODEX_HOOK_EVENTS.filter((spec) => spec.canonical !== null).map((spec) => spec.canonical);
  assert.deepEqual(canonical.sort(), [
    'posttooluse',
    'pretooluse',
    'sessionend',
    'sessionstart',
    'stop',
    'substop'
  ]);

  const noop = CODEX_HOOK_EVENTS.filter((spec) => spec.canonical === null).map((spec) => spec.pascal);
  assert.deepEqual(noop, [
    'PermissionRequest',
    'PreCompact',
    'PostCompact',
    'UserPromptSubmit',
    'SubagentStart',
    'Interrupt'
  ]);
  assert.deepEqual(codexOnlyEvents().length, 6);
});

test('codex: every spelling resolves to the same event', () => {
  // PascalCase, kebab-case, snake_case, the subcommand, and the canonical name
  // must all reach one spec — a wiring mistake then costs nothing.
  const cases: [string, string][] = [
    ['PreToolUse', 'PreToolUse'],
    ['pre-tool-use', 'PreToolUse'],
    ['pre_tool_use', 'PreToolUse'],
    ['pretooluse', 'PreToolUse'],
    ['post-tool-use', 'PostToolUse'],
    ['postToolUse', 'PostToolUse'],
    ['session-start', 'SessionStart'],
    ['SessionStart', 'SessionStart'],
    ['session-end', 'SessionEnd'],
    ['subagent-stop', 'SubagentStop'],
    ['substop', 'SubagentStop'],
    ['user-prompt-submit', 'UserPromptSubmit'],
    ['permission-request', 'PermissionRequest'],
    ['pre-compact', 'PreCompact'],
    ['post-compact', 'PostCompact'],
    ['subagent-start', 'SubagentStart'],
    ['interrupt', 'Interrupt'],
    ['Interrupt', 'Interrupt'],
    ['stop', 'Stop'],
    ['Stop', 'Stop']
  ];
  for (const [raw, expected] of cases) {
    assert.equal(parseCodexHookEvent(raw)?.pascal, expected, `parse ${raw}`);
  }
  assert.equal(parseCodexHookEvent('not-an-event'), undefined);
  assert.equal(parseCodexHookEvent(''), undefined);
  assert.equal(parseCodexHookEvent(undefined), undefined);
});

test('codex: stop and substop map back from the canonical names', () => {
  assert.equal(codexSpecForCanonical('stop')?.pascal, 'Stop');
  assert.equal(codexSpecForCanonical('substop')?.pascal, 'SubagentStop');
  assert.equal(codexSpecForCanonical('pretooluse')?.subcommand, 'pretooluse');
});

test('codex: the hook command carries the event, because args are dropped', () => {
  // Measured: a handler with `args: ["session-start"]` runs with `argv = []`.
  const spec = parseCodexHookEvent('SessionStart');
  assert.ok(spec);
  assert.equal(renderCodexHookCommand('harness-reflex', spec), 'harness-reflex hook sessionstart');
  // A script path runs under node, and a path with spaces survives quoting.
  assert.equal(
    renderCodexHookCommand('/opt/my dir/dist/cli/index.js', spec),
    'node "/opt/my dir/dist/cli/index.js" hook sessionstart'
  );
  for (const event of CODEX_HOOK_EVENTS) {
    const command = renderCodexHookCommand('harness-reflex', event);
    assert.match(command, / hook \S+$/, 'the subcommand is the last word');
    assert.ok(!command.includes('args'), 'there is no args channel');
  }
});

test('codex: hooks.json wires twelve events and only tool events get a matcher', () => {
  const config = buildCodexHooksConfig('harness-reflex');
  assert.deepEqual(Object.keys(config.hooks), EXPECTED_PASCAL);

  for (const [event, groups] of Object.entries(config.hooks)) {
    assert.equal(groups.length, 1, `${event} has one group`);
    const group = groups[0];
    assert.equal(group.hooks.length, 1, `${event} has one handler`);
    const handler = group.hooks[0];
    assert.equal(handler.type, 'command');
    assert.match(handler.command, /^harness-reflex hook \S+$/);
    assert.equal(typeof handler.timeout, 'number');
    assert.ok(handler.timeout >= 1 && handler.timeout <= 3, `${event} timeout inside both budgets`);

    // The matcher must be broad: a matcher naming only MCP tools would let
    // every shell call through unguarded.
    if (event === 'PreToolUse' || event === 'PostToolUse') {
      assert.equal(group.matcher, '.*', `${event} must match every tool`);
    } else {
      assert.equal(group.matcher, undefined, `${event} takes no matcher`);
    }
  }
});

test('codex: SessionEnd stays inside the host clamp', () => {
  // Codex prints `clamping SessionEnd hook timeout to 3s` above this number.
  const config = buildCodexHooksConfig('harness-reflex');
  const timeout = config.hooks.SessionEnd[0].hooks[0].timeout;
  assert.ok(timeout <= CODEX_SESSION_END_TIMEOUT_SEC, `${timeout} <= ${CODEX_SESSION_END_TIMEOUT_SEC}`);
  assert.equal(CODEX_SESSION_END_TIMEOUT_SEC, 3);
});

test('codex: the generated hooks.json is stable, so the shipped file can be diffed', () => {
  // The package ships a hooks.json; it must be exactly what the adapter builds.
  const twice = buildCodexHooksConfig('harness-reflex');
  assert.equal(JSON.stringify(twice), JSON.stringify(buildCodexHooksConfig('harness-reflex')));
  assert.equal(JSON.stringify(twice).includes('"args"'), false);
});

test('codex: a real PreToolUse payload normalizes into the decision vocabulary', () => {
  // Copied from a live probe run of `codex exec` (fields trimmed to the ones
  // the decision layer reads, plus the Codex-only context it should keep).
  const raw = {
    session_id: '01a198f7-97d4-73a3-af05-3c5e83218798',
    turn_id: '01a198f7-983e-7363-ac1c-ba36bc2e4a05',
    transcript_path: '/home/u/.codex/sessions/rollout-2026.jsonl',
    cwd: '/home/u/work',
    hook_event_name: 'PreToolUse',
    model: 'gpt-6.1-sol',
    permission_mode: 'bypassPermissions',
    tool_name: 'read_mcp_resource',
    tool_input: { server: 'probe', uri: 'probe://hello' },
    tool_use_id: 'call_1'
  };
  const normalized = normalizeHookPayload(raw);
  assert.equal(normalized.session_id, raw.session_id);
  assert.equal(normalized.tool_name, 'read_mcp_resource');
  assert.deepEqual(normalized.tool_input, { server: 'probe', uri: 'probe://hello' });
  assert.equal(normalized.tool_use_id, 'call_1');
  assert.equal(normalized.hook_event_name, 'PreToolUse');
  // Codex-only context is kept rather than dropped.
  assert.equal(normalized.turn_id, raw.turn_id);
  assert.equal(normalized.permission_mode, 'bypassPermissions');
  assert.equal(normalized.cwd, '/home/u/work');
});

test('codex: a real Stop payload keeps the guarded-retry flag', () => {
  // The flag is what stops a blocking Stop hook from being retried forever.
  const normalized = normalizeHookPayload({
    session_id: 's1',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'done'
  });
  assert.equal(normalized.stop_hook_active, false);
  assert.equal(normalized.last_assistant_message, 'done');
});

test('codex: subagent_id folds into agent_id, and an explicit agent_id wins', () => {
  assert.equal(
    normalizeHookPayload({ session_id: 's1', subagent_id: 'a1' }).agent_id,
    'a1'
  );
  assert.equal(
    normalizeHookPayload({ session_id: 's1', subagent_id: 'a1', agent_id: 'a2' }).agent_id,
    'a2'
  );
});

test('codex: normalization is total, so it cannot break the other hosts', () => {
  // No session_id: no throw, no invented value — the caller keeps its own
  // fail-open decision.
  const bare = normalizeHookPayload({ hook_event_name: 'SessionStart' });
  assert.equal(bare.session_id, undefined);

  // A payload already in the decision's vocabulary passes through unchanged, and
  // no unknown field is invented.
  const already = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' };
  assert.deepEqual(normalizeHookPayload(already), already);

  // Garbage in the optional fields is dropped, not copied.
  const junk = normalizeHookPayload({ session_id: 's1', tool_input: 'not-an-object', tool_name: 42 });
  assert.equal(junk.tool_input, undefined);
  assert.equal(junk.tool_name, undefined);
});

test('codex: the MCP toml registers the server under the name Codex reports', () => {
  // No credentials configured: the server block is emitted, no env table.
  const toml = renderCodexMcpToml('/abs/dist/cli/index.js', { env: {} });
  assert.match(toml, /^\[mcp_servers\.harness-reflex\]$/m);
  assert.match(toml, /^command = "node"$/m);
  assert.match(toml, /^args = \["\/abs\/dist\/cli\/index\.js", "mcp"\]$/m);
  assert.match(toml, /^startup_timeout_sec = 20$/m);
  assert.equal(toml.includes('[mcp_servers.harness-reflex.env]'), false);

  // A configured backend adds the env table, and empty values never appear.
  const withEnv = renderCodexMcpToml('/x/cli.js', {
    env: { SYSTEM_ONE_BACKEND: 'jev', SYSTEM_ONE_API_KEY: '', SYSTEM_ONE_BASE_URL: 'https://example.test' }
  });
  assert.match(withEnv, /^\[mcp_servers\.harness-reflex\.env\]$/m);
  assert.match(withEnv, /^SYSTEM_ONE_BACKEND = "jev"$/m);
  assert.match(withEnv, /^SYSTEM_ONE_BASE_URL = "https:\/\/example\.test"$/m);
  assert.equal(withEnv.includes('SYSTEM_ONE_API_KEY'), false, 'an empty value is dropped');
});

test('codex: the stdout shapes are the ones Codex reads', () => {
  // PreToolUse denial: a deny needs a non-empty reason or the host rejects it.
  const deny = preToolUseDeny('stagnation: 3 identical calls');
  assert.equal(deny.hookSpecificOutput?.permissionDecision, 'deny');
  assert.ok((deny.hookSpecificOutput?.permissionDecisionReason ?? '').length > 0);

  // Stop: `decision: "block"` plus the reason fed back to the model.
  const stop = stopBlock('claim contradicted by failing test');
  assert.equal(stop.decision, 'block');
  assert.ok((stop.reason ?? '').length > 0);

  // PostToolUse: Codex reads `updatedMCPToolOutput` and ignores Claude's field.
  const mcp = postToolUseMcpReplace('pruned');
  assert.equal(mcp.hookSpecificOutput?.updatedMCPToolOutput, 'pruned');
  assert.equal(mcp.hookSpecificOutput?.updatedToolOutput, undefined);

  // The Claude shape is untouched by the Codex addition.
  const claude = postToolUseReplace('pruned');
  assert.equal(claude.hookSpecificOutput?.updatedToolOutput, 'pruned');
  assert.equal(claude.hookSpecificOutput?.updatedMCPToolOutput, undefined);
});
