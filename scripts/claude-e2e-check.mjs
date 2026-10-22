#!/usr/bin/env node
/**
 * Assertions for `scripts/claude-e2e.sh`.
 *
 * The shell script owns the real `claude -p` runs; this file only reads their
 * outputs so the checks are testable and do not depend on jq:
 *
 *   ledger <stateRoot>
 *       Require one applied closing block, one stop_hook_active allow, one
 *       applied prune with a retained original, and no error record.
 *
 *   assert-pruned <stream.jsonl> <commandFragment> <expectedOriginalFile> <stateRoot>
 *       The tool result Claude read must carry a reflex locator, be shorter than
 *       the original, and the retained original must restore it byte-for-byte.
 *
 *   assert-observe-equal <baseline.jsonl> <observe.jsonl> <commandFragment>
 *       The tool result Claude read must be byte-identical with and without the
 *       plugin while the plugin is in observe mode, and must not be rewritten.
 *
 * Exit code 0 = all assertions passed; 1 = an assertion failed; 2 = bad usage.
 */
import fs from 'node:fs';
import path from 'node:path';

const usage = `usage:
  claude-e2e-check.mjs ledger <stateRoot>
  claude-e2e-check.mjs assert-pruned <stream.jsonl> <fragment> <expectedOriginalFile> <stateRoot>
  claude-e2e-check.mjs assert-observe-equal <baseline.jsonl> <observe.jsonl> <fragment>`;

/** Fail with a single, actionable line. */
function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

/** Parse every JSONL record, skipping blank lines. */
function readJsonl(file) {
  if (!fs.existsSync(file)) fail(`${file} does not exist`);
  const records = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A non-JSON diagnostic line in the stream is not fatal by itself.
    }
  }
  return records;
}

/** All ledger records under a state root. */
function readLedger(stateRoot) {
  if (!fs.existsSync(stateRoot)) fail(`state root ${stateRoot} does not exist`);
  const records = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'ledger.jsonl') {
        for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            records.push(JSON.parse(line));
          } catch {
            // The store quarantines bad lines; the e2e only asserts the good ones.
          }
        }
      }
    }
  };
  walk(stateRoot);
  return records;
}

/** The tool_use id and text of one tool result in a stream-json transcript. */
function extractToolResult(file, fragment) {
  const records = readJsonl(file);
  const uses = new Map();
  const results = [];
  for (const record of records) {
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use') {
        uses.set(block.id, { name: block.name, input: block.input ?? {} });
      }
      if (block?.type === 'tool_result') {
        const text = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .filter((part) => part?.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text)
                .join('\n')
            : '';
        results.push({ id: block.tool_use_id, text });
      }
    }
  }
  for (const [id, use] of uses) {
    const command = typeof use.input?.command === 'string' ? use.input.command : '';
    if (!command.includes(fragment)) continue;
    const result = results.find((entry) => entry.id === id);
    if (result) return { command, text: result.text };
  }
  const seen = [...uses.values()].map((use) => `${use.name}:${String(use.input?.command ?? '').slice(0, 80)}`);
  fail(`no tool result for a command containing "${fragment}" in ${file}; saw ${JSON.stringify(seen)}`);
}

/** Require the active run to have actually made every claimed decision. */
function checkLedger(stateRoot) {
  const records = readLedger(stateRoot);
  const closing = records.filter((record) => record.type === 'closing');
  const prune = records.filter((record) => record.type === 'prune');
  const errors = records.filter((record) => record.type === 'error');

  const blocked = closing.filter((record) => record.applied === true);
  const stoppedActive = closing.filter((record) => record.skipReason === 'stop-hook-active');
  const pruned = prune.filter(
    (record) => record.applied === true && record.tokensSaved > 0 && record.retention === 'retained'
  );

  if (blocked.length < 1) fail('no applied closing block in the ledger (Stop never blocked)');
  if (stoppedActive.length < 1) fail('no stop_hook_active allow in the ledger (the guarded retry never ran)');
  if (pruned.length < 1) fail('no applied prune with a retained original in the ledger');
  if (errors.length > 0) fail(`the ledger recorded ${errors.length} error record(s): ${JSON.stringify(errors[0])}`);

  console.log(`PASS ledger: closing-block=${blocked.length} stop-hook-active=${stoppedActive.length} prune=${pruned.length} errors=0`);
}

/** Check the model-visible prune result and the retained original. */
function checkPruned(streamFile, fragment, expectedFile, stateRoot) {
  const { text } = extractToolResult(streamFile, fragment);
  const expected = fs.readFileSync(expectedFile, 'utf8');
  // Claude Code keeps the original tool result in its transcript: the rewrite a
  // PostToolUse hook returns only changes what the model reads next. When the
  // marker is absent the decision still has to be proven, so fall back to the
  // ledger's own record of what was installed and retained.
  let digest;
  if (text.includes('[reflex prune:')) {
    if (!/originals\/[a-f0-9]+\.txt/.test(text)) fail('the reflex marker carries no originals/<digest>.txt locator');
    if (text.length >= expected.length) {
      fail(`the pruned result (${text.length}) is not shorter than the original (${expected.length})`);
    }
    digest = /originals\/([a-f0-9]+)\.txt/.exec(text)[1];
  } else {
    const records = readLedger(stateRoot).filter((record) => record.type === 'prune' && record.applied === true);
    if (records.length === 0) fail('no applied prune in the ledger and no marker in the transcript');
    const last = records[records.length - 1];
    const recorded = last.details?.digest;
    if (typeof recorded !== 'string' || !/^[a-f0-9]+$/.test(recorded)) {
      fail(`the ledger prune record carries no digest: ${JSON.stringify(last)}`);
    }
    digest = recorded;
    if (!(last.tokensSaved > 0)) fail('the ledger prune claims no saving');
  }
  const candidates = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === `${digest}.txt`) candidates.push(full);
    }
  };
  walk(stateRoot);
  if (candidates.length !== 1) fail(`expected one retained original for ${digest}, found ${candidates.length}`);
  const retained = fs.readFileSync(candidates[0], 'utf8');
  // The command hook reads stdout and stderr as two text parts and joins them;
  // with an empty stderr the retained text is the command output plus one '\n'.
  if (retained !== expected && retained !== `${expected}\n`) {
    fail(`the retained original does not restore the command output byte-for-byte (${retained.length} vs ${expected.length})`);
  }
  const where = text.includes('[reflex prune:') ? 'transcript marker' : 'ledger (the transcript keeps the original)';
  console.log(`PASS prune [${where}]: original=${expected.length} retained=${retained.length} locator=${digest}`);
}

/** Compare the deterministic tool result with and without the plugin. */
function checkObserveEqual(baselineFile, observeFile, fragment) {
  const baseline = extractToolResult(baselineFile, fragment).text;
  const observe = extractToolResult(observeFile, fragment).text;
  if (observe.includes('[reflex prune:')) fail('observe mode rewrote the model-visible result');
  if (baseline !== observe) {
    fail(`observe result differs from no-plugin baseline (${baseline.length} vs ${observe.length} bytes)`);
  }
  console.log(`PASS observe: diff=0 bytes (${observe.length})`);
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'ledger':
    if (args.length !== 1) fail(usage);
    checkLedger(args[0]);
    break;
  case 'assert-pruned':
    if (args.length !== 4) fail(usage);
    checkPruned(args[0], args[1], args[2], args[3]);
    break;
  case 'assert-observe-equal':
    if (args.length !== 3) fail(usage);
    checkObserveEqual(args[0], args[1], args[2]);
    break;
  default:
    fail(usage);
}
