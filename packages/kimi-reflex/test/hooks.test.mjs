/**
 * Behavioral checks for the Kimi Code wiring, run without a `kimi` binary.
 *
 * Everything here goes through the real surface the shipped config uses: the
 * `harness-reflex hook <event>` CLI for the direct events, and
 * `hooks/reflex-stop-exit2.sh` for Stop. The stdin payloads are shaped like the
 * ones Kimi Code actually writes — snake_case keys, `tool_call_id` instead of
 * `tool_use_id`, `tool_output` instead of `tool_response`, plus
 * `hook_event_name`/`session_title`/`client_type` facts — because those are the
 * spellings the normalizer exists to fold (see
 * `src/hook/payload.ts` in the root package).
 *
 * The four model-visible paths the goal names are each asserted on the surface
 * the HOST reads, not on our own JSON:
 *   allow   -> exit 0, no decision for the host
 *   deny    -> `hookSpecificOutput.permissionDecision == "deny"` (a real veto)
 *   rewrite -> `hookSpecificOutput.updatedToolOutput` (recorded; observation-only)
 *   block   -> exit code 2 with the reason on stderr (the shim's whole job)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const CLI = path.join(repoRoot, 'dist', 'cli', 'index.js');
const STOP_SHIM = path.join(pluginRoot, 'hooks', 'reflex-stop-exit2.sh');
const dist = (relative) => pathToFileURL(path.join(repoRoot, 'dist', relative)).href;

const { FixedClock } = await import(dist('state/clock.js'));
const { FileStateStore } = await import(dist('state/file-store.js'));

const roots = [];
const NOW = Date.parse('2026-10-22T10:00:00.000Z');

/** A throwaway state root for one test. */
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-kimi-'));
  roots.push(root);
  return root;
}

/** The environment a hook process sees, sans any inherited mode override. */
function hookEnv(stateRoot, extra = {}) {
  const env = {
    ...process.env,
    SYSTEM_ONE_BACKEND: 'mock',
    HARNESS_REFLEX_STATE_DIR: stateRoot,
    ...extra
  };
  if (!('HARNESS_REFLEX_MODE' in extra)) delete env.HARNESS_REFLEX_MODE;
  if (!('HARNESS_REFLEX_CLOSING_MODE' in extra)) delete env.HARNESS_REFLEX_CLOSING_MODE;
  return env;
}

/** Run one command with stdin closed, exactly as the host does (shell: true). */
function run(command, args, payload, env, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

/**
 * Put a `harness-reflex` command on PATH, the way an installed user has one.
 *
 * The shim calls the bare command name on purpose (the host resolves the
 * installed CLI, never a plugin path), so the test has to provide the same
 * surface. A two-line shell wrapper keeps the shim under test unmodified and
 * still exercises a real `sh` -> CLI -> JSON chain.
 */
function installCliShim() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-kimi-bin-'));
  roots.push(binDir);
  const file = path.join(binDir, 'harness-reflex');
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  fs.chmodSync(file, 0o755);
  return binDir;
}

/** Run the real hook CLI for one event. */
function runCli(event, payload, env) {
  return run(process.execPath, [CLI, 'hook', event], payload, env);
}

/** Parse the single stdout object; a hook must never print anything else. */
function hookOutput(result) {
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(typeof parsed, 'object');
  return parsed;
}

/** The base facts Kimi Code prepends to every hook payload (docs + bundle). */
function kimiFacts(overrides = {}) {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'session_abc',
    session_title: 'Fix the login page',
    client_type: 'kimi_code_cli',
    cwd: repoRoot,
    ...overrides
  };
}

/** Seed one failed tool observation, the evidence a closing check reads. */
function seedFailure(root, session = 'session_abc') {
  const store = new FileStateStore({ root, clock: new FixedClock(NOW) });
  store.ensureSession(session, 'active');
  store.appendEvent(session, {
    v: 1,
    kind: 'post',
    at: NOW,
    atIso: new Date(NOW).toISOString(),
    turnNo: 0,
    tool: 'Bash',
    failed: true,
    output: 'ERROR: build failed'
  });
}

/** A tool result above the prune threshold whose bulk the mock prune drops. */
function bigText() {
  const lines = [];
  for (let index = 0; index < 160; index += 1) {
    lines.push(`[=== progress ${index % 100}% ===] downloading artifact ${index}`);
  }
  lines.push('ERROR: cannot find module "example"');
  return lines.join('\n');
}

test('allow: a normal Kimi tool call answers {} and exit 0', async () => {
  const result = await runCli('pretooluse', kimiFacts({
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_call_id: 'call-1'
  }), hookEnv(tempRoot()));
  assert.deepEqual(hookOutput(result), {});
});

test('deny: the third identical call emits the permissionDecision the host vetoes on', async () => {
  const root = tempRoot();
  const base = hookEnv(root);
  const payload = () => kimiFacts({
    tool_name: 'Bash',
    tool_input: { command: 'make test' },
    tool_call_id: `call-${Math.random()}`
  });
  // Distinct call ids: the dedupe key must not collapse two different calls, or
  // the stagnation count could never advance (this is why `tool_call_id` is
  // folded onto `tool_use_id` by the normalizer).
  assert.deepEqual(hookOutput(await runCli('pretooluse', payload(), base)), {});
  assert.deepEqual(hookOutput(await runCli('pretooluse', payload(), base)), {});
  const denied = hookOutput(await runCli('pretooluse', payload(), base));
  assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(denied.hookSpecificOutput?.hookEventName, 'PreToolUse');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /identical|repeated|consecutive/i);
});

