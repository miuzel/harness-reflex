/**
 * Failure detection, evidence candidates, and budget truncation.
 *
 * The closing check's safety property is that a failure-marker line survives
 * every budget: truncation may drop the explanatory tail but never the diagnostic
 * floor. These tests pin that priority, and the three authoritative failure
 * sources (isError, structured exit status, exit marker).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assembleEvidence,
  evidenceOf,
  exitMarkerFailure,
  failureOf,
  type EvidenceEntry,
  type ToolResultLike
} from './evidence.js';

test('failureOf trusts the isError flag first', () => {
  assert.equal(failureOf({ isError: true }, 'all good'), true);
});

test('failureOf reads a non-zero structured exit status', () => {
  assert.equal(failureOf({ value: { exitCode: 2 } }, 'anything'), true);
  assert.equal(failureOf({ value: { exitCode: 0 } }, 'anything'), false);
  assert.equal(failureOf({ value: { exitCode: 0, signal: 'SIGTERM' } }, 'anything'), true);
});

test('failureOf reads only a trailing exit marker', () => {
  assert.equal(failureOf({}, 'build done\n[exit code: 1]'), true);
  assert.equal(failureOf({}, 'the log mentioned exit code 1 in its body'), false);
  assert.equal(failureOf({}, 'terminated\n[killed by signal: SIGKILL]'), true);
});

test('exitMarkerFailure anchors to the end of the text', () => {
  assert.equal(exitMarkerFailure('[exit code: 1]'), true);
  assert.equal(exitMarkerFailure('[exit code: 0]'), false);
  assert.equal(exitMarkerFailure('[exit code: 1]\nmore output'), false);
});

test('evidenceOf keeps a marker line as a diagnostic candidate whatever the budget', () => {
  const entries = evidenceOf('bash', { isError: true }, 'ERROR: first failure\nall other lines are ordinary');
  const diagnostic = entries.find((entry) => entry.priority === 'diagnostic');
  assert.ok(diagnostic, 'the marker line became a diagnostic candidate');
  assert.equal(diagnostic?.suspect, true);
  assert.match(diagnostic?.text ?? '', /ERROR: first failure/);
});

test('evidenceOf always contributes a tail summary with structured facts', () => {
  const entries = evidenceOf('bash', { isError: false, value: { exitCode: 0, ok: false } }, 'ordinary output');
  const tail = entries.find((entry) => entry.priority === 'tail');
  assert.ok(tail);
  assert.equal(tail?.suspect, true, 'ok:false is a failure suspicion');
  assert.match(tail?.text ?? '', /exitCode/);
});

test('evidenceOf adds a head fallback only when there is no diagnostic', () => {
  const withDiagnostic = evidenceOf('bash', {}, 'ERROR: bad');
  assert.equal(withDiagnostic.some((entry) => entry.priority === 'other'), false);
  const withoutDiagnostic = evidenceOf('bash', {}, 'just a normal line');
  assert.equal(withoutDiagnostic.some((entry) => entry.priority === 'other'), true);
});

test('assembleEvidence never drops a diagnostic line, even past the budget', () => {
  const entries: EvidenceEntry[] = [
    { tool: 'bash', text: 'ERROR: ' + 'x'.repeat(200), priority: 'diagnostic', suspect: true },
    { tool: 'bash', text: 'tail summary', priority: 'tail', suspect: false },
    { tool: 'bash', text: 'head fallback', priority: 'other', suspect: false }
  ];
  const assembled = assembleEvidence(entries, 50);
  assert.match(assembled.text, /ERROR:/);
  assert.equal(assembled.text.includes('tail summary'), false);
  assert.equal(assembled.text.includes('head fallback'), false);
  assert.ok(assembled.truncatedChars > 0);
});

test('assembleEvidence fills the budget in priority order and reports what it dropped', () => {
  const entries: EvidenceEntry[] = [
    { tool: 'bash', text: 'tail one', priority: 'tail', suspect: false },
    { tool: 'bash', text: 'other one', priority: 'other', suspect: false }
  ];
  const assembled = assembleEvidence(entries, 14);
  assert.equal(assembled.text, 'tail one');
  assert.equal(assembled.retainedChars, 'tail one'.length);
  assert.equal(assembled.truncatedChars, 'other one'.length + 1);
});

test('an empty evidence set assembles to an empty string', () => {
  assert.deepEqual(assembleEvidence([], 100), { text: '', retainedChars: 0, truncatedChars: 0 });
});

test('the structural result interface accepts an ordinary result value', () => {
  const result: ToolResultLike = { isError: false, value: { exitCode: 0 } };
  assert.equal(failureOf(result, 'ok'), false);
});
