/**
 * Static and behavioral checks for the Codex plugin package.
 *
 * Codex has no `plugin validate` equivalent, so the two jobs it would do are
 * reproduced here without a Codex binary:
 *
 * 1. the shipped `hooks.json` is exactly what the adapter generates — a typo in
 *    an event name, a dropped `matcher`, or a timeout outside Codex's clamp
 *    fails this suite;
 * 2. the MCP server the `config.toml` points at really answers `tools/list` with
 *    the eight `reflex_*` tools.
 *
 * The hooks wiring is checked against facts measured from `codex-cli 0.163.0`:
 * twelve events, no `args` channel, and a 3 s clamp on `SessionEnd`.
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

const readText = (relative) => fs.readFileSync(path.join(pluginRoot, relative), 'utf8');
const readJson = (relative) => JSON.parse(readText(relative));

/** The twelve events Codex 0.163.0 fires, and the subcommand each maps to. */
const EXPECTED_HOOKS = {
  PreToolUse: { subcommand: 'pretooluse', timeout: 1, matcher: '.*' },
  PermissionRequest: { subcommand: 'permissionrequest', timeout: 1, matcher: undefined },
  PostToolUse: { subcommand: 'posttooluse', timeout: 2, matcher: '.*' },
  PreCompact: { subcommand: 'precompact', timeout: 1, matcher: undefined },
  PostCompact: { subcommand: 'postcompact', timeout: 1, matcher: undefined },
  SessionStart: { subcommand: 'sessionstart', timeout: 2, matcher: undefined },
  SessionEnd: { subcommand: 'sessionend', timeout: 2, matcher: undefined },
  UserPromptSubmit: { subcommand: 'userpromptsubmit', timeout: 1, matcher: undefined },
  SubagentStart: { subcommand: 'subagentstart', timeout: 1, matcher: undefined },
  SubagentStop: { subcommand: 'substop', timeout: 2, matcher: undefined },
  Stop: { subcommand: 'stop', timeout: 2, matcher: undefined },
  Interrupt: { subcommand: 'interrupt', timeout: 1, matcher: undefined }
};

/** The eight tools the root package has always exposed. */
const ROOT_TOOLS = [
  'reflex_choice',
  'reflex_detect_stagnation',
  'reflex_gate',
  'reflex_prune',
  'reflex_route',
  'reflex_score',
  'reflex_screen',
  'reflex_status_ledger'
];

test('package: the manifest describes a private config bundle', () => {
  const manifest = readJson('package.json');
  assert.equal(manifest.name, 'harness-reflex-codex');
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.files.slice().sort(), ['README.md', 'config.toml', 'hooks.json']);
});

test('hooks.json: all twelve events are wired with an inline command', () => {
  const hooks = readJson('hooks.json');
  assert.deepEqual(Object.keys(hooks.hooks), Object.keys(EXPECTED_HOOKS));

  for (const [event, expected] of Object.entries(EXPECTED_HOOKS)) {
    const groups = hooks.hooks[event];
    assert.ok(Array.isArray(groups), `${event} must be an array`);
    assert.equal(groups.length, 1, `${event} has one matcher group`);
    const group = groups[0];
    assert.equal(group.matcher, expected.matcher, `${event} matcher`);
    assert.equal(group.hooks.length, 1);

    const handler = group.hooks[0];
    assert.equal(handler.type, 'command');
    // Codex drops handler `args`, so the event has to be in the command string.
    assert.equal(handler.command, `harness-reflex hook ${expected.subcommand}`, `${event} command`);
    assert.equal(handler.args, undefined, `${event} must not use the args channel`);
    assert.equal(handler.timeout, expected.timeout, `${event} timeout`);

    // Codex clamps SessionEnd to 3 s; every handler must stay inside that cap.
    assert.ok(handler.timeout <= 3, `${event} timeout inside Codex's clamp`);
    // The command must resolve from PATH, never an absolute plugin path.
    assert.equal(path.isAbsolute(handler.command), false);
  }
});

test('hooks.json: the tool events match shell tools, not only MCP tools', () => {
  // A `mcp__.*`-only matcher would let every `exec_command` through unguarded,
  // which is the failure mode the live probe was run to rule out.
  const hooks = readJson('hooks.json');
  for (const event of ['PreToolUse', 'PostToolUse']) {
    assert.equal(hooks.hooks[event][0].matcher, '.*', `${event} must match every tool`);
  }
});

test('config.toml: registers the stdio MCP server Codex reads', () => {
  const toml = readText('config.toml');
  assert.match(toml, /^\[mcp_servers\.harness-reflex\]$/m);
  assert.match(toml, /^command = "node"$/m);
  assert.match(toml, /^args = \["[^"]+", "mcp"\]$/m);
  assert.match(toml, /^startup_timeout_sec = 20$/m);
  // The legacy JSON file is documented as not read by Codex.
  assert.match(toml, /config\.json/);
});

test('mcp: a real stdio handshake answers tools/list with the eight tools', async () => {
  // The declaration is not the contract; the server's answer is. Spawn the real
  // CLI — the same command config.toml points at — and ask for tools/list.
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
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`tools/list timed out; stderr=${stderr}`));
    }, 15000);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 2 && Array.isArray(message.result?.tools)) {
          clearTimeout(timer);
          child.kill();
          resolve(message.result.tools.map((tool) => tool.name));
          return;
        }
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    // The two requests the MCP handshake needs, in order.
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codex-test', version: '0.0.0' } }
      })}\n`
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  });
}
