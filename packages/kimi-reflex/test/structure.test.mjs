/**
 * Static and contract checks for the Kimi Code CLI wiring.
 *
 * Kimi Code is not installed on this machine (`command -v kimi` is empty), so
 * there is no `kimi` binary to validate against. These checks reproduce the
 * host's own most failure-prone rules with no host present, using the real
 * build: the four-field `[[hooks]]` restriction, the seconds-not-milliseconds
 * timeout unit, the event names, and the MCP tool list the server actually
 * answers with.
 *
 * Every expectation here is derived from a cited source, not from memory; see
 * docs/contract-sources.md. The two rules that most easily rot:
 *
 * 1. A `[[hooks]]` table accepts EXACTLY event/matcher/command/timeout. Any
 *    extra field makes the whole `config.toml` fail to load — so an extra key
 *    here would break every unrelated setting the user has.
 * 2. `timeout` is in seconds (1-600). The design budgets are milliseconds, so a
 *    missing conversion leaves a 2000 ms event claiming 2000 *seconds*.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const dist = (relative) => pathToFileURL(path.join(repoRoot, 'dist', relative)).href;

const { EVENT_BUDGETS, parseHookEvent } = await import(dist('hook/contract.js'));

/** The fields a `[[hooks]]` table may contain (Kimi Code, four exactly). */
const ALLOWED_HOOK_FIELDS = ['event', 'matcher', 'command', 'timeout'];

/**
 * The event -> (subcommand, timeout seconds) table the wiring must produce.
 *
 * `sessionend` is the one host-timeout that is not a whole number of seconds
 * (1500 ms in the design); Kimi Code takes an integer 1-600, so it rounds up to
 * 2 rather than down, which would cut the hook off before its own deadline.
 */
const EXPECTED_HOOKS = {
  PreToolUse: { subcommand: 'pretooluse', timeout: 1 },
  PostToolUse: { subcommand: 'posttooluse', timeout: 2 },
  PostToolUseFailure: { subcommand: 'postfailure', timeout: 1 },
  Stop: { subcommand: 'stop', timeout: 2, shim: true },
  SubagentStop: { subcommand: 'substop', timeout: 2 },
  SessionStart: { subcommand: 'sessionstart', timeout: 2 },
  SessionEnd: { subcommand: 'sessionend', timeout: 2 }
};

/** The eight tools the root package has always exposed. */
const ROOT_TOOLS = [
  'reflex_gate',
  'reflex_prune',
  'reflex_detect_stagnation',
  'reflex_route',
  'reflex_status_ledger',
  'reflex_choice',
  'reflex_score',
  'reflex_screen'
];

/**
 * A TOML reader for exactly the subset hooks.toml uses.
 *
 * The package has no runtime dependencies by design, so there is no TOML
 * library to call. This parser refuses anything outside the documented shape
 * instead of guessing, which is the property the test actually needs: an
 * unrecognized line fails the suite rather than being silently skipped.
 */
function parseHooksToml(text) {
  const entries = [];
  let current = null;
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) return;
    if (trimmed === '[[hooks]]') {
      current = { line: index + 1 };
      entries.push(current);
      return;
    }
    assert.ok(current, `line ${index + 1}: content outside a [[hooks]] table: ${trimmed}`);
    const match = /^([a-z_]+)\s*=\s*(.+)$/.exec(trimmed);
    assert.ok(match, `line ${index + 1}: not a key = value pair: ${trimmed}`);
    const [, key, rawValue] = match;
    assert.equal(current[key], undefined, `line ${index + 1}: duplicate key "${key}"`);
    if (/^-?\d+$/.test(rawValue)) current[key] = Number(rawValue);
    else {
      const quoted = /^"(.*)"$/.exec(rawValue);
      assert.ok(quoted, `line ${index + 1}: only plain integers and "strings" are allowed here: ${rawValue}`);
      current[key] = quoted[1];
    }
  });
  return entries;
}

test('hooks: every entry uses ONLY the four fields the host allows', () => {
  const hooks = parseHooksToml(fs.readFileSync(path.join(pluginRoot, 'hooks.toml'), 'utf8'));
  assert.ok(hooks.length > 0, 'hooks.toml declares no [[hooks]] entries');
  for (const hook of hooks) {
    const fields = Object.keys(hook).filter((key) => key !== 'line');
    // The rule is a closed set, not a required one: event/command are required
    // by the host, matcher/timeout are optional, and ANY other field makes the
    // whole config.toml fail to load.
    for (const field of fields) {
      assert.ok(ALLOWED_HOOK_FIELDS.includes(field), `event ${hook.event}: "${field}" is not one of ${ALLOWED_HOOK_FIELDS.join('/')}`);
    }
    assert.ok(fields.includes('event'), 'every entry needs an event');
    assert.ok(fields.includes('command'), 'every entry needs a command');
  }
});

