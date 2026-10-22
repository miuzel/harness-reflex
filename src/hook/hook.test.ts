/**
 * `harness-reflex hook <event>` fixtures.
 *
 * The suite covers the design §4.1 S2 acceptance list: the normal paths, the
 * no-decision and failure paths, the three modes, idempotency, `stop_hook_active`,
 * the fifty-process ledger invariant, kill/replay at the store boundary, three
 * corrupted files, and the explicit refusal of an unsupported platform.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MockDecisionBackend } from '../backend/mock.js';
import type { DecisionBackend } from '../backend/types.js';
import { FixedClock } from '../state/clock.js';
import { FileStateStore, type HookLedgerRecord } from '../state/file-store.js';
import { EVENT_BUDGETS, parseHookEvent } from './contract.js';
import { dedupeKeyFor, runHook, type HookConfig } from './run.js';

const CLI = fileURLToPath(new URL('../cli/index.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const NOW = Date.parse('2026-10-22T10:00:00.000Z');
const roots: string[] = [];

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface CliOptions {
  env?: Record<string, string>;
  /** Leave stdin open after writing, for the signal fixture. */
  holdStdin?: boolean;
  signalAfterMs?: number;
  signal?: NodeJS.Signals;
}

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-hook-'));
  roots.push(dir);
  return dir;
}

function runCli(event: string, payload: string | Record<string, unknown>, options: CliOptions = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'hook', event], {
      env: {
        ...process.env,
        SYSTEM_ONE_BACKEND: 'mock',
        HARNESS_REFLEX_MODE: 'active',
        ...(options.env ?? {})
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (options.holdStdin) {
      child.stdin.write(body);
      if (options.signalAfterMs !== undefined) {
        setTimeout(() => child.kill(options.signal ?? 'SIGTERM'), options.signalAfterMs);
      }
      return;
    }
    child.stdin.end(body);
  });
}

function parseJson(result: CliResult): Record<string, unknown> {
  assert.equal(result.stderr.includes('Error'), false, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function ledgerOf(root: string, session = 's1'): HookLedgerRecord[] {
  const store = new FileStateStore({ root, clock: new FixedClock(NOW) });
  return store.readLedger(session, 500);
}

/** A payload above the prune threshold with reducible lines. */
function bigText(): string {
  const lines: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    lines.push(`line ${index}: generated output that the reduction may keep or drop`);
  }
  lines.push('[=== progress 20% ===');
  lines.push('[=== progress 40% ===');
  lines.push('node_modules/example/dist/index.js: 1 error');
  lines.push('ERROR: cannot find module "example"');
  return lines.join('\n');
}

function inProcess(payloads: Record<string, unknown>, event: string, extra: {
  mode?: string;
  backend?: DecisionBackend;
  store?: FileStateStore;
  config?: Partial<HookConfig>;
} = {}): Promise<{ output: Record<string, unknown>; result: Awaited<ReturnType<typeof runHook>> }> {
  const root = tempRoot();
  const clock = new FixedClock(NOW);
  const store = extra.store ?? new FileStateStore({ root, clock });
  return runHook(event, {
    env: {
      HARNESS_REFLEX_STATE_DIR: root,
      HARNESS_REFLEX_MODE: extra.mode ?? 'active',
      SYSTEM_ONE_BACKEND: 'mock'
    } as NodeJS.ProcessEnv,
    clock,
    store,
    backend: extra.backend,
    config: extra.config,
    stderr: () => {},
    readStdin: async () => ({ text: JSON.stringify(payloads), overflow: false })
  }).then((result) => ({ output: (result.output ?? {}) as Record<string, unknown>, result }));
}

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('event aliases cover the six required events plus SubagentStop', () => {
  assert.equal(parseHookEvent('pretooluse'), 'pretooluse');
  assert.equal(parseHookEvent('PreToolUse'), 'pretooluse');
  assert.equal(parseHookEvent('posttooluse'), 'posttooluse');
  assert.equal(parseHookEvent('PostToolUseFailure'), 'postfailure');
  assert.equal(parseHookEvent('postfailure'), 'postfailure');
  assert.equal(parseHookEvent('stop'), 'stop');
  assert.equal(parseHookEvent('subagentstop'), 'substop');
  assert.equal(parseHookEvent('sessionstart'), 'sessionstart');
  assert.equal(parseHookEvent('sessionend'), 'sessionend');
  // `post-tool` / `pre-tool` are what the AGY bundle used to emit; the alias
  // keeps that wiring working instead of silently no-oping.
  assert.equal(parseHookEvent('post-tool'), 'posttooluse');
  assert.equal(parseHookEvent('pre-tool'), 'pretooluse');
  assert.equal(parseHookEvent('nonsense'), undefined);
});

test('every hook command a bundled harness ships names a real event', async () => {
  const shipped = [
    join(repoRoot, '.agents', 'plugins', 'harness-reflex', 'hooks.json'),
    join(repoRoot, 'packages', 'claude-reflex', 'hooks', 'hooks.json')
  ];
  for (const file of shipped) {
    const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const seen = new Set<string>();
    // The bundle shapes differ (Claude nests under `hooks`, AGY keys by guard),
    // so scan the whole document for the dispatcher call.
    JSON.stringify(config, (key, value: unknown) => {
      if (key === 'args' && Array.isArray(value)) {
        const index = value.indexOf('hook');
        if (index >= 0 && typeof value[index + 1] === 'string') seen.add(value[index + 1] as string);
      }
      if (typeof value === 'string' && /\bhook\s+([a-z-]+)/i.test(value)) {
        seen.add(/\bhook\s+([a-z-]+)/i.exec(value)![1] as string);
      }
      return value;
    });
    assert.ok(seen.size > 0, `${file} wires no hook command`);
    for (const event of seen) {
      assert.notEqual(parseHookEvent(event), undefined, `${file} wires unknown hook event "${event}"`);
    }
  }
});

test('PreToolUse: a normal call allows silently and records one ledger line', async () => {
  const root = tempRoot();
  const result = await runCli('pretooluse', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 't1'
  }, { env: { HARNESS_REFLEX_STATE_DIR: root } });
  assert.equal(result.code, 0);
  assert.deepEqual(parseJson(result), {});
  const ledger = ledgerOf(root);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.type, 'stagnation');
  assert.equal(ledger[0]!.skipReason, 'no-local-pattern');
});

