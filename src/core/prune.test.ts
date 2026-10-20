import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MockDecisionBackend } from '../backend/mock.js';
import { DecisionLedger } from './ledger.js';
import { ToolResultPruner } from './prune.js';

/**
 * A payload the mock backend really shrinks: it drops progress bars, so the
 * candidate is the one line that carries a result.
 */
const BULKY_OUTPUT = `${Array.from({ length: 30 }, (_, index) => `=] progress ${index} [${'='.repeat(40)}]`).join('\n')}\nbuild finished ok\n`;

function prunerWithLedger(): { pruner: ToolResultPruner; ledger: DecisionLedger } {
  const ledger = new DecisionLedger(null);
  return { pruner: new ToolResultPruner(new MockDecisionBackend(), ledger), ledger };
}

test('a measure-only reduction hands the candidate back without booking a saving', async () => {
  const { pruner, ledger } = prunerWithLedger();

  const measured = await pruner.prune(BULKY_OUTPUT, { measureOnly: true });
  const entry = ledger.getEntries()[0]!;

  assert.notEqual(measured.processedOutput, BULKY_OUTPUT, 'the caller is given the candidate, not the raw text');
  assert.equal(measured.processedOutput.includes('build finished ok'), true);
  assert.ok(measured.estimatedTokensSaved > 0, 'the candidate really is a reduction');
  assert.equal(entry.type, 'prune');
  assert.equal(entry.tokensSaved, 0, 'nothing has left the context yet');
  assert.equal(
    (entry.details as { potentialTokensSaved?: number }).potentialTokensSaved,
    measured.estimatedTokensSaved,
    'the candidate’s size stays readable next to the zero'
  );
});

test('an ordinary reduction books the saving it really made', async () => {
  const { pruner, ledger } = prunerWithLedger();

  const applied = await pruner.prune(BULKY_OUTPUT);
  const entry = ledger.getEntries()[0]!;

  assert.equal(entry.tokensSaved, applied.estimatedTokensSaved, 'the reduction is booked');
  assert.ok(entry.tokensSaved! > 0);
  assert.equal(
    (entry.details as { potentialTokensSaved?: number }).potentialTokensSaved,
    undefined,
    'a booked saving is not also a potential one'
  );
});

test('a shadow measurement withholds the candidate and books no saving either', async () => {
  const { pruner, ledger } = prunerWithLedger();

  const shadow = await pruner.prune(BULKY_OUTPUT, { shadowMode: true });
  const entry = ledger.getEntries()[0]!;

  assert.equal(shadow.processedOutput, BULKY_OUTPUT, 'a shadow measurement withholds the candidate');
  assert.equal(entry.tokensSaved, 0);
  assert.equal(
    (entry.details as { potentialTokensSaved?: number }).potentialTokensSaved,
    shadow.estimatedTokensSaved,
    'the size it did not install stays readable'
  );
});
