import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DELEGATION_ROW_ID,
  MODEL_SELECTION_FIELD,
  PROFILE_PATCH_FILENAME,
  enableHostModelSelection,
  inspectHostModelSelection,
  planModelSelectionEdit,
  resolveProfilePatchPath
} from './host-patch.js';

/**
 * Coverage of the one file this plugin edits outside its own settings section.
 *
 * Two properties matter more than any other, and both are asserted here:
 *
 * 1. **The user's document survives.** Every byte of a real-world patch that is
 *    not the one edited field must come out unchanged — comments, ordering,
 *    `!!js` expressions, unrelated rows.
 * 2. **Nothing is guessed.** A shape this editor cannot read exactly is refused
 *    with a reason, never rewritten into something the Host would boot
 *    differently.
 *
 * Every case runs against a scratch directory created here; none of them reads or
 * writes the user's home.
 *
 * @module dsh-reflex/host-patch.test
 */

/** A patch that looks like a running deployment's, with content this plugin must not lose. */
const USER_PATCH = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
- id: compaction-basic
  config:
    maxTokens: 16384
- id: aegis-method-pack
  disabled: true
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      newapi-aseit:
        apiKeyEnv: NEWAPI_ASEIT_API_KEY
        models:
          - id: DeepSeek-V4.1-Flash
            name: DeepSeek-F-Local
            reasoningEfforts:
              off: none
              low: low
              high: high
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
`;

/** A patch that carries an executable `!!js` expression, as the real one does. */
const JS_PATCH = `- id: compaction-basic
  config:
    maxTokens: !!js ((() => { const tls = process.getBuiltinModule("node:tls"); return 16384; })())
- id: locale
  config:
    preference: zh
`;

/** Create a scratch directory that the test removes afterwards. */
function scratch(): { dir: string; patch: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'reflex-host-patch-'));
  return {
    dir,
    patch: join(dir, PROFILE_PATCH_FILENAME),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

/** Every line of `before` that does not appear, in order, in `after`. */
function lostLines(before: string, after: string): string[] {
  const remaining = after.split('\n');
  const lost: string[] = [];
  let cursor = 0;
  for (const line of before.split('\n')) {
    const found = remaining.indexOf(line, cursor);
    if (found === -1) lost.push(line);
    else cursor = found + 1;
  }
  return lost;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

test('the patch path comes from the profile directory the Host exported', () => {
  const resolution = resolveProfilePatchPath({ DSH_PROFILE_DIR: '/home/someone/.dsh/profiles/web' }, '/home/someone');
  assert.equal(resolution.path, `/home/someone/.dsh/profiles/web/${PROFILE_PATCH_FILENAME}`);
  assert.equal(resolution.source, 'DSH_PROFILE_DIR', 'the exported directory is the authoritative fact');
  assert.equal(resolution.reason, undefined, 'an authoritative resolution carries no caveat');
});

test('a harness home rebuilds the same path when the profile directory was not exported', () => {
  const resolution = resolveProfilePatchPath({ DSH_HOME: '/opt/dsh-home', DSH_PROFILE: 'work' }, '/home/someone');
  assert.equal(resolution.path, `/opt/dsh-home/profiles/work/${PROFILE_PATCH_FILENAME}`);
  assert.equal(resolution.source, 'DSH_HOME');
});

test('a fallback path is reported as a guess, never as a fact', () => {
  // Nothing exported: the conventional location is the only remaining reading,
  // and the resolution has to say so — a caller that cannot see this would
  // present a guess as the profile the Host booted.
  const resolution = resolveProfilePatchPath({}, '/home/someone');
  assert.equal(resolution.path, `/home/someone/.dsh/profiles/web/${PROFILE_PATCH_FILENAME}`);
  assert.equal(resolution.source, 'default-profile');
  assert.match(String(resolution.reason), /assuming/);
});

test('no export and no home yields an unresolved path instead of a guess', () => {
  const resolution = resolveProfilePatchPath({}, '');
  assert.equal(resolution.path, undefined);
  assert.equal(resolution.source, 'unresolved');
  assert.match(String(resolution.reason), /DSH_PROFILE_DIR/);
});

// ---------------------------------------------------------------------------
// The merge rule, as a pure function over text
// ---------------------------------------------------------------------------

test('a user patch with no delegation row keeps every byte and gains the row', () => {
  const result = planModelSelectionEdit(USER_PATCH);
  assert.equal(result.outcome, 'added-row');
  const text = result.text ?? '';

  assert.deepEqual(lostLines(USER_PATCH, text), [], 'every original line survives, in order');
  assert.ok(text.startsWith(USER_PATCH.replace(/\n+$/, '')), 'the existing document is a prefix, unmodified');
  assert.ok(text.includes(`- id: ${DELEGATION_ROW_ID}`), 'the row is appended');
  assert.ok(text.includes(`${MODEL_SELECTION_FIELD}: true`), 'with the field the host reads');

  // The user's own content, spot-checked by its most fragile parts.
  for (const needle of ['maxTokens: 16384', 'disabled: true', 'apiKeyEnv: NEWAPI_ASEIT_API_KEY', 'DeepSeek-V4.1-Flash', 'preference: zh']) {
    assert.ok(text.includes(needle), `${needle} must survive the edit`);
  }
  assert.ok(text.includes('# Your patch layer'), 'comments survive');
});

test('an existing tool-subagent row gains the field in place, and nothing else changes', () => {
  const document = `# my patch