test('rewrite: an oversized Kimi tool_output is reduced and retained', async () => {
  const root = tempRoot();
  const big = bigText();
  const result = await runCli('posttooluse', kimiFacts({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_call_id: 'call-2',
    tool_output: big
  }), hookEnv(root));
  const output = hookOutput(result);
  assert.equal(output.hookSpecificOutput?.hookEventName, 'PostToolUse');
  // Kimi truncates tool_output to 2000 chars before sending it; the reduction
  // must still be a reduction of whatever the host sent.
  assert.ok(output.hookSpecificOutput.updatedToolOutput.length < big.length);

  // The locator names a retained original that restores the input exactly.
  const locator = /originals\/([a-f0-9]+)\.txt/.exec(output.hookSpecificOutput.updatedToolOutput);
  assert.ok(locator, 'the replacement must carry a locator');
  const store = new FileStateStore({ root, clock: new FixedClock(NOW) });
  const original = fs.readFileSync(path.join(store.sessionPaths('session_abc').originals, `${locator[1]}.txt`));
  assert.ok(original.equals(Buffer.from(big)), 'the locator must restore the original byte-for-byte');
});

test('block: the Stop shim converts our JSON into exit 2 plus a stderr reason', async () => {
  const binDir = installCliShim();
  const payload = kimiFacts({
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'All tests pass and the task is complete.'
  });

  // Closing defaults to observe: the shim must pass the allow through untouched.
  const observedRoot = tempRoot();
  seedFailure(observedRoot);
  const observed = await run('sh', [STOP_SHIM], payload, hookEnv(observedRoot, {
    PATH: `${binDir}:${path.dirname(process.execPath)}:${process.env.PATH}`
  }));
  assert.equal(observed.code, 0, observed.stderr);
  assert.deepEqual(JSON.parse(observed.stdout), {});

  // A separate state root on purpose: an identical Stop payload in the same
  // session replays the committed decision, which is exactly the idempotency the
  // decision layer promises, and not what this fixture is about.
  const activeRoot = tempRoot();
  seedFailure(activeRoot);
  const blocked = await run('sh', [STOP_SHIM], payload, hookEnv(activeRoot, {
    HARNESS_REFLEX_CLOSING_MODE: 'active',
    PATH: `${binDir}:${path.dirname(process.execPath)}:${process.env.PATH}`
  }));
  // The host reads exit code 2 and takes stderr as the reason to keep working.
  assert.equal(blocked.code, 2, blocked.stderr);
  assert.match(blocked.stderr, /"decision":"block"/);
  const reason = JSON.parse(blocked.stderr.trim()).reason;
  assert.match(reason, /contradicts/);
});

test('block: the shim can only ever allow on an unrecognized verdict', async () => {
  // A stub standing in for the CLI proves the shim's own contract: stdout that
  // is not our exact block bytes is forwarded, and the exit stays 0.
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-kimi-stub-'));
  roots.push(stubDir);
  const stub = path.join(stubDir, 'harness-reflex');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' \'{"hookSpecificOutput":{"additionalContext":"x"}}\'\n');
  fs.chmodSync(stub, 0o755);
  const result = await run('sh', [STOP_SHIM], kimiFacts({ hook_event_name: 'Stop' }), {
    ...process.env,
    PATH: `${stubDir}:${process.env.PATH}`
  });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, 'x');

  // An empty answer is an allow, never a block.
  const empty = path.join(stubDir, 'harness-reflex');
  fs.writeFileSync(empty, '#!/bin/sh\nexit 0\n');
  const emptyResult = await run('sh', [STOP_SHIM], kimiFacts({ hook_event_name: 'Stop' }), {
    ...process.env,
    PATH: `${stubDir}:${process.env.PATH}`
  });
  assert.equal(emptyResult.code, 0);
});

test('session boundaries: start announces the mode, end is silent', async () => {
  const start = hookOutput(await runCli('sessionstart', kimiFacts({
    hook_event_name: 'SessionStart',
    source: 'startup',
    model: 'kimi-code/k3',
    profile: 'default'
  }), hookEnv(tempRoot())));
  assert.equal(start.hookSpecificOutput?.hookEventName, 'SessionStart');
  assert.match(start.hookSpecificOutput.additionalContext, /mode=active/);
  assert.match(start.hookSpecificOutput.additionalContext, /closing=observe/);

  const end = hookOutput(await runCli('sessionend', kimiFacts({
    hook_event_name: 'SessionEnd',
    reason: 'exit'
  }), hookEnv(tempRoot())));
  assert.deepEqual(end, {});
});

test('failure correction: three PostToolUseFailure events attach a correction', async () => {
  const root = tempRoot();
  const base = hookEnv(root);
  const failure = (id) => runCli('postfailure', kimiFacts({
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_call_id: id,
    error: { name: 'BashError', message: 'boom' }
  }), base);
  assert.deepEqual(hookOutput(await failure('f1')), {});
  assert.deepEqual(hookOutput(await failure('f2')), {});
  const corrected = hookOutput(await failure('f3'));
  assert.equal(corrected.hookSpecificOutput?.hookEventName, 'PostToolUseFailure');
  assert.match(corrected.hookSpecificOutput.additionalContext, /consecutive tool calls failed/);
});

test('bad input and an unknown event fail open with {} and exit 0', async () => {
  const bad = await runCli('pretooluse', 'not json at all', hookEnv(tempRoot()));
  assert.equal(bad.code, 0);
  assert.equal(bad.stdout, '{}\n');

  // Kimi Code's event table carries events harness-reflex has no decision for;
  // wiring one by mistake must be a no-op, not a crash.
  const unknown = await runCli('userpromptsubmit', kimiFacts(), hookEnv(tempRoot()));
  assert.equal(unknown.code, 0);
  assert.equal(unknown.stdout, '{}\n');
});

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
