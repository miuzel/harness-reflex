import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The one file this plugin is allowed to edit outside its own settings section:
 * the DSH **profile patch layer** (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`,
 * which the Host reports as `profileContext.patchPath`).
 *
 * The edit is deliberately a **line-level text edit**, never a parse-and-dump of
 * the document. That is a safety property, not a shortcut:
 *
 * - the file belongs to the user and may carry `!!js` expressions, comments,
 *   anchors, and rows this plugin knows nothing about. A generic YAML round trip
 *   would re-emit them at best differently and at worst as inert strings — the
 *   Host parses this file with its own dialect, in which `!!js` is *code*. Text
 *   that is never interpreted cannot be changed by being written back;
 * - the only thing this module needs to know is *where* the `tool-subagent` row
 *   is in the text, which is a question about a line's leading indent and its
 *   `id:` key, answerable without a grammar;
 * - when a line-level edit cannot be placed with certainty, the module declines
 *   and says why. Refusing to guess is the whole design: nothing it cannot read
 *   exactly is ever rewritten.
 *
 * Path resolution, file I/O, and the clock are injected, so the tests drive it
 * against a scratch directory and never touch the user's home.
 *
 * @module dsh-reflex/host-patch
 */

/** Environment variables the patch path is resolved from, in order of authority. */
export const PROFILE_DIR_ENV = 'DSH_PROFILE_DIR';
/** Harness home variable, used when the profile directory was not exported. */
export const DSH_HOME_ENV = 'DSH_HOME';
/** Patch file basename inside a profile directory. */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml';
/** Profile name variable, used when neither directory nor home is exported. */
export const DSH_PROFILE_ENV = 'DSH_PROFILE';
/** Default profile name, matching the Host's own default. */
export const DEFAULT_PROFILE = 'web';

/**
 * The row this module edits, spelled the way the Host spells it.
 *
 * `id` is the loader entry id the Host mounts the delegation tool under. The
 * package `name:` is deliberately not matched: a patch that re-points the row at
 * another build is still the same entry as far as the loader is concerned.
 */
export const DELEGATION_ROW_ID = 'tool-subagent';
/** The Host field that publishes `reasoning_effort` on the delegation tool. */
export const MODEL_SELECTION_FIELD = 'modelSelection';

/** The marker comment the added row carries, naming the plugin that added it. */
export const OWNERSHIP_MARKER = 'dsh-harness-reflex';

/**
 * How a patch file was resolved for this Host.
 *
 * `source` says which fact produced the path, so the panel can explain — and so
 * a test can prove nothing fell back to a guessed location silently.
 */
export interface PatchPathResolution {
  /** Absolute path the plugin would edit, when one could be resolved. */
  path?: string;
  /** Which fact resolved it, or why it did not. */
  source: typeof PROFILE_DIR_ENV | typeof DSH_HOME_ENV | typeof DSH_PROFILE_ENV | 'default-profile' | 'explicit' | 'unresolved';
  /** Why the path is not authoritative, when it is not. */
  reason?: string;
}

/**
 * Resolve the profile patch file this Host boots from.
 *
 * The profile directory exported to shell tools is the authoritative answer (the
 * Host computes it from the profile it actually loaded); the remaining sources
 * reconstruct it for a Host that did not export it. The last one — the
 * conventional location under the user's home — is a *guess*, which is why
 * {@link PatchPathResolution.source} names it and {@link PatchPathResolution.reason}
 * says so; a caller must not present it as a fact the Host confirmed.
 * @param env - environment to read; defaults to `process.env`.
 * @param home - user home, used only when nothing else is exported.
 * @returns the resolution, with `path` absent when nothing could be resolved.
 */
export function resolveProfilePatchPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): PatchPathResolution {
  const text = (name: string): string | undefined => {
    const value = env[name];
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  // 1. The profile directory the Host actually loaded, as it exports it.
  const profileDir = text(PROFILE_DIR_ENV);
  if (profileDir !== undefined) {
    return { path: join(profileDir, PROFILE_PATCH_FILENAME), source: PROFILE_DIR_ENV };
  }

  // 2. Harness home (exported) reconstructs the directory exactly.
  const dshHome = text(DSH_HOME_ENV);
  const profile = text(DSH_PROFILE_ENV);
  if (dshHome !== undefined) {
    return {
      path: join(dshHome, 'profiles', profile ?? DEFAULT_PROFILE, PROFILE_PATCH_FILENAME),
      source: profile === undefined ? 'default-profile' : DSH_HOME_ENV
    };
  }

  // 3. Nothing exported: the conventional `<home>/.dsh` location, reported as a
  //    guess so no caller can present it as a confirmed fact.
  if (home.trim().length > 0) {
    return {
      path: join(home, '.dsh', 'profiles', profile ?? DEFAULT_PROFILE, PROFILE_PATCH_FILENAME),
      source: 'default-profile',
      reason: `neither ${PROFILE_DIR_ENV} nor ${DSH_HOME_ENV} is set; assuming the profile location under the user home`
    };
  }
  return { source: 'unresolved', reason: `neither ${PROFILE_DIR_ENV} nor ${DSH_HOME_ENV} is set, and no home directory is known` };
}

/** What {@link planModelSelectionEdit} decided, and the document it produced. */
export interface PatchEditResult {
  /**
   * - `already-enabled`: the row already asks for the field; nothing to write;
   * - `added-field`: a top-level field was merged into the existing row;
   * - `added-field-after-name`: merged into the row's `name:`-only form (the
   *   field must follow `name:` because that row has no `config:` block yet);
   * - `added-row`: the file had no such row, so one was appended;
   * - the `refused-*` outcomes changed nothing and carry a reason.
   */
  outcome:
    | 'already-enabled'
    | 'added-field'
    | 'added-field-after-name'
    | 'added-row'
    | 'already-disabled'
    | 'refused-not-a-sequence'
    | 'refused-ambiguous-row'
    | 'refused-unreadable-row';
  /** The rewritten document, present only for the additive outcomes. */
  text?: string;
  /** Single-line reason, for the outcomes that changed nothing. */
  reason?: string;
}

/** One line of a patch document, remembering its exact bytes and line ending. */
interface Line {
  /** Content without the line ending. */
  readonly text: string;
  /** The line ending as it appeared (`\n`, `\r\n`, or `''` for a last unterminated line). */
  readonly eol: string;
}

/** Split a document into lines, preserving each line's own ending. */
function splitLines(document: string): Line[] {
  const lines: Line[] = [];
  const pattern = /([^\r\n]*)(\r\n|\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(document)) !== null) {
    const content = match[1] ?? '';
    const eol = match[2] ?? '';
    // The regex matches an empty tail once a document ends with a newline; drop
    // that phantom line so the join reproduces the original byte for byte.
    if (content.length === 0 && eol.length === 0 && lines.length > 0) break;
    lines.push({ text: content, eol });
    if (document.length === 0) break;
  }
  return lines;
}

/** Join lines back, preserving every line's ending and the final one's. */
function joinLines(lines: readonly Line[]): string {
  return lines.map((line) => `${line.text}${line.eol}`).join('');
}

/** Read the indentation of one line as whitespace, or `undefined` when it starts with a non-space. */
function leadingWhitespace(line: string): string | undefined {
  const match = /^[ \t]*/.exec(line);
  return match?.[0];
}

/** Whether one line is a YAML sequence entry (`- …`) at some indent. */
function sequenceEntryOf(line: string): { indent: string; rest: string } | undefined {
  const indent = leadingWhitespace(line);
  if (indent === undefined) return undefined;
  const rest = line.slice(indent.length);
  if (!rest.startsWith('- ')) return undefined;
  return { indent, rest: rest.slice(2) };
}

/**
 * Read a scalar value written on one line, for the few keys this module reads.
 *
 * Only plain, single-line scalars are accepted — an `id: subagent` written in
 * flow style or with a tag is *not* something this module will claim to
 * understand, and every such line yields `undefined`, which the caller turns
 * into a refusal rather than a guess.
 * @param line - the text after `- ` or after the key indent.
 * @param key - the key to read.
 * @returns the trimmed scalar, or `undefined` when the line does not carry a plain value for it.
 */
function plainScalar(line: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:[ \\t]+([^\\s#'"\\[\\]{},&*!|>%@\`]+)[ \\t]*(?:#.*)?$`).exec(line);
  return match?.[1];
}

