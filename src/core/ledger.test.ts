import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DecisionLedger } from './ledger.js';

test('memory-only ledger keeps decisions in process and never writes files', () => {
  const ledger = new DecisionLedger(null);

  assert.equal(ledger.getLogPath(), null);
  ledger.record({ type: 'choice', backend: 'stub', latencyMs: 3, details: { action: 'unit-test' } });

  assert.equal(ledger.getEntries().length, 1);
  const summary = ledger.getSummary();
  assert.equal(summary.totalCalls, 1);
  assert.equal(summary.callsByType.choice, 1);

  ledger.clear();
  assert.equal(ledger.getSummary().totalCalls, 0);
});

test('default ledger path stays <cwd>/.reflex/ledger.jsonl', () => {
  const ledger = new DecisionLedger();

  assert.equal(ledger.getLogPath(), path.join(process.cwd(), '.reflex', 'ledger.jsonl'));
});

test('file-backed ledger appends to disk and replays on construction', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-ledger-'));
  const logPath = path.join(dir, 'nested', 'ledger.jsonl');

  try {
    const first = new DecisionLedger(logPath);
    first.record({ type: 'gate', backend: 'stub', latencyMs: 2, passed: true });
    first.record({ type: 'prune', backend: 'stub', latencyMs: 1, tokensSaved: 12 });

    assert.equal(fs.existsSync(logPath), true);
    assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 2);

    const replayed = new DecisionLedger(logPath);
    assert.equal(replayed.getEntries().length, 2);
    const summary = replayed.getSummary();
    assert.equal(summary.gatePassedCount, 1);
    assert.equal(summary.totalTokensSaved, 12);

    replayed.clear();
    assert.equal(fs.existsSync(logPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
