/**
 * The file store and the memory store must decide identically.
 *
 * The decision logic is written once against {@link HookStorePort}, and the two
 * implementations differ only in *where* the state lives. If a future decision
 * starts depending on something one store happens to do differently (an
 * ordering, a rounding, a missing read), an in-process host would silently
 * behave unlike the command hook. These fixtures replay the same events through
 * both and compare the model-visible output and the ledger's meaning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MockDecisionBackend } from '../backend/mock.js';
import { FixedClock } from '../state/clock.js';
import { FileStateStore } from '../state/file-store.js';
import { EVENT_BUDGETS } from './contract.js';
import { DEFAULT_HOOK_CONFIG, HookDecision, type HookConfig } from './decision.js';
import { MemoryStateStore } from './memory-store.js';
import type { HookStorePort } from './store-port.js';

const NOW = Date.parse('2026-10-22T10:00:00.000Z');
const SESSION = 'parity-session';

/** A quiet clock: every decision of one fixture sees the same instant. */
function clock(): FixedClock {
  return new FixedClock(NOW);
}

/** The decision config with closing active, so every capability can act. */
const CONFIG: HookConfig = { ...DEFAULT_HOOK_CONFIG };
const MODES = { stagnation: 'active', prune: 'active', gate: 'active', closing: 'active' } as const;

interface Outcome {
  /** Every model-visible stdout object, in order. */
  outputs: string[];
  /** The ledger's meaning: type, applied flag and skip reason per decision. */
  ledger: string[];
}

/** Replay one event sequence through one store. */
async function replay(store: HookStorePort): Promise<Outcome> {
  const run = new HookDecision({
    store,
    backend: new MockDecisionBackend(),
    config: CONFIG,
    modes: { ...MODES },
    sessionId: SESSION,
    clock: clock(),
    stderr: () => undefined
  });
  store.ensureSession(SESSION, 'active');
  const outputs: string[] = [];
  const deliver = async (event: 'pretooluse' | 'posttooluse' | 'stop', payload: Record<string, unknown>): Promise<void> => {
    const output = await run.handle(event, { session_id: SESSION, ...payload }, EVENT_BUDGETS[event]);
    outputs.push(JSON.stringify(output));
  };

  // One failing call, twice: the second is a repetition the judgment may refuse.
  const failing = {
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_use_id: 'tool-1',
    tool_response: { exitCode: 1, stdout: 'ERR failure one\n'.repeat(40), stderr: '' }
  };
  await deliver('pretooluse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tool-1' });
  await deliver('posttooluse', failing);
  await deliver('pretooluse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tool-2' });
  await deliver('posttooluse', { ...failing, tool_use_id: 'tool-2' });
  // A genuine completion claim contradicted by the failures above.
  await deliver('stop', { last_assistant_message: 'All tests pass and the task is complete.', stop_hook_active: false });

  return { outputs, ledger: readLedgerMeaning(store) };
}

/** The ledger rows' meaning, independent of their ids and timestamps. */
function readLedgerMeaning(store: HookStorePort): string[] {
  const events = store.readEvents(SESSION, 100);
  return events.map((event) => `${event.kind}:${event.signature ?? ''}:${event.failed === true ? 'fail' : 'ok'}`);
}

test('the memory store decides exactly like the file store', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-parity-'));
  try {
    const file = new FileStateStore({ root, harness: 'file', clock: clock() });
    const memory = new MemoryStateStore({ harness: 'memory', now: () => NOW });
    const viaFile = await replay(file);
    const viaMemory = await replay(memory);
    assert.deepEqual(viaMemory.outputs, viaFile.outputs, 'an in-process host must produce the same model-visible output');
    assert.deepEqual(viaMemory.ledger, viaFile.ledger, 'the two stores must record the same observations');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a retained original reads back through both stores', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-orig-'));
  try {
    for (const store of [
      new FileStateStore({ root, harness: 'file', clock: clock() }),
      new MemoryStateStore({ now: () => NOW })
    ]) {
      store.ensureSession('retain', 'active');
      const text = 'line one\nline two\n'.repeat(30);
      const result = store.retainOriginal('retain', 'abcdef0123456789', text);
      assert.equal(result.retained, true);
      assert.equal(store.readOriginal('retain', 'abcdef0123456789'), text, 'the locator must read the payload back');
      assert.equal(store.readOriginal('retain', 'nonexistent'), undefined);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