test('PostToolUse: oversized output is pruned, retained, and accounted', async () => {
  const root = tempRoot();
  const text = bigText();
  const result = await runCli('posttooluse', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_use_id: 't1',
    tool_response: { stdout: text, stderr: '' },
    duration_ms: 10
  }, { env: { HARNESS_REFLEX_STATE_DIR: root } });
  assert.equal(result.code, 0);
  const output = parseJson(result) as { hookSpecificOutput?: { updatedToolOutput?: string } };
  const replaced = output.hookSpecificOutput?.updatedToolOutput;
  assert.equal(typeof replaced, 'string');
  assert.ok(replaced!.length < text.length);
  const ledger = ledgerOf(root);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.type, 'prune');
  assert.equal(ledger[0]!.applied, true);
  assert.equal(ledger[0]!.retention, 'retained');
  assert.ok((ledger[0]!.tokensSaved ?? 0) > 0);
  const store = new FileStateStore({ root, clock: new FixedClock(NOW) });
  const originals = fs.readdirSync(store.sessionPaths('s1').originals);
  assert.equal(originals.length, 1);
});

test('PostToolUse: below-threshold output produces no decision', async () => {
  const root = tempRoot();
  const result = await runCli('posttooluse', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_use_id: 't1',
    tool_response: { stdout: 'hi\n' }
  }, { env: { HARNESS_REFLEX_STATE_DIR: root } });
  assert.deepEqual(parseJson(result), {});
  const ledger = ledgerOf(root);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.skipReason, 'below-threshold');
  const store = new FileStateStore({ root, clock: new FixedClock(NOW) });
  assert.deepEqual(fs.readdirSync(store.sessionPaths('s1').originals), []);
});

test('bad stdin JSON fails open with an empty object and creates no state', async () => {
  const root = tempRoot();
  const result = await runCli('pretooluse', '{"session_id": ', { env: { HARNESS_REFLEX_STATE_DIR: root } });
  assert.equal(result.code, 0);
  assert.deepEqual(parseJson(result), {});
  assert.equal(fs.existsSync(path.join(root, 'sessions')), false);
});

