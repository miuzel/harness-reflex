import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MockDecisionBackend } from '../backend/mock.js';
import { scoreStatement } from '../core/score.js';

/**
 * End-to-end baseline for the stdio MCP surface.
 *
 * The DSH Host plugin reuses the same core services; this suite pins the MCP
 * contract (tool list + canonical payloads) so a Host-side change can never
 * silently alter what existing Claude Code / Codex clients already receive.
 */

const cliPath = fileURLToPath(new URL('../cli/index.js', import.meta.url));

const MCP_TOOLS = [
  'reflex_gate',
  'reflex_prune',
  'reflex_detect_stagnation',
  'reflex_route',
  'reflex_status_ledger',
  'reflex_choice',
  'reflex_score',
  'reflex_screen'
];

interface JsonRpcResponse {
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string };
}

/** Serve one batch of JSON-RPC lines through a real `harness-reflex mcp` process. */
function callMcp(requests: unknown[], cwd: string): JsonRpcResponse[] {
  const input = requests.map((request) => JSON.stringify(request)).join('\n') + '\n';
  const result = spawnSync(process.execPath, [cliPath, 'mcp'], {
    input,
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      SYSTEM_ONE_BACKEND: 'mock',
      SYSTEM_ONE_API_KEY: '',
      SYSTEM_ONE_BASE_URL: '',
      VLLM_BASE_URL: '',
      OPENAI_BASE_URL: ''
    }
  });

  assert.equal(result.status, 0, `mcp process failed: ${result.stderr}`);
  return result.stdout
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JsonRpcResponse);
}

/** Text JSON payload of one MCP tool result. */
function toolPayload(response: JsonRpcResponse): any {
  assert.equal(response.error, undefined, `tool call failed: ${JSON.stringify(response.error)}`);
  return JSON.parse(response.result.content[0].text);
}

/** Responses are emitted as each async handler settles, so index them by request id. */
function byId(responses: JsonRpcResponse[]): Map<string | number | null, JsonRpcResponse> {
  return new Map(responses.map((response) => [response.id, response]));
}

test('MCP tools/list still advertises the frozen eight-tool surface', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-mcp-'));
  try {
    const [list] = callMcp([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], workspace);
    const names = list.result.tools.map((tool: { name: string }) => tool.name);
    assert.deepEqual(names, MCP_TOOLS);
    assert.equal(new Set(names).size, 8);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('reflex_score over MCP equals the shared core projection', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-mcp-'));
  const args = { statement: 'the build succeeded and tests passed', criteria: 'verification quality' };

  try {
    const [response] = callMcp(
      [{ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'reflex_score', arguments: args } }],
      workspace
    );

    const expected = await scoreStatement(new MockDecisionBackend(), args);
    const actual = toolPayload(response) as { latencyMs?: unknown };

    // The subprocess and this process each measure their own wall clock, so the
    // payloads are compared with the timing field pinned.
    assert.equal(typeof actual.latencyMs, 'number');
    assert.deepEqual({ ...actual, latencyMs: 0 }, { ...expected, latencyMs: 0 });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('gate fails closed on contradictory evidence and prune saves tokens end to end', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-mcp-'));
  const bulky = Array.from({ length: 200 }, (_, index) => `progress [===    ] step ${index}`).join('\n');

  try {
    const responses = byId(callMcp(
      [
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'reflex_gate',
            arguments: {
              assertions: [{ statement: 'The build passed' }],
              evidence: 'error: tsc failed with 3 errors'
            }
          }
        },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'reflex_prune', arguments: { rawOutput: bulky, intent: 'find failures' } }
        }
      ],
      workspace
    ));

    const gate = toolPayload(responses.get(2)!);
    assert.equal(gate.passed, false);
    assert.equal(gate.results[0].outcome, 'contradicted');

    const prune = toolPayload(responses.get(3)!);
    assert.equal(prune.shadow, false);
    assert.ok(prune.tokensSaved > 0, `expected token savings, got ${prune.tokensSaved}`);

    // Handlers settle concurrently, so the audit is read by a second process
    // that replays the JSONL the first one appended.
    const [ledgerResponse] = callMcp(
      [{ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'reflex_status_ledger', arguments: {} } }],
      workspace
    );
    const ledger = toolPayload(ledgerResponse);
    assert.ok(ledger.summary.totalCalls >= 2, `ledger did not observe the calls above: ${ledger.summary.totalCalls}`);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});


