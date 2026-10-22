/**
 * Behavioral checks for the plugin's hook wiring, run without a `claude`
 * binary: the seven events are fed real-shaped stdin JSON, the three states are
 * compared on the model-visible surface, and the fail-open paths are injected.
 *
 * The tests call the same `harness-reflex hook <event>` command hooks.json
 * declares, so they exercise the installed surface rather than a mock of it.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const CLI = path.join(repoRoot, 'dist', 'cli', 'index.js');
const dist = (relative) => pathToFileURL(path.join(repoRoot, 'dist', relative)).href;

const { FixedClock } = await import(dist('state/clock.js'));
const { FileStateStore } = await import(dist('state/file-store.js'));
const { MockDecisionBackend } = await import(dist('backend/mock.js'));
const { runHook, resolveHookModes, DEFAULT_CAPABILITY_MODES } = await import(dist('hook/run.js'));

const roots = [];
const NOW = Date.parse('2026-10-22T10:00:00.000Z');

/** A throwaway state root for one test. */
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-claude-'));
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
  if (!('CLAUDE_PLUGIN_OPTION_CLOSING_MODE' in extra)) delete env.CLAUDE_PLUGIN_OPTION_CLOSING_MODE;
  return env;
}

/** Run the real command hook, exactly as `hooks/hooks.json` does. */
function runCli(event, payload, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'hook', event], {
      cwd: repoRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
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

/** Parse the single stdout object; a hook must never print anything else. */
function hookOutput(result) {
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(typeof parsed, 'object');
  return parsed;
}

/** Read the ledger from a state root. */
function ledgerOf(root, session = 's1') {
  return new FileStateStore({ root, clock: new FixedClock(NOW) }).readLedger(session, 500);
}

/** Seed one failed tool observation, the evidence a closing check reads. */
function seedFailure(root, session = 's1') {
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

/**
 * A tool result above the prune threshold whose bulk the deterministic mock
 * prune really drops (progress bars and node_modules internals). The remaining
 * candidate is under the 50 % floor, so the installed form carries the locator
 * marker — the shape the e2e script has to verify on a real run.
 */
function bigText() {
  const lines = [];
  for (let index = 0; index < 160; index += 1) {
    lines.push(`[=== progress ${index % 100}% ===] downloading artifact ${index}`);
  }
  for (let index = 0; index < 10; index += 1) {
    lines.push(`line ${index}: generated output that the reduction may keep or drop`);
  }
  lines.push('node_modules/example/dist/index.js: 1 error');
  lines.push('ERROR: cannot find module "example"');
  return lines.join('\n');
}

/**
 * The text Claude actually reads for a PostToolUse event: the hook replacement
 * when present, otherwise the tool's own output. This is the surface the
 * observe contract is defined on.
 */
function visiblePostToolOutput(payload, output) {
  if (output?.hookSpecificOutput?.updatedToolOutput !== undefined) {
    return output.hookSpecificOutput.updatedToolOutput;
  }
  // What `toolResponseText` reads from the host's stdout/stderr shape; this is
  // the exact text the hook retains, so a locator can be compared byte-for-byte.
  return [payload.tool_response.stdout, payload.tool_response.stderr].join('\n');
}

/** The context Claude actually reads for a PreToolUse event. */
function visiblePreToolOutput(output) {
  if (output?.hookSpecificOutput?.permissionDecision === 'deny') {
    return `DENY ${output.hookSpecificOutput.permissionDecisionReason}`;
  }
  return '';
}

test('all seven events answer with the documented shape and exit 0', async () => {
  const root = tempRoot();
  const base = hookEnv(root);

  const pre = await runCli('pretooluse', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 't1'
  }, base);
  assert.deepEqual(hookOutput(pre), {});

  const big = bigText();
  const post = await runCli('posttooluse', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_use_id: 't2',
    tool_response: { stdout: big, stderr: '' },
    duration_ms: 10
  }, base);
  const postOut = hookOutput(post);
  assert.equal(postOut.hookSpecificOutput?.hookEventName, 'PostToolUse');
  assert.ok(postOut.hookSpecificOutput.updatedToolOutput.length < big.length);

  // Three consecutive failed calls: the third carries the correction.
  const failure = (id) => runCli('postfailure', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_use_id: id,
    error: 'boom'
  }, base);
  assert.deepEqual(hookOutput(await failure('f1')), {});
  assert.deepEqual(hookOutput(await failure('f2')), {});
  const corrected = hookOutput(await failure('f3'));
  assert.equal(corrected.hookSpecificOutput?.hookEventName, 'PostToolUseFailure');
  assert.match(corrected.hookSpecificOutput.additionalContext, /consecutive tool calls failed/);

  // Stop defaults to observe: same evidence + claim, but no decision. The
  // ledger still records what active would have done.
  const stopRoot = tempRoot();
  seedFailure(stopRoot);
  const observed = await runCli('stop', {
    session_id: 's1',
    stop_hook_active: false,
    last_assistant_message: 'All tests pass and the task is complete.'
  }, hookEnv(stopRoot));
  assert.deepEqual(hookOutput(observed), {});
  const observedClosing = ledgerOf(stopRoot).findLast((record) => record.type === 'closing');
  assert.equal(observedClosing.shadow, true);
  assert.equal(observedClosing.applied, false);

  // The plugin option flips the same event to a hard block.
  const activeRoot = tempRoot();
  seedFailure(activeRoot);
  const active = await runCli('stop', {
    session_id: 's1',
    stop_hook_active: false,
    last_assistant_message: 'All tests pass and the task is complete.'
  }, hookEnv(activeRoot, { CLAUDE_PLUGIN_OPTION_CLOSING_MODE: 'active' }));
  const blocked = hookOutput(active);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /contradicts/);

  // The host's guarded retry must reach the allow path.
  const retry = await runCli('stop', {
    session_id: 's1',
    stop_hook_active: true,
    last_assistant_message: 'All tests pass and the task is complete.'
  }, hookEnv(activeRoot, { CLAUDE_PLUGIN_OPTION_CLOSING_MODE: 'active' }));
  assert.deepEqual(hookOutput(retry), {});

  // SubagentStop shares the Stop contract; the plugin ships it disabled.
  const subRoot = tempRoot();
  seedFailure(subRoot);
  const sub = await runCli('substop', {
    session_id: 's1',
    stop_hook_active: false,
    last_assistant_message: 'All tests pass and the task is complete.',
    agent_id: 'a1',
    agent_type: 'general-purpose'
  }, hookEnv(subRoot, { CLAUDE_PLUGIN_OPTION_CLOSING_MODE: 'active' }));
  assert.equal(hookOutput(sub).decision, 'block');

  const start = hookOutput(await runCli('sessionstart', {
    session_id: 's1',
    source: 'startup',
    cwd: repoRoot
  }, hookEnv(tempRoot())));
  assert.equal(start.hookSpecificOutput?.hookEventName, 'SessionStart');
  assert.match(start.hookSpecificOutput.additionalContext, /mode=active/);
  assert.match(start.hookSpecificOutput.additionalContext, /closing=observe/);

  const end = await runCli('sessionend', { session_id: 's1', reason: 'exit' }, hookEnv(tempRoot()));
  assert.deepEqual(hookOutput(end), {});
});