test('a 10 MiB stdin is drained with bounded memory and fails open', async () => {
  const root = tempRoot();
  const huge = 'x'.repeat(10 * 1024 * 1024);
  const payload = `{"session_id":"s1","tool_name":"Bash","tool_input":"${huge}"}`;
  const result = await runCli('pretooluse', payload, { env: { HARNESS_REFLEX_STATE_DIR: root } });
  assert.equal(result.code, 0);
  assert.deepEqual(parseJson(result), {});
  assert.equal(fs.existsSync(path.join(root, 'sessions')), false);
});

test('SIGTERM while waiting on stdin still emits {} and exits 0', async () => {
  const root = tempRoot();
  const result = await runCli('pretooluse', '{"session_id":"s1"', {
    env: { HARNESS_REFLEX_STATE_DIR: root },
    holdStdin: true,
    signalAfterMs: 120
  });
  assert.equal(result.code, 0);
  assert.deepEqual(parseJson(result), {});
});

test('a decision that exceeds its budget fails open and records a timeout', async () => {
  const root = tempRoot();
  const clock = new FixedClock(NOW);
  const store = new FileStateStore({ root, clock });
  const hanging = {
    name: 'hanging',
    model: 'hanging',
    prune: () => new Promise(() => {}),
    checkStagnation: () => new Promise(() => {}),
    gate: () => new Promise(() => {}),
    choice: () => new Promise(() => {}),
    route: () => new Promise(() => {})
  } as unknown as DecisionBackend;
  const config: Partial<HookConfig> = {
    eventBudgets: {
      ...EVENT_BUDGETS,
      posttooluse: { budgetMs: 40, hookTimeoutMs: 2000 }
    }
  };
  const { output } = await inProcess({
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_use_id: 't1',
    tool_response: { stdout: bigText() }
  }, 'posttooluse', { backend: hanging, store, config });
  assert.deepEqual(output, {});
  const ledger = store.readLedger('s1', 10);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.type, 'error');
  assert.equal(ledger[0]!.skipReason, 'hook-timeout');
});

test('duplicate delivery of the same tool_use_id is idempotent', async () => {
  const root = tempRoot();
  const payload = {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_use_id: 'same-id',
    tool_response: { stdout: bigText() }
  };
  const first = await runCli('posttooluse', payload, { env: { HARNESS_REFLEX_STATE_DIR: root } });
  const second = await runCli('posttooluse', payload, { env: { HARNESS_REFLEX_STATE_DIR: root } });
  assert.equal(first.stdout, second.stdout);
  assert.equal(ledgerOf(root).length, 1);
});

test('twenty concurrent deliveries of one tool_use_id are accounted exactly once', async () => {
  const root = tempRoot();
  const env = { HARNESS_REFLEX_STATE_DIR: root };
  const payload = {
    session_id: 'shared',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_use_id: 'same-call',
    tool_response: { stdout: bigText() }
  };
  const results = await Promise.all(
    Array.from({ length: 20 }, () => runCli('posttooluse', payload, { env }))
  );
  assert.equal(results.every((result) => result.code === 0), true);
  const store = new FileStateStore({ root, clock: new FixedClock(NOW) });
  assert.equal(store.readLedger('shared', 100).length, 1);
  assert.equal(store.readEvents('shared', 100).length, 1);
  const decisions = new Set(
    results.map((result) => result.stdout.trim()).filter((stdout) => stdout !== '{}' && stdout !== '')
  );
  assert.equal(decisions.size, 1, 'every replayed delivery returns the same decision');
});

test('a claim left by a killed process is recovered on the next delivery', async () => {
  const root = tempRoot();
  const env = { HARNESS_REFLEX_STATE_DIR: root };
  const payload = {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_use_id: 'killed-call',
    tool_response: { stdout: bigText() }
  };
  // Create the session first, then plant a claim owned by a dead pid.
  const first = await runCli('posttooluse', { ...payload, tool_use_id: 'warmup' }, { env });
  assert.equal(first.code, 0);
  const store = new FileStateStore({ root, clock: new FixedClock(NOW) });
  const key = dedupeKeyFor('posttooluse', payload as unknown as Record<string, unknown>);
  fs.writeFileSync(
    path.join(store.sessionPaths('s1').decisions, `${key}.claim`),
    JSON.stringify({ pid: 999999, startedMs: Date.now() })
  );
  const recovered = await runCli('posttooluse', payload, { env });
  const output = parseJson(recovered) as { hookSpecificOutput?: { updatedToolOutput?: string } };
  assert.equal(typeof output.hookSpecificOutput?.updatedToolOutput, 'string');
  assert.equal(store.readLedger('s1', 100).filter((record) => record.dedupeKey === key).length, 1);
});

