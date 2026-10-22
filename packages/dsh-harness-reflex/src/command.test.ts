import assert from 'node:assert/strict';
import test from 'node:test';

import type { Context } from '@deepseek-ai/cordis';
import type { CommandDefinition, CommandId, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands';

import type { ReflexLedgerResult } from './bridge.js';
import type { LedgerEntry } from './vendor/harness-reflex/index.js';
import { Config, type ReflexConfig } from './config.js';
import {
  LEDGER_COMMAND_ENTRIES,
  REFLEX_LEDGER_COMMAND,
  REFLEX_LEDGER_COMMAND_DESCRIPTION,
  formatLedgerReport
} from './command.js';
import { applyReflex, type ReflexRuntime } from './index.js';
import { createReflexHost, createToolContext, fakeAgent, registerPhysicalAdapter } from './testing.js';

/**
 * Coverage of the `/reflex-ledger` command.
 *
 * The ledger used to be a tool the model could call. It is a Host command now:
 * a person types it, the registry answers with text, and no model turn is
 * scheduled. These tests hold that contract — the registered name and
 * description, the text a person actually reads (full and empty ledgers alike),
 * that reading it costs no dispatch, and that the name is released with the
 * activation that owns it rather than leaking into the next one.
 *
 * @module dsh-reflex/command.test
 */

/** The command registry as this module uses it, taken from the live service. */
type Commands = Context['commands'];

/**
 * Resolve one definition through the registry, the way the Host does.
 * @param commands - the live command service.
 * @param name - command name without the leading slash.
 * @returns the registered definition.
 */
function definitionOf(commands: Commands, name = REFLEX_LEDGER_COMMAND): CommandDefinition {
  const definition = commands.find(undefined as never, name);
  assert.ok(definition !== undefined, `the registry does not answer for "${name}"`);
  return definition;
}

/**
 * Invoke a handler with the invocation shape the Host passes.
 *
 * The invocation deliberately carries a raw input and attachments: a handler
 * that reads either one would answer differently here.
 * @param definition - the registered definition.
 * @returns the command result.
 */
async function invoke(definition: CommandDefinition): Promise<CommandResult> {
  const invocation = {
    commandId: 'cmd-test-1' as CommandId,
    agent: fakeAgent({ id: 'ledger-reader' }),
    rawInput: ' --json ignored',
    attachments: [],
    signal: new AbortController().signal
  } as unknown as CommandInvocation;
  return definition.handler(invocation);
}

/**
 * The text of a successful command result.
 * @param result - the result to read.
 * @returns the text.
 */
function textOf(result: CommandResult): string {
  assert.equal(result.kind, 'success', `the command failed: ${result.kind === 'error' ? result.text : ''}`);
  return result.kind === 'success' ? (result.text ?? '') : '';
}

/** One ledger entry, with the fields the formatter reads. */
function entry(id: string, type: LedgerEntry['type'], extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id,
    timestamp: `2024-03-04T05:06:${String(Number(id.replace(/\D/gu, '')) % 60).padStart(2, '0')}.000Z`,
    type,
    backend: 'mock-heuristic-v1',
    latencyMs: 4.2,
    ...extra
  };
}

test('the plugin registers exactly one ledger command with its documented name', async () => {
  const host = await createReflexHost({ backend: 'mock' });
  try {
    const definition = definitionOf(host.ctx.commands);
    assert.equal(definition.name, REFLEX_LEDGER_COMMAND);
    assert.equal(definition.name, 'reflex-ledger', 'the name a person types after the slash');
    assert.equal(definition.description, REFLEX_LEDGER_COMMAND_DESCRIPTION);
    assert.equal(definition.input, undefined, 'the command takes no arguments');

    const registered = host.ctx.commands.list(undefined as never).map((command) => command.name);
    assert.deepEqual(registered, [REFLEX_LEDGER_COMMAND], 'the plugin registers nothing else');
  } finally {
    await host.dispose();
  }
});

