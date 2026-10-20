/**
 * The in-panel user guide: document, embedding, artifact and renderer.
 *
 * The settings panel shows the repository's `USER_GUIDE.md` /
 * `docs/USER_GUIDE.en.md` inside a fully self-contained `client.js`. Three
 * things can therefore rot silently, and each one gets its own guard here:
 *
 * 1. the generated module drifting from the documents it claims to embed;
 * 2. the committed browser artifact missing (or lagging) the guide, so the
 *    panel a user opens would show a different revision than the tarball;
 * 3. the documents drifting apart in structure, or carrying Markdown the panel
 *    renderer cannot represent — a table with a ragged row would render as
 *    garbage in the settings page while plain Markdown still looked fine.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * The checkout that owns the guide documents.
 *
 * Found by marker rather than by counting `..`: the negative-control harness runs
 * a copy of this package from `tmp/mutation/`, where a fixed relative path would
 * point at a directory that has no documents and the whole suite would go red for
 * the wrong reason.
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let level = 0; level < 8; level += 1) {
    if (existsSync(join(dir, 'USER_GUIDE.md')) && existsSync(join(dir, 'docs', 'USER_GUIDE.en.md'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('no checkout holding USER_GUIDE.md and docs/USER_GUIDE.en.md was found above this build');
}

const repoRoot = findRepoRoot();
const packageDir = fileURLToPath(new URL('..', import.meta.url));

/** Where the documents and their build products live. */
const PATHS = {
  generated: join(repoRoot, 'packages', 'dsh-reflex', 'src', 'client', 'guide.generated.ts'),
  clientArtifact: join(packageDir, 'client.js'),
  clientOut: join(packageDir, 'dist-client'),
  zh: join(repoRoot, 'USER_GUIDE.md'),
  en: join(repoRoot, 'docs', 'USER_GUIDE.en.md')
} as const;

/** sha256 of a file's exact bytes. */
function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path, 'utf8'), 'utf8').digest('hex');
}

/** Parse the `export const NAME = <json literal> as const;` value of the generated module. */
function generated<T>(name: string): T {
  const source = readFileSync(PATHS.generated, 'utf8');
  const match = new RegExp(`export const ${name} = (\\{[\\s\\S]*?\\}|\\[[\\s\\S]*?\\]) as const;`).exec(source);
  assert.ok(match !== null, `the generated module has no ${name}`);
  return JSON.parse(match[1] as string) as T;
}

