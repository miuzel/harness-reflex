/**
 * The extension surface: the eight tools, the event wiring, and the closing
 * degradation seen from the outside.
 *
 * Everything here drives the real `installPiReflex` against a fake pi API, so a
 * change to how pi delivers an event shows up here rather than only in the e2e
 * (which needs the network and a real model).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { installPiReflex, PI_DEFAULT_MODES, resolveModes } from './index.js';
import { REFLEX_TOOLS, REFLEX_TOOL_NAMES } from './tools.js';
import { CLOSING_BLOCK, CLOSING_DEGRADED_PASS } from './pi-adapter.js';

/** A fake pi API that records handlers and registered tools. */
function fakeApi() {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const tools: Array<{ name: string; label: string; description: string; parameters: unknown }> = [];
  const api = {
    on(event: string, handler: (event: unknown) => unknown) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerTool(tool: { name: string; label: string; description: string; parameters: unknown }) {
      tools.push(tool);
    }
  };
  return { api, handlers, tools };
}

/** The eight names, written out so a rename cannot pass by matching itself. */
const EXPECTED_TOOLS = [
  'reflex_gate',
  'reflex_prune',
  'reflex_detect_stagnation',
  'reflex_route',
  'reflex_status_ledger',
  'reflex_choice',
  'reflex_score',
  'reflex_screen'
];

test('all eight reflex tools are registered through registerTool', () => {
  const { api, tools } = fakeApi();
  installPiReflex(api);
  assert.deepEqual(tools.map((tool) => tool.name), EXPECTED_TOOLS);
  assert.deepEqual([...REFLEX_TOOL_NAMES], EXPECTED_TOOLS);
});

test('every registered tool carries a label, a description, and an object schema', () => {
  const { api, tools } = fakeApi();
  installPiReflex(api);
  for (const tool of tools) {
    assert.ok(tool.label.length > 0, `${tool.name} has a label`);
    assert.ok(tool.description.length > 20, `${tool.name} has a real description`);
    const schema = tool.parameters as { type?: string; properties?: Record<string, unknown> };
    assert.equal(schema.type, 'object', `${tool.name} parameters are an object schema`);
    assert.ok(schema.properties && Object.keys(schema.properties).length > 0, `${tool.name} declares properties`);
  }
});

test('the tool schemas match the MCP surface field for field', () => {
  // The point of the parity is that an agent does not relearn the tools.
  const byName = new Map(REFLEX_TOOLS.map((tool) => [tool.name, tool]));
  const gate = byName.get('reflex_gate')!;
  const gateProps = (gate.parameters as { properties: Record<string, unknown>; required: string[] });
  assert.deepEqual(gateProps.required, ['assertions', 'evidence']);
  assert.deepEqual(Object.keys(gateProps.properties), ['assertions', 'evidence', 'strictness']);

  const prune = byName.get('reflex_prune')!;
  const pruneProps = (prune.parameters as { properties: Record<string, unknown>; required: string[] });
  assert.deepEqual(pruneProps.required, ['rawOutput']);
  assert.deepEqual(Object.keys(pruneProps.properties), ['rawOutput', 'intent', 'shadowMode']);

  const screen = byName.get('reflex_screen')!;
  const source = (screen.parameters as { properties: { source: { enum: string[] } } }).properties.source;
  assert.deepEqual(source.enum, ['tool_output', 'web_page', 'user_input', 'file_content']);
});

test('the wiring subscribes to every pi event the four capabilities need', () => {
  const { api, handlers } = fakeApi();
  installPiReflex(api);
  for (const event of [
    'session_start',
    'session_shutdown',
    'turn_start',
    'tool_call',
    'tool_result',
    'agent_before_settle'
  ]) {
    assert.ok(handlers.has(event), `handles ${event}`);
  }
});

test('closing starts in observe, in line with the shipped default', () => {
  assert.deepEqual(PI_DEFAULT_MODES, {
    stagnation: 'active',
    prune: 'active',
    gate: 'active',
    closing: 'observe'
  });
  assert.equal(resolveModes({}).closing, 'observe');
  assert.equal(resolveModes({ modes: { closing: 'active' } }).closing, 'active');
});