test('the command reports the decisions the activation recorded, without a model turn', async () => {
  const host = await createReflexHost({ backend: 'mock' });
  try {
    const adapter = registerPhysicalAdapter(host.ctx, 'deepseek');
    await host.callTool('reflex_choice', { question: 'Ship it?', options: ['yes', 'no'] });
    await host.callTool('reflex_gate', { assertions: [{ statement: 'the build is green' }], evidence: 'the build is green' });

    const text = textOf(await invoke(definitionOf(host.ctx.commands)));
    assert.match(text, /Reflex 决策账本/);
    assert.match(text, /总调用数：2/, text);
    assert.match(text, /按类型：choice 1、gate 1/, text);
    assert.match(text, /平均时延：\d+(\.\d+)? ms/, text);
    assert.match(text, /节省 token：\d+（约 \$\d+\.\d{4}）/, text);
    assert.match(text, /门禁：通过 \d+ \/ 失败 \d+/, text);
    assert.match(text, /停滞告警：\d+/, text);
    assert.match(text, /最近 2 条决策（最新在前）：/, text);
    assert.match(text, /- \d{2}:\d{2}:\d{2} choice · /, text);
    assert.match(text, /- \d{2}:\d{2}:\d{2} gate · /, text);
    assert.equal(
      text.indexOf('gate ·') < text.indexOf('choice ·'),
      true,
      'the newest decision is printed first'
    );

    // The handler is a plain callback: answering the command scheduled nothing.
    assert.equal(adapter.calls.length, 0, 'reading the ledger reached a model');
  } finally {
    await host.dispose();
  }
});

test('an empty ledger says so instead of printing zeroes that look measured', async () => {
  const host = await createReflexHost({ backend: 'mock' });
  try {
    const text = textOf(await invoke(definitionOf(host.ctx.commands)));
    assert.match(text, /暂无记录/);
    assert.equal(text.includes('总调用数'), false, 'an empty ledger printed an aggregate of zeroes');
    assert.match(text, /reflex-ledger/, 'the empty answer does not name the command');
  } finally {
    await host.dispose();
  }
});

test('the report prints the facts each decision type owns', () => {
  const result: ReflexLedgerResult = {
    summary: {
      totalCalls: 5,
      callsByType: { gate: 2, stagnation: 1, prune: 1, choice: 1 },
      totalTokensSaved: 2048,
      avgLatencyMs: 3.56,
      estimatedCostSavedUsd: 0.0123,
      stagnationAlerts: 1,
      gatePassedCount: 1,
      gateFailedCount: 1
    },
    recentEntries: [
      entry('e1', 'gate', { passed: true }),
      entry('e2', 'gate', { passed: false }),
      entry('e3', 'stagnation', { isStuck: true }),
      entry('e4', 'prune', { tokensSaved: 2048, shadow: true }),
      entry('e5', 'choice', { skipReason: 'shadow mode' })
    ]
  };

  const text = formatLedgerReport(result);
  assert.match(text, /总调用数：5/);
  assert.match(text, /平均时延：3\.6 ms/, 'a fractional latency keeps one decimal instead of printing the raw float');
  assert.match(text, /节省 token：2048（约 \$0\.0123）/, text);
  assert.match(text, /门禁：通过 1 \/ 失败 1/);
  assert.match(text, /停滞告警：1/);
  assert.match(text, /按类型：gate 2、choice 1、prune 1、stagnation 1/, 'the type breakdown is ordered by count');
  assert.equal(text.includes('- e'), false, 'entry ids belong in the ledger file, not in the reply');

  const lines = text.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, 5);
  assert.match(lines[0] ?? '', /choice · .*跳过：shadow mode/, 'the newest entry comes first and carries its skip reason');
  assert.match(lines[1] ?? '', /prune · .*节省 2048 token · shadow/, 'a shadow prune is marked as one');
  assert.match(lines[2] ?? '', /stagnation · .*判定停滞/);
  assert.match(lines[3] ?? '', /gate · .*未通过/);
  assert.match(lines[4] ?? '', /gate · .*通过/);
  assert.equal(
    lines[4]?.includes('未通过'),
    false,
    'a passing gate must not also read as a failure'
  );
});