test('Stop blocks a contradicted completion claim; stop_hook_active allows', async () => {
  const root = tempRoot();
  const env = { HARNESS_REFLEX_STATE_DIR: root };
  await runCli('posttooluse', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_use_id: 't1',
    tool_response: { stdout: 'ERROR: cannot find module\n' }
  }, { env });
  const beforeStop = new FileStateStore({ root, clock: new FixedClock(NOW) }).readState('s1');
  assert.equal(beforeStop.turnNo, 0, 'turnNo advances only on Stop');
  const blocked = await runCli('stop', {
    session_id: 's1',
    stop_hook_active: false,
    last_assistant_message: 'All tests pass and the task is complete.'
  }, { env });
  const output = parseJson(blocked) as { decision?: string; reason?: string };
  assert.equal(output.decision, 'block');
  assert.ok((output.reason ?? '').includes('contradicts'));

  const guarded = await runCli('stop', {
    session_id: 's1',
    stop_hook_active: true,
    last_assistant_message: 'All tests pass and the task is complete.'
  }, { env });
  assert.deepEqual(parseJson(guarded), {});
  const store = new FileStateStore({ root, clock: new FixedClock(NOW) });
  const state = store.readState('s1');
  assert.equal(state.turnNo, 2);
});

test('a full originals store degrades to shrink-without-retention and claims no saving', async () => {
  const root = tempRoot();
  const clock = new FixedClock(NOW);
  const store = new FileStateStore({ root, clock, maxOriginalBytes: 10 });
  const { output } = await inProcess({
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_use_id: 't1',
    tool_response: { stdout: bigText() }
  }, 'posttooluse', { store });
  const replaced = (output as { hookSpecificOutput?: { updatedToolOutput?: string } }).hookSpecificOutput?.updatedToolOutput;
  assert.equal(typeof replaced, 'string');
  const ledger = store.readLedger('s1', 10);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.retention, 'evicted');
  assert.equal(ledger[0]!.tokensSaved, 0);
  assert.deepEqual(fs.readdirSync(store.sessionPaths('s1').originals), []);
});

test('off is absent, observe records but never changes the surface, active replaces', async () => {
  const offRoot = tempRoot();
  const off = await runCli('posttooluse', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_use_id: 't1',
    tool_response: { stdout: bigText() }
  }, { env: { HARNESS_REFLEX_STATE_DIR: offRoot, HARNESS_REFLEX_MODE: 'off' } });
  assert.deepEqual(parseJson(off), {});
  assert.equal(fs.existsSync(path.join(offRoot, 'sessions')), false);

  const observeRoot = tempRoot();
  const observe = await runCli('posttooluse', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_use_id: 't1',
    tool_response: { stdout: bigText() }
  }, { env: { HARNESS_REFLEX_STATE_DIR: observeRoot, HARNESS_REFLEX_MODE: 'observe' } });
  assert.deepEqual(parseJson(observe), {});
  const observed = ledgerOf(observeRoot);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]!.shadow, true);
  assert.equal(observed[0]!.tokensSaved, 0);
  const observeStore = new FileStateStore({ root: observeRoot, clock: new FixedClock(NOW) });
  assert.deepEqual(fs.readdirSync(observeStore.sessionPaths('s1').originals), []);

  const activeRoot = tempRoot();
  const active = await runCli('posttooluse', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_use_id: 't1',
    tool_response: { stdout: bigText() }
  }, { env: { HARNESS_REFLEX_STATE_DIR: activeRoot } });
  const activeOutput = parseJson(active) as { hookSpecificOutput?: { updatedToolOutput?: string } };
  assert.equal(typeof activeOutput.hookSpecificOutput?.updatedToolOutput, 'string');
});

test('F3: a backend crash at Stop allows instead of blocking', async () => {
  const root = tempRoot();
  const clock = new FixedClock(NOW);
  const store = new FileStateStore({ root, clock });
  store.ensureSession('s1', 'active');
  store.appendEvent('s1', {
    v: 1,
    kind: 'post',
    at: NOW,
    atIso: new Date(NOW).toISOString(),
    turnNo: 0,
    tool: 'Bash',
    failed: true,
    output: 'ERROR: build failed'
  });
  const backend = new MockDecisionBackend();
  backend.gate = async () => {
    throw new Error('backend down');
  };
  const { output } = await inProcess({
    session_id: 's1',
    stop_hook_active: false,
    last_assistant_message: 'All tests pass and the task is complete.'
  }, 'stop', { store, backend });
  assert.deepEqual(output, {});
  const ledger = store.readLedger('s1', 10);
  const last = ledger[ledger.length - 1]!;
  assert.equal(last.type, 'error');
  assert.equal(last.skipReason, 'backend-error');
});