test('hooks: the seven events are wired, exactly once each, with a converted timeout', () => {
  const hooks = parseHooksToml(fs.readFileSync(path.join(pluginRoot, 'hooks.toml'), 'utf8'));
  const events = hooks.map((hook) => hook.event).sort();
  assert.deepEqual(events, Object.keys(EXPECTED_HOOKS).sort());
  assert.equal(new Set(events).size, events.length, 'an event must be wired exactly once');

  for (const hook of hooks) {
    const expected = EXPECTED_HOOKS[hook.event];
    assert.ok(expected, `unexpected event ${hook.event}`);

    // The host resolves hooks with `new RegExp(matcher).test(value)` and treats
    // an absent matcher as "match everything". We rely on the absent form, so a
    // matcher appearing here changes coverage and must be a deliberate edit.
    assert.equal(hook.matcher, undefined, `${hook.event} must omit matcher (= match all)`);

    // Seconds, integer, inside the host's documented 1-600 range.
    assert.equal(typeof hook.timeout, 'number', `${hook.event} timeout must be an integer`);
    assert.ok(Number.isInteger(hook.timeout), `${hook.event} timeout must be a whole number of seconds`);
    assert.ok(hook.timeout >= 1 && hook.timeout <= 600, `${hook.event} timeout must be 1-600 seconds`);
    assert.equal(hook.timeout, expected.timeout, `${hook.event} timeout must be the design budget in seconds`);

    // The wiring must name a real decision event; a typo would be a silent no-op
    // because the CLI fails open on an unknown event.
    assert.equal(parseHookEvent(expected.subcommand), expected.subcommand, `${hook.event} maps to an unknown subcommand`);

    if (expected.shim) {
      // Stop goes through the exit-2 shim, which must ship with the package.
      assert.match(hook.command, /reflex-stop-exit2\.sh/);
      assert.ok(fs.existsSync(path.join(pluginRoot, 'hooks', 'reflex-stop-exit2.sh')));
    } else {
      assert.equal(hook.command, `harness-reflex hook ${expected.subcommand}`);
    }
    assert.ok(!path.isAbsolute(hook.command), 'the command resolves the installed CLI, never a plugin path');
  }
});

test('hooks: timeouts are the design host budget rounded up to seconds', () => {
  for (const [event, expected] of Object.entries(EXPECTED_HOOKS)) {
    // `sessionstart`/`sessionend` are the only entries whose budget differs from
    // the timeout above; the rest must be an exact ceil of the host budget.
    const budgetMs = EVENT_BUDGETS[expected.subcommand].hookTimeoutMs;
    assert.equal(expected.timeout, Math.ceil(budgetMs / 1000), `${event} timeout must be ceil(${budgetMs}ms)`);
  }
});

test('mcp.json declares the root stdio server and its eight tools', async () => {
  const mcp = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'mcp.json'), 'utf8'));
  const servers = Object.keys(mcp.mcpServers ?? {});
  assert.deepEqual(servers, ['harness-reflex'], 'Kimi Code keys servers under mcpServers');
  const server = mcp.mcpServers['harness-reflex'];
  assert.equal(server.command, 'harness-reflex');
  assert.deepEqual(server.args, ['mcp']);

  // The declaration is not the contract; the server's answer is.
  const cli = path.join(repoRoot, 'dist', 'cli', 'index.js');
  assert.ok(fs.existsSync(cli), `build first: ${cli} is missing`);
  const tools = await listMcpTools(cli);
  assert.deepEqual(tools.slice().sort(), ROOT_TOOLS.slice().sort());
});

/** Run `harness-reflex mcp` over stdio and return its `tools/list` names. */
function listMcpTools(cli) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'mcp'], {
      cwd: repoRoot,
      env: { ...process.env, SYSTEM_ONE_BACKEND: 'mock' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`MCP server did not answer tools/list in time; stderr: ${stderr}`));
    }, 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      for (const line of stdout.split('\n').filter(Boolean)) {
        try {
          const message = JSON.parse(line);
          if (message.id === 2 && Array.isArray(message.result?.tools)) {
            clearTimeout(timer);
            child.kill('SIGKILL');
            resolve(message.result.tools.map((tool) => tool.name));
          }
        } catch {
          // A partial line; wait for the next chunk.
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  });
}