test('the report keeps the newest entries and drops the rest', () => {
  const entries = Array.from({ length: LEDGER_COMMAND_ENTRIES + 4 }, (_, index) =>
    entry(`x${index}`, 'choice', { latencyMs: index })
  );
  const result: ReflexLedgerResult = {
    summary: {
      totalCalls: entries.length,
      callsByType: { choice: entries.length },
      totalTokensSaved: 0,
      avgLatencyMs: 1,
      estimatedCostSavedUsd: 0,
      stagnationAlerts: 0,
      gatePassedCount: 0,
      gateFailedCount: 0
    },
    recentEntries: entries
  };

  const text = formatLedgerReport(result);
  const lines = text.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, LEDGER_COMMAND_ENTRIES, 'the reply is not capped');
  assert.match(text, new RegExp(`最近 ${LEDGER_COMMAND_ENTRIES} 条决策`));
  assert.match(lines[0] ?? '', new RegExp(`${entries.length - 1} ms`), 'the newest entry is first');
  assert.match(lines[LEDGER_COMMAND_ENTRIES - 1] ?? '', new RegExp(`${entries.length - LEDGER_COMMAND_ENTRIES} ms`));
});

test('a ledger read that cannot be answered comes back as text, not as a crash', async () => {
  const ctx = await createToolContext();
  try {
    const runtime = applyReflex(ctx, { backend: 'mock' });
    const definition = definitionOf(ctx.commands);
    // The activation is torn down underneath the definition, the way an unload
    // that races a typed command would leave it.
    runtime.dispose();

    const result = await invoke(definition);
    assert.equal(result.kind, 'error', 'a disposed runtime must not look like a successful read');
    assert.match(result.kind === 'error' ? result.text : '', /读取失败/, 'the failure is reported in the reply');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('the command name is released with its owner and is not double-registered', async () => {
  const ctx = await createToolContext();
  try {
    // Two full activations on one context, loaded the way the Host loader does.
    const load = async (prefix: string): Promise<{ fiber: { dispose(): Promise<void> }; runtime: ReflexRuntime }> => {
      let created: ReflexRuntime | undefined;
      const fiber = await ctx.plugin(
        {
          name: 'dsh-reflex',
          inject: ['tools', 'llm', 'commands'],
          Config,
          apply: (inner: Context, innerConfig: ReflexConfig) => {
            created = applyReflex(inner, innerConfig);
          }
        },
        { backend: 'mock', toolPrefix: prefix }
      );
      assert.ok(created, 'apply must run while the plugin loads');
      return { fiber, runtime: created };
    };

    const owner = await load('alpha_');
    const first = definitionOf(ctx.commands);

    // The name is context-global while tools are per activation: the second
    // activation must not fail, and it must not take the name from its owner.
    const other = await load('beta_');
    assert.equal(definitionOf(ctx.commands), first, 'the second activation replaced the owner');
    assert.equal(other.runtime.toolSurface.includes('beta_choice'), true, 'the second activation still owns its tools');

    // Disposing the owner releases the name; the survivor never claimed it, so
    // the command is simply gone until an activation registers it again.
    await owner.fiber.dispose();
    assert.equal(ctx.commands.find(undefined as never, REFLEX_LEDGER_COMMAND), undefined, 'unloading leaked the command name');

    await other.fiber.dispose();
    assert.equal(ctx.commands.find(undefined as never, REFLEX_LEDGER_COMMAND), undefined);
  } finally {
    await ctx.fiber.dispose();
  }
});