/** Whether one line ends a scalar with a block indicator this module refuses to interpret. */
function isBlockScalarLine(line: string): boolean {
  return /^[^#]*:[ \t]*[|>][+-]?[ \t]*(?:#.*)?$/.test(line);
}

/**
 * Locate the top-level `tool-subagent` rows in one document.
 *
 * A top-level row is a sequence entry indented less than every other sequence
 * entry; rows nested under `insert:`/`config:` belong to a group and are never
 * edited here. Everything this function cannot read exactly is reported, not
 * coerced.
 * @param lines - the document's lines.
 * @returns the row spans, or a refusal with its reason.
 */
function locateRows(lines: readonly Line[]): { spans: Array<{ start: number; end: number }> } | { refusal: PatchEditResult } {
  const entries: Array<{ index: number; indent: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const entry = sequenceEntryOf(lines[index]!.text);
    if (entry !== undefined) entries.push({ index, indent: entry.indent });
  }
  if (entries.length === 0) return { spans: [] };

  // The top level is the minimum indent of a sequence entry; ties are the same
  // level. A document mixing several indents is legal YAML (a group's children
  // are deeper), and this rule is what distinguishes them without a parser.
  const topIndent = entries.reduce((min, entry) => (entry.indent.length < min.length ? entry.indent : min), entries[0]!.indent);
  const topEntries = entries.filter((entry) => entry.indent === topIndent);

  const spans: Array<{ start: number; end: number }> = [];
  for (let position = 0; position < topEntries.length; position += 1) {
    const start = topEntries[position]!.index;
    const nextStart = topEntries[position + 1]?.index ?? lines.length;
    const first = sequenceEntryOf(lines[start]!.text)!;
    // The row's own keys begin after `- `; they may sit on the same line
    // (`- id: x`) or on following lines indented under the dash.
    const idOnDashLine = plainScalar(first.rest, 'id');
    let id = idOnDashLine;
    if (id === undefined && /^id:[ \t]*$/.test(first.rest)) {
      // `- id:` on its own line is a block value this module does not read.
      return { refusal: { outcome: 'refused-unreadable-row', reason: 'a top-level row writes its id as a block value, which this edit does not interpret' } };
    }
    if (id === undefined) {
      // The id may be the first key on its own line under the dash.
      const keyIndent = `${first.indent}  `;
      for (let scan = start + 1; scan < nextStart; scan += 1) {
        const line = lines[scan]!;
        if (leadingWhitespace(line.text) !== keyIndent) break;
        const keyText = line.text.slice(keyIndent.length);
        if (keyText.startsWith('id:')) {
          id = plainScalar(keyText, 'id');
          break;
        }
      }
    }
    if (id === DELEGATION_ROW_ID) spans.push({ start, end: nextStart });
  }
  return { spans };
}

/**
 * Find the document's own row-key indentation.
 *
 * Used only when a row is appended: a four-space user file must not grow a
 * two-space tail.
 * @param lines - the document's lines.
 * @returns the indent prefix for a new top-level `- ` entry, or `'  '` for an empty shape.
 */
function detectRowIndent(lines: readonly Line[]): { indent: string; eol: string } {
  for (const line of lines) {
    const entry = sequenceEntryOf(line.text);
    if (entry !== undefined) {
      const eol = lines.find((candidate) => candidate.eol.length > 0)?.eol ?? '\n';
      return { indent: entry.indent, eol };
    }
  }
  const eol = lines.find((candidate) => candidate.eol.length > 0)?.eol ?? '\n';
  return { indent: '  ', eol };
}

/**
 * Plan the one edit this plugin makes to the user's patch.
 *
 * Pure: it returns the exact text to write, or the reason it will not write.
 * Every user byte outside the edited row's span is carried through untouched,
 * including comments, ordering, blank lines, `!!js` expressions, and line endings.
 * @param document - the current patch text (`''` when the file does not exist).
 * @returns the decision and, for the additive outcomes, the rewritten document.
 */
export function planModelSelectionEdit(document: string): PatchEditResult {
  const lines = splitLines(document);
  const located = locateRows(lines);
  if ('refusal' in located) return located.refusal;

  if (located.spans.length === 0) {
    // No such row: append one, in the document's own style. The existing text is
    // kept verbatim; only a trailing newline is normalised so the new row starts
    // on its own line.
    const { indent, eol } = detectRowIndent(lines);
    const body = joinLines(lines).replace(/[\s]+$/, '');
    const child = `${indent}  `;
    const added = [
      ...(document.includes(OWNERSHIP_MARKER)
        ? []
        : [
            `# Added by ${OWNERSHIP_MARKER}: the delegation tool publishes reasoning_effort only with modelSelection on.`,
            '# Remove this row (or this field) to revoke it; the Reflex settings switch shows the change next time.'
          ]),
      `${indent}- id: ${DELEGATION_ROW_ID}`,
      `${child}config:`,
      `${child}  ${MODEL_SELECTION_FIELD}: true`
    ].join(eol);
    return { outcome: 'added-row', text: body.length === 0 ? `${added}${eol}` : `${body}${eol}${added}${eol}` };
  }

  // One row is the shape the Host writes and the shape every deployment uses.
  // Several top-level rows with this id would need the loader's own precedence
  // rules to know which one wins; this module does not reimplement those.
  if (located.spans.length > 1) {
    return {
      outcome: 'refused-ambiguous-row',
      reason: `the profile patch has ${String(located.spans.length)} top-level "${DELEGATION_ROW_ID}" rows, so which one wins is the loader's call; add ${MODEL_SELECTION_FIELD}: true to the one you mean by hand`
    };
  }

  const span = located.spans[0]!;
  const first = sequenceEntryOf(lines[span.start]!.text)!;
  const keyIndent = `${first.indent}  `;

  // Walk the row's own key block: lines indented exactly at the key level, up to
  // the first line indented less. Deeper lines are a nested block (a `config:`
  // body, a list) and are never touched.
  let configLine = -1;
  let modelSelectionLine = -1;
  /** Indent the `modelSelection` field was found at (it may sit inside `config:`). */
  let modelSelectionIndent = '';
  let nameLine = -1;
  let disabled = false;
  let sawBlockStructuredValue = false;
  let lastKeyLine = span.start;

  const inspect = (lineIndex: number, keyText: string): void => {
    if (isBlockScalarLine(keyText)) sawBlockStructuredValue = true;
    const key = /^([A-Za-z_][\w-]*):/.exec(keyText)?.[1];
    if (key === undefined) return;
    lastKeyLine = lineIndex;
    if (key === 'config') configLine = lineIndex;
    if (key === 'name') nameLine = lineIndex;
    if (key === 'disabled') disabled = /^disabled:[ \t]+true[ \t]*(?:#.*)?$/.test(keyText);
  };

  // The dash line's own key, when the row is written as `- id: tool-subagent`.
  inspect(span.start, first.rest);
  /**
   * Indent of the `config:` block's own keys, once that block starts.
   *
   * A row's keys sit at `keyIndent`; the fields *inside* `config:` sit one level
   * deeper, and that is where `modelSelection` would already live. Tracking the
   * block separately is what lets the scan see it without walking a general
   * nested structure — the only nested block this edit ever reads.
   */
  let configChildIndent: string | undefined;
  for (let index = span.start + 1; index < span.end; index += 1) {
    const line = lines[index]!;
    if (line.text.trim().length === 0) continue;
    if (line.text.trimStart().startsWith('#')) continue;
    const indent = leadingWhitespace(line.text) ?? '';
    const keyText = line.text.slice(indent.length);

    if (indent === keyIndent) {
      // Back at the row's own level: this ends any `config:` child block.
      configChildIndent = undefined;
      if (keyText.startsWith(MODEL_SELECTION_FIELD)) {
        modelSelectionLine = index;
        modelSelectionIndent = indent;
      }
      inspect(index, keyText);
      if (configLine === index) configChildIndent = 'unknown';
      continue;
    }

    if (indent.length > keyIndent.length) {
      // Inside a nested block. Fields are read only while we are inside the
      // row's own `config:` block; anything else (a list, a deeper map) is left
      // alone, which is why a list item never looks like a config field.
      if (configLine >= 0 && configChildIndent === 'unknown' && !keyText.startsWith('- ')) {
        configChildIndent = indent;
      }
      if (configLine >= 0 && configChildIndent === indent && keyText.startsWith(MODEL_SELECTION_FIELD)) {
        modelSelectionLine = index;
        modelSelectionIndent = indent;
      }
      if (isBlockScalarLine(keyText)) sawBlockStructuredValue = true;
      continue;
    }

    // Shallower than the row's own keys: the row has ended.
    break;
  }

  if (disabled) {
    return {
      outcome: 'already-disabled',
      reason: `the profile patch disables ${DELEGATION_ROW_ID} (disabled: true), so enabling model selection would not make the tool appear`
    };
  }

  if (modelSelectionLine >= 0) {
    const fieldLine = lines[modelSelectionLine]!;
    const current = plainScalar(fieldLine.text.slice(modelSelectionIndent.length), MODEL_SELECTION_FIELD);
    if (current === 'true') return { outcome: 'already-enabled' };
    if (current === 'false') {
      // An explicit `false` is a decision the user wrote down, but it is the one
      // value this switch exists to flip, and it is the value the goal names:
      // ticking the consent box writes `true`. Replacing just that token keeps
      // the comment beside it and every other byte of the line.
      const replaced = fieldLine.text.replace(
        new RegExp(`(^[ \\t]*${MODEL_SELECTION_FIELD}:[ \\t]+)false([ \\t]*(?:#.*)?)$`),
        `$1true$2`
      );
      const next = [...lines];
      next[modelSelectionLine] = { text: replaced, eol: fieldLine.eol };
      return { outcome: 'added-field', text: joinLines(next) };
    }
    return {
      outcome: 'refused-unreadable-row',
      reason: `${MODEL_SELECTION_FIELD} is written with a value this edit does not interpret (${fieldLine.text.trim()}); set it to true by hand`
    };
  }

  // A `config:` key with a value on its own line cannot be extended without
  // rewriting it, and doing that would restate the user's block as this
  // module's formatting.
  if (configLine >= 0) {
    const configKeyText = lines[configLine]!.text.slice(keyIndent.length);
    if (!/^config:[ \t]*(?:#.*)?$/.test(configKeyText)) {
      return {
        outcome: 'refused-unreadable-row',
        reason: 'the row writes config as an inline value, which this edit will not rewrite'
      };
    }
    // Merge a new key into the existing block, after its last key line.
    let insertAfter = configLine;
    for (let index = configLine + 1; index < span.end; index += 1) {
      const line = lines[index]!;
      if (line.text.trim().length === 0) continue;
      const indent = leadingWhitespace(line.text) ?? '';
      if (indent.length <= keyIndent.length) break;
      insertAfter = index;
    }
    const next = [...lines];
    const eol = lines[insertAfter]!.eol || lines.find((candidate) => candidate.eol.length > 0)?.eol || '\n';
    next.splice(insertAfter + 1, 0, { text: `${keyIndent}  ${MODEL_SELECTION_FIELD}: true`, eol });
    if (next[insertAfter]!.eol.length === 0) next[insertAfter] = { text: next[insertAfter]!.text, eol };
    return { outcome: 'added-field', text: joinLines(next) };
  }

  if (sawBlockStructuredValue) {
    return {
      outcome: 'refused-unreadable-row',
      reason: 'the row has a block-scalar value, which this edit does not interpret'
    };
  }

  // The row has no config block: add one after its last top-level key. When the
  // row was written `- name: …` (no id key of its own), `name:` has to stay the
  // first key of the dash line, so the field follows it.
  const insertAfter = lastKeyLine;
  const next = [...lines];
  const eol = lines[insertAfter]!.eol || lines.find((candidate) => candidate.eol.length > 0)?.eol || '\n';
  if (next[insertAfter]!.eol.length === 0) next[insertAfter] = { text: next[insertAfter]!.text, eol };
  next.splice(insertAfter + 1, 0, { text: `${keyIndent}config:`, eol }, { text: `${keyIndent}  ${MODEL_SELECTION_FIELD}: true`, eol });
  const outcome = nameLine === span.start && modelSelectionLine < 0 && configLine < 0 && !first.rest.startsWith('id:')
    ? 'added-field-after-name'
    : 'added-field';
  return { outcome, text: joinLines(next) };
}

/** What one attempted edit did, as the panel reports it. */
export type HostPatchOutcome = PatchEditResult['outcome'] | 'unresolved' | 'write-failed';

/** Result of {@link enableHostModelSelection}. */
export interface HostPatchResult {
  /** What happened. */
  outcome: HostPatchOutcome;
  /** Absolute path considered, when one was resolved. */
  path?: string;
  /** Which fact resolved that path. */
  source?: PatchPathResolution['source'];
  /** Single-line reason for the outcomes that changed nothing. */
  reason?: string;
  /** Byte size of the document before the edit (diagnostics). */
  previousBytes?: number;
  /** Backup file written before the edit, when one was. */
  backupPath?: string;
}

/** Seams one edit needs; all defaulted in production, all injected in tests. */
export interface HostPatchOptions {
  /** Absolute patch path; omit to resolve it from the environment. */
  readonly path?: string;
  /** Environment the path is resolved from when `path` is omitted. */
  readonly env?: Record<string, string | undefined>;
  /** User home used by the fallback resolution; defaults to the real one. */
  readonly home?: string;
  /** Clock, for the backup filename. */
  readonly now?: () => number;
}

/** Resolve the path and how it was found, for the options a caller passed. */
function resolveFor(options: HostPatchOptions): PatchPathResolution {
  if (options.path !== undefined) return { path: options.path, source: 'explicit' };
  return resolveProfilePatchPath(options.env ?? process.env, options.home);
}

/**
 * Turn `modelSelection` on for the delegation tool in the user's profile patch.
 *
 * The only write this plugin makes outside its own settings section. Each
 * outcome is distinguishable and the function never throws: a patch it cannot
 * edit exactly reports why, and the caller shows that reason rather than
 * pretending the switch is effective.
 * @param options - the path (or the environment it is resolved from) and a clock.
 * @returns what happened, and where.
 */
export function enableHostModelSelection(options: HostPatchOptions = {}): HostPatchResult {
  const now = options.now ?? (() => Date.now());
  const resolution = resolveFor(options);
  const path = resolution.path;
  if (path === undefined) {
    return { outcome: 'unresolved', source: resolution.source, ...(resolution.reason === undefined ? {} : { reason: resolution.reason }) };
  }

  // The file may be a dangling link or a directory: refusing keeps the backup
  // and the atomic rename from acting on something that is not a file.
  if (existsSync(path) && !statSync(path).isFile()) {
    return { outcome: 'write-failed', path, source: resolution.source, reason: `${path} exists but is not a regular file` };
  }

  let document = '';
  try {
    document = existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch (error) {
    return { outcome: 'write-failed', path, source: resolution.source, reason: `cannot read ${path}: ${firstLine(error)}` };
  }

  const planned = planModelSelectionEdit(document);
  if (planned.text === undefined) {
    return {
      outcome: planned.outcome,
      path,
      source: resolution.source,
      ...(planned.reason === undefined ? {} : { reason: planned.reason })
    };
  }

  const backupPath = `${path}.bak-dsh-reflex-${timestamp(now())}`;
  try {
    if (existsSync(path)) {
      copyFileSync(path, backupPath);
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
    // Write beside the target and rename: a crash mid-write leaves the user's
    // patch exactly as it was rather than half a document.
    const staging = join(dirname(path), `.${basename(path)}.dsh-reflex-${String(process.pid)}-${String(now())}.tmp`);
    writeFileSync(staging, planned.text, 'utf8');
    renameSync(staging, path);
  } catch (error) {
    return { outcome: 'write-failed', path, source: resolution.source, reason: `cannot write ${path}: ${firstLine(error)}` };
  }

  return {
    outcome: planned.outcome,
    path,
    source: resolution.source,
    previousBytes: Buffer.byteLength(document, 'utf8'),
    ...(existsSync(backupPath) ? { backupPath } : {})
  };
}

/**
 * Read, without writing, whether the profile patch asks for the field.
 *
 * The panel calls this so its switch reflects the *file* rather than a memory of
 * what this activation wrote: a user who removes the field by hand sees the
 * switch fall back to "off" instead of being told a stale "on".
 * @param options - the path (or the environment it is resolved from).
 * @returns the current state, with the reason when it cannot be read.
 */
export function inspectHostModelSelection(options: HostPatchOptions = {}): {
  path?: string;
  source?: PatchPathResolution['source'];
  enabled: boolean;
  /** Why the state cannot be read, when it cannot. */
  reason?: string;
} {
  const resolution = resolveFor(options);
  if (resolution.path === undefined) {
    return { enabled: false, source: resolution.source, ...(resolution.reason === undefined ? {} : { reason: resolution.reason }) };
  }
  let document: string;
  try {
    if (!existsSync(resolution.path)) {
      return { path: resolution.path, source: resolution.source, enabled: false };
    }
    document = readFileSync(resolution.path, 'utf8');
  } catch (error) {
    return { path: resolution.path, source: resolution.source, enabled: false, reason: firstLine(error) };
  }
  const plan = planModelSelectionEdit(document);
  return {
    path: resolution.path,
    source: resolution.source,
    enabled: plan.outcome === 'already-enabled'
  };
}

/** First line of a caught value, for a one-line reason. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n', 1)[0]?.slice(0, 160) || 'unknown error';
}

/** `YYYYMMDD-HHmmss` for a backup suffix, in local time. */
function timestamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