- id: compaction-basic
  config:
    maxTokens: 16384
- id: tool-subagent
  config:
    provider: spawn
    toolName: subagent
- id: locale
  config:
    preference: zh
`;
  const result = planModelSelectionEdit(document);
  assert.equal(result.outcome, 'added-field');
  const text = result.text ?? '';

  assert.deepEqual(lostLines(document, text), [], 'no original line is lost');
  assert.ok(
    text.includes('    provider: spawn\n    toolName: subagent\n    modelSelection: true\n'),
    'the field is merged after the row\'s existing config keys'
  );
  // The order of the user's keys is preserved: a merge appends, it does not sort.
  assert.ok(text.indexOf('provider: spawn') < text.indexOf('toolName: subagent'));
  assert.equal(text.split(`- id: ${DELEGATION_ROW_ID}`).length, 2, 'no second row is added');
});

test('a row that already asks for it is left untouched', () => {
  const document = `- id: tool-subagent
  config:
    modelSelection: true
`;
  const result = planModelSelectionEdit(document);
  assert.equal(result.outcome, 'already-enabled');
  assert.equal(result.text, undefined, 'nothing to write');
});

test('an explicit false is flipped to true, keeping the comment beside it', () => {
  const document = `- id: tool-subagent
  config:
    provider: spawn
    modelSelection: false  # was off on purpose
`;
  const result = planModelSelectionEdit(document);
  assert.equal(result.outcome, 'added-field');
  assert.ok(result.text?.includes('modelSelection: true  # was off on purpose'), 'the trailing comment survives the flip');
});

test('a row with no config block gains one, without disturbing the row above or below', () => {
  const document = `- id: tool-subagent
  name: "@deepseek-ai/dsh-tool-subagent"
- id: locale
  config:
    preference: zh
`;
  const result = planModelSelectionEdit(document);
  assert.equal(result.outcome, 'added-field');
  const text = result.text ?? '';
  assert.deepEqual(lostLines(document, text), []);
  assert.ok(text.includes('  name: "@deepseek-ai/dsh-tool-subagent"\n  config:\n    modelSelection: true\n- id: locale'));
});

test('an indented document keeps its own indentation for the appended row', () => {
  const document = `  - id: compaction-basic
    config:
      maxTokens: 16384
`;
  const result = planModelSelectionEdit(document);
  assert.equal(result.outcome, 'added-row');
  assert.ok(result.text?.includes('\n  - id: tool-subagent\n    config:\n      modelSelection: true\n'), 'the row matches the 2-space style');
});

test('CRLF line endings are preserved', () => {
  const document = '- id: compaction-basic\r\n  config:\r\n    maxTokens: 16384\r\n';
  const result = planModelSelectionEdit(document);
  assert.equal(result.outcome, 'added-row');
  assert.ok(result.text?.includes('- id: tool-subagent\r\n  config:\r\n    modelSelection: true\r\n'), 'the new row uses CRLF too');
  assert.equal(lostLines(document, result.text ?? '').length, 0);
});

// ---------------------------------------------------------------------------
// Refusals: the cases where guessing would be worse than declining
// ---------------------------------------------------------------------------

test('a !!js expression does not block the edit, because nothing is ever parsed', () => {
  // This is the property the text editor buys: the expression is opaque text, so
  // it can neither be misread nor re-emitted in a different form.
  const result = planModelSelectionEdit(JS_PATCH);
  assert.equal(result.outcome, 'added-row');
  const text = result.text ?? '';
  assert.ok(
    text.includes('!!js ((() => { const tls = process.getBuiltinModule("node:tls"); return 16384; })())'),
    'the expression survives byte for byte'
  );
  assert.deepEqual(lostLines(JS_PATCH, text), []);
});

test('two top-level rows with the same id are refused, because precedence is the loader\'s call', () => {
  const document = `- id: tool-subagent
  config:
    provider: spawn