test('default modes: tool-call interventions active, closing observe', () => {
  assert.deepEqual(DEFAULT_CAPABILITY_MODES, {
    stagnation: 'active',
    prune: 'active',
    gate: 'active',
    closing: 'observe'
  });
  const resolved = resolveHookModes({});
  assert.deepEqual(resolved, DEFAULT_CAPABILITY_MODES);
  assert.equal(resolveHookModes({ CLAUDE_PLUGIN_OPTION_CLOSING_MODE: 'active' }).closing, 'active');
  assert.equal(resolveHookModes({ HARNESS_REFLEX_MODE: 'off' }).prune, 'off');
  assert.equal(resolveHookModes({ HARNESS_REFLEX_PRUNE_MODE: 'observe' }).prune, 'observe');
});

test('off and observe leave the model-visible surface byte-identical; active differs and restores', async () => {
  const payload = {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_use_id: 't1',
    tool_response: { stdout: bigText(), stderr: '' },
    duration_ms: 10
  };
  const baseline = Buffer.from(visiblePostToolOutput(payload, {}));

  const offRoot = tempRoot();
  const off = hookOutput(await runCli('posttooluse', payload, hookEnv(offRoot, { HARNESS_REFLEX_MODE: 'off' })));
  assert.deepEqual(off, {});
  assert.ok(Buffer.from(visiblePostToolOutput(payload, off)).equals(baseline), 'off must be byte-identical');
  assert.equal(fs.existsSync(path.join(offRoot, 'sessions')), false, 'off must not create state');

  const observeRoot = tempRoot();
  const observe = hookOutput(await runCli('posttooluse', payload, hookEnv(observeRoot, { HARNESS_REFLEX_MODE: 'observe' })));
  assert.deepEqual(observe, {});
  assert.ok(Buffer.from(visiblePostToolOutput(payload, observe)).equals(baseline), 'observe must be byte-identical');
  const observeLedger = ledgerOf(observeRoot).find((record) => record.type === 'prune');
  assert.equal(observeLedger.shadow, true);
  assert.equal(observeLedger.applied, false);
  assert.equal(observeLedger.tokensSaved, 0);

  const activeRoot = tempRoot();
  const active = hookOutput(await runCli('posttooluse', payload, hookEnv(activeRoot)));
  const replaced = visiblePostToolOutput(payload, active);
  assert.notEqual(replaced, payload.tool_response.stdout);
  assert.ok(replaced.length < payload.tool_response.stdout.length, 'active must be shorter');

  // The locator names a retained original that restores the baseline exactly.
  const locator = /originals\/([a-f0-9]+)\.txt/.exec(replaced);
  assert.ok(locator, 'the replacement must carry a locator');
  const store = new FileStateStore({ root: activeRoot, clock: new FixedClock(NOW) });
  const original = fs.readFileSync(path.join(store.sessionPaths('s1').originals, `${locator[1]}.txt`));
  assert.ok(original.equals(baseline), 'the locator must restore the original byte-for-byte');

  // PreToolUse: the same baseline/off/observe equality on the deny surface.
  const prePayload = {
    session_id: 'p1',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_use_id: 'x1'
  };
  const preBaseline = Buffer.from(visiblePreToolOutput({}));
  const preOff = hookOutput(await runCli('pretooluse', prePayload, hookEnv(tempRoot(), { HARNESS_REFLEX_MODE: 'off' })));
  const preObserve = hookOutput(await runCli('pretooluse', prePayload, hookEnv(tempRoot(), { HARNESS_REFLEX_MODE: 'observe' })));
  assert.ok(Buffer.from(visiblePreToolOutput(preOff)).equals(preBaseline));
  assert.ok(Buffer.from(visiblePreToolOutput(preObserve)).equals(preBaseline));
});