test('PreToolUse denies the third identical call', async () => {
  const root = tempRoot();
  const env = { HARNESS_REFLEX_STATE_DIR: root };
  for (let index = 0; index < 2; index += 1) {
    const result = await runCli('pretooluse', {
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_use_id: `t${index}`
    }, { env });
    assert.deepEqual(parseJson(result), {});
  }
  const denied = await runCli('pretooluse', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_use_id: 't3'
  }, { env });
  const output = parseJson(denied) as {
    hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string };
  };
  assert.equal(output.hookSpecificOutput?.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput?.permissionDecision, 'deny');
  assert.ok((output.hookSpecificOutput?.permissionDecisionReason ?? '').length > 0);
});

test('PostToolUseFailure attaches a correction after three consecutive failures', async () => {
  const root = tempRoot();
  const env = { HARNESS_REFLEX_STATE_DIR: root };
  for (let index = 0; index < 2; index += 1) {
    const quiet = await runCli('postfailure', {
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: 'make' },
      tool_use_id: `f${index}`,
      error: 'boom'
    }, { env });
    assert.deepEqual(parseJson(quiet), {});
  }
  const corrected = await runCli('postfailure', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_use_id: 'f3',
    error: { message: 'boom again' }
  }, { env });
  const output = parseJson(corrected) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
  assert.equal(output.hookSpecificOutput?.hookEventName, 'PostToolUseFailure');
  assert.ok((output.hookSpecificOutput?.additionalContext ?? '').includes('consecutive tool calls failed'));
});

test('SessionStart announces the mode and SessionEnd is silent', async () => {
  const root = tempRoot();
  const env = { HARNESS_REFLEX_STATE_DIR: root };
  const start = await runCli('sessionstart', { session_id: 's1', source: 'startup', cwd: '/tmp' }, { env });
  const output = parseJson(start) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
  assert.equal(output.hookSpecificOutput?.hookEventName, 'SessionStart');
  assert.ok((output.hookSpecificOutput?.additionalContext ?? '').includes('mode=active'));
  const end = await runCli('sessionend', { session_id: 's1', reason: 'exit' }, { env });
  assert.deepEqual(parseJson(end), {});
});

test('SessionStart garbage-collects a session older than seven days', async () => {
  const root = tempRoot();
  const clock = new FixedClock(NOW);
  const store = new FileStateStore({ root, clock });
  const oldPaths = store.ensureSession('old-session', 'active');
  const old = new Date(NOW - 8 * 24 * 60 * 60 * 1000);
  for (const entry of fs.readdirSync(oldPaths.dir)) {
    fs.utimesSync(path.join(oldPaths.dir, entry), old, old);
  }
  fs.utimesSync(oldPaths.dir, old, old);
  const result = await runHook('sessionstart', {
    env: { HARNESS_REFLEX_STATE_DIR: root, HARNESS_REFLEX_MODE: 'active' } as NodeJS.ProcessEnv,
    clock,
    store,
    stderr: () => {},
    readStdin: async () => ({ text: JSON.stringify({ session_id: 'current', source: 'startup' }), overflow: false })
  });
  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(oldPaths.dir), false);
  assert.ok(fs.existsSync(store.sessionDir('current')));
});

test('an unacquirable lock skips this turn and does not block the call', async () => {
  const root = tempRoot();
  const env = { HARNESS_REFLEX_STATE_DIR: root };
  for (let index = 0; index < 2; index += 1) {
    await runCli('pretooluse', {
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_use_id: `t${index}`
    }, { env });
  }
  const store = new FileStateStore({ root, clock: new FixedClock(NOW) });
  const paths = store.sessionPaths('s1');
  fs.mkdirSync(paths.lock);
  fs.writeFileSync(path.join(paths.lock, 'owner.json'), JSON.stringify({ pid: 1, startedMs: Date.now() }));
  const result = await runCli('pretooluse', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_use_id: 't3'
  }, { env });
  assert.equal(result.code, 0);
  assert.deepEqual(parseJson(result), {});
  const ledger = ledgerOf(root);
  assert.equal(ledger[ledger.length - 1]!.skipReason, 'skippedLockContention');
});