- id: tool-subagent
  config:
    provider: fork
`;
  const result = planModelSelectionEdit(document);
  assert.equal(result.outcome, 'refused-ambiguous-row');
  assert.equal(result.text, undefined);
  assert.match(String(result.reason), /top-level/);
});

test('a row that disables the entry is reported instead of enabled under it', () => {
  const document = `- id: tool-subagent
  disabled: true
  config:
    provider: spawn
`;
  const result = planModelSelectionEdit(document);
  assert.equal(result.outcome, 'already-disabled');
  assert.match(String(result.reason), /disabled/);
});

test('a value this editor does not interpret is refused rather than overwritten', () => {
  const document = `- id: tool-subagent
  config:
    modelSelection: "yes"
`;
  const result = planModelSelectionEdit(document);
  assert.equal(result.outcome, 'refused-unreadable-row');
  assert.equal(result.text, undefined, 'nothing is written for a refusal');
});

test('an inline config value is refused instead of being restated', () => {
  const document = `- id: tool-subagent
  config: { provider: spawn }
`;
  const result = planModelSelectionEdit(document);
  assert.equal(result.outcome, 'refused-unreadable-row');
  assert.match(String(result.reason), /inline/);
});

test('a nested row inside a group is never mistaken for the top-level one', () => {
  // The real base composes `tool-subagent` inside a `delegation` group; only a
  // top-level row is something this editor may touch.
  const document = `- id: delegation
  group: true
  config:
    - id: tool-subagent
      config:
        provider: spawn
`;
  const result = planModelSelectionEdit(document);
  assert.equal(result.outcome, 'added-row', 'the nested row does not count as the target');
  assert.ok(result.text?.includes(`- id: ${DELEGATION_ROW_ID}\n  config:\n    ${MODEL_SELECTION_FIELD}: true`));
});

test('a nested list item named like the field is not treated as the field', () => {
  const document = `- id: tool-subagent
  config:
    models:
      - modelSelection: notakey