/** Every heading number the document's `## n.` sections carry. */
function sectionNumbers(document: string): number[] {
  return [...document.matchAll(/^## (\d+)\.\s/gm)].map((match) => Number(match[1]));
}

//#region the document and its embedding

test('the embedded guide is the repository document, byte for byte', () => {
  const sources = generated<Record<string, string>>('GUIDE_SOURCES');
  const digests = generated<Record<string, string>>('GUIDE_DIGESTS');
  assert.deepEqual(sources, { zh: 'USER_GUIDE.md', en: join('docs', 'USER_GUIDE.en.md') });
  assert.deepEqual(
    digests,
    { zh: digest(PATHS.zh), en: digest(PATHS.en) },
    'guide.generated.ts is stale — run node scripts/embed-user-guide.mjs (npm run build:all)'
  );
  assert.deepEqual(generated<string[]>('GUIDE_LANGUAGES'), ['zh', 'en']);
});

test('both guide revisions document the same twelve sections', () => {
  const zh = readFileSync(PATHS.zh, 'utf8');
  const en = readFileSync(PATHS.en, 'utf8');
  const numbers = Array.from({ length: 12 }, (_, index) => index + 1);
  assert.deepEqual(sectionNumbers(zh), numbers, 'the Chinese guide lost or reordered a section');
  assert.deepEqual(sectionNumbers(en), numbers, 'the English guide lost or reordered a section');

  // Surface facts a reader is told the guide covers; a revision that drops one
  // of them is incomplete no matter how many headings survive.
  const required = [
    'npm run build:all',
    'dsh plugin add',
    'settings.section',
    'client.js',
    'USER_GUIDE.md',
    'SYSTEM_ONE_BACKEND',
    'virtualProvider',
    'reasoningEffort',
    'reflex-auto',
    'reflex_choice',
    'reflex_score',
    'reflex_screen',
    'reflex_gate',
    'reflex_prune',
    'reflex_detect_stagnation',
    'reflex_route',
    'reflex_status_ledger'
  ];
  for (const document of [zh, en]) {
    for (const token of required) {
      assert.ok(document.includes(token), `the guide does not mention "${token}"`);
    }
    assert.ok(document.includes('|'), 'the guide carries no comparison table');
  }
  assert.match(zh, /\p{Script=Han}/u, 'the Chinese guide carries no Chinese text');
});

//#endregion

//#region the committed artifact

test('the committed client artifact carries both guide languages and their revisions', () => {
  const artifact = readFileSync(PATHS.clientArtifact, 'utf8');
  const zh = readFileSync(PATHS.zh, 'utf8');
  const en = readFileSync(PATHS.en, 'utf8');

  // One distinctive line from each revision, deep inside the document, proves
  // the artifact embeds the body rather than a summary of it.
  const probes: [string, string][] = [
    ['zh', '## 5. 虚拟 Provider 与模型池'],
    ['en', '## 5. Virtual provider and model pools'],
    ['zh', 'Fail-Closed'],
    ['en', 'fail-closed']
  ];
  for (const [language, probe] of probes) {
    assert.ok(artifact.includes(probe), `the browser artifact does not carry the ${language} guide (${probe})`);
  }
  assert.ok(zh.length > 8_000 && en.length > 8_000, 'a guide revision looks truncated');

  // The provenance line the panel prints comes from the artifact too.
  for (const value of [digest(PATHS.zh).slice(0, 12), digest(PATHS.en).slice(0, 12), 'USER_GUIDE.md', 'docs/USER_GUIDE.en.md']) {
    assert.ok(artifact.includes(value), `the artifact cannot report its guide provenance (${value})`);
  }
});

//#endregion

//#region the renderer the panel uses

/** A `react` stand-in that records the element tree instead of rendering it. */
interface Renderer {
  parseMarkdown(text: string): MarkdownBlock[];
  renderMarkdown(text: string): unknown;
  renderInline(text: string): unknown[];
}

function loadRenderer(): Renderer {
  const source = readFileSync(join(PATHS.clientOut, 'markdown.js'), 'utf8');
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]): unknown => ({ type, props: props ?? {}, children })
  };
  const sandbox: Record<string, unknown> = {
    module: { exports: {} as Record<string, unknown> },
    exports: {},
    require: (spec: string) => {
      if (spec === 'react') return react;
      throw new Error(`the renderer required an unexpected module: ${spec}`);
    }
  };
  sandbox.exports = (sandbox.module as { exports: unknown }).exports;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'dist-client/markdown.js' });
  return (sandbox.module as { exports: Renderer }).exports;
}

interface MarkdownBlock {
  kind: string;
  level?: number;
  text?: string;
  items?: string[];
  language?: string;
  headers?: string[];
  rows?: string[][];
  ordered?: boolean;
}

/** Every `{ type, props, children }` node of a rendered tree, depth first. */
function elements(tree: unknown, out: { type: string; props: Record<string, unknown>; children: unknown[] }[] = []) {
  if (Array.isArray(tree)) {
    for (const child of tree) elements(child, out);
    return out;
  }
  if (typeof tree !== 'object' || tree === null) return out;
  const node = tree as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] };
  if (typeof node.type === 'string') out.push({ type: node.type, props: node.props ?? {}, children: node.children ?? [] });
  for (const child of node.children ?? []) elements(child, out);
  return out;
}

/** All text of a rendered tree. */
function textOf(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (typeof tree === 'string') return tree;
  if (typeof tree !== 'object' || tree === null) return '';
  const node = tree as { children?: unknown[] };
  return (node.children ?? []).map(textOf).join('');
}

