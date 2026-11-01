/**
 * The Codex hook surface as the host actually invokes it: one process per event,
 * the event in the command string, the payload on stdin.
 *
 * These tests spawn `harness-reflex hook <event>` exactly as
 * `packages/codex-reflex/hooks.json` declares it, so they cover the wiring rather
 * than a mock of it. Three properties matter most, because each one was a real
 * failure mode during development:
 *
 * 1. **kebab-case events parse** — Codex spells them `pre-tool-use`.
 * 2. **an event with no capability exits 0 with `{}`** — otherwise a hook that
 *    has nothing to say becomes a broken pipe or a spurious warning every turn.
 * 3. **stdout is one JSON object and nothing else** — the host splices it into
 *    model-visible text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Compiled location is dist/adapters or dist/hook; the repo root is two up.
const repoRoot = path.resolve(here, '..', '..');
const CLI = path.join(repoRoot, 'dist', 'cli', 'index.js');

const roots: string[] = [];

/** A throwaway state root so the ledger never touches the developer's. */
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-codex-'));
  roots.push(root);
  return root;
}

/** The environment one hook process sees. */
function hookEnv(stateRoot: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SYSTEM_ONE_BACKEND: 'mock',
    HARNESS_REFLEX_STATE_DIR: stateRoot,
    ...extra
  };
  for (const key of ['HARNESS_REFLEX_MODE', 'HARNESS_REFLEX_CLOSING_MODE']) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