test('three corrupted files still produce decisions', async () => {
  // (a) half a line in events.jsonl
  const rootA = tempRoot();
  const envA = { HARNESS_REFLEX_STATE_DIR: rootA };
  await runCli('pretooluse', { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' }, { env: envA });
  const storeA = new FileStateStore({ root: rootA, clock: new FixedClock(NOW) });
  const pathsA = storeA.sessionPaths('s1');
  fs.appendFileSync(pathsA.events, '{"half": ');
  const decisionA = await runCli('pretooluse', { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_use_id: 't2' }, { env: envA });
  assert.deepEqual(parseJson(decisionA), {});
  assert.ok(fs.readdirSync(pathsA.dir).some((name) => name.startsWith('corrupt-')));

  // (b) truncated state.json
  const rootB = tempRoot();
  const envB = { HARNESS_REFLEX_STATE_DIR: rootB };
  await runCli('pretooluse', { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' }, { env: envB });
  const storeB = new FileStateStore({ root: rootB, clock: new FixedClock(NOW) });
  const pathsB = storeB.sessionPaths('s1');
  fs.writeFileSync(pathsB.state, '{"version":1,"turnNo":');
  const decisionB = await runCli('stop', { session_id: 's1', stop_hook_active: true, last_assistant_message: 'done' }, { env: envB });
  assert.deepEqual(parseJson(decisionB), {});
  assert.equal(storeB.readState('s1').turnNo, 1);

  // (c) a non-JSON line inside ledger.jsonl
  const rootC = tempRoot();
  const envC = { HARNESS_REFLEX_STATE_DIR: rootC };
  await runCli('pretooluse', { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' }, { env: envC });
  const storeC = new FileStateStore({ root: rootC, clock: new FixedClock(NOW) });
  const pathsC = storeC.sessionPaths('s1');
  fs.appendFileSync(pathsC.ledger, 'this is not json\n');
  const decisionC = await runCli('posttooluse', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_use_id: 't2',
    tool_response: { stdout: bigText() }
  }, { env: envC });
  const outputC = parseJson(decisionC) as { hookSpecificOutput?: { updatedToolOutput?: string } };
  assert.equal(typeof outputC.hookSpecificOutput?.updatedToolOutput, 'string');
});

test('fifty concurrent processes writing one session keep the ledger parseable and complete', async () => {
  for (let round = 0; round < 3; round += 1) {
    const root = tempRoot();
    const env = { HARNESS_REFLEX_STATE_DIR: root };
    const text = bigText();
    const processes: Array<Promise<CliResult>> = [];
    for (let index = 0; index < 50; index += 1) {
      processes.push(
        runCli('posttooluse', {
          session_id: 'shared',
          tool_name: 'Bash',
          tool_input: { command: `make-${index}` },
          tool_use_id: `call-${index}`,
          tool_response: { stdout: text }
        }, { env })
      );
    }
    const results = await Promise.all(processes);
    assert.equal(results.every((result) => result.code === 0), true);
    const store = new FileStateStore({ root, clock: new FixedClock(NOW) });
    const ledger = store.readLedger('shared', 1000);
    assert.equal(ledger.length, 50, `round ${round}: expected 50 ledger lines`);
    const keys = new Set(ledger.map((record) => record.dedupeKey));
    assert.equal(keys.size, 50, `round ${round}: dedupe keys must stay unique`);
    const raw = fs.readFileSync(store.sessionPaths('shared').ledger, 'utf8').split('\n').filter(Boolean);
    assert.equal(raw.length, 50, `round ${round}: raw line count`);
    for (const line of raw) assert.doesNotThrow(() => JSON.parse(line), `round ${round}: ${line.slice(0, 80)}`);
  }
});

test('Windows is refused with an explicit error and no stdout payload', async () => {
  const messages: string[] = [];
  const result = await runHook('pretooluse', {
    platform: 'win32',
    env: { HARNESS_REFLEX_MODE: 'active' } as NodeJS.ProcessEnv,
    stderr: (message) => messages.push(message),
    readStdin: async () => ({ text: '{}', overflow: false })
  });
  assert.equal(result.code, 2);
  assert.equal(result.output, null);
  assert.ok(messages.join('\n').includes('Windows is not supported'));
});