test('both guide documents parse into the block kinds the panel renders', () => {
  const { parseMarkdown } = loadRenderer();
  for (const path of [PATHS.zh, PATHS.en]) {
    const blocks = parseMarkdown(readFileSync(path, 'utf8'));
    const kinds = new Set(blocks.map((block) => block.kind));
    for (const kind of ['heading', 'paragraph', 'list', 'code', 'table', 'quote', 'rule']) {
      assert.ok(kinds.has(kind), `${path} parses without a "${kind}" block`);
    }

    const headings = blocks.filter((block) => block.kind === 'heading');
    assert.ok(headings.length >= 13, `${path} parsed only ${String(headings.length)} headings`);
    for (const heading of headings) {
      assert.ok((heading.level ?? 0) >= 1 && (heading.level ?? 0) <= 4, `heading level out of range: ${JSON.stringify(heading)}`);
      assert.ok((heading.text ?? '').trim().length > 0, `empty heading in ${path}`);
    }

    const tables = blocks.filter((block) => block.kind === 'table');
    assert.ok(tables.length >= 3, `${path} parsed only ${String(tables.length)} tables`);
    for (const table of tables) {
      assert.ok((table.headers ?? []).length >= 2, `a table in ${path} has no header row`);
      for (const row of table.rows ?? []) {
        assert.equal(row.length, (table.headers ?? []).length, `a ragged table row in ${path}: ${JSON.stringify(row)}`);
        assert.ok(row.every((cell) => cell.length > 0), `an empty table cell in ${path}: ${JSON.stringify(row)}`);
      }
    }

    const code = blocks.filter((block) => block.kind === 'code');
    assert.ok(code.length >= 6, `${path} parsed only ${String(code.length)} code blocks`);
    for (const block of code) {
      assert.ok((block.language ?? '').length > 0, `an unlabelled code fence in ${path}: ${JSON.stringify(block.text?.slice(0, 40))}`);
    }

    for (const list of blocks.filter((block) => block.kind === 'list')) {
      assert.ok((list.items ?? []).length > 0, `an empty list in ${path}`);
      assert.ok((list.items ?? []).every((item) => item.trim().length > 0), `an empty list item in ${path}`);
    }
  }
});

test('the guide renders as elements, never as injected markup', () => {
  const { renderMarkdown, renderInline } = loadRenderer();
  const rendered = renderMarkdown(readFileSync(PATHS.zh, 'utf8'));
  const nodes = elements(rendered);
  const types = new Set(nodes.map((node) => node.type));

  for (const type of ['h1', 'h2', 'p', 'ul', 'ol', 'pre', 'code', 'table', 'thead', 'tbody', 'th', 'td', 'hr', 'blockquote']) {
    assert.ok(types.has(type), `the rendered guide has no <${type}>`);
  }
  // The document's own title survives into the element tree.
  assert.ok(textOf(rendered).includes('Harness Reflex 使用说明'), 'the rendered guide lost its title');

  // A document that embeds markup must display it: the renderer produces text
  // children, so no `<script>` element can reach the panel's DOM.
  const hostile = renderMarkdown('Look: <script>alert(1)</script> and <img src=x onerror=y>');
  const hostileNodes = elements(hostile);
  assert.equal(hostileNodes.some((node) => ['script', 'img'].includes(node.type)), false, 'the renderer built a raw markup element');
  assert.ok(textOf(hostile).includes('<script>alert(1)</script>'), 'the renderer did not keep embedded markup as text');

  // Inline spans: code, bold and links become elements; everything else is text.
  const inline = elements(renderInline('run `npm run build:all` and **save** the [guide](https://example.test/g)')) ;
  assert.deepEqual(inline.map((node) => node.type), ['code', 'strong', 'a']);
  assert.equal(inline[0]?.children[0], 'npm run build:all');
  assert.equal(inline[1]?.children[0], 'save');
  assert.equal(inline[2]?.props.href, 'https://example.test/g');
});

//#endregion
