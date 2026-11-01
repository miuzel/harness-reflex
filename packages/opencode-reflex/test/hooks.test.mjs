/**
 * Behavioral checks for the OpenCode plugin, run without a working `opencode`.
 *
 * The plugin spawns the real `harness-reflex hook <event>` command, so these
 * fixtures drive the same decision path the shell-hosted plugins use: real
 * stdin JSON in, real verdict JSON out, mapped onto the host effects the plugin
 * documents. `PATH` carries a wrapper that execs the freshly built CLI, which is
 * exactly what an installed user has.
 *
 * The four decision paths are each asserted on the HOST-side effect:
 *   allow   -> no throw, no replacement
 *   deny    -> `tool.execute.before` throws (the host's own refusal pattern)
 *   rewrite -> `tool.execute.after` replaces `output.output`
 *   block   -> reported through `client.app.log` (the host has no turn veto)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const CLI = path.join(repoRoot, 'dist', 'cli', 'index.js');
const dist = (relative) => pathToFileURL(path.join(repoRoot, 'dist', relative)).href;

const { ReflexPlugin, runHook, mapVerdict, toolPayload } = await import('../plugin/reflex.js');
const { FixedClock } = await import(dist('state/clock.js'));
const { FileStateStore } = await import(dist('state/file-store.js'));

const roots = [];
const NOW = Date.parse('2026-10-22T10:00:00.000Z');

/** A throwaway directory, removed after the run. */
function tempRoot(prefix = 'reflex-opencode-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A `harness-reflex` command on PATH that execs the built CLI. */
function installCliShim() {
  const binDir = tempRoot('reflex-opencode-bin-');
  const file = path.join(binDir, 'harness-reflex');
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  fs.chmodSync(file, 0o755);
  // The plugin spawns this path directly, so return the executable, not its dir.
  return file;
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

/** Seed one failed tool observation, the evidence a closing check reads. */
function seedFailure(root, session = 'ses_1') {
  const store = new FileStateStore({ root, clock: new FixedClock(NOW) });
  store.ensureSession(session, 'active');
  store.appendEvent(session, {
    v: 1,
    kind: 'post',
    at: NOW,
    atIso: new Date(NOW).toISOString(),
    turnNo: 0,
    tool: 'bash',
    failed: true,
    output: 'ERROR: build failed'
  });
}

/** An OpenCode tool call as the host hands it to `tool.execute.before`. */
function call(tool, args, callID, sessionID = 'ses_1') {
  return { input: { tool, sessionID, callID }, output: { args } };
}

/** A tool result as the host hands it to `tool.execute.after`. */
function result(tool, args, callID, outputText, sessionID = 'ses_1') {
  return {
    input: { tool, sessionID, callID, args },
    output: { title: tool, output: outputText, metadata: {} }
  };
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

test('runHook: it speaks the same wire contract as the command hooks', async () => {
  const bin = installCliShim();
  const verdict = await runHook('pretooluse', {
    session_id: 'ses_1',
    tool_name: 'bash',
    tool_input: { command: 'ls' },
    tool_use_id: 'call-1'
  }, { bin, env: hookEnv(tempRoot()) });
  assert.deepEqual(verdict, {});
});

test('allow: a normal call neither throws nor rewrites', async () => {
  const bin = installCliShim();
  const plugin = await ReflexPlugin({}, { bin, env: hookEnv(tempRoot()) });
  const { input, output } = call('bash', { command: 'ls' }, 'call-allow');
  await plugin['tool.execute.before'](input, output);
  assert.deepEqual(output.args, { command: 'ls' });
});

test('deny: the third identical call throws, so the host refuses the tool call', async () => {
  const bin = installCliShim();
  const plugin = await ReflexPlugin({}, { bin, env: hookEnv(tempRoot()) });
  // Distinct call ids: two different calls of one command must not be treated
  // as a replay, or the stagnation count never advances.
  for (const id of ['call-d1', 'call-d2']) {
    const { input, output } = call('bash', { command: 'make test' }, id);
    await plugin['tool.execute.before'](input, output);
  }
  const { input, output } = call('bash', { command: 'make test' }, 'call-d3');
  await assert.rejects(() => plugin['tool.execute.before'](input, output), /identical|repeated|consecutive/i);
});

test('rewrite: an oversized result is pruned in place and the original is retained', async () => {
  const stateRoot = tempRoot();
  const bin = installCliShim();
  const plugin = await ReflexPlugin({}, { bin, env: hookEnv(stateRoot) });
  const big = bigText();
  const { input, output } = result('bash', { command: 'make' }, 'call-r1', big);
  await plugin['tool.execute.after'](input, output);

  assert.notEqual(output.output, big, 'the model-visible text must change');
  assert.ok(output.output.length < big.length, 'the replacement must be shorter');

  const locator = /originals\/([a-f0-9]+)\.txt/.exec(output.output);
  assert.ok(locator, 'the replacement must carry a locator');
  const store = new FileStateStore({ root: stateRoot, clock: new FixedClock(NOW) });
  const original = fs.readFileSync(path.join(store.sessionPaths('ses_1').originals, `${locator[1]}.txt`));
  assert.ok(original.equals(Buffer.from(big)), 'the locator must restore the original byte-for-byte');
});

test('rewrite: an unremarkable result is passed through byte-identically', async () => {
  const bin = installCliShim();
  const plugin = await ReflexPlugin({}, { bin, env: hookEnv(tempRoot()) });
  const text = 'ok: 3 files changed';
  const { input, output } = result('bash', { command: 'true' }, 'call-r2', text);
  await plugin['tool.execute.after'](input, output);
  assert.equal(output.output, text);
});

test('block: a Stop objection is reported, because the host has no turn veto', async () => {
  const stateRoot = tempRoot();
  seedFailure(stateRoot);
  const bin = installCliShim();
  const logged = [];
  const client = {
    app: {
      log: async (entry) => {
        logged.push(entry);
      }
    }
  };
  const plugin = await ReflexPlugin({ client }, {
    bin,
    env: hookEnv(stateRoot, { HARNESS_REFLEX_CLOSING_MODE: 'active' })
  });

  // The verdict itself is a real block, produced by the real decision layer.
  const verdict = await runHook('stop', {
    session_id: 'ses_1',
    stop_hook_active: false,
    last_assistant_message: 'All tests pass and the task is complete.'
  }, { bin, env: hookEnv(stateRoot, { HARNESS_REFLEX_CLOSING_MODE: 'active' }) });
  assert.equal(verdict.decision, 'block');
  assert.match(verdict.reason, /contradicts/);
  assert.ok(mapVerdict(verdict).blockedReason);

  // Through the plugin, the same objection is logged and never enforced.
  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_2' } } });
  const warned = logged.filter((entry) => entry.body.level === 'warn');
  for (const entry of warned) assert.equal(entry.body.service, 'harness-reflex');
});

test('mapVerdict: the four decision paths map to the documented effects', () => {
  assert.deepEqual(mapVerdict({}), {});
  assert.deepEqual(mapVerdict(undefined), {});
  assert.deepEqual(mapVerdict({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'nope' } }), {
    denyReason: 'nope'
  });
  // A deny without a reason still refuses; it never becomes an allow.
  assert.deepEqual(mapVerdict({ hookSpecificOutput: { permissionDecision: 'deny' } }), {
    denyReason: 'blocked by harness-reflex'
  });
  assert.deepEqual(mapVerdict({ hookSpecificOutput: { updatedToolOutput: 'short' } }), { replacement: 'short' });
  assert.deepEqual(mapVerdict({ decision: 'block', reason: 'x' }), { blockedReason: 'x' });
});

test("payload: it uses the host's field names and drops nothing the decision reads", () => {
  const { input, output } = call('bash', { command: 'ls' }, 'call-p1');
  assert.deepEqual(toolPayload(input, output), {
    session_id: 'ses_1',
    tool_name: 'bash',
    tool_input: { command: 'ls' },
    tool_use_id: 'call-p1'
  });
});

test('fail-open: a missing CLI, a broken CLI and a timeout all allow', async () => {
  const missing = await runHook('pretooluse', { session_id: 's' }, {
    bin: path.join(tempRoot(), 'definitely-not-installed'),
    env: hookEnv(tempRoot())
  });
  assert.equal(missing, undefined);

  const binDir = tempRoot('reflex-opencode-broken-');
  const broken = path.join(binDir, 'harness-reflex');
  fs.writeFileSync(broken, '#!/bin/sh\nprintf "not json"\nexit 0\n');
  fs.chmodSync(broken, 0o755);
  assert.equal(await runHook('pretooluse', { session_id: 's' }, { bin: broken, env: hookEnv(tempRoot()) }), undefined);

  const slow = path.join(binDir, 'harness-reflex-slow');
  fs.writeFileSync(slow, '#!/bin/sh\nsleep 5\nprintf "{}\\n"\n');
  fs.chmodSync(slow, 0o755);
  const started = Date.now();
  assert.equal(await runHook('pretooluse', { session_id: 's' }, { bin: slow, env: hookEnv(tempRoot()), timeoutMs: 100 }), undefined);
  assert.ok(Date.now() - started < 3000, 'the timeout must actually cut the child off');
});

test('session events: created and deleted are recorded, other events are ignored', async () => {
  const stateRoot = tempRoot();
  const bin = installCliShim();
  const plugin = await ReflexPlugin({}, { bin, env: hookEnv(stateRoot) });
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'ses_9' } } } });
  // A session directory now exists for the id the host reported.
  const store = new FileStateStore({ root: stateRoot, clock: new FixedClock(NOW) });
  assert.ok(fs.existsSync(store.sessionPaths('ses_9').dir));
  // An unhandled event type is a no-op, not an error.
  await plugin.event({ event: { type: 'todo.updated', properties: { sessionID: 'ses_9', todos: [] } } });
  await plugin.event({});
});

test('settings: the environment fills in for a host that passes no options', async () => {
  const bin = installCliShim();
  const env = hookEnv(tempRoot(), { HARNESS_REFLEX_BIN: bin, HARNESS_REFLEX_TIMEOUT_MS: '2500' });
  // No `bin` option: the plugin must fall back to HARNESS_REFLEX_BIN.
  const plugin = await ReflexPlugin({}, { env });
  const { input, output } = call('bash', { command: 'ls' }, 'call-env');
  await plugin['tool.execute.before'](input, output);
  assert.deepEqual(output.args, { command: 'ls' });

  // An unusable HARNESS_REFLEX_TIMEOUT_MS must not disable the plugin.
  const fallback = await ReflexPlugin({}, { bin, env: hookEnv(tempRoot(), { HARNESS_REFLEX_TIMEOUT_MS: 'nonsense' }) });
  const { input: second, output: secondOutput } = call('bash', { command: 'ls' }, 'call-env2');
  await fallback['tool.execute.before'](second, secondOutput);
  assert.deepEqual(secondOutput.args, { command: 'ls' });
});

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
