/**
 * Static and contract checks for the Claude Code plugin package.
 *
 * `claude plugin validate` is the real authority, but it needs a `claude`
 * binary. These checks reproduce its two most failure-prone jobs with no host
 * installed: the manifest/hooks/.mcp.json shape, and the MCP tool list the
 * server actually answers with. They are deliberately exact — a typo in a
 * command, a timeout that no longer matches the design budget, or a dropped
 * tool fails the suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8'));

/** The event -> (subcommand, timeout seconds) table the plugin must wire. */
const EXPECTED_HOOKS = {
  PreToolUse: { subcommand: 'pretooluse', timeout: 1, matcher: 'Bash|Edit|Write|MultiEdit|mcp__.*' },
  PostToolUse: { subcommand: 'posttooluse', timeout: 2, matcher: 'Bash|Edit|Write|MultiEdit|mcp__.*' },
  PostToolUseFailure: { subcommand: 'postfailure', timeout: 1, matcher: 'Bash|Edit|Write|MultiEdit|mcp__.*' },
  Stop: { subcommand: 'stop', timeout: 2, matcher: undefined },
  SubagentStop: { subcommand: 'substop', timeout: 2, matcher: '__disabled_by_default__' },
  SessionStart: { subcommand: 'sessionstart', timeout: 2, matcher: undefined },
  SessionEnd: { subcommand: 'sessionend', timeout: 2, matcher: undefined }
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

test('manifest: identity and the two user-facing options are complete', () => {
  const manifest = readJson('.claude-plugin/plugin.json');
  assert.equal(manifest.name, 'claude-reflex');
  assert.match(manifest.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.equal(typeof manifest.version, 'string');
  assert.ok(manifest.version.length > 0);
  assert.equal(typeof manifest.description, 'string');
  assert.ok(manifest.description.length > 20);
  assert.equal(manifest.author?.name, 'miuzel');
  assert.equal(manifest.license, 'MIT');

  const closing = manifest.userConfig?.closing_mode;
  assert.equal(closing?.type, 'string');
  assert.equal(closing?.default, 'observe');
  assert.deepEqual(closing?.options, ['observe', 'active', 'off']);

  const effort = manifest.userConfig?.effort_level;
  assert.equal(effort?.type, 'string');
  assert.equal(effort?.default, 'off');
  assert.deepEqual(effort?.options, ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('hooks: all seven events are wired, SubagentStop is off by default', () => {
  const hooks = readJson('hooks/hooks.json');
  assert.deepEqual(hooks.modules, ['./register.js']);
  assert.ok(fs.existsSync(path.join(pluginRoot, 'hooks/register.js')));

  assert.deepEqual(Object.keys(hooks.hooks).sort(), Object.keys(EXPECTED_HOOKS).sort());

  for (const [event, expected] of Object.entries(EXPECTED_HOOKS)) {
    const groups = hooks.hooks[event];
    assert.ok(Array.isArray(groups), `${event} must be an array`);
    assert.equal(groups.length, 1, `${event} must have one matcher group`);
    const group = groups[0];
    assert.equal(group.matcher, expected.matcher, `${event} matcher`);
    assert.equal(group.hooks.length, 1);
    const handler = group.hooks[0];
    assert.equal(handler.type, 'command');
    assert.equal(handler.command, 'harness-reflex');
    assert.deepEqual(handler.args, ['hook', expected.subcommand]);
    assert.equal(handler.timeout, expected.timeout, `${event} timeout must stay inside the design budget`);
    assert.equal(handler.async, undefined, 'decision hooks must stay synchronous');
    assert.equal(handler.onFailure, undefined, 'fail-open is the deliberate policy');
    // Plugin paths are never used here: the command resolves the installed CLI.
    assert.equal(typeof handler.command, 'string');
    assert.ok(!path.isAbsolute(handler.command));
  }
});

test('.mcp.json declares the root stdio server and its eight tools', async () => {
  const mcp = readJson('.mcp.json');
  const servers = Object.keys(mcp.mcpServers ?? {});
  assert.deepEqual(servers, ['harness-reflex']);
  const server = mcp.mcpServers['harness-reflex'];
  assert.equal(server.command, 'harness-reflex');
  assert.deepEqual(server.args, ['mcp']);

  // The declaration is not the contract; the server's answer is. Spawn the
  // real CLI (the same command the plugin runs) and ask for tools/list.
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
      const lines = stdout.split('\n').filter(Boolean);
      for (const line of lines) {
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

test('mod: turn.step applies only a valid configured effort; tool.call forwards', async () => {
  const { register, resolveEffort, EFFORT_LEVELS } = await import('../hooks/register.js');

  /** Install the mod once with one `userConfig` object. */
  function install(options) {
    const handlers = new Map();
    const on = (event, hook) => {
      handlers.set(event, hook);
      return { event, off() {} };
    };
    const registrations = register(on, options);
    return { handlers, registrations };
  }

  const defaultInstall = install({});
  assert.equal(defaultInstall.registrations.length, 2);
  assert.deepEqual([...defaultInstall.handlers.keys()], ['turn.step', 'tool.call']);

  assert.equal(resolveEffort({ effort_level: 'high' }), 'high');
  assert.equal(resolveEffort({ effort_level: 'HIGH' }), 'high');
  assert.equal(resolveEffort({ effort_level: 'off' }), undefined);
  assert.equal(resolveEffort({ effort_level: 'ultra' }), undefined);
  assert.equal(resolveEffort({}, { env: { get: () => 'low' } }), 'low');

  /** Drive one turn.step handler and capture the event passed to next. */
  async function drive(handlers, envValue) {
    const step = handlers.get('turn.step');
    const seen = [];
    const event = { model: 'claude-opus-5', effort: 'medium' };
    const $ = { env: { get: (name) => (name === 'HARNESS_REFLEX_EFFORT' ? envValue : undefined) } };
    async function* next(nextEvent) {
      seen.push(nextEvent);
      yield 'stream-chunk';
    }
    const chunks = [];
    for await (const chunk of step($, event, next)) chunks.push(chunk);
    return { seen, chunks, event };
  }

  const unchanged = await drive(defaultInstall.handlers, undefined);
  assert.equal(unchanged.seen.length, 1);
  assert.equal(unchanged.seen[0], unchanged.event, 'no option must forward the same object');
  assert.deepEqual(unchanged.chunks, ['stream-chunk']);

  const applied = await drive(install({ effort_level: 'high' }).handlers, undefined);
  assert.equal(applied.seen[0].effort, 'high');
  assert.equal(applied.seen[0].model, 'claude-opus-5');

  const fromEnv = await drive(install({}).handlers, 'max');
  assert.equal(fromEnv.seen[0].effort, 'max');

  const toolCall = defaultInstall.handlers.get('tool.call');
  const forwarded = {};
  const result = await toolCall({}, { tool: 'Bash' }, async (event) => {
    forwarded.tool = event.tool;
    return 'next-result';
  });
  assert.equal(result, 'next-result');
  assert.equal(forwarded.tool, 'Bash');

  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.ok(EFFORT_LEVELS.includes(level));
  }
});