test('a tool_result can be replaced by the prune path and read back by locator', async () => {
  const { api, handlers } = fakeApi();
  const runtime = installPiReflex(api, { modes: { prune: 'active' } });
  // A realistic build trace: real evidence lines plus the two things the
  // deterministic pruner removes (deep `node_modules/` frames, blank-line runs).
  const long = [
    '> build@1.0.0 build',
    ...Array.from({ length: 60 }, (_, index) => `  at node_modules/framework/lib/internal-${index}.js:12:5`),
    ...Array.from({ length: 20 }, () => ''),
    'src/index.ts(12,5): error TS2322: Type string is not assignable to type number.',
    'npm ERR! code ELIFECYCLE'
  ].join('\n');
  const outcome = (await handlers.get('tool_result')!({
    type: 'tool_result',
    toolCallId: 'call-prune',
    toolName: 'bash',
    input: { command: 'npm run build' },
    content: [{ type: 'text', text: long }],
    isError: false
  })) as { content?: Array<{ type: string; text?: string }> } | undefined;

  assert.ok(outcome?.content, 'a bulky result is replaced');
  const replaced = outcome!.content!.map((block) => block.text ?? '').join('\n');
  assert.ok(replaced.length < long.length, 'the replacement is smaller');

  // The locator in the replacement must resolve through the store that kept the original.
  const locator = /originals\/([0-9a-f]+)\.txt/.exec(replaced);
  assert.ok(locator, 'the replacement publishes a locator for the original');
  const original = runtime.store.readOriginal(runtime.sessionId, locator[1]!);
  assert.equal(original, long, 'the full original is retrievable by its locator digest');
});

test('a contradictory settle continues once, then passes and is recorded as degraded', async () => {
  const { api, handlers } = fakeApi();
  const runtime = installPiReflex(api, { modes: { closing: 'active' } });
  runtime.closing.beginTurn(1);

  // Feed the closing evidence so the judgment can contradict the claim.
  await handlers.get('tool_result')!({
    type: 'tool_result',
    toolCallId: 'c1',
    toolName: 'bash',
    input: {},
    content: [{ type: 'text', text: 'FAILED: 3 tests failed\nError: expected 1 to equal 2' }],
    isError: false
  });

  // pi's real settle shape: the assistant message is in `context.contextMessages`,
  // and `entries` holds only the drafts a handler may append.
  const settle = () => ({
    type: 'agent_before_settle',
    entries: [],
    continue: false,
    context: {
      canContinue: true,
      contextEntries: [],
      contextMessages: [
        { role: 'user', content: 'is the build green?' },
        { role: 'assistant', content: [{ type: 'text', text: 'All tests pass, the build is clean.' }] }
      ],
      llmMessages: [],
      pendingMessages: []
    },
    outcome: {}
  });

  const first = (await handlers.get('agent_before_settle')!(settle())) as
    | { continue?: boolean; entries?: unknown[] }
    | undefined;

  assert.equal(first?.continue, true, 'the first contradictory settle asks for one more turn');
  assert.ok(Array.isArray(first!.entries), 'the continuation appends the correction');
  const appended = first!.entries!.at(-1) as { customType?: string; content?: string };
  assert.equal(appended.customType, 'reflex.closing');
  assert.ok((appended.content ?? '').length > 0);

  // The one continuation is spent; the next contradictory settle must pass.
  const second = await handlers.get('agent_before_settle')!(settle());
  assert.equal(second, undefined, 'a second contradictory settle is not continued again');
  const outcomes = runtime.ledger.map((line) => line.closingOutcome);
  assert.deepEqual(outcomes, [CLOSING_DEGRADED_PASS], `recorded ${JSON.stringify(outcomes)}`);

  // Whatever pi decided, the extension must never have written a pi "block".
  assert.ok(
    !runtime.ledger.some((line) => line.closingOutcome === CLOSING_BLOCK),
    'pi has no veto, so pi never records closing-block'
  );
});

test('the suite reads the same degraded outcome label the goal requires', () => {
  // Guard the literal itself: a rename would break the ledger's cross-host story.
  assert.equal(CLOSING_DEGRADED_PASS, 'closing-degraded-pass');
  assert.equal(CLOSING_BLOCK, 'closing-block');
});