test('bad input, a crashing backend and a timeout all fail open; the session ones are audited', async () => {
  // Bad JSON has no session_id, so it can only fail open and explain itself on
  // stderr; the session ledger (which is keyed by session) stays untouched.
  const badRoot = tempRoot();
  const bad = await runCli('pretooluse', 'not json at all', hookEnv(badRoot));
  assert.equal(bad.code, 0);
  assert.equal(bad.stdout, '{}\n');
  assert.equal(fs.existsSync(path.join(badRoot, 'sessions')), false, 'unattributable input must not create state');

  // Backend crash at Stop: the decision itself is the only thing that can block.
  const crashRoot = tempRoot();
  seedFailure(crashRoot);
  const clock = new FixedClock(NOW);
  const store = new FileStateStore({ root: crashRoot, clock });
  const backend = new MockDecisionBackend();
  backend.gate = async () => {
    throw new Error('backend down');
  };
  const crashed = await runHook('stop', {
    env: {
      HARNESS_REFLEX_STATE_DIR: crashRoot,
      HARNESS_REFLEX_MODE: 'active',
      SYSTEM_ONE_BACKEND: 'mock'
    },
    clock,
    store,
    backend,
    stderr: () => {},
    readStdin: async () => ({
      text: JSON.stringify({
        session_id: 's1',
        stop_hook_active: false,
        last_assistant_message: 'All tests pass and the task is complete.'
      }),
      overflow: false
    })
  });
  assert.deepEqual(crashed.output, {});
  assert.equal(crashed.code, 0);
  const crashLedger = store.readLedger('s1', 50);
  const crashError = crashLedger.findLast((record) => record.type === 'error');
  assert.equal(crashError.skipReason, 'backend-error');

  // Timeout: a judgment that outlives the event budget is abandoned, audited,
  // and cannot become a veto.
  const timeoutRoot = tempRoot();
  seedFailure(timeoutRoot);
  const slowStore = new FileStateStore({ root: timeoutRoot, clock });
  const slowBackend = new MockDecisionBackend();
  slowBackend.classifyClaims = async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { results: [], latencyMs: 100 };
  };
  const timedOut = await runHook('stop', {
    env: {
      HARNESS_REFLEX_STATE_DIR: timeoutRoot,
      HARNESS_REFLEX_MODE: 'active'
    },
    clock,
    store: slowStore,
    backend: slowBackend,
    config: { eventBudgets: { ...DEFAULT_BUDGETS(), stop: { budgetMs: 5, hookTimeoutMs: 2000 } } },
    stderr: () => {},
    readStdin: async () => ({
      text: JSON.stringify({
        session_id: 's1',
        stop_hook_active: false,
        last_assistant_message: 'All tests pass and the task is complete.'
      }),
      overflow: false
    })
  });
  assert.deepEqual(timedOut.output, {});
  const timeoutError = slowStore.readLedger('s1', 50).findLast((record) => record.type === 'error');
  assert.equal(timeoutError.skipReason, 'hook-timeout');
});

/** The default per-event budget table, kept local so the fixture is explicit. */
function DEFAULT_BUDGETS() {
  return {
    pretooluse: { budgetMs: 300, hookTimeoutMs: 1000 },
    posttooluse: { budgetMs: 800, hookTimeoutMs: 2000 },
    postfailure: { budgetMs: 300, hookTimeoutMs: 1000 },
    stop: { budgetMs: 1000, hookTimeoutMs: 2000 },
    substop: { budgetMs: 1000, hookTimeoutMs: 2000 },
    sessionstart: { budgetMs: 1200, hookTimeoutMs: 2000 },
    sessionend: { budgetMs: 1200, hookTimeoutMs: 1500 }
  };
}

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
