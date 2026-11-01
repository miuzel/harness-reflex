/**
 * Static and contract checks for the OpenCode wiring.
 *
 * OpenCode is not installed as a usable host on this machine: `opencode` starts
 * but throws `PlatformError: Unknown: FileSystem.open (~/.local/share/opencode/log/opencode.log)`
 * before it can load a plugin, so nothing here has been exercised against a real
 * `opencode` process. These checks reproduce the host's documented rules with no
 * host present, using the real build.
 *
 * The three rules most likely to rot (each cited in docs/contract-sources.md):
 * 1. MCP servers live under the `mcp` key — NOT `mcpServers`, which is what every
 *    other host in this repository uses.
 * 2. A local MCP server's `command` is an ARRAY, not a string plus `args`.
 * 3. The plugin entry point is a function returning a hooks object; the hook
 *    names asserted below are the ones `@opencode-ai/plugin` 1.19.5 declares.
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

/** The hook names this plugin implements, from `@opencode-ai/plugin` 1.19.5. */
const IMPLEMENTED_HOOKS = ['tool.execute.before', 'tool.execute.after', 'event'];

test('mcp: servers live under `mcp`, local commands are arrays, and eight tools answer', async () => {
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'opencode.json'), 'utf8'));
  // OpenCode uses `mcp`; every other host in this repo uses `mcpServers`.
  assert.equal(config.mcpServers, undefined, 'OpenCode does not read mcpServers');
  assert.deepEqual(Object.keys(config.mcp ?? {}), ['harness-reflex']);
  const server = config.mcp['harness-reflex'];
  assert.equal(server.type, 'local');
  assert.ok(Array.isArray(server.command), 'a local server command is an array, not a string');
  assert.deepEqual(server.command, ['harness-reflex', 'mcp']);
  assert.equal(server.args, undefined, 'OpenCode has no separate args field');
  assert.equal(server.enabled, true);

  const cli = path.join(repoRoot, 'dist', 'cli', 'index.js');
  assert.ok(fs.existsSync(cli), `build first: ${cli} is missing`);
  const tools = await listMcpTools(cli);
  assert.deepEqual(tools.slice().sort(), ROOT_TOOLS.slice().sort());
});

test('plugin: the entry point is a function and the hook names are the host’s', async () => {
  const mod = await import('../plugin/reflex.js');
  assert.equal(typeof mod.ReflexPlugin, 'function');
  assert.equal(mod.default, mod.ReflexPlugin);
  assert.equal(typeof mod.runHook, 'function');
  assert.equal(typeof mod.mapVerdict, 'function');

  const hooks = await mod.ReflexPlugin({}, { bin: 'unused' });
  assert.deepEqual(Object.keys(hooks).sort(), IMPLEMENTED_HOOKS.slice().sort());
  for (const name of IMPLEMENTED_HOOKS) assert.equal(typeof hooks[name], 'function');
});

test('plugin: it loads with no host SDK and no runtime dependencies', () => {
  const source = fs.readFileSync(path.join(pluginRoot, 'plugin', 'reflex.js'), 'utf8');
  const imports = [...source.matchAll(/^import\s[^;]+from\s+'([^']+)';/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ['node:child_process'], 'the plugin must not import a host SDK');
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies, undefined, 'zero runtime dependencies');
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
