import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * Rules-of-Hooks fence for the settings client.
 *
 * `src/client/view.ts` builds its tree with `h()`, and it also calls small
 * presentational helpers directly (`Button({...})`) — which is fine only while
 * those helpers hold no state. A helper that *does* call a hook must be rendered
 * as an element (`h(Helper, {...})`), because calling it inline grafts its hook
 * onto the caller's sequence. React then counts a different number of hooks
 * between two renders and throws minified error #310 — a failure the local test
 * runtime cannot see, since it services hooks through a disposable slot cursor
 * rather than a committed fiber.
 *
 * That is exactly how g-059 shipped a crashing settings page: `FoldedCard` owns
 * a `useState` and `BackendTab` invoked it as a plain function. This test reads
 * the source, so it fails in the same commit that introduces the mistake rather
 * than in the browser.
 */

// The client sources are not emitted to `dist/client` (the client ships as a
/// bundled `client.js`), so the scan reads the TypeScript next to this package.
const CLIENT_DIR = new URL('../src/client/', import.meta.url);

/** The React hooks whose presence makes a component stateful. */
const HOOK_CALL = /\buse(?:State|Effect|Memo|Callback|Ref|SyncExternalStore|LayoutEffect)\s*\(/;

/** A top-level component declaration: `function Name(`. */
const DECLARATION = /^function ([A-Z][A-Za-z0-9_]*)\s*\(/gm;

interface Component {
  /** Source file name, e.g. `view.ts`. */
  file: string;
  /** Declared name, e.g. `FoldedCard`. */
  name: string;
  /** Whether the body calls a hook directly. */
  hooky: boolean;
}

/** Every `function Name(` in one source, with the braces of its body. */
function declarations(file: string, source: string): Component[] {
  const found: Component[] = [];
  DECLARATION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DECLARATION.exec(source)) !== null) {
    const name = match[1]!;
    // The body brace is the first `{` *after the parameter list closes* — a
    // destructured or annotated parameter list contains braces of its own, and
    // taking the first one would slice the body off at the type literal.
    const open = source.indexOf('(', match.index);
    let parens = 0;
    let close = -1;
    for (let index = open; index < source.length; index += 1) {
      const char = source[index];
      if (char === '(') parens += 1;
      else if (char === ')') {
        parens -= 1;
        if (parens === 0) {
          close = index;
          break;
        }
      }
    }
    if (close === -1) continue;
    const brace = source.indexOf('{', close);
    if (brace === -1) continue;
    let depth = 0;
    let end = brace;
    for (let index = brace; index < source.length; index += 1) {
      const char = source[index];
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    found.push({ file, name, hooky: HOOK_CALL.test(source.slice(match.index, end)) });
  }
  return found;
}

/** The client sources, read from disk so the check covers what ships. */
function sources(): { file: string; source: string }[] {
  const dir = CLIENT_DIR;
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((file) => ({ file, source: readFileSync(join(dir.pathname, file), 'utf8') }));
}

test('the scan finds the hook-carrying components it is supposed to police', () => {
  // A guard on the guard: if `declarations` or `HOOK_CALL` rots, every other
  // assertion here becomes vacuously true and the fence silently disappears.
  const all = sources().flatMap(({ file, source }) => declarations(file, source));
  const hooky = all.filter((component) => component.hooky).map((component) => component.name);
  assert.ok(all.length > 20, `expected the client to declare many components, saw ${all.length}`);
  assert.ok(
    hooky.includes('Field'),
    `the scan missed a known stateful component; it found ${hooky.join(', ') || 'none'}`
  );
});

test('no stateful component is invoked as a plain function call', () => {
  const all = sources();
  const components = all.flatMap(({ file, source }) => declarations(file, source));
  const hooky = components.filter((component) => component.hooky);
  const offenders: string[] = [];
  for (const component of hooky) {
    // Every *other* file may still reference it, so search the whole client.
    for (const { file, source } of all) {
      const pattern = new RegExp(`(^|[^A-Za-z0-9_.$])${component.name}\\s*\\(`, 'g');
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        // Skip the declaration itself (`function FoldedCard(`).
        const head = source.slice(0, match.index);
        if (/\bfunction\s*$/.test(head)) continue;
        // `h(FoldedCard, ...)` — including a line break after the paren — is the
        // correct form; anything else calls the component as a plain function.
        if (/h\s*\(\s*$/.test(head)) continue;
        const line = head.split('\n').length;
        offenders.push(`${component.file}:${component.name} called as a function at ${file}:${line}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `stateful components must be rendered as elements:\n${offenders.join('\n')}`);
});

test('the stateful helper is rendered through h, and the fold helper carries no state', () => {
  const view = sources().find(({ file }) => file === 'view.ts');
  assert.ok(view !== undefined, 'view.ts is missing');
  // `Field` opens its own help disclosure, so it must be an element.
  assert.equal(/\bh\s*\(\s*Field\s*,/.test(view.source), true, 'Field must be created with h(Field, {...})');
  // `FoldedCard` is called inline, which is only sound while it stays stateless:
  // its open flag is hoisted into `BackendTab`. If state ever returns here, the
  // scan above starts failing — keep the two facts in step.
  const foldCard = view.source.slice(view.source.indexOf('function FoldedCard'), view.source.indexOf('function Button'));
  assert.equal(HOOK_CALL.test(foldCard), false, 'FoldedCard became stateful; it must be rendered with h(...) again');
  assert.equal(/\bopen:\s*boolean/.test(foldCard), true, 'FoldedCard no longer takes its open flag as a prop');
  assert.equal(/\bonToggle:\s*\(\)\s*=>\s*void/.test(foldCard), true, 'FoldedCard no longer takes an onToggle prop');
});