/** Run the real command hook and capture both streams. */
function runCli(
  event: string,
  payload: unknown,
  env: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string; code: number }> {
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
function hookOutput(result: { stdout: string; stderr: string; code: number }): Record<string, any> {
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as Record<string, any>;
  assert.equal(typeof parsed, 'object');
  return parsed;
}

test('codex: kebab-case events parse, not warn, and answer one JSON object', async () => {
  const root = tempRoot();
  const env = hookEnv(root);
  const session = { session_id: 'codex-1', hook_event_name: 'PreToolUse' };

  // The five kebab spellings Codex uses for events this runtime can decide.
  for (const event of ['pre-tool-use', 'post-tool-use', 'session-start', 'session-end', 'subagent-stop']) {
    const result = await runCli(event, session, env);
    const output = hookOutput(result);
    assert.equal(typeof output, 'object', `${event} answers an object`);
    assert.equal(result.stderr.includes('unknown event'), false, `${event} is not reported unknown`);
  }

  // `stop` has no separator, and the PascalCase spelling parses too.
  for (const event of ['stop', 'Stop', 'PreToolUse']) {
    const result = await runCli(event, session, env);
    hookOutput(result);
    assert.equal(result.stderr.includes('unknown event'), false, `${event} resolves`);
  }
});

test('codex: events with no capability are a silent no-op, not an error', async () => {
  const root = tempRoot();
  const env = hookEnv(root);

  // These six are real Codex events that this runtime deliberately does not
  // decide. They must answer `{}` and, crucially, must not warn: a warning on
  // every turn would train the user to ignore stderr.
  const noop = [
    'user-prompt-submit',
    'permission-request',
    'pre-compact',
    'post-compact',
    'subagent-start',
    'interrupt',
    // The subcommands hooks.json actually passes for those events.
    'userpromptsubmit',
    'permissionrequest',
    'precompact',
    'postcompact',
    'subagentstart'
  ];
  for (const event of noop) {
    const result = await runCli(event, { session_id: 'codex-1', hook_event_name: 'UserPromptSubmit' }, env);
    assert.deepEqual(hookOutput(result), {}, `${event} answers {}`);
    assert.equal(result.stderr.includes('unknown event'), false, `${event} is recognized, not unknown`);
  }

  // A genuinely unknown event is still `{}` with exit 0, and says so on stderr.
  const typo = await runCli('pre-tool-usee', { session_id: 'codex-1' }, env);
  assert.deepEqual(hookOutput(typo), {});
  assert.match(typo.stderr, /unknown event/);
});

test('codex: malformed input fails open with {} and exit 0', async () => {
  const env = hookEnv(tempRoot());
  for (const bad of ['not json', '[]', 'null', '42']) {
    const result = await runCli('pre-tool-use', bad, env);
    assert.deepEqual(hookOutput(result), {}, `${bad} answers {}`);
  }
  // No session_id: the decision is session-scoped, so refuse to guess.
  const noSession = await runCli('pre-tool-use', { tool_name: 'exec_command' }, env);
  assert.deepEqual(hookOutput(noSession), {});
  assert.match(noSession.stderr, /no session_id/);
});

test('codex: a PreToolUse denial carries a non-empty reason', async () => {
  // Drive the real stagnation path: the same tool + input three times, with a
  // distinct tool_use_id each time (a repeated id is a replay of one call, which
  // is correctly deduped and must not decide twice). The third carries the deny.
  const env = hookEnv(tempRoot());
  const results = [];
  for (let index = 0; index < 3; index += 1) {
    results.push(
      await runCli(
        'pre-tool-use',
        {
          session_id: 'codex-deny',
          hook_event_name: 'PreToolUse',
          tool_name: 'exec_command',
          tool_input: { cmd: 'npm test' },
          tool_use_id: `call_${index}`
        },
        env
      )
    );
  }
  const denied = results
    .map(hookOutput)
    .find((output) => output.hookSpecificOutput?.permissionDecision === 'deny');
  assert.ok(denied, 'the repeated call is denied');
  assert.equal(denied.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(
    typeof denied.hookSpecificOutput.permissionDecisionReason === 'string' &&
      denied.hookSpecificOutput.permissionDecisionReason.length > 0,
    'deny must carry a non-empty reason'
  );
});

test('codex: a Stop block uses decision:block with a reason', async () => {
  // Seed a failed tool observation, then make the closing check active so the
  // claim is contradicted and blocked — the exact shape Codex reads.
  const root = tempRoot();
  const { FileStateStore } = await import(new URL('../state/file-store.js', import.meta.url).href);
  const { FixedClock } = await import(new URL('../state/clock.js', import.meta.url).href);
  const now = Date.parse('2026-10-22T10:00:00.000Z');
  const store = new FileStateStore({ root, clock: new FixedClock(now) });
  store.ensureSession('codex-stop', 'active');
  store.appendEvent('codex-stop', {
    v: 1,
    kind: 'post',
    at: now,
    atIso: new Date(now).toISOString(),
    turnNo: 0,
    tool: 'exec_command',
    failed: true,
    output: 'ERROR: build failed'
  });

  const env = hookEnv(root, { HARNESS_REFLEX_CLOSING_MODE: 'active', HARNESS_REFLEX_MODE: 'active' });
  const result = await runCli(
    'stop',
    {
      session_id: 'codex-stop',
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'All tests pass and the task is complete.'
    },
    env
  );
  const output = hookOutput(result);
  assert.equal(output.decision, 'block');
  assert.ok(typeof output.reason === 'string' && output.reason.length > 0);
  // The host distinguishes this field from `hookSpecificOutput`; if it ever
  // arrives nested, Codex silently ignores the block.
  assert.equal(output.hookSpecificOutput, undefined);
});

test('codex: a retried Stop (stop_hook_active) does not block twice', async () => {
  // Measured hazard: an always-blocking Stop is retried without a visible cap.
  // The guarded retry must reach the allow path.
  const root = tempRoot();
  const { FileStateStore } = await import(new URL('../state/file-store.js', import.meta.url).href);
  const { FixedClock } = await import(new URL('../state/clock.js', import.meta.url).href);
  const now = Date.parse('2026-10-22T10:00:00.000Z');
  const store = new FileStateStore({ root, clock: new FixedClock(now) });
  store.ensureSession('codex-retry', 'active');
  store.appendEvent('codex-retry', {
    v: 1,
    kind: 'post',
    at: now,
    atIso: new Date(now).toISOString(),
    turnNo: 0,
    tool: 'exec_command',
    failed: true,
    output: 'ERROR: build failed'
  });

  const env = hookEnv(root, { HARNESS_REFLEX_CLOSING_MODE: 'active', HARNESS_REFLEX_MODE: 'active' });
  const base = {
    session_id: 'codex-retry',
    hook_event_name: 'Stop',
    last_assistant_message: 'All tests pass and the task is complete.'
  };
  const first = hookOutput(await runCli('stop', { ...base, stop_hook_active: false }, env));
  assert.equal(first.decision, 'block');
  const retried = hookOutput(await runCli('stop', { ...base, stop_hook_active: true }, env));
  assert.deepEqual(retried, {}, 'the guarded retry is allowed');
});

test('codex: HARNESS_REFLEX_HARNESS tags the ledger without changing the default', async () => {
  // The audit ledger records which harness produced a decision. The default stays
  // `cc` so existing session directories keep their names; a second host opts in.
  const taggedRoot = tempRoot();
  const tagged = hookOutput(
    await runCli(
      'pre-tool-use',
      { session_id: 'harness-tag', tool_name: 'exec_command', tool_input: { cmd: 'ls' }, tool_use_id: 'c1' },
      hookEnv(taggedRoot, { HARNESS_REFLEX_HARNESS: 'codex' })
    )
  );
  assert.deepEqual(tagged, {});
  const dirs = fs.readdirSync(path.join(taggedRoot, 'sessions'));
  assert.ok(
    dirs.some((dir) => dir.startsWith('codex-')),
    `expected a codex- session dir, saw ${dirs.join(', ')}`
  );

  // Without the variable the historical `cc` prefix is unchanged.
  const plainRoot = tempRoot();
  hookOutput(
    await runCli(
      'pre-tool-use',
      { session_id: 'harness-plain', tool_name: 'exec_command', tool_input: { cmd: 'ls' }, tool_use_id: 'c1' },
      hookEnv(plainRoot)
    )
  );
  const plainDirs = fs.readdirSync(path.join(plainRoot, 'sessions'));
  assert.ok(
    plainDirs.some((dir) => dir.startsWith('cc-')),
    `expected a cc- session dir, saw ${plainDirs.join(', ')}`
  );
});