test('authored guide argument tables match the live MCP tool definitions', () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const [list] = callMcp([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], repoRoot);
  for (const relative of ['USER_GUIDE.md', 'docs/USER_GUIDE.en.md']) {
    const document = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    for (const tool of list.result.tools) {
      const rows = document.split('\n').filter((line) => line.split('|')[2]?.trim() === '`' + tool.name + '`');
      assert.equal(rows.length, 1, `${relative}: expected one argument row for ${tool.name}`);
      const cell = rows[0].split('|')[4];
      // Compare identifiers, not prose, whitespace, translations or row order.
      const keys = [...cell.matchAll(/`([A-Za-z]\w*)[^`]*`/g)].map((match) => match[1]);
      // The ledger row also describes its return envelope after the arguments.
      const argumentsOnly = keys.filter((key) => !['summary', 'recentEntries'].includes(key));
      assert.deepEqual(argumentsOnly.sort(), Object.keys(tool.inputSchema.properties).sort(), `${relative}: ${tool.name} parameter drift`);
      if (tool.name === 'reflex_gate') {
        for (const key of tool.inputSchema.properties.assertions.items.required) {
          assert.ok(cell.includes(key), `${relative}: missing nested assertion field ${key}`);
        }
      }
    }
  }
});

test('MCP wrong gate aliases reach empty-assertion escalation, not schema validation', () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const [response] = callMcp([{
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'reflex_gate', arguments: { claims: ['All tests passed'], evidence: 'All tests passed: 10 passed, 0 failed' } }
  }], repoRoot);
  assert.equal(response.result.isError, undefined);
  const result = toolPayload(response);
  assert.equal(result.passed, false);
  assert.equal(result.needsEscalation, true);
  assert.deepEqual(result.results, []);
});


/** Wait for each response before sending the next call to the same MCP server. */
async function callMcpSequential(evidence: string[], cwd: string): Promise<JsonRpcResponse[]> {
  const child = spawn(process.execPath, [cliPath, 'mcp'], {
    cwd,
    env: { ...process.env, SYSTEM_ONE_BACKEND: 'mock' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const responses: JsonRpcResponse[] = [];
    for (const [index, text] of evidence.entries()) {
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: index, method: 'tools/call',
        params: { name: 'reflex_gate', arguments: { assertions: [{ statement: 'All tests passed.' }], evidence: text } }
      }) + '\n');
      const line = await iterator.next();
      assert.equal(line.done, false, `MCP ended before response: ${stderr}`);
      const response = JSON.parse(line.value!) as JsonRpcResponse;
      assert.equal(response.id, index);
      responses.push(response);
    }
    child.stdin.end();
    assert.equal((await exited)[0], 0, stderr);
    return responses;
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
  }
}

for (const firstPassed of [true, false]) {
  test(`one MCP process isolates equal-length evidence in ${firstPassed ? 'positive-negative' : 'negative-positive'} order`, { timeout: 10_000 }, async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-mcp-cache-'));
    try {
      const good = 'All tests: 10 passed, 0 failed';
      const bad = 'All tests: 10 passed, 1 failed';
      assert.equal(good.length, bad.length);
      const evidence = firstPassed ? [good, bad, good] : [bad, good, bad];
      const responses = await callMcpSequential(evidence, workspace);
      for (const [index, response] of responses.entries()) {
        const result = toolPayload(response);
        assert.equal(result.passed, evidence[index] === good);
        assert.equal(result.results[0].outcome, evidence[index] === good ? 'verified' : 'contradicted');
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
}