`;
  const result = planModelSelectionEdit(document);
  assert.equal(result.outcome, 'added-field');
  assert.ok(result.text?.includes('      - modelSelection: notakey'), 'the list item is untouched');
  assert.ok(result.text?.includes('    modelSelection: true'), 'the real field is added at the config level');
});

// ---------------------------------------------------------------------------
// File I/O: atomic write, backup, and the outcomes the panel reports
// ---------------------------------------------------------------------------

test('writing the patch lands the field and leaves a backup of the original', () => {
  const { patch, cleanup } = scratch();
  try {
    mkdirSync(join(patch, '..'), { recursive: true });
    writeFileSync(patch, USER_PATCH, 'utf8');
    const result = enableHostModelSelection({ path: patch, now: () => Date.UTC(2026, 10, 7, 3, 4, 5) });

    assert.equal(result.outcome, 'added-row');
    assert.equal(result.path, patch);
    assert.ok(result.backupPath !== undefined && existsSync(result.backupPath), 'a backup is written before the edit');
    assert.equal(readFileSync(result.backupPath!, 'utf8'), USER_PATCH, 'the backup is the exact original');
    assert.deepEqual(lostLines(USER_PATCH, readFileSync(patch, 'utf8')), [], 'the edited file keeps the user content');
  } finally {
    cleanup();
  }
});

test('a missing patch file is created with only the row this plugin owns', () => {
  const { patch, cleanup } = scratch();
  try {
    const result = enableHostModelSelection({ path: patch });
    assert.equal(result.outcome, 'added-row');
    assert.equal(result.backupPath, undefined, 'there was no original to back up');
    const text = readFileSync(patch, 'utf8');
    assert.ok(text.includes(`- id: ${DELEGATION_ROW_ID}`));
    // The marker comment quotes the package name, so a person (and the panel's
    // revoke hint) can tell which row this plugin added.
    assert.ok(text.includes('dsh-harness-reflex'), 'the added row is attributable');
  } finally {
    cleanup();
  }
});

test('a second run reports already-enabled and writes nothing new', () => {
  const { patch, cleanup } = scratch();
  try {
    enableHostModelSelection({ path: patch });
    const before = readFileSync(patch, 'utf8');
    const backupsBefore = readdirSync(join(patch, '..')).filter((name) => name.includes('.bak-'));

    const second = enableHostModelSelection({ path: patch });
    assert.equal(second.outcome, 'already-enabled');
    assert.equal(readFileSync(patch, 'utf8'), before, 'the file is byte-identical');
    assert.equal(
      readdirSync(join(patch, '..')).filter((name) => name.includes('.bak-')).length,
      backupsBefore.length,
      'no second backup is taken for a run that changed nothing'
    );
  } finally {
    cleanup();
  }
});

test('an unwritable patch reports a write failure instead of throwing', () => {
  const { dir, patch, cleanup } = scratch();
  try {
    writeFileSync(patch, USER_PATCH, 'utf8');
    chmodSync(patch, 0o444);
    chmodSync(dir, 0o555);
    const result = enableHostModelSelection({ path: patch });
    // Running as root defeats the permission bits; when that happens the write
    // legitimately succeeds, so only assert the non-throwing contract.
    assert.ok(
      result.outcome === 'write-failed' || result.outcome === 'added-row',
      `unexpected outcome ${result.outcome}`
    );
    if (result.outcome === 'write-failed') assert.match(String(result.reason), /cannot write/);
  } finally {
    chmodSync(dir, 0o755);
    cleanup();
  }
});

test('a path that is not a regular file is refused without being touched', () => {
  const { dir, patch, cleanup } = scratch();
  try {
    mkdirSync(patch, { recursive: true });
    const result = enableHostModelSelection({ path: patch });
    assert.equal(result.outcome, 'write-failed');
    assert.match(String(result.reason), /not a regular file/);
    assert.ok(existsSync(patch), 'the directory is still there, untouched');
    assert.equal(readdirSync(patch).length, 0, 'nothing was written into it');
  } finally {
    cleanup();
  }
});

test('inspection reads the file rather than remembering what an activation wrote', () => {
  const { patch, cleanup } = scratch();
  try {
    writeFileSync(patch, USER_PATCH, 'utf8');
    assert.equal(inspectHostModelSelection({ path: patch }).enabled, false, 'the user file does not ask yet');

    enableHostModelSelection({ path: patch });
    assert.equal(inspectHostModelSelection({ path: patch }).enabled, true, 'after the edit it does');

    // A person removing the row by hand is visible immediately: this is what makes
    // the panel's switch follow the file instead of a stale memory.
    writeFileSync(patch, USER_PATCH, 'utf8');
    assert.equal(inspectHostModelSelection({ path: patch }).enabled, false, 'removing it by hand is honoured');
  } finally {
    cleanup();
  }
});

test('the edit resolves its path from the environment when none is given', () => {
  const { dir, patch, cleanup } = scratch();
  try {
    const result = enableHostModelSelection({ env: { DSH_PROFILE_DIR: dir }, now: () => 0 });
    assert.equal(result.path, patch);
    assert.equal(result.source, 'DSH_PROFILE_DIR');
    assert.ok(existsSync(patch));
  } finally {
    cleanup();
  }
});

test('a marker comment is added at most once', () => {
  const { patch, cleanup } = scratch();
  try {
    enableHostModelSelection({ path: patch });
    const once = readFileSync(patch, 'utf8');
    // Removing the row but keeping the rest of the file: the next run must not
    // stack a second marker comment on top of the first.
    const withoutRow = once.split('\n').filter((line) => !line.includes(DELEGATION_ROW_ID) && !line.includes('modelSelection: true') && !line.trim().startsWith('config:')).join('\n');
    writeFileSync(patch, `${withoutRow}\n`, 'utf8');
    enableHostModelSelection({ path: patch });
    assert.equal((readFileSync(patch, 'utf8').match(/# Added by dsh-harness-reflex/g) ?? []).length, 1);
  } finally {
    cleanup();
  }
});
